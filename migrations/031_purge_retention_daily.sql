-- =====================================================================
-- 031 · Retención diaria de analytics crudos (1 día)
-- =====================================================================
-- Cambio: el cron 'purge-raw-analytics' pasa a retención de 1 día.
-- Aplica a las 4 tablas crudas que purga la función (coupon_events,
-- search_events, ad_impressions, analytics_events).
--
-- Por qué es seguro borrar tan agresivo:
--   La agregación al diario es ATÓMICA: cada fila cruda incrementa su
--   contador en ad_impressions_daily / *_daily_stats dentro de la MISMA
--   transacción del INSERT (ver RPC record_ad_impression en 026/027).
--   No hay un "job de agregación diaria" separado que deba correr antes:
--   la métrica ya está sumada en el instante en que se escribe la fila.
--   El agregado diario se conserva para siempre; la fila cruda solo es
--   buffer forense.
--
-- Orden garantizado: el cron corre a las 00:20 America/Caracas
-- (20 4 * * * UTC), ya pasada la medianoche, así que el día anterior
-- está cerrado y 100% agregado. GREATEST(p_retention_days, 1) hace que
-- el mínimo real sea 1 día, dejando un colchón de ~1 día.
--
-- Idempotente: cron.schedule con un jobname existente lo actualiza en
-- sitio. Horario sin cambios: 20 4 * * * UTC = 00:20 America/Caracas.
-- Sucede a la 031 previa (retención 5) y a 027 (retención 30).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SELECT cron.schedule(
  'purge-raw-analytics',
  '20 4 * * *',
  $$ SELECT public.purge_raw_analytics(1); $$
);

DO $$
DECLARE v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'purge-raw-analytics';
  IF v_cmd IS NULL THEN
    RAISE WARNING 'cron "purge-raw-analytics" no existe; corré 027 + 028 primero';
  ELSIF v_cmd NOT LIKE '%purge_raw_analytics(1)%' THEN
    RAISE WARNING 'cron "purge-raw-analytics" no quedó en retención 1: %', v_cmd;
  ELSE
    RAISE NOTICE 'cron "purge-raw-analytics" reprogramado a retención diaria (1 día)';
  END IF;
END $$;
