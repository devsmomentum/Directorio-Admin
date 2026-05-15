-- ============================================================
-- Cronjobs: desactivar campañas vencidas + notificar por vencer
-- Smart Kill-Switch con payment_status (Fase 2)
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;  -- necesario para llamar Edge Functions vía HTTP

-- ── Fase 2: nuevas columnas en ad_campaigns ─────────────────────────────────
ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'overdue')),
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

-- ── Fase 1: nuevas columnas en stores ───────────────────────────────────────
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS cedula_url TEXT;

-- El plan PROMO_FLASH no estaba en el CHECK original; lo agregamos:
ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_plan_type_check;
ALTER TABLE public.stores
  ADD CONSTRAINT stores_plan_type_check
    CHECK (plan_type = ANY (ARRAY[
      'DIAMANTE'::text,
      'ORO'::text,
      'IA_PERFORMANCE'::text,
      'PROMO_FLASH'::text
    ]));

-- Tabla de notificaciones para el panel admin
CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'info',
  title text,
  message text,
  metadata jsonb,
  unique_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'admin_notifications'
      AND policyname = 'auth_full_admin_notifications'
  ) THEN
    CREATE POLICY "auth_full_admin_notifications"
      ON public.admin_notifications
      FOR ALL TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

-- Funcion: desactivar campañas vencidas (versión original — solo is_active)
-- DEPRECADA: reemplazada por apply_kill_switch() que maneja payment_status
CREATE OR REPLACE FUNCTION public.deactivate_expired_campaigns()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer := 0;
BEGIN
  UPDATE public.ad_campaigns
  SET is_active = false
  WHERE is_active = true
    AND end_date IS NOT NULL
    AND end_date::date < CURRENT_DATE;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- ── Smart Kill-Switch con payment_status (Fase 2) ───────────────────────────
-- Aplica el corte de impago: marca payment_status='overdue' + crea notificación
-- Esta función es el respaldo DB-level si la Edge Function no está disponible.
CREATE OR REPLACE FUNCTION public.apply_kill_switch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec         RECORD;
  updated_cnt integer := 0;
  today_str   text    := to_char(CURRENT_DATE, 'YYYY-MM-DD');
BEGIN
  FOR rec IN
    SELECT c.id, c.brand_name, c.end_date, s.name AS store_name
    FROM   public.ad_campaigns c
    LEFT JOIN public.stores s ON s.id = c.store_id
    WHERE  c.is_active = true
      AND  c.end_date IS NOT NULL
      AND  c.end_date < CURRENT_DATE
      AND  COALESCE(c.payment_status, 'pending') != 'paid'
  LOOP
    -- Aplicar corte
    UPDATE public.ad_campaigns
    SET    is_active      = false,
           payment_status = 'overdue',
           suspended_at   = now()
    WHERE  id = rec.id;

    -- Notificación en el panel admin (unique_key evita duplicados)
    INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
    VALUES (
      'error',
      'Campaña suspendida por impago',
      '"' || rec.brand_name || '"' ||
        CASE WHEN rec.store_name IS NOT NULL
             THEN ' (' || rec.store_name || ')'
             ELSE '' END ||
        ' fue suspendida. Venció el ' || to_char(rec.end_date, 'DD/MM/YYYY') || ' sin pago.',
      jsonb_build_object(
        'campaign_id', rec.id,
        'store_name',  rec.store_name,
        'end_date',    rec.end_date
      ),
      'kill_switch_' || rec.id::text || '_' || today_str
    )
    ON CONFLICT (unique_key) DO NOTHING;

    updated_cnt := updated_cnt + 1;
  END LOOP;

  RETURN updated_cnt;
END;
$$;

-- Funcion: notificar campañas que vencen en 3 dias o menos
CREATE OR REPLACE FUNCTION public.notify_campaigns_expiring()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count integer := 0;
BEGIN
  INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
  SELECT
    'warning' AS type,
    'Campana por vencer' AS title,
    'La campana "' || c.brand_name || '" vence el ' || to_char(c.end_date, 'YYYY-MM-DD') || '.' AS message,
    jsonb_build_object('campaign_id', c.id, 'end_date', c.end_date) AS metadata,
    'campaign_expiring_' || c.id || '_' || to_char(c.end_date, 'YYYYMMDD') AS unique_key
  FROM public.ad_campaigns c
  WHERE c.is_active = true
    AND c.end_date IS NOT NULL
    AND c.end_date >= CURRENT_DATE
    AND c.end_date <= CURRENT_DATE + INTERVAL '3 days'
  ON CONFLICT (unique_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ── Cron Schedules ──────────────────────────────────────────────────────────
-- NOTA: pg_cron usa UTC. Venezuela = UTC-4.
--   00:05 VET = 04:05 UTC → '5 4 * * *'
--   12:00 VET = 16:00 UTC → '0 16 * * *'

-- Eliminar jobs anteriores si existen (para re-ejecutar este script limpio)
SELECT cron.unschedule('deactivate_expired_campaigns') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'deactivate_expired_campaigns'
);
SELECT cron.unschedule('notify_campaigns_expiring') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'notify_campaigns_expiring'
);
SELECT cron.unschedule('kill-switch-nightly') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'kill-switch-nightly'
);

-- ── OPCIÓN A: Kill-Switch via Edge Function (requiere pg_net + URL de tu proyecto)
-- Reemplaza YOUR_PROJECT_REF y YOUR_CRON_SECRET con los valores reales.
-- Descomenta este bloque si tienes la Edge Function desplegada.
/*
SELECT cron.schedule(
  'kill-switch-nightly',
  '5 4 * * *',   -- 00:05 VET
  $$
  SELECT net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/kill-switch',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', 'YOUR_CRON_SECRET'
    ),
    body    := '{}'::jsonb
  );
  $$
);
*/

-- ── OPCIÓN B: Kill-Switch directo en DB (sin Edge Function, activo por defecto)
SELECT cron.schedule(
  'kill-switch-nightly',
  '5 4 * * *',   -- 00:05 VET
  $$SELECT public.apply_kill_switch();$$
);

-- Notificar campañas por vencer: 12:00 PM VET
SELECT cron.schedule(
  'notify_campaigns_expiring',
  '0 16 * * *',  -- 12:00 VET
  $$SELECT public.notify_campaigns_expiring();$$
);

-- Verificar jobs activos
SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;
