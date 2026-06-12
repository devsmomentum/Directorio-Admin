-- =====================================================================
-- Migración 034: métricas de facturación por tiempo de visualización
-- =====================================================================
-- Contexto (reglas de negocio del salvapantallas del kiosco, slots ~15 s):
--   • < 5 s vistos  → NINGUNA métrica (vista fantasma; el kiosco ni la envía).
--   • >= 5 s vistos → 1 impresión válida (impressions_valid).
--   • slot completo → 1 impresión válida + 1 visualización completa (full_views).
--
-- El K2 ahora SOLO envía eventos que ya son impresiones válidas, con el flag
-- `is_full_view` para distinguir las que además se vieron completas. Esta
-- migración:
--   1. agrega `is_full_view` a la tabla bruta `ad_impressions`,
--   2. agrega `impressions_valid` y `full_views` al agregado diario,
--   3. reescribe el RPC (y su batch) para sumar ambas métricas,
--   4. expone full views en la vista de dashboard,
--   5. hace backfill best-effort del histórico.
--
-- COMPATIBILIDAD: la columna legacy `count` se mantiene y se sigue
-- incrementando en paralelo (= impressions_valid) para no romper a los
-- consumidores que aún la leen (app/panel/tiendas, app/panel/analiticas).
-- =====================================================================

-- ── 1. Tabla bruta: marcar si la impresión fue vista completa ────────────
ALTER TABLE public.ad_impressions
  ADD COLUMN IF NOT EXISTS is_full_view BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Agregado diario: dos métricas separadas ──────────────────────────
ALTER TABLE public.ad_impressions_daily
  ADD COLUMN IF NOT EXISTS impressions_valid INT NOT NULL DEFAULT 0;
ALTER TABLE public.ad_impressions_daily
  ADD COLUMN IF NOT EXISTS full_views INT NOT NULL DEFAULT 0;

