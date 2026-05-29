-- ============================================================================
-- 028_interaction_daily_stats.sql
--
-- Cierra el último hueco de saturación: `analytics_events` (clicks, taps,
-- navigate, select, filter) era la única tabla cruda SIN agregado diario, por
-- lo que no se podía purgar sin perder métricas. Aquí:
--
--   1. Creamos `interaction_daily_stats` (agregado diario, PERSISTE).
--   2. Un TRIGGER sobre analytics_events suma cada evento al diario en el
--      instante en que se inserta (atómico). NO hay que tocar Flutter: el
--      `AnalyticsService().logEvent(...)` sigue insertando igual que hoy.
--   3. Backfill del histórico existente.
--   4. Redefinimos `purge_raw_analytics` (de 027) para que ADEMÁS borre
--      analytics_events vieja. Esta versión SUPERSEDE a la de 027.
--
-- Resultado: TODA tabla cruda (ad_impressions, coupon_events, search_events,
-- analytics_events) se purga; TODO agregado diario persiste.
--
-- Requisitos previos: 027_coupon_search_daily_stats.sql, cliente_portal_auth.sql.
-- Idempotente.
-- ============================================================================


-- ── 1. Agregado diario de interacciones (PERSISTE) ───────────────────────────
-- Granularidad: (día, kiosko, módulo, tipo de evento, item, tienda dueña).
--   • kiosk_id  = preserva el desglose por kiosko (heatmap / tráfico por kiosko
--                 / filtro por kiosko del panel admin).
--   • item_id   = entidad tocada (tienda / cupón / servicio) cuando aplica.
--   • item_name = etiqueta para los rankings del panel (top clicks, etc.).
--   • store_id  = dueño resuelto para multi-tenant (NULL si no aplica:
--                 navegación, filtros de categoría, etc.).
CREATE TABLE IF NOT EXISTS public.interaction_daily_stats (
  date        DATE NOT NULL,
  kiosk_id    TEXT,
  module      TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  item_id     UUID,
  item_name   TEXT,
  store_id    UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  count       INT  NOT NULL DEFAULT 0
);

