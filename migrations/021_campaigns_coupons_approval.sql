-- ============================================================================
-- 021_campaigns_coupons_approval.sql
--
-- Aprobación admin obligatoria para campañas y cupones que suben las tiendas.
--
-- Modelo:
--   * approval_status: 'pending' | 'approved' | 'rejected'  (default 'approved')
--   * El default queda en 'approved' para que filas legacy y filas insertadas
--     por el admin (is_admin()) no necesiten revisión.
--   * Los triggers de INSERT/UPDATE de owner forzan approval_status='pending'
--     y is_active=false. Sólo el admin (vía RPC) puede aprobar.
--   * is_active sigue siendo el flag que filtra el K2 — al aprobar lo
--     reactivamos. Así no hay que tocar el repo del K2.
--
--   * Re-aprobación: cualquier edición del owner regresa a 'pending' (e
--     is_active=false) salvo cuando lo único que cambia es is_active (el
--     owner pausando o intentando reactivar su campaña).
--
-- RPCs nuevos:
--   * admin_approve_campaign(p_id)            → set approved + active
--   * admin_reject_campaign(p_id, p_reason)   → set rejected + inactive
--   * admin_approve_coupon(p_id)              → set approved + active
--   * admin_reject_coupon(p_id, p_reason)     → set rejected + inactive
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columnas de aprobación
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS approval_status  TEXT NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by      UUID REFERENCES auth.users(id);

ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS approval_status  TEXT NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by      UUID REFERENCES auth.users(id);

COMMENT ON COLUMN public.ad_campaigns.approval_status IS
  'Estado de revisión: pending (en cola del admin), approved (visible en K2), rejected.';
