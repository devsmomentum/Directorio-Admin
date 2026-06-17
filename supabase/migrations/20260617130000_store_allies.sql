-- Marcas/tiendas aliadas: pueden publicar campañas + cupones flash SIN pagar plan,
-- con un tope de campañas activas que fija el admin, y opcionalmente reciben un %
-- de los ingresos globales (se refleja en Finanzas). El estatus es PERMANENTE
-- hasta que el admin lo revoque: no usa contract_expiry_date.
--
-- Nota de implementación: las vistas kiosk_active_campaigns / active_ads_live y el
-- cron apply_kill_switch ya tratan `stores.contract_expiry_date IS NULL` como
-- "vigente", por lo que las campañas de aliados (sin fecha de plan) ya suenan en el
-- loop y NO las apaga el kill-switch. Por eso aquí no se tocan vistas ni kill-switch.

-- 1) Columnas de aliado en stores ───────────────────────────────────────────────
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS is_ally             boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ally_campaign_limit integer       NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ally_flash_enabled  boolean       NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ally_revenue_pct    numeric(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ally_since          timestamptz;

ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS chk_ally_revenue_pct,
  ADD  CONSTRAINT chk_ally_revenue_pct CHECK (ally_revenue_pct >= 0 AND ally_revenue_pct <= 100);

ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS chk_ally_campaign_limit,
  ADD  CONSTRAINT chk_ally_campaign_limit CHECK (ally_campaign_limit >= 1);

-- 2) guard_stores_owner_update: el dueño NO puede auto-otorgarse estatus de aliado.
--    Fijamos las columnas ally_* a OLD para clientes (solo el admin las cambia).
CREATE OR REPLACE FUNCTION public.guard_stores_owner_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Admin, o contexto backend sin sesión de usuario (cron / SECURITY DEFINER):
  -- permitir el update completo. El guard solo protege contra clientes dueños.
  IF public.is_admin() OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.plan_type            := OLD.plan_type;
  NEW.contract_url         := OLD.contract_url;
  NEW.mercantil_url        := OLD.mercantil_url;
  NEW.cedula_url           := OLD.cedula_url;
  NEW.contract_expiry_date := OLD.contract_expiry_date;
  NEW.rif                  := OLD.rif;
  NEW.local_number         := OLD.local_number;
  NEW.floor_level          := OLD.floor_level;
  NEW.category_id          := OLD.category_id;
  NEW.node_id              := OLD.node_id;
  -- Estatus de aliado: solo el admin lo gestiona.
  NEW.is_ally              := OLD.is_ally;
  NEW.ally_campaign_limit  := OLD.ally_campaign_limit;
  NEW.ally_flash_enabled   := OLD.ally_flash_enabled;
  NEW.ally_revenue_pct     := OLD.ally_revenue_pct;
  NEW.ally_since           := OLD.ally_since;
  RETURN NEW;
END $function$;

-- 3) guard_campaigns_owner_insert: la tienda aliada NO requiere plan/vigencia ni que
--    el plan_type de la campaña coincida; solo forzamos el flujo de aprobación.
CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_store_plan TEXT; v_expiry DATE; v_is_owner BOOLEAN; v_is_ally BOOLEAN;
BEGIN
  v_is_owner := NEW.store_id IS NOT NULL AND public.user_can_manage_ads(NEW.store_id);
  IF NOT v_is_owner THEN RETURN NEW; END IF;
  SELECT plan_type, contract_expiry_date, is_ally
    INTO v_store_plan, v_expiry, v_is_ally
    FROM public.stores WHERE id = NEW.store_id;

  -- Marca aliada: campañas gratis, sin plan pago. Saltamos validaciones de plan.
  IF COALESCE(v_is_ally, false) THEN
    NEW.is_active := false; NEW.approval_status := 'pending'; NEW.rejection_reason := NULL; NEW.reviewed_at := NULL; NEW.reviewed_by := NULL;
    RETURN NEW;
  END IF;

  IF v_store_plan IS NULL THEN RAISE EXCEPTION 'Tu tienda no tiene un plan activo. Solicita uno antes de crear campañas.' USING ERRCODE = 'P0001'; END IF;
  IF v_expiry IS NULL OR v_expiry < CURRENT_DATE THEN RAISE EXCEPTION 'Tu plan está vencido o sin fecha de vencimiento. Renueva antes de crear campañas.' USING ERRCODE = 'P0001'; END IF;
  IF NOT public.plan_applies_to(v_store_plan, 'campaigns') THEN RAISE EXCEPTION 'Tu plan (%) no incluye campañas publicitarias.', v_store_plan USING ERRCODE = 'P0001'; END IF;
  IF NEW.plan_type <> v_store_plan THEN RAISE EXCEPTION 'El plan_type de la campaña (%) debe coincidir con el plan de tu tienda (%).', NEW.plan_type, v_store_plan USING ERRCODE = 'P0001'; END IF;
  NEW.is_active := false; NEW.approval_status := 'pending'; NEW.rejection_reason := NULL; NEW.reviewed_at := NULL; NEW.reviewed_by := NULL;
  RETURN NEW;
