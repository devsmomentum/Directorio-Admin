-- ============================================================================
-- Control de campañas del admin (versión final, auditada)
--   • Tope 5 ACTIVAS por tienda (≥1 dueño + hasta 4 admin = 5 total).
--   • Dueño/publicista: 1 activa. Admin: exento de plan/aprobación/kill-switch
--     vía admin_managed, pero respeta el tope de 5 y el límite de fecha del plan.
--   • Sin cap global por plan_type. Apagado por end_date: diario.
-- ============================================================================

-- 1. Marcador + índices + invariante de end_date
ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS admin_managed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_admin_managed
  ON public.ad_campaigns (admin_managed) WHERE admin_managed = true;

-- (fix 7) soporte para la cuenta del cap por tienda (sustituye al índice único)
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_store_active
  ON public.ad_campaigns (store_id) WHERE is_active = true;

ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT chk_admin_managed_requires_end_date
  CHECK (NOT admin_managed OR end_date IS NOT NULL);

-- 2. Retirar bloqueos previos
DROP INDEX  IF EXISTS public.uq_one_active_campaign_per_store;
DROP TRIGGER IF EXISTS tr_check_slots ON public.ad_campaigns;  -- cap global legacy
-- validate_campaign_slots() queda huérfana a propósito.

-- 3. Cap por-tienda consciente del rol (admin 5 total / cliente 1)
CREATE OR REPLACE FUNCTION public.enforce_active_campaign_cap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_cap int; v_count int;
BEGIN
  IF NOT COALESCE(NEW.is_active, false) THEN RETURN NEW; END IF;
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;

  IF public.is_admin() THEN
    v_cap := 5;
  ELSIF NEW.store_id IS NOT NULL AND public.user_can_manage_ads(NEW.store_id) THEN
    v_cap := 1;
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
      NEW.is_active := false;     -- cliente: UX silenciosa (la UI detecta el revert)
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_enforce_active_campaign_cap ON public.ad_campaigns;
CREATE TRIGGER tr_enforce_active_campaign_cap
  BEFORE INSERT OR UPDATE ON public.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_active_campaign_cap();

-- 4. guard_campaigns_owner_update: cuerpo vivo SIN el bloque v_other_active
CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_plan_active BOOLEAN; v_content_changed BOOLEAN; v_is_owner BOOLEAN;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_can_manage_ads(OLD.store_id);
  IF NOT v_is_owner THEN RETURN NEW; END IF;
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;

  NEW.priority_level := OLD.priority_level; NEW.plan_type := OLD.plan_type; NEW.store_id := OLD.store_id;
  NEW.approval_status := OLD.approval_status; NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at := OLD.reviewed_at; NEW.reviewed_by := OLD.reviewed_by;

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
END $$;

-- 5. (fix 1) Solo el admin controla admin_managed — cierra el hueco RLS
CREATE OR REPLACE FUNCTION public.guard_admin_managed_flag()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN NEW.admin_managed := false;
  ELSE                    NEW.admin_managed := OLD.admin_managed;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_guard_admin_managed_flag ON public.ad_campaigns;
CREATE TRIGGER tr_guard_admin_managed_flag
  BEFORE INSERT OR UPDATE ON public.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.guard_admin_managed_flag();

-- 6. (fix 4) Tope de end_date por plan vigente — SOLO si la campaña va activa
CREATE OR REPLACE FUNCTION public.enforce_campaign_end_within_plan()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_expiry date;
BEGIN
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;
  IF NOT COALESCE(NEW.is_active, false) THEN RETURN NEW; END IF;   -- no muta pausadas
  IF NEW.store_id IS NULL THEN RETURN NEW; END IF;

  SELECT contract_expiry_date INTO v_expiry FROM public.stores WHERE id = NEW.store_id;
  IF v_expiry IS NOT NULL AND v_expiry >= CURRENT_DATE THEN          -- plan VIGENTE
    IF NEW.end_date IS NULL THEN
      NEW.end_date := v_expiry;
    ELSIF NEW.end_date > v_expiry THEN
      RAISE EXCEPTION 'La campaña no puede terminar después del vencimiento del plan de la tienda (%).', v_expiry
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_enforce_campaign_end_within_plan ON public.ad_campaigns;
CREATE TRIGGER tr_enforce_campaign_end_within_plan
  BEFORE INSERT OR UPDATE ON public.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_campaign_end_within_plan();

-- 7. Kill-switch: exime admin_managed + bypass defensivo
CREATE OR REPLACE FUNCTION public.apply_kill_switch()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE updated_cnt integer := 0; batch_cnt integer := 0;
BEGIN
  PERFORM set_config('app.bypass_campaign_guard', 'on', true);   -- endurecimiento

  UPDATE public.ad_campaigns c SET is_active = false
  FROM public.stores s
  WHERE c.store_id = s.id AND c.is_active = true AND NOT c.admin_managed
    AND ( (c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE)
       OR (s.contract_expiry_date IS NOT NULL AND s.contract_expiry_date < CURRENT_DATE) );
  GET DIAGNOSTICS batch_cnt = ROW_COUNT; updated_cnt := updated_cnt + batch_cnt;

  UPDATE public.ad_campaigns SET is_active = false
  WHERE is_active = true AND store_id IS NULL AND NOT admin_managed
    AND end_date IS NOT NULL AND end_date < CURRENT_DATE;
  GET DIAGNOSTICS batch_cnt = ROW_COUNT; updated_cnt := updated_cnt + batch_cnt;

  UPDATE public.stores s SET plan_type = NULL
  WHERE s.contract_expiry_date IS NOT NULL AND s.contract_expiry_date < CURRENT_DATE
    AND s.plan_type IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.plan_requests pr
       WHERE pr.store_id = s.id AND pr.status = 'approved'
         AND pr.expires_at IS NOT NULL AND pr.expires_at >= CURRENT_DATE
         AND NOT public.is_flash_coupon_plan(pr.plan_key));

  RETURN updated_cnt;
