-- ============================================================================
-- 026_cron_whatsapp_expiry_reminders.sql
--
-- Recordatorios por WhatsApp al cliente cuando el plan de su tienda
-- (stores.contract_expiry_date) está por vencer en T-5, T-3, T-1 y T-0 días.
-- Complementa la migración 025 (correo); lógica idéntica, canal distinto.
--
-- Componentes:
--   1. Tabla `plan_whatsapp_reminders_log` para idempotencia (una fila por
--      store + days_remaining + sent_date).
--   2. RPC `enqueue_whatsapp_expiry_reminders()` que resuelve los candidatos
--      con teléfono y descarta los ya notificados hoy.
--   3. pg_cron job que dispara la edge function
--      `send-whatsapp-expiry-reminders` vía `net.http_post`.
--
-- ⚠️ REQUISITO PREVIO — una sola vez por proyecto:
--
--     SELECT vault.create_secret(
--       'https://<PROJECT_REF>.supabase.co/functions/v1/send-whatsapp-expiry-reminders',
--       'edge_wa_expiry_url'
--     );
--     SELECT vault.create_secret(
--       '<CRON_SECRET>',
--       'edge_wa_expiry_cron_secret'
--     );
--
--   Secrets adicionales de la edge function (supabase secrets set …):
--     CRON_SECRET         → la misma cadena que en `edge_wa_expiry_cron_secret`
--     SUPERAPI_TOKEN      → API key de SuperAPI (WhatsApp)
--     SUPERAPI_CLIENT_ID  → (opcional) ID de cliente SuperAPI
--     SUPERAPI_URL        → (opcional) override de URL SuperAPI
--     PUBLIC_APP_URL      → base del portal cliente (ej. https://mallhub.morna.tech)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabla de log — idempotencia por (store_id, days_remaining, sent_date)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plan_whatsapp_reminders_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  days_remaining  smallint    NOT NULL CHECK (days_remaining IN (0, 1, 3, 5)),
  recipient_phone text        NOT NULL,
  expiry_date     date        NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  sent_date       date        GENERATED ALWAYS AS ((sent_at AT TIME ZONE 'America/Caracas')::date) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_whatsapp_reminders_log_uniq
  ON public.plan_whatsapp_reminders_log (store_id, days_remaining, sent_date);

CREATE INDEX IF NOT EXISTS plan_whatsapp_reminders_log_store_idx
  ON public.plan_whatsapp_reminders_log (store_id, sent_at DESC);

ALTER TABLE public.plan_whatsapp_reminders_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wa_expiry_reminders_log_service_role" ON public.plan_whatsapp_reminders_log;
CREATE POLICY "wa_expiry_reminders_log_service_role"
  ON public.plan_whatsapp_reminders_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RPC: resuelve los candidatos a notificar hoy vía WhatsApp
--
-- Para cada tienda con contract_expiry_date en {today, today+1, today+3,
-- today+5} buscamos el teléfono del cliente vinculado:
--   · users.telefono_personal  (fuente primaria)
--   · stores.contact_phone     (fallback)
-- Filtramos las (store, days_remaining) que ya tienen log hoy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enqueue_whatsapp_expiry_reminders()
RETURNS TABLE (
  store_id              uuid,
  store_name            text,
  plan_type             text,
  contract_expiry_date  date,
  days_remaining        smallint,
  recipient_phone       text,
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
    SELECT s.id                                                    AS store_id,
           s.name::text                                            AS store_name,
           s.plan_type::text                                       AS plan_type,
           s.contract_expiry_date                                  AS contract_expiry_date,
           (s.contract_expiry_date - v_today)::smallint            AS days_remaining,
           s.contact_phone::text                                   AS store_contact_phone
      FROM public.stores s
     WHERE s.contract_expiry_date IS NOT NULL
       AND (s.contract_expiry_date - v_today) IN (0, 1, 3, 5)
  ),
  with_user AS (
    SELECT t.*,
           u.telefono_personal::text AS user_phone,
           u.full_name::text         AS user_name
      FROM targets t
      LEFT JOIN public.user_stores us ON us.store_id = t.store_id
      LEFT JOIN public.users       u  ON u.id        = us.user_id
  )
  SELECT w.store_id,
         w.store_name,
         w.plan_type,
         w.contract_expiry_date,
         w.days_remaining,
         COALESCE(NULLIF(w.user_phone, ''), w.store_contact_phone)::text AS recipient_phone,
         w.user_name                                                      AS recipient_name
    FROM with_user w
   WHERE COALESCE(NULLIF(w.user_phone, ''), w.store_contact_phone) IS NOT NULL
     AND NOT EXISTS (
           SELECT 1
             FROM public.plan_whatsapp_reminders_log l
            WHERE l.store_id       = w.store_id
              AND l.days_remaining = w.days_remaining
              AND l.sent_date      = v_today
         );
END $$;

GRANT EXECUTE ON FUNCTION public.enqueue_whatsapp_expiry_reminders() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. pg_cron + pg_net
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $$
BEGIN
  PERFORM cron.unschedule('send-whatsapp-expiry-reminders');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 13:30 UTC == 09:30 America/Caracas (UTC-4). 30 min después del correo para
-- no saturar al cliente con ambos canales simultáneamente.
SELECT cron.schedule(
  'send-whatsapp-expiry-reminders',
  '30 13 * * *',
  $cron$
  SELECT net.http_post(
    url     := (
                 SELECT decrypted_secret
                   FROM vault.decrypted_secrets
                  WHERE name = 'edge_wa_expiry_url'
                  LIMIT 1
               ),
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'x-cron-secret',  (
                   SELECT decrypted_secret
                     FROM vault.decrypted_secrets
                    WHERE name = 'edge_wa_expiry_cron_secret'
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
    FROM cron.job WHERE jobname = 'send-whatsapp-expiry-reminders';
  IF v_job_id IS NULL THEN
    RAISE WARNING 'cron job "send-whatsapp-expiry-reminders" no quedó registrado';
  ELSE
    RAISE NOTICE 'cron job "send-whatsapp-expiry-reminders" registrado (id=%, schedule=%)', v_job_id, v_schedule;
  END IF;
END $$;
