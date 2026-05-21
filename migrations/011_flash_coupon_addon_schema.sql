-- ============================================================================
-- Flash Coupon como addon (no como plan base)
-- ----------------------------------------------------------------------------
-- Antes: stores.plan_type podía ser FLASH_COUPON_DIARIO / FLASH_COUPON_SEMANAL,
-- forzando a la tienda a renunciar a su plan base (DIAMANTE/ORO/IA_PERFORMANCE
-- /PUBLI_PROMO_*) para poder publicar cupones flash.
--
-- Ahora: Flash Coupon es un addon independiente. Una tienda puede tener
-- simultáneamente:
--   - plan_type base (DIAMANTE / ORO / IA_PERFORMANCE / PUBLI_PROMO_*)
--   - flash_coupon_plan addon (FLASH_COUPON_DIARIO / FLASH_COUPON_SEMANAL)
--
-- Los cupones que sube una tienda son normales (heredan plan base) salvo que
-- el addon flash esté vigente: en ese caso pueden marcarse como FLASH_COUPON_*
-- y entrarán en la galería con sus reglas (lead generation, etc.).
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columnas addon en stores
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS flash_coupon_plan        TEXT,
  ADD COLUMN IF NOT EXISTS flash_coupon_expiry_date DATE;

COMMENT ON COLUMN public.stores.flash_coupon_plan IS
  'Addon Flash Coupon activo (FLASH_COUPON_DIARIO|FLASH_COUPON_SEMANAL). NULL = sin addon.';
COMMENT ON COLUMN public.stores.flash_coupon_expiry_date IS
  'Vencimiento del addon Flash Coupon. Independiente de contract_expiry_date del plan base.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2a. Reparar guard_stores_owner_update: hace referencia a stores.cedula_url
--     que fue movida a la tabla users hace varias migraciones. Cualquier
--     UPDATE (incluido el de abajo) lo dispara y falla con:
--       record "new" has no field "cedula_url"
--     Reescribimos la función eliminando la línea muerta y añadiendo además
--     los campos del addon flash a la lista de columnas que el cliente NO
--     puede modificar (queremos que sea decisión del admin/RPC).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_stores_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  NEW.plan_type                := OLD.plan_type;
  NEW.contract_url             := OLD.contract_url;
  NEW.mercantil_url            := OLD.mercantil_url;
  NEW.contract_expiry_date     := OLD.contract_expiry_date;
  NEW.rif                      := OLD.rif;
  NEW.local_number             := OLD.local_number;
  NEW.floor_level              := OLD.floor_level;
  NEW.category_id              := OLD.category_id;
  NEW.node_id                  := OLD.node_id;
  NEW.flash_coupon_plan        := OLD.flash_coupon_plan;
  NEW.flash_coupon_expiry_date := OLD.flash_coupon_expiry_date;
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2b. Migrar datos legacy: stores con plan_type flash → addon
--     El trigger trg_stores_guard se dispara con cualquier UPDATE no-admin y,
--     en el contexto de migración (sin auth.uid()), is_admin() = false y la
--     guard ignoraría plan_type/contract_expiry_date. Lo deshabilitamos
--     puntualmente para que la migración tenga efecto.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.stores DISABLE TRIGGER trg_stores_guard;

UPDATE public.stores
   SET flash_coupon_plan        = CASE
         WHEN plan_type IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL') THEN plan_type
         WHEN plan_type = 'PROMO_FLASH'                                   THEN 'FLASH_COUPON_DIARIO'
         ELSE flash_coupon_plan
       END,
       flash_coupon_expiry_date = COALESCE(flash_coupon_expiry_date, contract_expiry_date),
       plan_type                = NULL,
       contract_expiry_date     = NULL
 WHERE plan_type IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL','PROMO_FLASH');

ALTER TABLE public.stores ENABLE TRIGGER trg_stores_guard;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Reemplazar CHECK de stores.plan_type para excluir flash
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.stores'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%plan_type%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stores DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.stores
  ADD CONSTRAINT stores_plan_type_check
  CHECK (plan_type IS NULL OR plan_type = ANY (ARRAY[
    'DIAMANTE',
    'ORO',
    'IA_PERFORMANCE',
    'PUBLI_PROMO_DIARIO',
    'PUBLI_PROMO_SEMANAL'
  ]));


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CHECK de la columna addon (idempotente)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_flash_coupon_plan_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_flash_coupon_plan_check
      CHECK (flash_coupon_plan IS NULL OR flash_coupon_plan = ANY (ARRAY[
        'FLASH_COUPON_DIARIO',
        'FLASH_COUPON_SEMANAL'
      ]));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_flash_coupon_expiry_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_flash_coupon_expiry_check
      CHECK (
        (flash_coupon_plan IS NULL AND flash_coupon_expiry_date IS NULL)
        OR
        (flash_coupon_plan IS NOT NULL)
      );
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Índice por addon vigente (consultas frecuentes "tiendas con flash activo")
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_stores_flash_coupon_active
  ON public.stores (flash_coupon_plan)
  WHERE flash_coupon_plan IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Helper: ¿la tienda tiene addon flash vigente?
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.store_has_active_flash_coupon(p_store_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stores
     WHERE id = p_store_id
       AND flash_coupon_plan IS NOT NULL
       AND (flash_coupon_expiry_date IS NULL
            OR flash_coupon_expiry_date >= CURRENT_DATE)
  );
$$;

GRANT EXECUTE ON FUNCTION public.store_has_active_flash_coupon(UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Helper: ¿plan_key es flash coupon?
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_flash_coupon_plan(p_plan_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_plan_key IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL');
$$;

GRANT EXECUTE ON FUNCTION public.is_flash_coupon_plan(TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Restringir cupones flash a tiendas con addon vigente
--    Antes: cualquier store podía tener cupones FLASH_COUPON_*.
--    Ahora: solo si store.flash_coupon_plan está activo y vigente.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_flash_coupon_eligibility()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_addon TEXT;
  v_exp   DATE;
BEGIN
  IF NEW.plan_type NOT IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL') THEN
    RETURN NEW;
  END IF;
  IF NEW.store_id IS NULL THEN
    RAISE EXCEPTION 'Un cupón flash requiere store_id' USING ERRCODE = '23502';
  END IF;
  SELECT flash_coupon_plan, flash_coupon_expiry_date
    INTO v_addon, v_exp
    FROM public.stores
   WHERE id = NEW.store_id;
  IF v_addon IS NULL THEN
    RAISE EXCEPTION 'La tienda no tiene addon Flash Coupon activo; no puede emitir cupones %.', NEW.plan_type
      USING ERRCODE = 'P0001';
  END IF;
  IF v_exp IS NOT NULL AND v_exp < CURRENT_DATE THEN
    RAISE EXCEPTION 'El addon Flash Coupon de la tienda venció el %.', v_exp
      USING ERRCODE = 'P0001';
  END IF;
  -- Permitimos cualquier flavor (diario/semanal) mientras el addon esté
  -- vigente — la tienda puede agotar su período diario y aún tener semanal,
  -- o viceversa. Si se quiere amarrar al mismo flavor, cambiar aquí.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_coupons_flash_eligibility ON public.coupons;
CREATE TRIGGER trg_coupons_flash_eligibility
  BEFORE INSERT OR UPDATE OF plan_type, store_id ON public.coupons
  FOR EACH ROW EXECUTE FUNCTION public.enforce_flash_coupon_eligibility();
