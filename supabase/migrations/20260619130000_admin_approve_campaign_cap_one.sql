-- El cap inline de admin_approve_campaign seguía en 5 y la RPC pone
-- app.bypass_campaign_guard='on', así que esquivaba el trigger
-- enforce_active_campaign_cap (migración 20260619120000) y dejaba aprobar una
-- 2da campaña activa de la misma tienda. Lo alineamos a la regla vigente:
-- 1 activa por tienda (o ally_campaign_limit para aliadas).
CREATE OR REPLACE FUNCTION public.admin_approve_campaign(p_campaign_id uuid)
 RETURNS ad_campaigns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_row public.ad_campaigns; v_camp public.ad_campaigns;
        v_expiry date; v_active int; v_new_end date;
        v_cap int; v_is_ally boolean; v_ally_cap int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden aprobar campañas.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_camp FROM public.ad_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaña % no existe.', p_campaign_id USING ERRCODE = 'P0002'; END IF;

  v_new_end := v_camp.end_date;

  IF v_camp.store_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('camp_cap:' || v_camp.store_id::text, 0));

    -- Cap por tienda: 1 normal, ally_campaign_limit para aliadas.
    SELECT is_ally, ally_campaign_limit, contract_expiry_date
      INTO v_is_ally, v_ally_cap, v_expiry
      FROM public.stores WHERE id = v_camp.store_id;
    v_cap := CASE WHEN COALESCE(v_is_ally, false)
                  THEN GREATEST(1, COALESCE(v_ally_cap, 1)) ELSE 1 END;

    SELECT count(*) INTO v_active FROM public.ad_campaigns
     WHERE store_id = v_camp.store_id AND is_active = true AND id <> p_campaign_id
       AND (end_date IS NULL OR end_date >= CURRENT_DATE);
    IF v_active + 1 > v_cap THEN
      RAISE EXCEPTION 'No se puede aprobar: la tienda ya tiene % campaña(s) activa(s) (máximo). Pausa una antes de aprobar otra.', v_cap
        USING ERRCODE = 'P0001';
    END IF;

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
END $function$;
