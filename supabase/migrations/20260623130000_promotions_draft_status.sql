-- ============================================================================
-- Estado 'draft' para promociones sin plan.
-- Una promo creada sin plan vigente se guarda como 'draft' (INACTIVA, FUERA de
-- revisión): no notifica al admin ni aparece en la cola de Solicitudes (que solo
-- consulta pending/approved/rejected). Pasa a 'pending' (revisión) cuando la
-- tienda ya tiene plan vigente y el dueño la edita/activa.
--
-- Aplicada al proyecto MallHub (lrjgocjubpxruobshtoe) vía MCP el 2026-06-23.
-- ============================================================================

-- 1) Permitir 'draft' en approval_status -------------------------------------
ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_approval_status_check;
ALTER TABLE public.ad_campaigns ADD CONSTRAINT ad_campaigns_approval_status_check
  CHECK (approval_status = ANY (ARRAY['draft','pending','approved','rejected']::text[]));

ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS coupons_approval_status_check;
ALTER TABLE public.coupons ADD CONSTRAINT coupons_approval_status_check
  CHECK (approval_status = ANY (ARRAY['draft','pending','approved','rejected']::text[]));

ALTER TABLE public.banners DROP CONSTRAINT IF EXISTS banners_approval_status_check;
ALTER TABLE public.banners ADD CONSTRAINT banners_approval_status_check
  CHECK (approval_status = ANY (ARRAY['draft','pending','approved','rejected']::text[]));

-- 2) Un cupón en borrador puede no tener fecha de vencimiento todavía ---------
ALTER TABLE public.coupons ALTER COLUMN end_date DROP NOT NULL;

-- 3) Campañas: transición draft -> pending al editar con plan vigente ---------
CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_plan_active BOOLEAN; v_content_changed BOOLEAN; v_is_owner BOOLEAN; v_store_plan TEXT;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_can_manage_ads(OLD.store_id);
  IF NOT v_is_owner THEN RETURN NEW; END IF;
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;

  NEW.priority_level := OLD.priority_level; NEW.plan_type := OLD.plan_type; NEW.store_id := OLD.store_id;
  NEW.approval_status := OLD.approval_status; NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at := OLD.reviewed_at; NEW.reviewed_by := OLD.reviewed_by;

  -- BORRADOR: campaña creada sin plan. Sale a 'pending' (revisión) solo cuando
  -- la tienda ya tiene plan vigente y el dueño la edita para activarla.
  IF OLD.approval_status = 'draft' THEN
    SELECT s.plan_type,
           (s.plan_type IS NOT NULL AND (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE))
      INTO v_store_plan, v_plan_active
      FROM public.stores s WHERE s.id = OLD.store_id;
    IF COALESCE(v_plan_active, false) THEN
      NEW.approval_status := 'pending';
      NEW.rejection_reason := NULL; NEW.reviewed_at := NULL; NEW.reviewed_by := NULL;
      NEW.plan_type := v_store_plan;
      NEW.is_active := false;  -- entra a revisión, no al loop
    ELSE
      NEW.approval_status := 'draft';
      NEW.is_active := false;
    END IF;
    RETURN NEW;
  END IF;

  v_content_changed := NEW.brand_name IS DISTINCT FROM OLD.brand_name
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.media_url  IS DISTINCT FROM OLD.media_url
    OR NEW.media_type IS DISTINCT FROM OLD.media_type;
  IF v_content_changed THEN
    NEW.approval_status := 'pending'; NEW.rejection_reason := NULL;
    NEW.reviewed_at := NULL; NEW.reviewed_by := NULL; NEW.is_active := false;
    RETURN NEW;
  END IF;

  IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
    NULL;
  ELSIF OLD.is_active = FALSE AND NEW.is_active = TRUE THEN
    IF OLD.approval_status <> 'approved' THEN
      NEW.is_active := OLD.is_active;
    ELSE
      SELECT (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
        INTO v_plan_active FROM public.stores s WHERE s.id = NEW.store_id;
      IF NOT COALESCE(v_plan_active, FALSE) THEN
        NEW.is_active := OLD.is_active;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- 4) Cupones: transición draft -> pending al editar con addon flash vigente ---
