-- ============================================================================
-- 032_campaign_reapproval_only_on_media_or_text.sql
--
-- Ajuste de la regla de re-aprobación para campañas editadas por el DUEÑO.
--
-- Problema: en 021/022, guard_campaigns_owner_update marcaba la campaña como
-- 'pending' (de vuelta a revisión) ante CUALQUIER cambio de contenido, e
-- incluía start_date / end_date / duration_seconds / slot_limit_group /
-- target_frequency_seconds en esa lista. Como reactivar una campaña vencida casi
-- siempre exige extender las fechas, el dueño quedaba atrapado: reactivar →
-- cambiar fecha → vuelve a revisión, aunque el video y el texto sean los mismos.
--
-- Regla nueva (pedida por negocio): una campaña ya aprobada solo vuelve a
-- revisión si cambia el MEDIO (video/imagen) o el TEXTO relevante
-- (nombre / descripción). Cambiar solo fechas, duración o agrupación de slots
-- NO dispara re-aprobación; el dueño puede reactivar/reprogramar directo.
--
-- Las fechas siguen acotadas por la vigencia del plan: el trigger de reactivar
-- valida contract_expiry_date y la vista active_ads_live filtra por fechas, así
-- que permitir cambios de fecha sin revisión no extiende nada fuera del plan.
--
-- Reproduce el cuerpo de 022 (path v_is_owner + reglas de is_active intactas);
-- el ÚNICO cambio es la lista v_content_changed.
-- ============================================================================

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

  -- Solo el medio o el texto relevante disparan re-aprobación.
  -- Fechas, duración y agrupación de slots quedan FUERA a propósito.
  v_content_changed :=
       NEW.brand_name  IS DISTINCT FROM OLD.brand_name
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.media_url   IS DISTINCT FROM OLD.media_url
    OR NEW.media_type  IS DISTINCT FROM OLD.media_type;

  IF v_content_changed THEN
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.reviewed_at      := NULL;
    NEW.reviewed_by      := NULL;
    NEW.is_active        := false;
    RETURN NEW;
  END IF;

  -- Sin cambio de medio/texto: aplican las reglas de is_active.
  --  · DESACTIVAR (TRUE -> FALSE): siempre permitido.
  --  · REACTIVAR  (FALSE -> TRUE): solo si está aprobada, plan vigente y sin
  --    otra campaña activa de la misma tienda.
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
