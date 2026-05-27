-- ============================================================================
-- 017_cron_update_bcv_rate.sql
--
-- Programa la edge function `update-rate` para correr todos los días a las
-- 00:01 hora Caracas (UTC-4, sin DST) → 04:01 UTC.
--
-- ⚠️ REQUISITO PREVIO — sólo una vez por proyecto, ejecuta en el SQL Editor
--    de Supabase (con tus valores reales):
--
--     SELECT vault.create_secret(
--       'https://<PROJECT_REF>.supabase.co/functions/v1/update-rate',
--       'edge_update_rate_url'
--     );
--     SELECT vault.create_secret(
--       '<SERVICE_ROLE_KEY>',           -- desde Project Settings → API
--       'edge_update_rate_token'
--     );
--
--    Si ya existen y necesitas rotarlos:
--     SELECT vault.update_secret(id, '<nuevo>') FROM vault.secrets
--      WHERE name IN ('edge_update_rate_url','edge_update_rate_token');
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net   WITH SCHEMA extensions;

-- Reprogramación idempotente: si ya existe el job, lo borramos antes de crear.
DO $$
BEGIN
  PERFORM cron.unschedule('update-bcv-rate');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'update-bcv-rate',
  '1 4 * * *',   -- 04:01 UTC == 00:01 America/Caracas (UTC-4, sin DST)
  $$
  SELECT net.http_post(
    url     := (
                 SELECT decrypted_secret
                   FROM vault.decrypted_secrets
                  WHERE name = 'edge_update_rate_url'
                  LIMIT 1
               ),
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (
                   SELECT decrypted_secret
                     FROM vault.decrypted_secrets
                    WHERE name = 'edge_update_rate_token'
                    LIMIT 1
                 )
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Verificación rápida (no falla la migración, sólo informa)
DO $$
DECLARE
  v_job_id   bigint;
  v_schedule text;
BEGIN
  SELECT jobid, schedule INTO v_job_id, v_schedule
    FROM cron.job WHERE jobname = 'update-bcv-rate';
  IF v_job_id IS NULL THEN
    RAISE WARNING 'cron job "update-bcv-rate" no quedó registrado';
  ELSE
    RAISE NOTICE 'cron job "update-bcv-rate" registrado (id=%, schedule=%)', v_job_id, v_schedule;
  END IF;
END $$;
