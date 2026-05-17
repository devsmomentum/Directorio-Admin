-- =====================================================================
-- Limpieza estricta de analytics_events
-- =====================================================================
-- Política definitiva:
--   analytics_events guarda SOLO interacciones de usuario:
--     • clicks          → event_type IN ('click','tap')
--     • búsquedas       → event_type IN ('filter','select')
--                         (filter = elige categoría / aplica búsqueda)
--                         (select = elige una tienda dada la búsqueda)
--     • navegaciones    → event_type IN ('navigate','navigation')
--     • flash coupons   → event_type = 'flash_coupon_shown'
--
-- Todo lo demás se considera contaminación y se elimina:
--   • video_impression  → debe estar en ad_impressions (esa tabla las
--                         guarda solo para campañas, sin mezcla)
--   • banner_impression → impresiones de banner: no se conservan
--   • bono_popup_shown / bono_popup_closed → telemetría UI
--   • view_modal → telemetría UI (dead code en el cliente)
--   • coupon_gallery_view → no es un flash coupon
--
-- IMPORTANTE: correr DESPUÉS de `ad_impressions_migration.sql`, que ya
-- migró los `video_impression` legítimos a la tabla `ad_impressions`.
-- =====================================================================

-- ── 1. Backfill defensivo de video_impression → ad_impressions ───────
-- (idempotente: si el migration ya los migró, este re-run es no-op)
WITH legacy AS (
  SELECT
    COALESCE(
      e.item_id,
      NULLIF(e.event_data->>'campaign_id','')::UUID,
      NULLIF(e.event_data->>'campaignId','')::UUID,
      NULLIF(e.event_data->>'ad_campaign_id','')::UUID
    ) AS campaign_id,
    e.kiosk_id,
    e.created_at
  FROM public.analytics_events e
  WHERE e.event_type IN ('video_impression', 'ad_impression')
),
inserted AS (
  INSERT INTO public.ad_impressions (campaign_id, kiosk_id, occurred_at)
  SELECT campaign_id, kiosk_id, created_at
  FROM legacy
  WHERE campaign_id IS NOT NULL
    AND kiosk_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.ad_campaigns c WHERE c.id = legacy.campaign_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.ad_impressions ai
      WHERE ai.campaign_id = legacy.campaign_id
        AND ai.kiosk_id    = legacy.kiosk_id
        AND ai.occurred_at = legacy.created_at
    )
  RETURNING 1
)
SELECT COUNT(*) AS impresiones_video_migradas FROM inserted;

-- Reconstruir agregado diario (idempotente)
TRUNCATE public.ad_impressions_daily;
INSERT INTO public.ad_impressions_daily (campaign_id, kiosk_id, day, count)
SELECT campaign_id, kiosk_id, occurred_at::date, COUNT(*)
FROM public.ad_impressions
GROUP BY campaign_id, kiosk_id, occurred_at::date;

-- ── 2. Preview de lo que se eliminará ────────────────────────────────
DO $$
DECLARE v_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.analytics_events
  WHERE event_type NOT IN (
    'click', 'tap',
    'filter', 'select',
    'navigate', 'navigation',
    'flash_coupon_shown'
  );

  RAISE NOTICE 'analytics_events: % fila(s) fuera del whitelist serán eliminadas.', v_count;
END $$;

-- ── 3. Snapshot opcional antes del DELETE ────────────────────────────
-- Descomentá si querés respaldo:
-- CREATE TABLE IF NOT EXISTS public.analytics_events_purged_backup AS
-- SELECT * FROM public.analytics_events
-- WHERE event_type NOT IN (
--   'click','tap','filter','select','navigate','navigation','flash_coupon_shown'
-- );

-- ── 4. DELETE estricto: conservar solo el whitelist ──────────────────
WITH deleted AS (
  DELETE FROM public.analytics_events
  WHERE event_type NOT IN (
    'click', 'tap',
    'filter', 'select',
    'navigate', 'navigation',
    'flash_coupon_shown'
  )
  RETURNING 1
)
SELECT COUNT(*) AS filas_eliminadas FROM deleted;

-- ── 5. Verificación: lo que quedó vivo ───────────────────────────────
SELECT
  module,
  event_type,
  COUNT(*) AS total,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM public.analytics_events
GROUP BY module, event_type
ORDER BY total DESC;
