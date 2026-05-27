-- ============================================================================
-- 020_cron_deactivate_expired_coupons.sql
--
-- RPC + pg_cron job que desactiva cupones cuya tienda perdió el addon Flash
-- Coupon (cancelado o expirado) y, de paso, cupones cuyo end_date ya pasó o
-- que se quedaron sin stock. is_active=false → soft-delete que preserva
-- historial (coupon_leads sigue resolviendo FK).
--
-- ⚠️ REQUISITO PREVIO — sólo una vez por proyecto, ejecuta en el SQL Editor
--    de Supabase (con tus valores reales):
--
--     SELECT vault.create_secret(
--       'https://<PROJECT_REF>.supabase.co/functions/v1/deactivate-expired-coupons',
--       'edge_deactivate_coupons_url'
--     );
--     SELECT vault.create_secret(
--       '<SERVICE_ROLE_KEY>',           -- desde Project Settings → API
--       'edge_deactivate_coupons_token'
--     );
--
--    Si ya existen y necesitas rotarlos:
--     SELECT vault.update_secret(id, '<nuevo>') FROM vault.secrets
--      WHERE name IN ('edge_deactivate_coupons_url','edge_deactivate_coupons_token');
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. RPC de desactivación
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.deactivate_expired_flash_coupons()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
              s.flash_coupon_plan IS NULL
           OR (s.flash_coupon_expiry_date IS NOT NULL
               AND s.flash_coupon_expiry_date < CURRENT_DATE)
           OR c.end_date         < NOW()
           OR c.amount_available <= 0
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;
  RETURN v_n;
END $$;

GRANT EXECUTE ON FUNCTION public.deactivate_expired_flash_coupons() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. pg_cron + pg_net (idempotente; mismo patrón que 017_cron_update_bcv_rate)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $$
BEGIN
  PERFORM cron.unschedule('deactivate-expired-coupons');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 04:05 UTC == 00:05 America/Caracas (UTC-4). Va 4 minutos después del job
-- de actualización de tasa BCV (04:01) para no chocar y dejarle margen.
SELECT cron.schedule(
  'deactivate-expired-coupons',
  '5 4 * * *',
  $$
  SELECT net.http_post(
    url     := (
                 SELECT decrypted_secret
                   FROM vault.decrypted_secrets
                  WHERE name = 'edge_deactivate_coupons_url'
                  LIMIT 1
               ),
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (
                   SELECT decrypted_secret
                     FROM vault.decrypted_secrets
                    WHERE name = 'edge_deactivate_coupons_token'
                    LIMIT 1
                 )
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Verificación (no falla la migración, sólo informa)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_job_id   bigint;
  v_schedule text;
BEGIN
  SELECT jobid, schedule INTO v_job_id, v_schedule
    FROM cron.job WHERE jobname = 'deactivate-expired-coupons';
  IF v_job_id IS NULL THEN
    RAISE WARNING 'cron job "deactivate-expired-coupons" no quedó registrado';
  ELSE
    RAISE NOTICE 'cron job "deactivate-expired-coupons" registrado (id=%, schedule=%)', v_job_id, v_schedule;
  END IF;
END $$;