END $function$;

-- 4) enforce_flash_coupon_eligibility: aliado con ally_flash_enabled es elegible sin addon.
CREATE OR REPLACE FUNCTION public.enforce_flash_coupon_eligibility()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_addon TEXT;
  v_exp   DATE;
  v_is_ally    BOOLEAN;
  v_ally_flash BOOLEAN;
BEGIN
  IF NEW.plan_type NOT IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL') THEN
    RETURN NEW;
  END IF;
  IF NEW.store_id IS NULL THEN
    RAISE EXCEPTION 'Un cupón flash requiere store_id' USING ERRCODE = '23502';
  END IF;
  SELECT flash_coupon_plan, flash_coupon_expiry_date, is_ally, ally_flash_enabled
    INTO v_addon, v_exp, v_is_ally, v_ally_flash
    FROM public.stores
   WHERE id = NEW.store_id;
  -- Marca aliada con cupones flash habilitados: elegible sin addon de pago.
  IF COALESCE(v_is_ally, false) AND COALESCE(v_ally_flash, false) THEN
    RETURN NEW;
  END IF;
  IF v_addon IS NULL THEN
    RAISE EXCEPTION 'La tienda no tiene addon Flash Coupon activo; no puede emitir cupones %.', NEW.plan_type
      USING ERRCODE = 'P0001';
  END IF;
  IF v_exp IS NOT NULL AND v_exp < CURRENT_DATE THEN
    RAISE EXCEPTION 'El addon Flash Coupon de la tienda venció el %.', v_exp
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$;

-- 5) enforce_active_campaign_cap: para aliados el tope lo fija el admin (ally_campaign_limit).
CREATE OR REPLACE FUNCTION public.enforce_active_campaign_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_cap int; v_count int; v_is_ally boolean; v_ally_cap int;
BEGIN
  IF NOT COALESCE(NEW.is_active, false) THEN RETURN NEW; END IF;
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;

  IF public.is_admin() THEN
    v_cap := 5;
  ELSIF NEW.store_id IS NOT NULL AND public.user_can_manage_ads(NEW.store_id) THEN
    -- Tienda aliada: cap definido por el admin (mínimo 1). Tienda normal: 1.
    SELECT is_ally, ally_campaign_limit INTO v_is_ally, v_ally_cap
      FROM public.stores WHERE id = NEW.store_id;
    IF COALESCE(v_is_ally, false) THEN
      v_cap := GREATEST(1, COALESCE(v_ally_cap, 1));
    ELSE
      v_cap := 1;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('camp_cap:' || COALESCE(NEW.store_id::text, 'global'), 0));

  SELECT count(*) INTO v_count
    FROM public.ad_campaigns c
   WHERE c.store_id = NEW.store_id AND c.is_active = true AND c.id <> NEW.id
     AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE);

  IF v_count + 1 > v_cap THEN
    IF public.is_admin() THEN
      RAISE EXCEPTION 'La tienda ya tiene % campañas activas (máximo). Pausa una antes de activar otra.', v_cap
        USING ERRCODE = 'P0001';
    ELSE
      NEW.is_active := false;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
