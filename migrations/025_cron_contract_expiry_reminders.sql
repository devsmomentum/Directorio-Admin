-- ============================================================================
-- 025_cron_contract_expiry_reminders.sql
--
-- Recordatorios por correo al cliente cuando el plan de su tienda
-- (stores.contract_expiry_date) está por vencer en T-5, T-3, T-1 y T-0 días.
--
-- Componentes:
--   1. Tabla `plan_expiry_reminders_log` para idempotencia (una fila por
--      store + days_remaining + sent_date).
--   2. RPC `enqueue_contract_expiry_reminders()` que resuelve los candidatos
--      del día y descarta los ya notificados. Devuelve filas que la edge
--      function consume.
--   3. pg_cron job que dispara la edge function `send-contract-expiry-reminders`
--      vía `net.http_post`, autenticándose con `x-cron-secret`.
--
-- ⚠️ REQUISITO PREVIO — una sola vez por proyecto, ejecuta en el SQL Editor:
--
--     SELECT vault.create_secret(
--       'https://<PROJECT_REF>.supabase.co/functions/v1/send-contract-expiry-reminders',
--       'edge_contract_expiry_url'
--     );
--     SELECT vault.create_secret(
--       '<CRON_SECRET>',          -- el mismo valor que se setea con:
--                                 -- supabase secrets set CRON_SECRET=...
--       'edge_contract_expiry_cron_secret'
--     );
--
--    Para rotar:
--     SELECT vault.update_secret(id, '<nuevo>') FROM vault.secrets
--      WHERE name IN ('edge_contract_expiry_url','edge_contract_expiry_cron_secret');
--
--   Secrets adicionales que la edge function necesita (no van en Vault, van
--   en `supabase secrets set …`):
--     RESEND_API_KEY    → API key de Resend
--     RESEND_FROM       → remitente verificado (ej. "Millennium Mall <noreply@morna.tech>")
--     CRON_SECRET       → la misma cadena que en `edge_contract_expiry_cron_secret`
--     PUBLIC_APP_URL    → base del portal cliente (ej. https://mallhub.morna.tech)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabla de log — idempotencia por (store_id, days_remaining, sent_date)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plan_expiry_reminders_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  days_remaining  smallint    NOT NULL CHECK (days_remaining IN (0, 1, 3, 5)),
  recipient       text        NOT NULL,
  expiry_date     date        NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  sent_date       date        GENERATED ALWAYS AS ((sent_at AT TIME ZONE 'America/Caracas')::date) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_expiry_reminders_log_uniq
  ON public.plan_expiry_reminders_log (store_id, days_remaining, sent_date);

CREATE INDEX IF NOT EXISTS plan_expiry_reminders_log_store_idx
  ON public.plan_expiry_reminders_log (store_id, sent_at DESC);

ALTER TABLE public.plan_expiry_reminders_log ENABLE ROW LEVEL SECURITY;

-- Solo el service role puede leer/escribir esta tabla.
DROP POLICY IF EXISTS "expiry_reminders_log_service_role" ON public.plan_expiry_reminders_log;
CREATE POLICY "expiry_reminders_log_service_role"
  ON public.plan_expiry_reminders_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RPC: resuelve los candidatos a notificar hoy
--
-- Para cada tienda con contract_expiry_date en {today, today+1, today+3,
-- today+5} buscamos:
--   · el email del cliente vinculado (user_stores → users)
--   · fallback: stores.contact_email
-- Filtramos las (store, days_remaining) que ya tienen log hoy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enqueue_contract_expiry_reminders()
RETURNS TABLE (
  store_id              uuid,
  store_name            text,
  plan_type             text,
  contract_expiry_date  date,
  days_remaining        smallint,
  recipient_email       text,
  recipient_name        text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Caracas')::date;
BEGIN
  RETURN QUERY
  WITH targets AS (
    SELECT s.id                              AS store_id,
           s.name::text                      AS store_name,
           s.plan_type::text                 AS plan_type,
           s.contract_expiry_date            AS contract_expiry_date,
           (s.contract_expiry_date - v_today)::smallint AS days_remaining,
           s.contact_email::text             AS store_contact_email
      FROM public.stores s
     WHERE s.contract_expiry_date IS NOT NULL
       AND (s.contract_expiry_date - v_today) IN (0, 1, 3, 5)
  ),
  with_user AS (
    SELECT t.*,
           u.email::text     AS user_email,
           u.full_name::text AS user_name
      FROM targets t
      LEFT JOIN public.user_stores us ON us.store_id = t.store_id
      LEFT JOIN public.users       u  ON u.id        = us.user_id
  )
  SELECT w.store_id,
         w.store_name,
         w.plan_type,
         w.contract_expiry_date,
         w.days_remaining,
         COALESCE(NULLIF(w.user_email, ''), w.store_contact_email)::text AS recipient_email,
         w.user_name                                                      AS recipient_name
    FROM with_user w
   WHERE COALESCE(NULLIF(w.user_email, ''), w.store_contact_email) IS NOT NULL
     AND NOT EXISTS (
           SELECT 1
             FROM public.plan_expiry_reminders_log l
            WHERE l.store_id       = w.store_id
              AND l.days_remaining = w.days_remaining
              AND l.sent_date      = v_today
         );
END $$;

GRANT EXECUTE ON FUNCTION public.enqueue_contract_expiry_reminders() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. pg_cron + pg_net (mismo patrón que 017/020)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $$
BEGIN
  PERFORM cron.unschedule('send-contract-expiry-reminders');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 13:00 UTC == 09:00 America/Caracas (UTC-4). Hora razonable para que el
-- cliente reciba el correo a primera hora del día laboral.
SELECT cron.schedule(
  'send-contract-expiry-reminders',
  '0 13 * * *',
  $cron$
  SELECT net.http_post(
    url     := (
                 SELECT decrypted_secret
                   FROM vault.decrypted_secrets
                  WHERE name = 'edge_contract_expiry_url'
                  LIMIT 1
               ),
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'x-cron-secret',  (
                   SELECT decrypted_secret
                     FROM vault.decrypted_secrets
                    WHERE name = 'edge_contract_expiry_cron_secret'
                    LIMIT 1
                 )
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Verificación informativa
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_job_id   bigint;
  v_schedule text;
BEGIN
  SELECT jobid, schedule INTO v_job_id, v_schedule
    FROM cron.job WHERE jobname = 'send-contract-expiry-reminders';
  IF v_job_id IS NULL THEN
    RAISE WARNING 'cron job "send-contract-expiry-reminders" no quedó registrado';
  ELSE
    RAISE NOTICE 'cron job "send-contract-expiry-reminders" registrado (id=%, schedule=%)', v_job_id, v_schedule;
  END IF;
END $$;
