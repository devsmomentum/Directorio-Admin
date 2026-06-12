-- ============================================================================
-- 035_cron_deactivate_coupons_direct_rpc.sql
--
-- El cron 'deactivate-expired-coupons' (migración 020) llamaba a la edge
-- function vía net.http_post() usando dos secrets del vault
-- (edge_deactivate_coupons_url / edge_deactivate_coupons_token) que NUNCA se
-- crearon — había que hacerlo a mano y nadie lo hizo. Resultado: el job FALLABA
-- a diario con `null value in column "url"` y los cupones vencidos jamás se
-- desactivaban.
--
-- El edge function solo autenticaba y llamaba al RPC. El cron ya corre dentro de
-- la BD con privilegios, así que lo llamamos DIRECTO (igual que kill-switch /
-- apply_kill_switch). Sin HTTP, sin secrets, sin edge: imposible que falle por
-- configuración faltante. El edge function queda disponible para invocación
-- manual/externa, pero el cron ya no depende de él.
-- ============================================================================

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'deactivate-expired-coupons';
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(v_job_id, command => 'SELECT public.deactivate_expired_flash_coupons();');
  ELSE
    PERFORM cron.schedule(
      'deactivate-expired-coupons',
      '5 4 * * *',
      'SELECT public.deactivate_expired_flash_coupons();'
    );
  END IF;
END $$;
