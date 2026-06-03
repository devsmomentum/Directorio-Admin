-- ============================================================
-- Cronjobs: kill switch + alerta de planes vencidos
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;  -- necesario para llamar Edge Functions vía HTTP

-- ── Plan PROMO_FLASH ────────────────────────────────────────────────────────
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS cedula_url TEXT;

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

-- ── Kill-Switch ─────────────────────────────────────────────────────────────
-- Desactiva una campaña si:
--   · su end_date ya pasó, O
--   · el plan de su tienda venció (contract_expiry_date < hoy)
-- Además nulifica stores.plan_type en contratos vencidos sin activación agendada
-- pendiente (la condición "y no tiene planificado otro contrato").
-- Los pagos viven a nivel plan/tienda (transactions); las notificaciones de
-- cobranza son por plan vencido (notify_expired_plans).
-- IMPORTANTE: esta definición debe quedar SINCRONIZADA con la migración
-- supabase/migrations/20260603120000_kill_switch_nullify_plan_fix.sql.
-- No remover el bloque de nulificación de plan_type al re-correr este archivo.
CREATE OR REPLACE FUNCTION public.apply_kill_switch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_cnt integer := 0;
  batch_cnt   integer := 0;
BEGIN
  UPDATE public.ad_campaigns c
  SET    is_active = false
  FROM   public.stores s
  WHERE  c.store_id = s.id
    AND  c.is_active = true
    AND ( (c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE)
       OR (s.contract_expiry_date IS NOT NULL AND s.contract_expiry_date < CURRENT_DATE) );

  GET DIAGNOSTICS batch_cnt = ROW_COUNT;
  updated_cnt := updated_cnt + batch_cnt;

  UPDATE public.ad_campaigns
  SET    is_active = false
  WHERE  is_active = true
    AND  store_id IS NULL
    AND  end_date IS NOT NULL
    AND  end_date < CURRENT_DATE;

  GET DIAGNOSTICS batch_cnt = ROW_COUNT;
  updated_cnt := updated_cnt + batch_cnt;

  -- Nulificar plan_type en tiendas con contrato vencido, salvo que tengan
  -- "planificado otro contrato": una solicitud aprobada (no flash) cuyo contrato
  -- siga vigente (expires_at >= hoy). Lo aplicará activate_scheduled_plans().
  UPDATE public.stores s
  SET    plan_type = NULL
  WHERE  s.contract_expiry_date IS NOT NULL
    AND  s.contract_expiry_date < CURRENT_DATE
    AND  s.plan_type IS NOT NULL
    AND  NOT EXISTS (
           SELECT 1
             FROM public.plan_requests pr
            WHERE pr.store_id   = s.id
              AND pr.status     = 'approved'
              AND pr.expires_at IS NOT NULL
              AND pr.expires_at >= CURRENT_DATE
              AND NOT public.is_flash_coupon_plan(pr.plan_key)
         );

  RETURN updated_cnt;
END;
$$;

-- ── notify_expired_plans: alerta diaria de planes ya vencidos ──────────────
CREATE OR REPLACE FUNCTION public.notify_expired_plans()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count integer := 0;
  today_str      text    := to_char(CURRENT_DATE, 'YYYY-MM-DD');
BEGIN
  INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
  SELECT
    'error' AS type,
    'Plan vencido sin renovar' AS title,
    'El plan de la tienda "' || s.name || '" venció el ' ||
      to_char(s.contract_expiry_date, 'DD/MM/YYYY') || '.' AS message,
    jsonb_build_object(
      'store_id',             s.id,
      'store_name',           s.name,
      'plan_type',            s.plan_type,
      'contract_expiry_date', s.contract_expiry_date
    ) AS metadata,
    'expired_plan_' || s.id::text || '_' || today_str AS unique_key
  FROM public.stores s
  WHERE s.contract_expiry_date IS NOT NULL
    AND s.contract_expiry_date < CURRENT_DATE
  ON CONFLICT (unique_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ── Cron Schedules ──────────────────────────────────────────────────────────
-- NOTA: pg_cron usa UTC. Venezuela = UTC-4.
--   00:05 VET = 04:05 UTC → '5 4 * * *'
--   08:00 VET = 12:00 UTC → '0 12 * * *'

SELECT cron.unschedule('deactivate_expired_campaigns') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'deactivate_expired_campaigns'
);
SELECT cron.unschedule('notify_campaigns_expiring') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'notify_campaigns_expiring'
);
SELECT cron.unschedule('kill-switch-nightly') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'kill-switch-nightly'
);
SELECT cron.unschedule('notify_expired_plans') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'notify_expired_plans'
);

SELECT cron.schedule(
  'kill-switch-nightly',
  '5 4 * * *',
  $$SELECT public.apply_kill_switch();$$
);

SELECT cron.schedule(
  'notify_expired_plans',
  '0 12 * * *',
  $$SELECT public.notify_expired_plans();$$
);

SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;