CREATE OR REPLACE FUNCTION public.guard_coupons_owner_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_content_changed BOOLEAN;
  v_is_owner        BOOLEAN;
  v_cap             INTEGER;
  v_flash_ok        BOOLEAN;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_can_manage_ads(OLD.store_id);
  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.bypass_coupon_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  NEW.store_id    := OLD.store_id;
  NEW.code        := OLD.code;
  NEW.campaign_id := OLD.campaign_id;

  -- BORRADOR: cupón creado sin addon Flash. Sale a 'pending' cuando la tienda
  -- tiene addon Flash vigente (o es aliada flash) y se le fija un plan flash.
  IF OLD.approval_status = 'draft' THEN
    SELECT (
      (COALESCE(s.is_ally,false) AND COALESCE(s.ally_flash_enabled,false))
      OR (s.flash_coupon_plan IS NOT NULL AND (s.flash_coupon_expiry_date IS NULL OR s.flash_coupon_expiry_date >= CURRENT_DATE))
    )
      INTO v_flash_ok FROM public.stores s WHERE s.id = OLD.store_id;
    IF COALESCE(v_flash_ok, false) AND public.is_flash_coupon_plan(NEW.plan_type) THEN
      NEW.approval_status  := 'pending';
      NEW.rejection_reason := NULL; NEW.reviewed_at := NULL; NEW.reviewed_by := NULL;
      NEW.is_active        := false;
    ELSE
      NEW.plan_type        := OLD.plan_type;
      NEW.approval_status  := 'draft';
      NEW.is_active        := false;
    END IF;
    RETURN NEW;
  END IF;

  NEW.plan_type := OLD.plan_type;

  v_cap := public.store_coupon_stock_cap(OLD.store_id);
  IF public.is_flash_coupon_plan(NEW.plan_type)
     AND public.store_coupon_stock_used(OLD.store_id, OLD.id) + COALESCE(NEW.amount_available, 0) > v_cap THEN
    RAISE EXCEPTION 'Superas el tope de % cupones de tu tienda. Ya tienes % en stock vigente (incluye canjeados); reduce el stock o espera a que venza/se canjee.',
      v_cap, public.store_coupon_stock_used(OLD.store_id, OLD.id) USING ERRCODE = 'P0001';
  END IF;

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
END $function$;

-- 5) Banners: permitir guardar borradores sin plan DIAMANTE -------------------
CREATE OR REPLACE FUNCTION public.enforce_banner_diamante()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_plan TEXT; v_expiry DATE;
BEGIN
  IF NEW.store_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT plan_type, contract_expiry_date INTO v_plan, v_expiry
    FROM public.stores WHERE id = NEW.store_id;

  -- Sin plan DIAMANTE vigente solo se permite GUARDAR el banner como borrador
  -- inactivo. guard_banners_client_insert/update lo marca como 'draft'.
  IF v_plan IS DISTINCT FROM 'DIAMANTE' OR (v_expiry IS NOT NULL AND v_expiry < CURRENT_DATE) THEN
    IF COALESCE(NEW.is_active, false) THEN
      RAISE EXCEPTION 'Los banners requieren un plan DIAMANTE vigente.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_banners_client_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_diam_active BOOLEAN;
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF public.user_member_of_store(NEW.store_id) THEN
    NEW.rejection_reason := NULL;
    NEW.is_active        := false;
    SELECT (plan_type = 'DIAMANTE' AND (contract_expiry_date IS NULL OR contract_expiry_date >= CURRENT_DATE))
      INTO v_diam_active FROM public.stores WHERE id = NEW.store_id;
    IF COALESCE(v_diam_active, false) THEN
      NEW.approval_status := 'pending';
    ELSE
      -- Sin plan DIAMANTE vigente: borrador, fuera de revisión.
      NEW.approval_status := 'draft';
    END IF;
  ELSE
    RAISE EXCEPTION 'No tienes permisos sobre esta tienda.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_banners_client_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_diam_active BOOLEAN;
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF public.user_member_of_store(NEW.store_id) THEN
    NEW.store_id         := OLD.store_id;
    NEW.approval_status  := OLD.approval_status;
    NEW.rejection_reason := OLD.rejection_reason;

    -- BORRADOR: al editarlo con plan DIAMANTE vigente, pasa a revisión.
    IF OLD.approval_status = 'draft' THEN
      SELECT (plan_type = 'DIAMANTE' AND (contract_expiry_date IS NULL OR contract_expiry_date >= CURRENT_DATE))
        INTO v_diam_active FROM public.stores WHERE id = OLD.store_id;
      IF COALESCE(v_diam_active, false) THEN
        NEW.approval_status  := 'pending';
        NEW.rejection_reason := NULL;
      ELSE
        NEW.approval_status  := 'draft';
      END IF;
      NEW.is_active := false;
      RETURN NEW;
    END IF;

    IF NEW.media_url IS DISTINCT FROM OLD.media_url THEN
      NEW.approval_status  := 'pending';
      NEW.rejection_reason := NULL;
      NEW.is_active        := false;
    END IF;
  ELSE
    RAISE EXCEPTION 'No tienes permisos sobre esta tienda.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