COMMENT ON COLUMN public.coupons.approval_status IS
  'Estado de revisión: pending (en cola del admin), approved (visible en K2), rejected.';

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_approval_pending
  ON public.ad_campaigns (created_at DESC) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_coupons_approval_pending
  ON public.coupons (created_at DESC) WHERE approval_status = 'pending';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Trigger INSERT (campañas) — owner siempre arranca en 'pending' + inactivo
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
  IF public.is_admin() THEN RETURN NEW; END IF;

  SELECT plan_type, contract_expiry_date
    INTO v_store_plan, v_expiry
    FROM public.stores
   WHERE id = NEW.store_id;

  IF v_store_plan IS NULL THEN
    RAISE EXCEPTION 'Tu tienda no tiene un plan activo. Solicita uno antes de crear campañas.'
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

  -- Owner upload → cola de revisión. is_active=false hasta que admin apruebe.
  NEW.is_active       := false;
  NEW.approval_status := 'pending';
  NEW.rejection_reason := NULL;
  NEW.reviewed_at     := NULL;
  NEW.reviewed_by     := NULL;
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Trigger UPDATE (campañas) — owner que toca contenido vuelve a 'pending'
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_plan_active    BOOLEAN;
  v_other_active   BOOLEAN;
  v_content_changed BOOLEAN;
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  -- Bypass para RPCs SECURITY DEFINER (sync_store_plan_to_campaigns, etc.)
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Campos inmutables para el owner.
  NEW.priority_level := OLD.priority_level;
  NEW.plan_type      := OLD.plan_type;
  NEW.store_id       := OLD.store_id;

  -- Campos de aprobación son solo de admin/RPC.
  NEW.approval_status  := OLD.approval_status;
  NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.reviewed_by      := OLD.reviewed_by;

  -- ¿Cambió contenido (no sólo el flag is_active)?
  v_content_changed :=
       NEW.brand_name        IS DISTINCT FROM OLD.brand_name
    OR NEW.description       IS DISTINCT FROM OLD.description
    OR NEW.media_url         IS DISTINCT FROM OLD.media_url
    OR NEW.media_type        IS DISTINCT FROM OLD.media_type
    OR NEW.duration_seconds  IS DISTINCT FROM OLD.duration_seconds
    OR NEW.start_date        IS DISTINCT FROM OLD.start_date
    OR NEW.end_date          IS DISTINCT FROM OLD.end_date
    OR NEW.slot_limit_group  IS DISTINCT FROM OLD.slot_limit_group
    OR NEW.target_frequency_seconds IS DISTINCT FROM OLD.target_frequency_seconds;

  IF v_content_changed THEN
    -- Edición real → vuelve a la cola, sale del loop hasta nueva aprobación.
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.reviewed_at      := NULL;
    NEW.reviewed_by      := NULL;
    NEW.is_active        := false;
    RETURN NEW;
  END IF;

  -- Sin cambio de contenido: aplican las reglas previas de is_active.
  -- DESACTIVAR (TRUE → FALSE) siempre permitido.
  -- REACTIVAR  (FALSE → TRUE) sólo si está aprobada, plan vigente, y no hay otra activa.
  IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
    NULL;
  ELSIF OLD.is_active = FALSE AND NEW.is_active = TRUE THEN
    IF OLD.approval_status <> 'approved' THEN
      NEW.is_active := OLD.is_active;
    ELSE
      SELECT (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
        INTO v_plan_active
        FROM public.stores s
       WHERE s.id = NEW.store_id;
      IF NOT COALESCE(v_plan_active, FALSE) THEN
        NEW.is_active := OLD.is_active;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM public.ad_campaigns c
           WHERE c.store_id  = NEW.store_id
             AND c.is_active = TRUE
             AND c.id        <> NEW.id
        ) INTO v_other_active;
        IF v_other_active THEN
          NEW.is_active := OLD.is_active;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Trigger INSERT (cupones) — owner arranca en 'pending' + inactivo
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

  -- Para flash, dejamos que el trigger enforce_flash_coupon_eligibility valide
  -- el addon. Aquí sólo añadimos el ciclo de aprobación.
  IF NOT public.is_flash_coupon_plan(NEW.plan_type) THEN
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
  END IF;

  -- Owner upload → cola de revisión.
  NEW.is_active        := false;
  NEW.approval_status  := 'pending';
  NEW.rejection_reason := NULL;
  NEW.reviewed_at      := NULL;
  NEW.reviewed_by      := NULL;
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Trigger UPDATE (cupones) — edición de contenido vuelve a 'pending'
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_coupons_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_content_changed BOOLEAN;
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  IF current_setting('app.bypass_coupon_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Campos inmutables para el owner.
  NEW.store_id   := OLD.store_id;
  NEW.plan_type  := OLD.plan_type;
  NEW.code       := OLD.code;
  NEW.campaign_id := OLD.campaign_id;

  -- Aprobación es admin-only.
  NEW.approval_status  := OLD.approval_status;
  NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.reviewed_by      := OLD.reviewed_by;
  NEW.last_shown_at    := OLD.last_shown_at;

  v_content_changed :=
       NEW.title            IS DISTINCT FROM OLD.title
    OR NEW.image_url        IS DISTINCT FROM OLD.image_url
    OR NEW.amount_available IS DISTINCT FROM OLD.amount_available
    OR NEW.price_usd        IS DISTINCT FROM OLD.price_usd
    OR NEW.start_date       IS DISTINCT FROM OLD.start_date
    OR NEW.end_date         IS DISTINCT FROM OLD.end_date
    OR NEW.category         IS DISTINCT FROM OLD.category;

  IF v_content_changed THEN
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.reviewed_at      := NULL;
    NEW.reviewed_by      := NULL;
    NEW.is_active        := false;
    RETURN NEW;
  END IF;

  -- Sin cambio de contenido: permitimos pausar; reactivar requiere aprobado.
  IF OLD.is_active = FALSE AND NEW.is_active = TRUE AND OLD.approval_status <> 'approved' THEN
    NEW.is_active := OLD.is_active;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_coupons_owner_update ON public.coupons;
CREATE TRIGGER trg_coupons_owner_update
  BEFORE UPDATE ON public.coupons
  FOR EACH ROW EXECUTE FUNCTION public.guard_coupons_owner_update();

-- Defensa: si no existe el trigger del UPDATE de campañas (definido en una
-- migración base no presente en este repo), lo creamos. Es idempotente.
DROP TRIGGER IF EXISTS trg_campaigns_owner_update ON public.ad_campaigns;
CREATE TRIGGER trg_campaigns_owner_update
  BEFORE UPDATE ON public.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaigns_owner_update();


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RPCs de aprobación / rechazo
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_approve_campaign(UUID);
CREATE OR REPLACE FUNCTION public.admin_approve_campaign(p_campaign_id UUID)
RETURNS public.ad_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.ad_campaigns;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden aprobar campañas.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.ad_campaigns
     SET approval_status  = 'approved',
         rejection_reason = NULL,
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = true
   WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Campaña % no existe.', p_campaign_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_campaign(UUID) TO authenticated;


DROP FUNCTION IF EXISTS public.admin_reject_campaign(UUID, TEXT);
CREATE OR REPLACE FUNCTION public.admin_reject_campaign(p_campaign_id UUID, p_reason TEXT)
RETURNS public.ad_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.ad_campaigns;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden rechazar campañas.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.ad_campaigns
     SET approval_status  = 'rejected',
         rejection_reason = NULLIF(btrim(p_reason), ''),
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = false
   WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Campaña % no existe.', p_campaign_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_reject_campaign(UUID, TEXT) TO authenticated;


DROP FUNCTION IF EXISTS public.admin_approve_coupon(UUID);
CREATE OR REPLACE FUNCTION public.admin_approve_coupon(p_coupon_id UUID)
RETURNS public.coupons
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.coupons;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden aprobar cupones.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.coupons
     SET approval_status  = 'approved',
         rejection_reason = NULL,
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = true
   WHERE id = p_coupon_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cupón % no existe.', p_coupon_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_coupon(UUID) TO authenticated;


DROP FUNCTION IF EXISTS public.admin_reject_coupon(UUID, TEXT);
CREATE OR REPLACE FUNCTION public.admin_reject_coupon(p_coupon_id UUID, p_reason TEXT)
RETURNS public.coupons
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.coupons;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden rechazar cupones.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.coupons
     SET approval_status  = 'rejected',
         rejection_reason = NULLIF(btrim(p_reason), ''),
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = false
   WHERE id = p_coupon_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cupón % no existe.', p_coupon_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_reject_coupon(UUID, TEXT) TO authenticated;