END $$;

-- 8. Reaper propio del admin + cron (idempotente, fix 3)
CREATE OR REPLACE FUNCTION public.deactivate_expired_admin_campaigns()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.bypass_campaign_guard', 'on', true);
  UPDATE public.ad_campaigns SET is_active = false
   WHERE is_active = true AND admin_managed = true
     AND end_date IS NOT NULL AND end_date < CURRENT_DATE;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

DO $$ BEGIN PERFORM cron.unschedule('deactivate-expired-admin-campaigns');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule('deactivate-expired-admin-campaigns', '5 4 * * *',
  $$ SELECT public.deactivate_expired_admin_campaigns(); $$);

-- 9. (fix 2) Aprobar respeta el tope de 5 y el límite de fecha del plan
CREATE OR REPLACE FUNCTION public.admin_approve_campaign(p_campaign_id uuid)
RETURNS ad_campaigns LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','auth' AS $$
DECLARE v_row public.ad_campaigns; v_camp public.ad_campaigns;
        v_expiry date; v_active int; v_new_end date;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden aprobar campañas.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_camp FROM public.ad_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaña % no existe.', p_campaign_id USING ERRCODE = 'P0002'; END IF;

  v_new_end := v_camp.end_date;

  IF v_camp.store_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('camp_cap:' || v_camp.store_id::text, 0));

    SELECT count(*) INTO v_active FROM public.ad_campaigns
     WHERE store_id = v_camp.store_id AND is_active = true AND id <> p_campaign_id
       AND (end_date IS NULL OR end_date >= CURRENT_DATE);
    IF v_active + 1 > 5 THEN
      RAISE EXCEPTION 'No se puede aprobar: la tienda ya tiene 5 campañas activas (máximo). Pausa una antes de aprobar otra.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT contract_expiry_date INTO v_expiry FROM public.stores WHERE id = v_camp.store_id;
    IF v_expiry IS NOT NULL AND v_expiry >= CURRENT_DATE THEN
      IF v_camp.end_date IS NULL THEN
        v_new_end := v_expiry;
      ELSIF v_camp.end_date > v_expiry THEN
        RAISE EXCEPTION 'No se puede aprobar: la fecha de fin (%) supera el vencimiento del plan de la tienda (%).',
          v_camp.end_date, v_expiry USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  PERFORM set_config('app.bypass_campaign_guard', 'on', true);

  UPDATE public.ad_campaigns
     SET approval_status = 'approved', rejection_reason = NULL,
         reviewed_at = now(), reviewed_by = auth.uid(),
         is_active = true, end_date = v_new_end
   WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  IF v_row.store_id IS NOT NULL THEN
    INSERT INTO public.client_notifications (store_id, type, title, message, metadata)
    VALUES (v_row.store_id, 'campaign_approved', 'Campaña aprobada',
      '"' || v_row.brand_name || '" fue aprobada y ya aparece en el K2.',
      jsonb_build_object('entity', 'campaign', 'entity_id', v_row.id));
  END IF;

  RETURN v_row;
END $$;

-- 10. Vistas del kiosco: muestran admin_managed aunque falte/venza el plan,
--     respetando su propia ventana (start/end). Mismas columnas/orden.
CREATE OR REPLACE VIEW public.active_ads_live AS
  SELECT c.id, c.brand_name, c.plan_type, c.media_url, c.media_type, c.duration_seconds,
         c.start_date, c.end_date, c.is_active, c.created_at, c.description, c.priority_level,
         c.slot_limit_group, c.target_frequency_seconds, c.store_id, c.approval_status,
         c.rejection_reason, c.reviewed_at, c.reviewed_by, c.audio_enabled
    FROM public.ad_campaigns c
    LEFT JOIN public.stores s ON s.id = c.store_id
   WHERE c.is_active = true
     AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
     AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE)
     AND (c.store_id IS NULL OR s.contract_expiry_date IS NULL
          OR s.contract_expiry_date >= CURRENT_DATE OR c.admin_managed);

CREATE OR REPLACE VIEW public.kiosk_active_campaigns AS
  SELECT k.id AS kiosk_id, k.name AS kiosk_name, c.id AS campaign_id, c.brand_name, c.plan_type,
         c.media_url, c.media_type, c.duration_seconds, c.priority_level,
         c.target_frequency_seconds, c.slot_limit_group
    FROM public.kiosks k
    CROSS JOIN public.ad_campaigns c
    LEFT JOIN public.stores s ON s.id = c.store_id
   WHERE c.is_active = true
     AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
     AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE)
     AND (s.id IS NULL OR s.contract_expiry_date IS NULL
          OR s.contract_expiry_date >= CURRENT_DATE OR c.admin_managed)
     AND NOT EXISTS (SELECT 1 FROM public.kiosk_campaigns kc WHERE kc.kiosk_id = k.id)
  UNION ALL
  SELECT k.id, k.name, c.id, c.brand_name, c.plan_type, c.media_url, c.media_type,
         c.duration_seconds, c.priority_level, c.target_frequency_seconds, c.slot_limit_group
    FROM public.kiosks k
    JOIN public.kiosk_campaigns kc ON kc.kiosk_id = k.id
    JOIN public.ad_campaigns c     ON c.id = kc.campaign_id
    LEFT JOIN public.stores s      ON s.id = c.store_id
   WHERE c.is_active = true
     AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
     AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE)
     AND (s.id IS NULL OR s.contract_expiry_date IS NULL
          OR s.contract_expiry_date >= CURRENT_DATE OR c.admin_managed);
