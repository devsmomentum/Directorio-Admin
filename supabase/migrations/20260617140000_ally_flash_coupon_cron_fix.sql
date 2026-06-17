-- Fix: el cron deactivate_expired_flash_coupons (job 14) apagaba TODOS los cupones
-- flash de una tienda cuando `flash_coupon_plan IS NULL`. Las marcas aliadas NO
-- tienen flash_coupon_plan (su entitlement es is_ally + ally_flash_enabled), así que
-- el cron les desactivaba los cupones cada noche. Exentamos a los aliados con flash
-- habilitado de la cláusula de "addon ausente/vencido"; sus cupones siguen
-- desactivándose por end_date o stock agotado, igual que todos.
CREATE OR REPLACE FUNCTION public.deactivate_expired_flash_coupons()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n INTEGER;
BEGIN
  WITH upd AS (
    UPDATE public.coupons c
       SET is_active = false
      FROM public.stores s
     WHERE c.store_id  = s.id
       AND c.is_active = true
       AND (
              c.end_date         < NOW()
           OR c.amount_available <= 0
           OR (
                -- La pérdida de entitlement del addon NO aplica a un aliado con flash habilitado.
                NOT (COALESCE(s.is_ally, false) AND COALESCE(s.ally_flash_enabled, false))
                AND (
                     s.flash_coupon_plan IS NULL
                  OR (s.flash_coupon_expiry_date IS NOT NULL
                      AND s.flash_coupon_expiry_date < CURRENT_DATE)
                )
              )
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;
  RETURN v_n;
END $function$;
