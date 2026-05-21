-- ============================================================================
-- CRUD desde portal cliente: campañas y cupones
-- ----------------------------------------------------------------------------
-- Permite que la propia tienda gestione sus campañas y cupones, condicionado
-- por plans.applies_to (DIAMANTE/ORO/PUBLI_PROMO_* → campaigns;
-- IA_PERFORMANCE/DIAMANTE/ORO → coupons; addon flash → flash coupons).
--
-- Coupons ya tenía RLS FOR ALL para el owner; aquí añadimos:
--   * Trigger que valida plan_type del cupón vs plan / addon de la tienda
--     antes del INSERT (refuerzo del trigger enforce_flash_coupon_eligibility
--     que ya bloquea flash sin addon).
-- ad_campaigns sólo tenía SELECT + UPDATE para owner; añadimos:
--   * Policy de INSERT y DELETE para owner.
--   * Trigger que en INSERT por no-admin valida plan_type, fuerza
--     payment_status='paid' e is_active=true.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helper: applies_to del plan vigente para una tienda (por categoría
--    'campaigns' o 'coupons').
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


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ad_campaigns: policies INSERT / DELETE para owner
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "ad_campaigns_owner_insert" ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_owner_delete" ON public.ad_campaigns;

CREATE POLICY "ad_campaigns_owner_insert" ON public.ad_campaigns
  FOR INSERT TO authenticated
  WITH CHECK (public.user_owns_store(store_id));

CREATE POLICY "ad_campaigns_owner_delete" ON public.ad_campaigns
  FOR DELETE TO authenticated
  USING (public.user_owns_store(store_id));


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Trigger: validar y normalizar campañas creadas por el owner
--    - plan_type debe coincidir con stores.plan_type, y ese plan debe permitir
--      'campaigns' en plans.applies_to. (Las addon flash sólo admiten cupones.)
--    - Fuerza payment_status='paid' e is_active=true.
--    - store_id se fuerza a una tienda del usuario si está vacío o no le
--      pertenece (defensa en profundidad sobre la RLS).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_store_plan TEXT;
  v_expiry     DATE;
BEGIN
  -- Admin: paso libre.
  IF public.is_admin() THEN RETURN NEW; END IF;

  IF NEW.store_id IS NULL OR NOT public.user_owns_store(NEW.store_id) THEN
    RAISE EXCEPTION 'No tienes permiso sobre esa tienda' USING ERRCODE = '42501';
  END IF;

  SELECT plan_type, contract_expiry_date
    INTO v_store_plan, v_expiry
    FROM public.stores
   WHERE id = NEW.store_id;

  IF v_store_plan IS NULL THEN
    RAISE EXCEPTION 'Tu tienda no tiene plan base activo; no puedes crear campañas.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_expiry IS NULL OR v_expiry < CURRENT_DATE THEN
    RAISE EXCEPTION 'Tu plan está vencido o sin fecha de vencimiento. Renueva antes de crear campañas.'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.plan_applies_to(v_store_plan, 'campaigns') THEN
    RAISE EXCEPTION 'Tu plan (%) no incluye campañas publicitarias.', v_store_plan
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.plan_type <> v_store_plan THEN
    RAISE EXCEPTION 'El plan_type de la campaña (%) debe coincidir con el plan de tu tienda (%).',
      NEW.plan_type, v_store_plan USING ERRCODE = 'P0001';
  END IF;

  NEW.payment_status := 'paid';
  NEW.is_active      := true;
  NEW.suspended_at   := NULL;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_campaigns_owner_insert ON public.ad_campaigns;
CREATE TRIGGER trg_campaigns_owner_insert
  BEFORE INSERT ON public.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaigns_owner_insert();


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Trigger: validar plan_type al crear cupón desde owner
--    - Si plan_type es base (DIAMANTE/ORO/IA_PERFORMANCE/PUBLI_PROMO):
--        debe coincidir con stores.plan_type, y ese plan debe permitir
--        'coupons' (applies_to).
--    - Si plan_type es flash (FLASH_COUPON_*): ya hay un trigger separado
--      (enforce_flash_coupon_eligibility) que valida el addon vigente.
--    - Si plan_type es legacy (BONO_PREMIADO, PUBLI_PROMO): solo admin.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_coupons_owner_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_store_plan TEXT;
  v_expiry     DATE;
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;

  IF NEW.store_id IS NULL OR NOT public.user_owns_store(NEW.store_id) THEN
    RAISE EXCEPTION 'No tienes permiso sobre esa tienda' USING ERRCODE = '42501';
  END IF;

  -- Los flash se delegan al trigger existente.
  IF public.is_flash_coupon_plan(NEW.plan_type) THEN
    RETURN NEW;
  END IF;

  IF NEW.plan_type IN ('BONO_PREMIADO','PUBLI_PROMO') THEN
    RAISE EXCEPTION 'El plan_type % es legacy/administrativo; sólo el admin puede usarlo.',
      NEW.plan_type USING ERRCODE = '42501';
  END IF;

  SELECT plan_type, contract_expiry_date
    INTO v_store_plan, v_expiry
    FROM public.stores
   WHERE id = NEW.store_id;

  IF v_store_plan IS NULL THEN
    RAISE EXCEPTION 'Tu tienda no tiene plan base activo. Para subir cupones flash adquiere el addon Flash Coupon.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_expiry IS NULL OR v_expiry < CURRENT_DATE THEN
    RAISE EXCEPTION 'Tu plan está vencido o sin fecha de vencimiento. Renueva antes de subir cupones.'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.plan_applies_to(v_store_plan, 'coupons') THEN
    RAISE EXCEPTION 'Tu plan (%) no incluye cupones.', v_store_plan
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.plan_type <> v_store_plan THEN
    RAISE EXCEPTION 'El plan_type del cupón (%) debe coincidir con el plan de tu tienda (%) o ser FLASH_COUPON_* con addon activo.',
      NEW.plan_type, v_store_plan USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_coupons_owner_insert ON public.coupons;
CREATE TRIGGER trg_coupons_owner_insert
  BEFORE INSERT ON public.coupons
  FOR EACH ROW EXECUTE FUNCTION public.guard_coupons_owner_insert();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RPC helper: capacidades del store para la UI del cliente
--    Devuelve qué puede hacer (campañas, cupones normales, cupones flash)
--    según plan base y addon flash. Evita que la UI tenga que duplicar la
--    lógica de applies_to.
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
      AND public.plan_applies_to(s.plan_type, 'campaigns')
    ) AS can_create_campaigns,
    (
      s.plan_type IS NOT NULL
      AND (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
      AND public.plan_applies_to(s.plan_type, 'coupons')
    ) AS can_create_coupons,
    (
      s.flash_coupon_plan IS NOT NULL
      AND (s.flash_coupon_expiry_date IS NULL OR s.flash_coupon_expiry_date >= CURRENT_DATE)
    ) AS can_create_flash,
    (
      s.plan_type IS NOT NULL
      AND (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
    ) AS base_plan_active,
    s.plan_type      AS base_plan_key,
    s.flash_coupon_plan AS flash_plan_key
  FROM public.stores s
  WHERE s.id = p_store_id;
$$;

GRANT EXECUTE ON FUNCTION public.store_capabilities(UUID) TO authenticated;
