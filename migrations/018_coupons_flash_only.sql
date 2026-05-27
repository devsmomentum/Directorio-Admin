-- ============================================================================
-- 018_coupons_flash_only.sql
--
-- Cupones quedan exclusivamente atados al addon Flash Coupon. Antes los planes
-- base DIAMANTE / ORO / IA_PERFORMANCE permitían cupones (vía plans.applies_to
-- = '{coupons}'). A partir de aquí:
--
--   • Solo las tiendas con stores.flash_coupon_plan activo y vigente pueden
--     crear/poseer cupones.
--   • Se eliminan definitivamente los cupones legacy con plan_type base.
--   • Se añade columna is_active para soft-delete (lo usa el cron diario que
--     desactiva cupones cuyo addon flash venció — ver 020).
--   • Se añade last_shown_at para el round-robin por tienda (ver 019).
--   • coupon_leads pasa a ON DELETE CASCADE para que el DELETE legacy no choque
--     con la FK por defecto (NO ACTION / RESTRICT).
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. coupon_leads.coupon_id → ON DELETE CASCADE
--    Recreamos la FK existente sin opción ON DELETE (creada en schem.sql) para
--    permitir el DELETE masivo de cupones legacy del paso 3.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'public.coupon_leads'::regclass
     AND contype  = 'f'
     AND pg_get_constraintdef(oid) ILIKE '%coupon_id%REFERENCES%coupons%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.coupon_leads DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.coupon_leads
  ADD CONSTRAINT coupon_leads_coupon_id_fkey
  FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Nuevas columnas + índice de rotación
--    Se añaden antes del DELETE/CHECK porque los triggers existentes no las
--    necesitan, y así el índice ya queda listo para la RPC en 019.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS is_active     BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_shown_at TIMESTAMPTZ;

COMMENT ON COLUMN public.coupons.is_active     IS
  'false = cupón inhabilitado por cron de vencimiento (addon flash expirado, stock 0, fecha vencida). Preserva historial.';
COMMENT ON COLUMN public.coupons.last_shown_at IS
  'Última vez que el RPC get_flash_coupons_rotated devolvió este cupón con commit=true. Usado para round-robin por tienda.';

CREATE INDEX IF NOT EXISTS idx_coupons_rotation
  ON public.coupons (store_id, last_shown_at NULLS FIRST, id)
  WHERE is_active = true;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Limpieza legacy: eliminar cupones no-flash y sus leads
--    Con la FK ya en CASCADE, basta DELETE sobre coupons. Dejamos el DELETE
--    explícito de coupon_leads como defensa por si la migración corre dos
--    veces y la FK ya estaba en CASCADE desde la primera (idempotente).
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM public.coupon_leads
 WHERE coupon_id IN (
   SELECT id FROM public.coupons
    WHERE plan_type NOT IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL')
 );

DELETE FROM public.coupons
 WHERE plan_type NOT IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL');


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Endurecer CHECK de coupons.plan_type a sólo flash + nuevo DEFAULT
--    Patrón de drop dinámico copiado de 011_flash_coupon_addon_schema.sql:90.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'public.coupons'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%plan_type%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.coupons DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_plan_type_check
  CHECK (plan_type = ANY (ARRAY[
    'FLASH_COUPON_DIARIO',
    'FLASH_COUPON_SEMANAL'
  ]));

ALTER TABLE public.coupons
  ALTER COLUMN plan_type SET DEFAULT 'FLASH_COUPON_DIARIO';


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. plans.applies_to: quitar 'coupons' de planes base
--    plan_applies_to(p, 'coupons') ya no podrá devolver true para DIAMANTE /
--    ORO / IA_PERFORMANCE. Solo el addon habilita cupones.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.plans
   SET applies_to = array_remove(applies_to, 'coupons')
 WHERE plan_key IN ('DIAMANTE','ORO','IA_PERFORMANCE')
   AND 'coupons' = ANY(applies_to);


-- ─────────────────────────────────────────────────────────────────────────────
-- 5b. Re-declarar plan_applies_to(TEXT,TEXT) defensivamente.
--     En algunos entornos la firma quedó diferente (o la 014 no corrió
--     completa) y la llamada en store_capabilities falla con
--     "function public.plan_applies_to(text, unknown) does not exist".
--     CREATE OR REPLACE garantiza la firma esperada antes de definir
--     store_capabilities en el paso 7.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.plan_applies_to(p_plan_key TEXT, p_kind TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.plans
     WHERE plan_key = p_plan_key
       AND is_active = true
       AND p_kind = ANY (applies_to)
  );
$$;

GRANT EXECUTE ON FUNCTION public.plan_applies_to(TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Reescribir guard_coupons_owner_insert (definido en 014)
--    Antes: aceptaba flash o cupón base coincidente con stores.plan_type.
--    Ahora: SOLO flash. El trigger trg_coupons_flash_eligibility (011) sigue
--    validando que el addon esté vigente, así que aquí solo cortamos cualquier
--    intento de plan_type base/legacy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_coupons_owner_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;

  IF NEW.store_id IS NULL OR NOT public.user_owns_store(NEW.store_id) THEN
    RAISE EXCEPTION 'No tienes permiso sobre esa tienda' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_flash_coupon_plan(NEW.plan_type) THEN
    RAISE EXCEPTION 'Solo tiendas con addon Flash Coupon pueden crear cupones (plan_type=% no permitido).',
      NEW.plan_type USING ERRCODE = 'P0001';
  END IF;

  -- Delegamos validación del addon vigente al trigger trg_coupons_flash_eligibility.
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Reescribir store_capabilities (definido en 014)
--    can_create_coupons se mantiene en el RETURNS pero ahora es alias literal
--    de can_create_flash — los consumidores antiguos no rompen, simplemente
--    obtienen el mismo bool para ambos campos.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.store_capabilities(p_store_id UUID)
RETURNS TABLE (
  can_create_campaigns   BOOLEAN,
  can_create_coupons     BOOLEAN,
  can_create_flash       BOOLEAN,
  base_plan_active       BOOLEAN,
  base_plan_key          TEXT,
  flash_plan_key         TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      s.plan_type IS NOT NULL
      AND (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
      AND public.plan_applies_to(s.plan_type::text, 'campaigns'::text)
    ) AS can_create_campaigns,
    (
      s.flash_coupon_plan IS NOT NULL
      AND (s.flash_coupon_expiry_date IS NULL OR s.flash_coupon_expiry_date >= CURRENT_DATE)
    ) AS can_create_coupons,
    (
      s.flash_coupon_plan IS NOT NULL
      AND (s.flash_coupon_expiry_date IS NULL OR s.flash_coupon_expiry_date >= CURRENT_DATE)
    ) AS can_create_flash,
    (
      s.plan_type IS NOT NULL
      AND (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
    ) AS base_plan_active,
    s.plan_type         AS base_plan_key,
    s.flash_coupon_plan AS flash_plan_key
  FROM public.stores s
  WHERE s.id = p_store_id;
$$;

GRANT EXECUTE ON FUNCTION public.store_capabilities(UUID) TO authenticated;
