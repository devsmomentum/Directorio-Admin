-- ============================================================
-- Cronjobs: desactivar campañas vencidas + notificar por vencer
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

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

-- Funcion: desactivar campañas vencidas
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
    -- Usamos now() casted a fecha para asegurar consistencia
    -- O simplemente CURRENT_DATE si solo usas fechas sin hora
    AND end_date::date < CURRENT_DATE; 

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
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

-- Cronjobs (ajusta el horario si hace falta)
-- Desactivar campañas vencidas: 12:05 AM diario (hora de Venezuela)
SELECT cron.schedule(
  'deactivate_expired_campaigns',
  '5 0 * * *',
  $$SELECT public.deactivate_expired_campaigns();$$
);

-- Notificar campañas por vencer: 8:00 AM diario
SELECT cron.schedule(
  'notify_campaigns_expiring',
  '0 8 * * *',
  $$SELECT public.notify_campaigns_expiring();$$
);
