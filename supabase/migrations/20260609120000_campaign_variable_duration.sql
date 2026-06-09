-- ============================================================================
-- Duración de campañas variable (por plan + por campaña) y loop por suma real
-- ----------------------------------------------------------------------------
-- Cambio de regla de producto: la duración del video deja de ser "siempre 15s".
-- Ahora cada campaña puede tener su propia duración (ad_campaigns.duration_seconds),
-- con un valor por defecto que viene del plan (plans.video_seconds), editable
-- desde el panel admin. La duración del loop = suma de las duraciones de las
-- campañas activas/vigentes, no slots × 15.
--
-- Reemplaza el límite fijo de 15s introducido en
-- 20260521120000_campaign_duration_limit.sql.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Relajar el CHECK de duration_seconds: 1..120s (coincide con el máximo del UI)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_duration_seconds_check;

ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_duration_seconds_check
  CHECK (duration_seconds IS NOT NULL AND duration_seconds BETWEEN 1 AND 120);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Recrear v_loop_status: la duración del loop ahora suma duration_seconds
--    real de cada campaña (antes asumía 15s por slot).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_loop_status AS
SELECT
  COUNT(*) FILTER (WHERE plan_type = 'DIAMANTE')           AS diamante_count,
  COUNT(*) FILTER (WHERE plan_type = 'ORO')                AS oro_count,
  COUNT(*) FILTER (
    WHERE plan_type IN ('PUBLI_PROMO','PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL')
  )                                                         AS publi_promo_count,
  COUNT(*)                                                  AS loop_slots_used,
  COALESCE(SUM(duration_seconds), 0)                        AS loop_duration_seconds
FROM public.ad_campaigns
WHERE is_active = true
  AND (end_date IS NULL OR end_date >= CURRENT_DATE)
  AND plan_type IN (
    'DIAMANTE','ORO','PUBLI_PROMO',
    'PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL'
  );

COMMENT ON VIEW public.v_loop_status IS
  'Estado del loop publicitario: marcas activas y duración real del loop (suma de duration_seconds por campaña).';
