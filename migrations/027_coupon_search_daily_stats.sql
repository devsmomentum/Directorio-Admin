-- ============================================================================
-- 027_coupon_search_daily_stats.sql
--
-- Sistema de AGREGADOS DIARIOS + PURGA AUTOMÁTICA para Cupones e
-- Interacciones/Búsquedas. Mismo patrón que `ad_impressions` /
-- `ad_impressions_daily` (ver ad_impressions_migration.sql):
--
--   tabla cruda (alto volumen, append-only, SE PURGA)
--        │  RPC SECURITY DEFINER (insert raw + UPSERT atómico al diario)
--        ▼
--   tabla diaria (consolidada, PERSISTE meses/años)
--        ▲
--        │  vistas (security_invoker) + RLS multi-tenant
--   dashboards (admin global / portal de la tienda)
--
-- ESTADO ACTUAL DEL PRODUCTO (importante para entender qué se llena hoy):
--   • De cupones HOY sólo se registra cuántas veces APARECIÓ el cupón flash
--     (FlashCouponDialog en main_layout). Eso alimenta la columna `shown`.
--   • `clicks`   queda lista para cuando se trackee el tap sobre el cupón.
--   • `redeemed` queda lista para cuando "reclamar cupón" esté operativo;
--     se alimenta por TRIGGER sobre coupon_leads (no hay que tocar nada más).
--
-- Estrategia de alimentación (paso 3 del diseño):
--   • shown / clicks (alto volumen) → RPC + cola offline desde Flutter
--     (UPSERT `ON CONFLICT … DO UPDATE`). Igual que las impresiones.
--   • redeemed                      → TRIGGER AFTER INSERT sobre coupon_leads
--     (server-side, atómico, fuente de verdad). coupon_leads NO se purga.
--
-- Zona horaria del "día": America/Caracas (UTC-4), igual que el RPC de
-- impresiones, para que "hoy / últimos 7 días" cuadre en los dashboards.
--
-- Requisitos previos: cliente_portal_auth.sql (is_admin(), user_owns_store()).
-- Idempotente: se puede re-ejecutar sin efectos colaterales.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE A — CUPONES
-- ════════════════════════════════════════════════════════════════════════════

