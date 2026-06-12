-- ad_campaigns tenía DOS triggers BEFORE UPDATE ejecutando la MISMA función
-- guard_campaigns_owner_update():
--   * trg_campaigns_guard         — creado en cliente_portal_auth.sql (el viejo)
--   * trg_campaigns_owner_update  — migración 021_campaigns_coupons_approval (canónico)
-- La función corría dos veces por cada UPDATE. Eliminamos el viejo y conservamos
-- el canónico. (tr_check_slots / validate_campaign_slots es OTRO trigger y se mantiene.)
DROP TRIGGER IF EXISTS trg_campaigns_guard ON public.ad_campaigns;
