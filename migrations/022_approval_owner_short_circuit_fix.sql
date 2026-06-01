-- ============================================================================
-- 022_approval_owner_short_circuit_fix.sql
--
-- Fix: en 021 el trigger usaba `IF is_admin() THEN RETURN NEW` como primer
-- short-circuit. Eso hacía que una cuenta con rol admin que también es dueña
-- de una tienda saltara el flujo de revisión al subir desde /cliente/promociones.
--
-- Distinción correcta:
--   * Si user_owns_store(NEW.store_id) → el usuario está actuando como dueño,
--     sin importar su rol. Va a revisión (pending + is_active=false).
--   * Si NO posee la tienda → es admin/system insertando desde /panel/* (la
--     RLS ya gate'a quién puede llegar aquí). Se aprueba directo.
--
-- Misma corrección para coupons y para los triggers de UPDATE (para que un
-- admin-owner editando su propio cupón también dispare re-aprobación).
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Campañas — INSERT
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
  v_is_owner   BOOLEAN;
BEGIN
  v_is_owner := NEW.store_id IS NOT NULL AND public.user_owns_store(NEW.store_id);

  -- Path admin/system (no posee la tienda destino). RLS ya gate'ó el acceso.
  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;

  -- Path dueño: validar plan, forzar revisión.
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

  NEW.is_active        := false;
  NEW.approval_status  := 'pending';
  NEW.rejection_reason := NULL;
  NEW.reviewed_at      := NULL;
  NEW.reviewed_by      := NULL;
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Campañas — UPDATE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_plan_active     BOOLEAN;
  v_other_active    BOOLEAN;
  v_content_changed BOOLEAN;
  v_is_owner        BOOLEAN;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_owns_store(OLD.store_id);

  -- No-owner (admin/system): bypass.
  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;

  -- Bypass para RPCs SECURITY DEFINER autorizadas.
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Campos inmutables para el dueño.
  NEW.priority_level := OLD.priority_level;
  NEW.plan_type      := OLD.plan_type;
  NEW.store_id       := OLD.store_id;

  -- Aprobación es admin-only.
  NEW.approval_status  := OLD.approval_status;
  NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.reviewed_by      := OLD.reviewed_by;

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
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.reviewed_at      := NULL;
    NEW.reviewed_by      := NULL;
    NEW.is_active        := false;
    RETURN NEW;
  END IF;

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
-- 3. Cupones — INSERT
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
  v_is_owner   BOOLEAN;
BEGIN
  v_is_owner := NEW.store_id IS NOT NULL AND public.user_owns_store(NEW.store_id);

  IF NOT v_is_owner THEN
    -- Path admin/system. RLS ya gate'ó.
    RETURN NEW;
  END IF;

  -- Path dueño.
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

  NEW.is_active        := false;
  NEW.approval_status  := 'pending';
  NEW.rejection_reason := NULL;
  NEW.reviewed_at      := NULL;
  NEW.reviewed_by      := NULL;
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Cupones — UPDATE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_coupons_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_content_changed BOOLEAN;
  v_is_owner        BOOLEAN;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_owns_store(OLD.store_id);
  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.bypass_coupon_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  NEW.store_id    := OLD.store_id;
  NEW.plan_type   := OLD.plan_type;
  NEW.code        := OLD.code;
  NEW.campaign_id := OLD.campaign_id;

  NEW.approval_status  := OLD.approval_status;
  NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.reviewed_by      := OLD.reviewed_by;
  NEW.last_shown_at    := OLD.last_shown_at;

  v_content_changed :=
       NEW.title            IS DISTINCT FROM OLD.title
    OR NEW.image_url        IS DISTINCT FROM OLD.image_url
    OR NEW.amount_available IS DISTINCT FROM OLD.amount_available
    OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent
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

  IF OLD.is_active = FALSE AND NEW.is_active = TRUE AND OLD.approval_status <> 'approved' THEN
    NEW.is_active := OLD.is_active;
  END IF;

  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Normalizar filas creadas tras 021 pero antes de este fix: cualquier
--    campaña/cupón cuyo dueño existe (vínculo en store_owners) y que esté
--    'approved' sin reviewed_at queda en revisión.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.ad_campaigns c
   SET approval_status = 'pending',
       is_active       = false
 WHERE c.approval_status = 'approved'
   AND c.reviewed_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.user_stores us WHERE us.store_id = c.store_id
   );

UPDATE public.coupons c
   SET approval_status = 'pending',
       is_active       = false
 WHERE c.approval_status = 'approved'
   AND c.reviewed_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.user_stores us WHERE us.store_id = c.store_id
   );


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RPCs de aprobación: re-crean con `app.bypass_*_guard` activado, para
--    que el UPDATE atraviese el trigger incluso cuando la cuenta admin que
--    aprueba también figura como dueña de la tienda destino.
--    El gate de seguridad sigue siendo `is_admin()` al inicio de cada RPC.
-- ─────────────────────────────────────────────────────────────────────────────

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
  PERFORM set_config('app.bypass_campaign_guard', 'on', true);

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
  PERFORM set_config('app.bypass_campaign_guard', 'on', true);

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
  PERFORM set_config('app.bypass_coupon_guard', 'on', true);

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
  PERFORM set_config('app.bypass_coupon_guard', 'on', true);

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
