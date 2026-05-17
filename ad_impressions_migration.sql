-- =====================================================================
-- Módulo: Ad Impressions (separación de analytics_events)
-- Objetivo: tabla dedicada + RPC unificada + vista agregada
-- =====================================================================

-- ── 1. Tabla principal (append-only, alto volumen) ───────────────────
CREATE TABLE IF NOT EXISTS public.ad_impressions (
  id            BIGSERIAL PRIMARY KEY,
  campaign_id   UUID NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  kiosk_id      TEXT NOT NULL,
  slot_position INT,
  duration_ms   INT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_impressions_campaign_time
  ON public.ad_impressions (campaign_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_kiosk_time
  ON public.ad_impressions (kiosk_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_date
  ON public.ad_impressions (occurred_at DESC);

ALTER TABLE public.ad_impressions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'ad_impressions'
      AND policyname = 'auth_read_ad_impressions'
  ) THEN
    CREATE POLICY "auth_read_ad_impressions"
      ON public.ad_impressions
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- ── 2. Agregado diario (pre-calculado para dashboards) ───────────────
CREATE TABLE IF NOT EXISTS public.ad_impressions_daily (
  campaign_id UUID NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  kiosk_id    TEXT NOT NULL,
  day         DATE NOT NULL,
  count       INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, kiosk_id, day)
);

CREATE INDEX IF NOT EXISTS idx_ad_impressions_daily_day
  ON public.ad_impressions_daily (day DESC);

ALTER TABLE public.ad_impressions_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'ad_impressions_daily'
      AND policyname = 'auth_read_ad_impressions_daily'
  ) THEN
    CREATE POLICY "auth_read_ad_impressions_daily"
      ON public.ad_impressions_daily
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- ── 3. RPC unificada para insertar una impresión ─────────────────────
-- Política: el K2 (kiosko) es la fuente de verdad. Si reportó que reprodujo
-- el video, lo registramos siempre. El filtro de qué reproducir (campañas
-- pausadas / vencidas / impagas) lo aplica el cliente al armar el loop.
-- La RPC solo valida que el campaign_id exista (FK ya lo garantiza)
-- y que el kiosk_id no esté vacío.
CREATE OR REPLACE FUNCTION public.record_ad_impression(
  p_campaign_id   UUID,
  p_kiosk_id      TEXT,
  p_slot_position INT         DEFAULT NULL,
  p_duration_ms   INT         DEFAULT NULL,
  p_occurred_at   TIMESTAMPTZ DEFAULT now()
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id  BIGINT;
  v_day DATE := p_occurred_at::date;
BEGIN
  IF p_campaign_id IS NULL OR p_kiosk_id IS NULL OR p_kiosk_id = '' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.ad_impressions
    (campaign_id, kiosk_id, slot_position, duration_ms, occurred_at)
  VALUES
    (p_campaign_id, p_kiosk_id, p_slot_position, p_duration_ms, p_occurred_at)
  RETURNING id INTO v_id;

  INSERT INTO public.ad_impressions_daily (campaign_id, kiosk_id, day, count)
  VALUES (p_campaign_id, p_kiosk_id, v_day, 1)
  ON CONFLICT (campaign_id, kiosk_id, day)
  DO UPDATE SET count = public.ad_impressions_daily.count + 1;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ad_impression(UUID, TEXT, INT, INT, TIMESTAMPTZ)
  TO anon, authenticated;

-- ── 4. RPC batch (para flush offline desde el kiosko) ────────────────
-- Acepta JSONB array: [{campaign_id, kiosk_id, slot_position?, duration_ms?, occurred_at?}, ...]
-- Retorna cuántas se insertaron efectivamente (puede ser menor si alguna falla validación).
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

-- ── 5. Vista de lectura unificada para el dashboard ──────────────────
CREATE OR REPLACE VIEW public.v_campaign_impressions AS
SELECT
  c.id          AS campaign_id,
  c.brand_name,
  c.start_date,
  c.end_date,
  c.is_active,
  c.payment_status,
  COALESCE(SUM(d.count) FILTER (WHERE d.day = CURRENT_DATE), 0)::INT      AS today,
  COALESCE(SUM(d.count) FILTER (WHERE d.day >= CURRENT_DATE - 6), 0)::INT AS last_7d,
  COALESCE(SUM(d.count) FILTER (WHERE d.day >= CURRENT_DATE - 29), 0)::INT AS last_30d,
  COALESCE(SUM(d.count), 0)::INT AS total
FROM public.ad_campaigns c
LEFT JOIN public.ad_impressions_daily d ON d.campaign_id = c.id
GROUP BY c.id;

GRANT SELECT ON public.v_campaign_impressions TO authenticated;

-- Vista por kiosko (para detalle/heatmap por pantalla)
CREATE OR REPLACE VIEW public.v_campaign_impressions_by_kiosk AS
SELECT
  d.campaign_id,
  d.kiosk_id,
  d.day,
  d.count
FROM public.ad_impressions_daily d;

GRANT SELECT ON public.v_campaign_impressions_by_kiosk TO authenticated;

-- ── 6. Backfill desde analytics_events legacy (idempotente) ──────────
-- Migra eventos de impresión históricos a la nueva tabla.
-- Se puede correr varias veces; ON CONFLICT evita duplicados en el agregado.
DO $$
DECLARE v_migrated INT;
BEGIN
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
    WHERE e.event_type IN ('ad_impression', 'video_impression')
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
    RETURNING campaign_id, kiosk_id, occurred_at
  )
  SELECT COUNT(*) INTO v_migrated FROM inserted;

  RAISE NOTICE 'ad_impressions backfill: % filas migradas', v_migrated;
END $$;

-- Reconstruir agregado diario desde la tabla bruta (idempotente)
TRUNCATE public.ad_impressions_daily;
INSERT INTO public.ad_impressions_daily (campaign_id, kiosk_id, day, count)
SELECT campaign_id, kiosk_id, occurred_at::date, COUNT(*)
FROM public.ad_impressions
GROUP BY campaign_id, kiosk_id, occurred_at::date;