-- ── A.1 Tabla cruda de eventos de cupón (alto volumen, SE PURGA) ─────────────
-- `kind` distingue el tipo de interacción. Hoy sólo entra 'shown'; 'click'
-- queda disponible sin cambiar el esquema. Los canjes NO van aquí (viven en
-- coupon_leads, que es data de negocio y no se purga).
CREATE TABLE IF NOT EXISTS public.coupon_events (
  id          BIGSERIAL PRIMARY KEY,
  coupon_id   UUID NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
  store_id    UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'shown' CHECK (kind IN ('shown', 'click')),
  kiosk_id    TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_events_coupon_time
  ON public.coupon_events (coupon_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_coupon_events_time
  ON public.coupon_events (occurred_at);   -- la usa la purga (range scan por fecha)

ALTER TABLE public.coupon_events ENABLE ROW LEVEL SECURITY;


-- ── A.2 Agregado diario de cupones (PERSISTE) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.coupon_daily_stats (
  coupon_id  UUID NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
  store_id   UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  date       DATE NOT NULL,
  shown      INT  NOT NULL DEFAULT 0,   -- veces que apareció el cupón (flash)
  clicks     INT  NOT NULL DEFAULT 0,   -- futuro: tap sobre el cupón
  redeemed   INT  NOT NULL DEFAULT 0,   -- futuro: canjes (trigger coupon_leads)
  -- Restricción única compuesta exigida por el diseño.
  CONSTRAINT coupon_daily_stats_coupon_date_key UNIQUE (coupon_id, date)
);

-- Índices compuestos para las consultas del front (por tienda y por fecha).
CREATE INDEX IF NOT EXISTS idx_coupon_daily_store_date
  ON public.coupon_daily_stats (store_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_coupon_daily_date
  ON public.coupon_daily_stats (date DESC);

ALTER TABLE public.coupon_daily_stats ENABLE ROW LEVEL SECURITY;


-- ── A.3 RPC: registrar un evento de cupón (raw + UPSERT diario) ───────────────
-- El store_id se resuelve desde `coupons` en el servidor: el cliente no puede
-- falsear a qué tienda se atribuye el evento. p_kind ∈ ('shown','click').
CREATE OR REPLACE FUNCTION public.record_coupon_event(
  p_coupon_id   UUID,
  p_kind        TEXT        DEFAULT 'shown',
  p_kiosk_id    TEXT        DEFAULT NULL,
  p_occurred_at TIMESTAMPTZ DEFAULT now()
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id       BIGINT;
  v_store_id UUID;
  v_kind     TEXT := lower(COALESCE(p_kind, 'shown'));
  v_day      DATE := (p_occurred_at AT TIME ZONE 'America/Caracas')::date;
BEGIN
  IF p_coupon_id IS NULL OR v_kind NOT IN ('shown', 'click') THEN
    RETURN NULL;
  END IF;

  SELECT store_id INTO v_store_id FROM public.coupons WHERE id = p_coupon_id;
  IF NOT FOUND THEN
    RETURN NULL;   -- cupón inexistente: se ignora silenciosamente
  END IF;

  INSERT INTO public.coupon_events (coupon_id, store_id, kind, kiosk_id, occurred_at)
  VALUES (p_coupon_id, v_store_id, v_kind, p_kiosk_id, p_occurred_at)
  RETURNING id INTO v_id;

  IF v_kind = 'shown' THEN
    INSERT INTO public.coupon_daily_stats (coupon_id, store_id, date, shown)
    VALUES (p_coupon_id, v_store_id, v_day, 1)
    ON CONFLICT (coupon_id, date)
    DO UPDATE SET shown = public.coupon_daily_stats.shown + 1;
  ELSE
    INSERT INTO public.coupon_daily_stats (coupon_id, store_id, date, clicks)
    VALUES (p_coupon_id, v_store_id, v_day, 1)
    ON CONFLICT (coupon_id, date)
    DO UPDATE SET clicks = public.coupon_daily_stats.clicks + 1;
  END IF;

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.record_coupon_event(UUID, TEXT, TEXT, TIMESTAMPTZ)
  TO anon, authenticated;


-- ── A.4 RPC batch (flush offline desde el kiosko) ────────────────────────────
-- Acepta JSONB array: [{coupon_id, kind?, kiosk_id?, occurred_at?}, ...]
CREATE OR REPLACE FUNCTION public.record_coupon_events_batch(
  p_events JSONB
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event    JSONB;
  v_inserted INT := 0;
  v_result   BIGINT;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR v_event IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_result := public.record_coupon_event(
      NULLIF(v_event->>'coupon_id', '')::UUID,
      COALESCE(NULLIF(v_event->>'kind', ''), 'shown'),
      NULLIF(v_event->>'kiosk_id', ''),
      COALESCE(NULLIF(v_event->>'occurred_at', '')::TIMESTAMPTZ, now())
    );
    IF v_result IS NOT NULL THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END $$;

GRANT EXECUTE ON FUNCTION public.record_coupon_events_batch(JSONB)
  TO anon, authenticated;


-- ── A.5 TRIGGER: cada lead nuevo en coupon_leads = 1 canje ───────────────────
-- LISTO PARA EL FUTURO: hoy "reclamar cupón" no está operativo, así que este
-- trigger no se dispara aún. Cuando el flujo de canje entre en producción
-- (claim_catalog_coupon / claim_flash_coupon insertan en coupon_leads),
-- `redeemed` empezará a sumar solo, sin tocar los RPC.
CREATE OR REPLACE FUNCTION public.tg_coupon_lead_to_daily()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store_id UUID;
  v_day      DATE := (NEW.created_at AT TIME ZONE 'America/Caracas')::date;
BEGIN
  SELECT store_id INTO v_store_id FROM public.coupons WHERE id = NEW.coupon_id;

  INSERT INTO public.coupon_daily_stats (coupon_id, store_id, date, redeemed)
  VALUES (NEW.coupon_id, v_store_id, v_day, 1)
  ON CONFLICT (coupon_id, date)
  DO UPDATE SET redeemed = public.coupon_daily_stats.redeemed + 1;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_coupon_lead_to_daily ON public.coupon_leads;
CREATE TRIGGER trg_coupon_lead_to_daily
  AFTER INSERT ON public.coupon_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_coupon_lead_to_daily();


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE B — BÚSQUEDAS / INTERACCIONES
-- ════════════════════════════════════════════════════════════════════════════

-- ── B.1 Tabla cruda de búsquedas (alto volumen, SE PURGA) ────────────────────
CREATE TABLE IF NOT EXISTS public.search_events (
  id              BIGSERIAL PRIMARY KEY,
  search_term     TEXT NOT NULL,             -- ya normalizado en minúsculas
  store_id_target UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  kiosk_id        TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_events_time
  ON public.search_events (occurred_at);   -- la usa la purga

ALTER TABLE public.search_events ENABLE ROW LEVEL SECURITY;


-- ── B.2 Agregado diario de búsquedas (PERSISTE) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.search_daily_stats (
  search_term     TEXT NOT NULL,
  store_id_target UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  date            DATE NOT NULL,
  search_count    INT  NOT NULL DEFAULT 0
);

-- Unicidad compuesta tratando NULL como valor (PG15+: NULLS NOT DISTINCT),
-- para que las búsquedas SIN tienda destino (store_id_target IS NULL) también
-- agreguen contra una única fila por (término, día).
CREATE UNIQUE INDEX IF NOT EXISTS search_daily_stats_uq
  ON public.search_daily_stats (search_term, store_id_target, date)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_search_daily_store_date
  ON public.search_daily_stats (store_id_target, date DESC);
CREATE INDEX IF NOT EXISTS idx_search_daily_term_date
  ON public.search_daily_stats (search_term, date DESC);

ALTER TABLE public.search_daily_stats ENABLE ROW LEVEL SECURITY;


-- ── B.3 RPC: registrar una BÚSQUEDA (raw + UPSERT diario) ─────────────────────
-- Normaliza el término a minúsculas + trim. store_id_target es opcional:
-- viene relleno cuando la búsqueda terminó en click a una tienda (search_click).
CREATE OR REPLACE FUNCTION public.record_search(
  p_search_term     TEXT,
  p_store_id_target UUID        DEFAULT NULL,
  p_kiosk_id        TEXT        DEFAULT NULL,
  p_occurred_at     TIMESTAMPTZ DEFAULT now()
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id    BIGINT;
  v_term  TEXT := lower(btrim(COALESCE(p_search_term, '')));
  v_day   DATE := (p_occurred_at AT TIME ZONE 'America/Caracas')::date;
BEGIN
  IF v_term = '' THEN
    RETURN NULL;
  END IF;
  v_term := left(v_term, 120);   -- cota defensiva de longitud

  INSERT INTO public.search_events (search_term, store_id_target, kiosk_id, occurred_at)
  VALUES (v_term, p_store_id_target, p_kiosk_id, p_occurred_at)
  RETURNING id INTO v_id;

  -- UPSERT robusto con NULL en store_id_target (UPDATE-then-INSERT con
  -- reintento ante carrera; respaldado por search_daily_stats_uq).
  UPDATE public.search_daily_stats
     SET search_count = search_count + 1
   WHERE search_term     = v_term
     AND store_id_target IS NOT DISTINCT FROM p_store_id_target
     AND date            = v_day;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.search_daily_stats (search_term, store_id_target, date, search_count)
      VALUES (v_term, p_store_id_target, v_day, 1);
    EXCEPTION WHEN unique_violation THEN
      UPDATE public.search_daily_stats
         SET search_count = search_count + 1
       WHERE search_term     = v_term
         AND store_id_target IS NOT DISTINCT FROM p_store_id_target
         AND date            = v_day;
    END;
  END IF;

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.record_search(TEXT, UUID, TEXT, TIMESTAMPTZ)
  TO anon, authenticated;


-- ── B.4 RPC batch (flush offline desde el kiosko) ────────────────────────────
-- Acepta JSONB array: [{search_term, store_id_target?, kiosk_id?, occurred_at?}, ...]
CREATE OR REPLACE FUNCTION public.record_searches_batch(
  p_events JSONB
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event    JSONB;
  v_inserted INT := 0;
  v_result   BIGINT;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR v_event IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_result := public.record_search(
      v_event->>'search_term',
      NULLIF(v_event->>'store_id_target', '')::UUID,
      NULLIF(v_event->>'kiosk_id', ''),
      COALESCE(NULLIF(v_event->>'occurred_at', '')::TIMESTAMPTZ, now())
    );
    IF v_result IS NOT NULL THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END $$;

GRANT EXECUTE ON FUNCTION public.record_searches_batch(JSONB)
  TO anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE C — VISTAS PARA DASHBOARDS
-- ════════════════════════════════════════════════════════════════════════════

-- C.1 Resumen por cupón (hoy / 7d / 30d / total).
-- security_invoker=true → la vista respeta el RLS del usuario que consulta
-- (una tienda sólo ve sus cupones; el admin ve todos). Sin esto, una vista
-- normal correría con privilegios del dueño y se saltaría el RLS multi-tenant.
CREATE OR REPLACE VIEW public.v_coupon_stats
WITH (security_invoker = true) AS
SELECT
  c.id        AS coupon_id,
  c.store_id,
  c.title,
  c.code,
  c.amount_available,
  c.end_date,
  COALESCE(SUM(d.shown)    FILTER (WHERE d.date = CURRENT_DATE), 0)::INT       AS shown_today,
  COALESCE(SUM(d.redeemed) FILTER (WHERE d.date = CURRENT_DATE), 0)::INT       AS redeemed_today,
  COALESCE(SUM(d.shown)    FILTER (WHERE d.date >= CURRENT_DATE - 6), 0)::INT  AS shown_7d,
  COALESCE(SUM(d.shown)    FILTER (WHERE d.date >= CURRENT_DATE - 29), 0)::INT AS shown_30d,
  COALESCE(SUM(d.clicks),   0)::INT AS clicks_total,
  COALESCE(SUM(d.shown),    0)::INT AS shown_total,
  COALESCE(SUM(d.redeemed), 0)::INT AS redeemed_total
FROM public.coupons c
LEFT JOIN public.coupon_daily_stats d ON d.coupon_id = c.id
GROUP BY c.id;

GRANT SELECT ON public.v_coupon_stats TO authenticated;

-- C.2 Top de términos buscados (global). security_invoker=true → el admin ve
-- el agregado completo; una tienda sólo suma las búsquedas que terminaron en
-- SU local (las demás filas las oculta el RLS de search_daily_stats).
CREATE OR REPLACE VIEW public.v_search_top_terms
WITH (security_invoker = true) AS
SELECT
  search_term,
  SUM(search_count) FILTER (WHERE date >= CURRENT_DATE - 6)::INT  AS count_7d,
  SUM(search_count) FILTER (WHERE date >= CURRENT_DATE - 29)::INT AS count_30d,
  SUM(search_count)::INT AS count_total
FROM public.search_daily_stats
GROUP BY search_term;

GRANT SELECT ON public.v_search_top_terms TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE D — RLS (multi-tenant: admin ve todo, la tienda ve sólo lo suyo)
-- ════════════════════════════════════════════════════════════════════════════
-- La ESCRITURA siempre pasa por los RPC/trigger SECURITY DEFINER, así que NO
-- definimos políticas de INSERT/UPDATE para clientes. Sólo lectura (SELECT).

-- ── D.1 coupon_daily_stats ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='coupon_daily_stats' AND policyname='coupon_daily_admin') THEN
    CREATE POLICY "coupon_daily_admin" ON public.coupon_daily_stats
      FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='coupon_daily_stats' AND policyname='coupon_daily_owner') THEN
    CREATE POLICY "coupon_daily_owner" ON public.coupon_daily_stats
      FOR SELECT TO authenticated USING (public.user_owns_store(store_id));
  END IF;
END $$;

-- ── D.2 coupon_events (raw) ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='coupon_events' AND policyname='coupon_events_admin') THEN
    CREATE POLICY "coupon_events_admin" ON public.coupon_events
      FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='coupon_events' AND policyname='coupon_events_owner') THEN
    CREATE POLICY "coupon_events_owner" ON public.coupon_events
      FOR SELECT TO authenticated USING (public.user_owns_store(store_id));
  END IF;
END $$;

-- ── D.3 search_daily_stats ───────────────────────────────────────────────────
-- La tienda sólo ve filas cuyo store_id_target es suyo (búsquedas que
-- terminaron en SU tienda). Las búsquedas globales sin destino (NULL) son
-- exclusivas del admin.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='search_daily_stats' AND policyname='search_daily_admin') THEN
    CREATE POLICY "search_daily_admin" ON public.search_daily_stats
      FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='search_daily_stats' AND policyname='search_daily_owner') THEN
    CREATE POLICY "search_daily_owner" ON public.search_daily_stats
      FOR SELECT TO authenticated
      USING (store_id_target IS NOT NULL AND public.user_owns_store(store_id_target));
  END IF;
END $$;

-- ── D.4 search_events (raw) ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='search_events' AND policyname='search_events_admin') THEN
    CREATE POLICY "search_events_admin" ON public.search_events
      FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='search_events' AND policyname='search_events_owner') THEN
    CREATE POLICY "search_events_owner" ON public.search_events
      FOR SELECT TO authenticated
      USING (store_id_target IS NOT NULL AND public.user_owns_store(store_id_target));
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE E — PURGA AUTOMÁTICA (pg_cron)
-- ════════════════════════════════════════════════════════════════════════════
-- Purga las 3 tablas CRUDAS que crecen fila-por-fila y YA tienen su agregado
-- diario poblado: coupon_events, search_events y AD_IMPRESSIONS. Las tablas
-- diarias (coupon_daily_stats, search_daily_stats, ad_impressions_daily) y
-- coupon_leads NUNCA se tocan → las métricas se conservan para siempre.
--
-- Por qué es seguro borrar (incluso agresivamente): la agregación al diario es
-- ATÓMICA dentro de la misma transacción del INSERT crudo (RPC/trigger). En el
-- instante en que se escribe la fila cruda, el contador diario YA quedó sumado.
-- Por eso la fila cruda sólo sirve de buffer forense / para re-agregar si el
-- diario se corrompiera. La retención (días) es un colchón de seguridad, NO un
-- requisito de correctitud: podés bajarla a 7, 3 o incluso 1 sin perder métricas.
--
-- NOTA sobre analytics_events: esa tabla (clicks/navigate/select/filter) NO
-- tiene agregado diario, así que NO la purgamos aquí (perderíamos esos datos).
-- Ver el mensaje del agente para decidir qué hacer con ella.