-- Unicidad tratando NULL como valor (PG15: NULLS NOT DISTINCT). item_id/item_name
-- NULL (navigate/filter) agregan contra una sola fila por día/kiosko/módulo/tipo.
-- Respalda el ON CONFLICT del trigger.
CREATE UNIQUE INDEX IF NOT EXISTS interaction_daily_stats_uq
  ON public.interaction_daily_stats (date, kiosk_id, module, event_type, item_id, item_name)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_interaction_daily_store_date
  ON public.interaction_daily_stats (store_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_daily_date
  ON public.interaction_daily_stats (date DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_daily_kiosk_date
  ON public.interaction_daily_stats (kiosk_id, date DESC);

ALTER TABLE public.interaction_daily_stats ENABLE ROW LEVEL SECURITY;


-- ── 2. Trigger: cada insert en analytics_events suma al diario ───────────────
CREATE OR REPLACE FUNCTION public.tg_analytics_event_to_daily()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day      DATE := (NEW.created_at AT TIME ZONE 'America/Caracas')::date;
  v_store_id UUID;
BEGIN
  -- Resolver la tienda dueña del item, si lo hay: primero como tienda directa
  -- (event 'select' del directorio), luego como cupón.
  IF NEW.item_id IS NOT NULL THEN
    SELECT id INTO v_store_id FROM public.stores WHERE id = NEW.item_id;
    IF v_store_id IS NULL THEN
      SELECT store_id INTO v_store_id FROM public.coupons WHERE id = NEW.item_id;
    END IF;
  END IF;

  INSERT INTO public.interaction_daily_stats
    (date, kiosk_id, module, event_type, item_id, item_name, store_id, count)
  VALUES
    (v_day, NEW.kiosk_id, NEW.module, NEW.event_type, NEW.item_id, NEW.item_name, v_store_id, 1)
  ON CONFLICT (date, kiosk_id, module, event_type, item_id, item_name)
  DO UPDATE SET count = public.interaction_daily_stats.count + 1;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_analytics_event_to_daily ON public.analytics_events;
CREATE TRIGGER trg_analytics_event_to_daily
  AFTER INSERT ON public.analytics_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_analytics_event_to_daily();


-- ── 3. Backfill del histórico existente (idempotente) ────────────────────────
DO $$
BEGIN
  TRUNCATE public.interaction_daily_stats;

  INSERT INTO public.interaction_daily_stats
    (date, kiosk_id, module, event_type, item_id, item_name, store_id, count)
  SELECT
    (e.created_at AT TIME ZONE 'America/Caracas')::date AS day,
    e.kiosk_id,
    e.module,
    e.event_type,
    e.item_id,
    e.item_name,
    COALESCE(s.id, c.store_id) AS store_id,
    COUNT(*)
  FROM public.analytics_events e
  LEFT JOIN public.stores  s ON s.id = e.item_id
  LEFT JOIN public.coupons c ON c.id = e.item_id
  GROUP BY (e.created_at AT TIME ZONE 'America/Caracas')::date,
           e.kiosk_id, e.module, e.event_type, e.item_id, e.item_name,
           COALESCE(s.id, c.store_id);

  RAISE NOTICE 'Backfill de interaction_daily_stats completado.';
END $$;


-- ── 4. RLS (admin ve todo; la tienda ve sólo sus interacciones) ──────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='interaction_daily_stats' AND policyname='interaction_daily_admin') THEN
    CREATE POLICY "interaction_daily_admin" ON public.interaction_daily_stats
      FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='interaction_daily_stats' AND policyname='interaction_daily_owner') THEN
    CREATE POLICY "interaction_daily_owner" ON public.interaction_daily_stats
      FOR SELECT TO authenticated
      USING (store_id IS NOT NULL AND public.user_owns_store(store_id));
  END IF;
END $$;


-- ── 5. Purga unificada (SUPERSEDE la versión de 027) ─────────────────────────
-- Ahora incluye analytics_events. Se elimina la firma vieja por si cambió el
-- tipo de retorno (de 3 a 4 columnas).
DROP FUNCTION IF EXISTS public.purge_raw_analytics(INT);

CREATE OR REPLACE FUNCTION public.purge_raw_analytics(p_retention_days INT DEFAULT 30)
RETURNS TABLE (
  purged_coupon_events    BIGINT,
  purged_search_events    BIGINT,
  purged_ad_impressions   BIGINT,
  purged_analytics_events BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - make_interval(days => GREATEST(p_retention_days, 1));
  v_c1 BIGINT; v_c2 BIGINT; v_c3 BIGINT; v_c4 BIGINT;
BEGIN
  WITH del AS (
    DELETE FROM public.coupon_events WHERE occurred_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_c1 FROM del;

  WITH del AS (
    DELETE FROM public.search_events WHERE occurred_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_c2 FROM del;

  WITH del AS (
    DELETE FROM public.ad_impressions WHERE occurred_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_c3 FROM del;

  -- analytics_events usa created_at (no occurred_at). Ya agregada al diario.
  WITH del AS (
    DELETE FROM public.analytics_events WHERE created_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_c4 FROM del;

  RAISE NOTICE 'purge_raw_analytics(% días): % coupon_events, % search_events, % ad_impressions, % analytics_events.',
    p_retention_days, v_c1, v_c2, v_c3, v_c4;

  RETURN QUERY SELECT v_c1, v_c2, v_c3, v_c4;
END $$;

GRANT EXECUTE ON FUNCTION public.purge_raw_analytics(INT) TO service_role;

-- El cron 'purge-raw-analytics' creado en 027 ya llama a purge_raw_analytics(30):
-- al ser CREATE OR REPLACE, el job existente toma automáticamente esta versión.
-- No hace falta reprogramarlo.