-- ── 3. RPC unificada (firma nueva con p_is_full_view) ────────────────────
-- La firma cambia (param extra), así que primero soltamos la versión previa.
DROP FUNCTION IF EXISTS public.record_ad_impression(UUID, TEXT, INT, INT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.record_ad_impression(
  p_campaign_id   UUID,
  p_kiosk_id      TEXT,
  p_slot_position INT         DEFAULT NULL,
  p_duration_ms   INT         DEFAULT NULL,
  p_is_full_view  BOOLEAN     DEFAULT false,
  p_occurred_at   TIMESTAMPTZ DEFAULT now()
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id        BIGINT;
  v_local_ts  TIMESTAMP := (p_occurred_at AT TIME ZONE 'America/Caracas');
  v_local_hr  INT       := EXTRACT(HOUR FROM v_local_ts)::INT;
  v_day       DATE      := v_local_ts::date;
  v_full      INT       := CASE WHEN p_is_full_view THEN 1 ELSE 0 END;
BEGIN
  IF p_campaign_id IS NULL OR p_kiosk_id IS NULL OR p_kiosk_id = '' THEN
    RETURN NULL;
  END IF;

  -- Ventana operativa del CC: 10:00-20:59 (cierre 21:00 exclusivo).
  IF v_local_hr < 10 OR v_local_hr >= 21 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.ad_impressions
    (campaign_id, kiosk_id, slot_position, duration_ms, is_full_view, occurred_at)
  VALUES
    (p_campaign_id, p_kiosk_id, p_slot_position, p_duration_ms, p_is_full_view, p_occurred_at)
  RETURNING id INTO v_id;

  -- Cada llamada YA representa una impresión válida (>= 5 s). full_views solo
  -- suma cuando el slot se vio completo. `count` legacy = impressions_valid.
  INSERT INTO public.ad_impressions_daily
    (campaign_id, kiosk_id, day, count, impressions_valid, full_views)
  VALUES
    (p_campaign_id, p_kiosk_id, v_day, 1, 1, v_full)
  ON CONFLICT (campaign_id, kiosk_id, day)
  DO UPDATE SET
    count             = public.ad_impressions_daily.count + 1,
    impressions_valid = public.ad_impressions_daily.impressions_valid + 1,
    full_views        = public.ad_impressions_daily.full_views + v_full;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.record_ad_impression(UUID, TEXT, INT, INT, BOOLEAN, TIMESTAMPTZ)
  TO anon, authenticated;

-- ── 4. RPC batch (flush offline) — pasa is_full_view ─────────────────────
-- Acepta: [{campaign_id, kiosk_id, slot_position?, duration_ms?, is_full_view?, occurred_at?}, ...]
-- Eventos viejos en cola sin `is_full_view` se interpretan como false.
CREATE OR REPLACE FUNCTION public.record_ad_impressions_batch(
  p_events JSONB
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event JSONB;
  v_inserted INT := 0;
  v_result BIGINT;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR v_event IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_result := public.record_ad_impression(
      (v_event->>'campaign_id')::UUID,
      v_event->>'kiosk_id',
      NULLIF(v_event->>'slot_position', '')::INT,
      NULLIF(v_event->>'duration_ms', '')::INT,
      COALESCE((v_event->>'is_full_view')::BOOLEAN, false),
      COALESCE(NULLIF(v_event->>'occurred_at', '')::TIMESTAMPTZ, now())
    );
    IF v_result IS NOT NULL THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ad_impressions_batch(JSONB)
  TO anon, authenticated;

-- ── 5. Vista de dashboard: añade visualizaciones completas ───────────────
-- Mantiene today/last_7d/last_30d/total (impresiones válidas; antes 'count')
-- y agrega los equivalentes de full views.
CREATE OR REPLACE VIEW public.v_campaign_impressions AS
SELECT
  c.id          AS campaign_id,
  c.brand_name,
  c.start_date,
  c.end_date,
  c.is_active,
  COALESCE(SUM(d.impressions_valid) FILTER (WHERE d.day = CURRENT_DATE), 0)::INT       AS today,
  COALESCE(SUM(d.impressions_valid) FILTER (WHERE d.day >= CURRENT_DATE - 6), 0)::INT  AS last_7d,
  COALESCE(SUM(d.impressions_valid) FILTER (WHERE d.day >= CURRENT_DATE - 29), 0)::INT AS last_30d,
  COALESCE(SUM(d.impressions_valid), 0)::INT AS total,
  COALESCE(SUM(d.full_views) FILTER (WHERE d.day = CURRENT_DATE), 0)::INT       AS full_views_today,
  COALESCE(SUM(d.full_views) FILTER (WHERE d.day >= CURRENT_DATE - 6), 0)::INT  AS full_views_7d,
  COALESCE(SUM(d.full_views) FILTER (WHERE d.day >= CURRENT_DATE - 29), 0)::INT AS full_views_30d,
  COALESCE(SUM(d.full_views), 0)::INT AS full_views_total
FROM public.ad_campaigns c
LEFT JOIN public.ad_impressions_daily d ON d.campaign_id = c.id
GROUP BY c.id;

GRANT SELECT ON public.v_campaign_impressions TO authenticated;

-- Vista por kiosko: expone también las dos métricas.
CREATE OR REPLACE VIEW public.v_campaign_impressions_by_kiosk AS
SELECT
  d.campaign_id,
  d.kiosk_id,
  d.day,
  d.count,
  d.impressions_valid,
  d.full_views
FROM public.ad_impressions_daily d;

GRANT SELECT ON public.v_campaign_impressions_by_kiosk TO authenticated;

-- ── 6. Backfill histórico (idempotente) ──────────────────────────────────
-- Histórico: el modelo viejo contaba `count` al ARRANCAR el slot (incluía
-- vistas < 5 s). No hay forma de reconstruir cuáles fueron válidas o completas,
-- así que como mejor aproximación tratamos el histórico como impresiones
-- válidas (impressions_valid = count) y full_views = 0. Solo toca filas aún
-- sin migrar para poder re-ejecutar sin doble conteo.
UPDATE public.ad_impressions_daily
   SET impressions_valid = count
 WHERE impressions_valid = 0
   AND count > 0;