CREATE OR REPLACE FUNCTION public.purge_raw_analytics(p_retention_days INT DEFAULT 30)
RETURNS TABLE (
  purged_coupon_events  BIGINT,
  purged_search_events  BIGINT,
  purged_ad_impressions BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - make_interval(days => GREATEST(p_retention_days, 1));
  v_c1 BIGINT;
  v_c2 BIGINT;
  v_c3 BIGINT;
BEGIN
  WITH del AS (
    DELETE FROM public.coupon_events WHERE occurred_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_c1 FROM del;

  WITH del AS (
    DELETE FROM public.search_events WHERE occurred_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_c2 FROM del;

  -- ad_impressions: su agregado ad_impressions_daily lo llena el RPC
  -- record_ad_impression de forma atómica, igual que las nuevas tablas.
  WITH del AS (
    DELETE FROM public.ad_impressions WHERE occurred_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_c3 FROM del;

  RAISE NOTICE 'purge_raw_analytics(% días): % coupon_events, % search_events, % ad_impressions eliminadas (cutoff %).',
    p_retention_days, v_c1, v_c2, v_c3, v_cutoff;

  RETURN QUERY SELECT v_c1, v_c2, v_c3;
END $$;

GRANT EXECUTE ON FUNCTION public.purge_raw_analytics(INT) TO service_role;


-- Programación nocturna. 04:20 UTC == 00:20 America/Caracas, después de los
-- demás jobs (BCV 04:01, cupones 04:05). Retención = 30 días (cambiá a 15
-- editando el argumento del SELECT de abajo).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  PERFORM cron.unschedule('purge-raw-analytics');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-raw-analytics',
  '20 4 * * *',
  $$ SELECT public.purge_raw_analytics(30); $$
);

DO $$
DECLARE v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-raw-analytics';
  IF v_job_id IS NULL THEN
    RAISE WARNING 'cron job "purge-raw-analytics" no quedó registrado';
  ELSE
    RAISE NOTICE 'cron job "purge-raw-analytics" registrado (id=%)', v_job_id;
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE F — BACKFILL desde analytics_events legacy (idempotente, opcional)
-- ════════════════════════════════════════════════════════════════════════════
-- Reconstruye los diarios desde lo que ya existe:
--   • Cupones shown   → analytics_events.event_type = 'flash_coupon_shown'
--                       (item_id = coupon_id). Es lo que hoy inunda la tabla.
--   • Cupones redeemed→ coupon_leads (fuente de verdad; hoy ~0 hasta que el
--                       canje esté operativo).
--   • Búsquedas       → analytics_events.event_type = 'search_click'
--                       (event_data.query = término, item_id = tienda destino).
-- Re-ejecutable: TRUNCATE de los diarios + reinserción. Si NO querés perder
-- contadores ya acumulados en vivo, comentá este bloque antes de correrlo.

DO $$
BEGIN
  -- ── Cupones ──
  TRUNCATE public.coupon_daily_stats;

  -- shown (legacy flash_coupon_shown). Sólo cupones que aún existen.
  INSERT INTO public.coupon_daily_stats (coupon_id, store_id, date, shown)
  SELECT e.item_id, c.store_id,
         (e.created_at AT TIME ZONE 'America/Caracas')::date,
         COUNT(*)
  FROM public.analytics_events e
  JOIN public.coupons c ON c.id = e.item_id
  WHERE e.event_type = 'flash_coupon_shown'
    AND e.item_id IS NOT NULL
  GROUP BY e.item_id, c.store_id, (e.created_at AT TIME ZONE 'America/Caracas')::date
  ON CONFLICT (coupon_id, date)
  DO UPDATE SET shown = public.coupon_daily_stats.shown + EXCLUDED.shown;

  -- redeemed (desde coupon_leads, por si ya hay alguno)
  INSERT INTO public.coupon_daily_stats (coupon_id, store_id, date, redeemed)
  SELECT cl.coupon_id, c.store_id,
         (cl.created_at AT TIME ZONE 'America/Caracas')::date,
         COUNT(*)
  FROM public.coupon_leads cl
  JOIN public.coupons c ON c.id = cl.coupon_id
  GROUP BY cl.coupon_id, c.store_id, (cl.created_at AT TIME ZONE 'America/Caracas')::date
  ON CONFLICT (coupon_id, date)
  DO UPDATE SET redeemed = public.coupon_daily_stats.redeemed + EXCLUDED.redeemed;

  -- ── Búsquedas (search_click legacy) ──
  TRUNCATE public.search_daily_stats;

  INSERT INTO public.search_daily_stats (search_term, store_id_target, date, search_count)
  SELECT lower(btrim(e.event_data->>'query')),
         e.item_id,
         (e.created_at AT TIME ZONE 'America/Caracas')::date,
         COUNT(*)
  FROM public.analytics_events e
  WHERE e.event_type = 'search_click'
    AND COALESCE(btrim(e.event_data->>'query'), '') <> ''
  GROUP BY lower(btrim(e.event_data->>'query')), e.item_id,
           (e.created_at AT TIME ZONE 'America/Caracas')::date;

  RAISE NOTICE 'Backfill de diarios (cupones shown/redeemed + búsquedas) completado.';
END $$;
