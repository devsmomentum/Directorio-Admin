-- ============================================================================
-- Fix: apply_kill_switch() debe nulificar stores.plan_type al vencer el contrato
-- ----------------------------------------------------------------------------
-- Problema:
--   apply_kill_switch() tenía 4 definiciones en el repo (CREATE OR REPLACE →
--   gana la última que corre en la BD). La nulificación de plan_type solo vivía
--   en 20260529120000_active_ads_live_expire_plan.sql, pero campaigns_cronjobs.sql
--   (el archivo manual que agenda el cron 'kill-switch-nightly') define una
--   versión SIN nulificar. Al re-correr ese archivo en el SQL Editor, la función
--   volvía a la versión que no toca plan_type → el plan nunca pasaba a NULL.
--
-- Esta migración deja una única versión correcta y autoritativa, e incorpora
-- explícitamente la condición "y no tiene planificado otro contrato": no se
-- nulifica una tienda que tiene una solicitud aprobada a punto de activarse
-- (elimina además la carrera con activate_scheduled_plans(), que corre en el
--  mismo minuto como job de pg_cron independiente).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_kill_switch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_cnt integer := 0;
  batch_cnt   integer := 0;
BEGIN
  -- Desactivar campañas vinculadas a plan de tienda vencido o con end_date pasado
  UPDATE public.ad_campaigns c
  SET    is_active = false
  FROM   public.stores s
  WHERE  c.store_id = s.id
    AND  c.is_active = true
    AND ( (c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE)
       OR (s.contract_expiry_date IS NOT NULL AND s.contract_expiry_date < CURRENT_DATE) );

  GET DIAGNOSTICS batch_cnt = ROW_COUNT;
  updated_cnt := updated_cnt + batch_cnt;

  -- Desactivar campañas sin tienda (admin) con end_date pasado
  UPDATE public.ad_campaigns
  SET    is_active = false
  WHERE  is_active = true
    AND  store_id IS NULL
    AND  end_date IS NOT NULL
    AND  end_date < CURRENT_DATE;

  GET DIAGNOSTICS batch_cnt = ROW_COUNT;
  updated_cnt := updated_cnt + batch_cnt;

  -- Nulificar plan_type en tiendas con contrato vencido para que Flutter no
  -- muestre el plan como activo, PERO solo si la tienda no tiene "planificado
  -- otro contrato": una solicitud aprobada (no flash) cuyo contrato siga vigente
  -- (expires_at >= hoy), ya sea el contrato actual aún sin sincronizar o uno
  -- futuro encadenado. activate_scheduled_plans() asignará el plan/vencimiento.
  -- Se usa expires_at (no effective_date) para no bloquear permanentemente la
  -- nulificación por solicitudes antiguas ya consumidas.
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

COMMENT ON FUNCTION public.apply_kill_switch() IS
  'Kill-switch nocturno: desactiva campañas vencidas y nulifica stores.plan_type '
  'en contratos vencidos sin activación agendada pendiente. Definición autoritativa '
  '(ver 20260603120000). No re-correr campaigns_cronjobs.sql sin esta lógica.';
