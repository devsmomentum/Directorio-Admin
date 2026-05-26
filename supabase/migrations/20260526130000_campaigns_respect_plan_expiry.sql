-- ============================================================================
-- Las campañas dependen del plan de su tienda
-- ----------------------------------------------------------------------------
-- Modelo: los pagos son a nivel plan/tienda (stores.contract_expiry_date).
-- Una campaña no debe mostrarse ni quedar activa si:
--   · su end_date ya pasó, O
--   · el plan de su tienda venció (contract_expiry_date < hoy).
--
-- Pasos:
--   1. Vista kiosk_active_campaigns filtra por contract_expiry_date
--   2. Vista v_loop_status filtra por contract_expiry_date
--   3. apply_kill_switch() desactiva campañas por end_date O plan vencido,
--      sin generar notificación por campaña (solo registra el conteo)
--   4. Eliminar notify_campaigns_expiring() y su cron (las alertas ahora son
--      a nivel plan/tienda)
--   5. Crear notify_expired_plans() + cron diario (alerta de planes vencidos)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. kiosk_active_campaigns: solo si el plan de la tienda está vigente
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.kiosk_active_campaigns AS
SELECT
  k.id   AS kiosk_id,
  k.name AS kiosk_name,
  c.id   AS campaign_id,
  c.brand_name,
  c.plan_type,
  c.media_url,
  c.media_type,
  c.duration_seconds,
  c.priority_level,
  c.target_frequency_seconds,
  c.slot_limit_group
FROM kiosks k
CROSS JOIN ad_campaigns c
LEFT JOIN stores s ON s.id = c.store_id
WHERE c.is_active = true
  AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
  AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE)
  AND (s.id IS NULL
       OR s.contract_expiry_date IS NULL
       OR s.contract_expiry_date >= CURRENT_DATE)
  AND NOT EXISTS (
    SELECT 1 FROM kiosk_campaigns kc WHERE kc.kiosk_id = k.id
  )

UNION ALL

SELECT
  k.id   AS kiosk_id,
  k.name AS kiosk_name,
  c.id   AS campaign_id,
  c.brand_name,
  c.plan_type,
  c.media_url,
  c.media_type,
  c.duration_seconds,
  c.priority_level,
  c.target_frequency_seconds,
  c.slot_limit_group
FROM kiosks k
JOIN kiosk_campaigns kc ON kc.kiosk_id = k.id
JOIN ad_campaigns    c  ON c.id = kc.campaign_id
LEFT JOIN stores     s  ON s.id = c.store_id
WHERE c.is_active = true
  AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
  AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE)
  AND (s.id IS NULL
       OR s.contract_expiry_date IS NULL
       OR s.contract_expiry_date >= CURRENT_DATE);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. v_loop_status: solo cuenta campañas cuyo plan-tienda esté vigente
-- ─────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.v_loop_status;
CREATE VIEW public.v_loop_status AS
SELECT
  COUNT(*) FILTER (WHERE c.plan_type = 'DIAMANTE')           AS diamante_count,
  COUNT(*) FILTER (WHERE c.plan_type = 'ORO')                AS oro_count,
  COUNT(*) FILTER (
    WHERE c.plan_type IN ('PUBLI_PROMO','PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL')
  )                                                           AS publi_promo_count,
  COUNT(*)                                                    AS loop_slots_used,
  COUNT(*) * 15                                               AS loop_duration_seconds
FROM public.ad_campaigns c
LEFT JOIN public.stores s ON s.id = c.store_id
WHERE c.is_active = true
  AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)
  AND (s.id IS NULL
       OR s.contract_expiry_date IS NULL
       OR s.contract_expiry_date >= CURRENT_DATE)
  AND c.plan_type IN (
    'DIAMANTE','ORO','PUBLI_PROMO',
    'PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL'
  );

COMMENT ON VIEW public.v_loop_status IS
  'Estado del loop publicitario: cuántas marcas activas vigentes hay y duración (15s por slot).';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. apply_kill_switch(): desactiva por end_date OR plan vencido, sin notif
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- También desactivar campañas sin store_id (admin) que ya vencieron
  UPDATE public.ad_campaigns
  SET    is_active = false
  WHERE  is_active = true
    AND  store_id IS NULL
    AND  end_date IS NOT NULL
    AND  end_date < CURRENT_DATE;

  GET DIAGNOSTICS batch_cnt = ROW_COUNT;
  updated_cnt := updated_cnt + batch_cnt;

  RETURN updated_cnt;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Eliminar notify_campaigns_expiring() y su cron
-- ─────────────────────────────────────────────────────────────────────────────

SELECT cron.unschedule('notify_campaigns_expiring') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'notify_campaigns_expiring'
);

DROP FUNCTION IF EXISTS public.notify_campaigns_expiring();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. notify_expired_plans(): alerta diaria de tiendas con plan vencido
-- ─────────────────────────────────────────────────────────────────────────────

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


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Cron diario para notify_expired_plans (08:00 VET = 12:00 UTC)
-- ─────────────────────────────────────────────────────────────────────────────

SELECT cron.unschedule('notify_expired_plans') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'notify_expired_plans'
);

SELECT cron.schedule(
  'notify_expired_plans',
  '0 12 * * *',   -- 08:00 VET
  $$SELECT public.notify_expired_plans();$$
);
