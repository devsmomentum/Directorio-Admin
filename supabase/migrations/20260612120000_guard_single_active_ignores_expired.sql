-- Fix: la regla "una sola campaña activa por tienda" contaba CUALQUIER fila con
-- is_active=true, incluidas las que ya pasaron su end_date. Una campaña vencida
-- no está sonando en el loop (las vistas active_ads_live / kiosk_active_campaigns
-- la excluyen por fecha) pero seguía OCUPANDO el slot, bloqueando la activación
-- de la campaña real y vigente con el mensaje engañoso "tu plan venció o ya
-- tienes otra activa" — aun con el plan a días de vencer.
--
-- Aquí v_other_active solo cuenta campañas activas que además sigan dentro de su
-- ventana (end_date no vencida), igual que findActiveCampaign() en el cliente y
-- que las vistas del kiosco. El kill switch nocturno sigue siendo el encargado de
-- poner is_active=false a las vencidas; este cambio evita que una vencida que aún
-- no ha sido reconciliada bloquee al cliente.
CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_plan_active BOOLEAN; v_other_active BOOLEAN; v_content_changed BOOLEAN; v_is_owner BOOLEAN;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_can_manage_ads(OLD.store_id);
  IF NOT v_is_owner THEN RETURN NEW; END IF;
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;
  NEW.priority_level := OLD.priority_level; NEW.plan_type := OLD.plan_type; NEW.store_id := OLD.store_id;
  NEW.approval_status := OLD.approval_status; NEW.rejection_reason := OLD.rejection_reason; NEW.reviewed_at := OLD.reviewed_at; NEW.reviewed_by := OLD.reviewed_by;
  v_content_changed := NEW.brand_name IS DISTINCT FROM OLD.brand_name OR NEW.description IS DISTINCT FROM OLD.description OR NEW.media_url IS DISTINCT FROM OLD.media_url OR NEW.media_type IS DISTINCT FROM OLD.media_type;
  IF v_content_changed THEN
    NEW.approval_status := 'pending'; NEW.rejection_reason := NULL; NEW.reviewed_at := NULL; NEW.reviewed_by := NULL; NEW.is_active := false;
    RETURN NEW;
  END IF;
  IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
    NULL;
  ELSIF OLD.is_active = FALSE AND NEW.is_active = TRUE THEN
    IF OLD.approval_status <> 'approved' THEN
      NEW.is_active := OLD.is_active;
    ELSE
      SELECT (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE) INTO v_plan_active FROM public.stores s WHERE s.id = NEW.store_id;
      IF NOT COALESCE(v_plan_active, FALSE) THEN
        NEW.is_active := OLD.is_active;
      ELSE
        -- ▼ FIX: una campaña vencida (end_date pasada) ya no ocupa el slot.
        SELECT EXISTS (
          SELECT 1 FROM public.ad_campaigns c
          WHERE c.store_id = NEW.store_id
            AND c.is_active = TRUE
            AND c.id <> NEW.id
            AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)
        ) INTO v_other_active;
        IF v_other_active THEN NEW.is_active := OLD.is_active; END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
