-- ============================================================================
-- 016_app_config_bcv_rate.sql
--
-- Tasa BCV oficial vive en public.app_config (key='bcv_exchange_rate') y la
-- edge function `update-rate` la refresca scrapeando bcv.org.ve. Para que el
-- backend sea la fuente de verdad de los pagos en Bs:
--
--   * request_plan_atomic / report_additional_payment_atomic LEEN la tasa del
--     DB (no confían en p_bcv_rate del cliente).
--   * Validan que p_amount_bs ≈ p_amount_usd × db_rate (tolerancia 1% o Bs 1).
--   * Almacenan db_rate en la fila, no el valor reportado por el cliente.
--
-- Si la tasa aún no está sembrada (DB recién creada) las RPCs fallan con un
-- mensaje claro pidiendo al admin disparar la edge update-rate.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tablas (idempotentes — pueden existir si la edge ya las creó manualmente).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.exchange_rate_history (
  id            BIGSERIAL PRIMARY KEY,
  rate          NUMERIC(14,4),
  previous_rate NUMERIC(14,4),
  source        TEXT NOT NULL,
  error_message TEXT,
  scraped_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exchange_rate_history_scraped_at
  ON public.exchange_rate_history (scraped_at DESC);

-- Sembramos la fila para que la edge use UPDATE en vez de INSERT.
INSERT INTO public.app_config (key, value)
VALUES ('bcv_exchange_rate', '0')
ON CONFLICT (key) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS — clientes autenticados pueden LEER la config (necesario para que
--    el widget de pago muestre la tasa). Escritura sólo via service-role
--    (la edge function usa SUPABASE_SERVICE_ROLE_KEY).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.app_config             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rate_history  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_config select authenticated" ON public.app_config;
CREATE POLICY "app_config select authenticated"
  ON public.app_config FOR SELECT TO authenticated
  USING (true);

-- history: sólo lectura para admins (si quieres exponerlo en UI futura).
DROP POLICY IF EXISTS "exchange_rate_history admin select" ON public.exchange_rate_history;
CREATE POLICY "exchange_rate_history admin select"
  ON public.exchange_rate_history FOR SELECT TO authenticated
  USING (public.is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helper: lectura segura de la tasa actual.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.current_bcv_rate()
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(trim(value), '')::NUMERIC
  FROM public.app_config
  WHERE key = 'bcv_exchange_rate'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.current_bcv_rate() TO authenticated, anon;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. request_plan_atomic — usa la tasa del DB, ignora p_bcv_rate.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.request_plan_atomic(
  p_store_id          UUID,
  p_plan_key          TEXT,
  p_months            INTEGER,
  p_payment_method    TEXT,
  p_payment_reference TEXT,
  p_payment_bank      TEXT,
  p_amount_bs         NUMERIC,
  p_amount_usd        NUMERIC,
  p_bcv_rate          NUMERIC,  -- aceptado por compat; el backend usa la tasa del DB
  p_notes             TEXT DEFAULT NULL
)
RETURNS public.plan_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id        UUID := auth.uid();
  v_plan           public.plans%ROWTYPE;
  v_store          public.stores%ROWTYPE;
  v_is_flash       BOOLEAN := public.is_flash_coupon_plan(p_plan_key);
  v_current_key    TEXT;
  v_current_exp    DATE;
  v_effective_date DATE;
  v_expires_at     DATE;
  v_total_cost     NUMERIC(10,2);
  v_max_overlap    INTEGER;
  v_row            public.plan_requests%ROWTYPE;
  v_db_rate        NUMERIC(14,4);
  v_expected_bs    NUMERIC(14,2);
  v_bs_tolerance   NUMERIC(14,2);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Sesión inválida' USING ERRCODE = '28000';
  END IF;
  IF NOT public.user_owns_store(p_store_id) THEN
    RAISE EXCEPTION 'No tienes permiso sobre esta tienda' USING ERRCODE = '42501';
  END IF;
  IF p_months IS NULL OR p_months < 1 THEN
    RAISE EXCEPTION 'Cantidad de ciclos inválida' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method NOT IN ('transfer_bs','transfer_usd','cash_usd','cash_bs') THEN
    RAISE EXCEPTION 'Método de pago inválido: %', p_payment_method USING ERRCODE = '22023';
  END IF;
  IF p_payment_method IN ('transfer_bs','transfer_usd') THEN
    IF p_payment_reference IS NULL OR length(trim(p_payment_reference)) = 0 THEN
      RAISE EXCEPTION 'Número de referencia requerido' USING ERRCODE = '22023';
    END IF;
    IF p_payment_bank IS NULL OR length(trim(p_payment_bank)) = 0 THEN
      RAISE EXCEPTION 'Banco emisor requerido' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_payment_method IN ('transfer_bs','cash_bs') THEN
    IF p_amount_bs IS NULL OR p_amount_bs <= 0 THEN
      RAISE EXCEPTION 'Monto en Bs inválido' USING ERRCODE = '22023';
    END IF;
    IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
      RAISE EXCEPTION 'Monto en USD requerido para pagos en Bs (el Bs se deriva de USD × BCV)'
        USING ERRCODE = '22023';
    END IF;
    v_db_rate := public.current_bcv_rate();
    IF v_db_rate IS NULL OR v_db_rate <= 0 THEN
      RAISE EXCEPTION 'Tasa BCV no configurada en el sistema. Solicita a la administración refrescar la tasa antes de pagar en Bs.'
        USING ERRCODE = 'P0001';
    END IF;
    v_expected_bs  := ROUND(p_amount_usd * v_db_rate, 2);
    v_bs_tolerance := GREATEST(1, ROUND(v_expected_bs * 0.01, 2));
    IF abs(p_amount_bs - v_expected_bs) > v_bs_tolerance THEN
      RAISE EXCEPTION 'Inconsistencia en pago en Bs: reportaste Bs %, pero USD % × BCV % = Bs % (tolerancia ± Bs %). Recarga la página: la tasa BCV puede haberse actualizado.',
        to_char(p_amount_bs,    'FM999999999.00'),
        to_char(p_amount_usd,   'FM999999999.00'),
        to_char(v_db_rate,      'FM999999999.0000'),
        to_char(v_expected_bs,  'FM999999999.00'),
        to_char(v_bs_tolerance, 'FM999999999.00')
        USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_payment_method IN ('transfer_usd','cash_usd') THEN
    IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
      RAISE EXCEPTION 'Monto en USD inválido' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_store FROM public.stores WHERE id = p_store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tienda no encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.plan_requests pr
     WHERE pr.store_id = p_store_id
       AND pr.status IN ('pending','partial')
       AND public.is_flash_coupon_plan(pr.plan_key) = v_is_flash
  ) THEN
    RAISE EXCEPTION 'Ya tienes una solicitud %s con saldo pendiente. Reporta el abono a esa solicitud antes de crear una nueva.',
      CASE WHEN v_is_flash THEN 'de addon Flash Coupon' ELSE 'de plan' END
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.plan_requests pr
     WHERE pr.store_id = p_store_id
       AND pr.status = 'approved'
       AND pr.effective_date IS NOT NULL
       AND pr.effective_date > CURRENT_DATE
       AND public.is_flash_coupon_plan(pr.plan_key) = v_is_flash
  ) THEN
    RAISE EXCEPTION 'Tienes un cambio aprobado pendiente de activación en este tipo de plan. Espera a que entre en vigor antes de pedir otro.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_is_flash THEN
    v_current_key := v_store.flash_coupon_plan;
    v_current_exp := v_store.flash_coupon_expiry_date;
  ELSE
    v_current_key := v_store.plan_type;
    v_current_exp := v_store.contract_expiry_date;
  END IF;

  IF v_current_key IS NOT NULL AND v_current_key = p_plan_key
     AND (v_current_exp IS NULL OR v_current_exp >= CURRENT_DATE) THEN
    RAISE EXCEPTION 'Ya tienes este plan activo. Para extenderlo, registra un pago de renovación.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_current_key IS NULL OR (v_current_exp IS NOT NULL AND v_current_exp < CURRENT_DATE) THEN
    v_effective_date := CURRENT_DATE;
  ELSE
    IF v_current_exp IS NULL THEN
      RAISE EXCEPTION 'No se puede solicitar cambio: tu %s no tiene fecha de vencimiento configurada. Contacta a la administración.',
        CASE WHEN v_is_flash THEN 'addon Flash Coupon' ELSE 'contrato' END
        USING ERRCODE = 'P0001';
    END IF;
    v_effective_date := v_current_exp + INTERVAL '1 day';
  END IF;

  SELECT * INTO v_plan
    FROM public.plans
   WHERE plan_key = p_plan_key AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan % no disponible', p_plan_key USING ERRCODE = 'P0001';
  END IF;

  v_total_cost := ROUND(v_plan.price_usd * p_months, 2);
  v_expires_at := v_effective_date + (p_months * v_plan.duration_days) - 1;

  IF p_amount_usd IS NOT NULL AND p_amount_usd > v_total_cost THEN
    RAISE EXCEPTION 'El monto reportado (% USD) supera el costo total del plan (% USD × % ciclos = % USD). Reporta como máximo el costo total.',
      p_amount_usd, v_plan.price_usd, p_months, v_total_cost
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('plan_request:' || p_plan_key, 0));

  IF v_plan.max_brands IS NOT NULL THEN
    v_max_overlap := public.plan_max_overlap_in_window(
      p_plan_key, v_effective_date, v_expires_at, p_store_id, NULL
    );
    IF v_max_overlap + 1 > v_plan.max_brands THEN
      RAISE EXCEPTION 'Plan % sin cupo durante el período solicitado (%–%): % ocupantes simultáneos detectados, cap=%.',
        p_plan_key, v_effective_date, v_expires_at, v_max_overlap, v_plan.max_brands
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.plan_requests (
    store_id, plan_key, requested_by, status,
    months_requested, payment_method,
    payment_reference, payment_bank,
    amount_bs, amount_usd, bcv_rate,
    effective_date, notes,
    total_amount_usd, paid_amount_usd
  ) VALUES (
    p_store_id, p_plan_key, v_user_id, 'pending',
    p_months, p_payment_method,
    NULLIF(trim(coalesce(p_payment_reference,'')), ''),
    NULLIF(trim(coalesce(p_payment_bank,'')), ''),
    p_amount_bs, p_amount_usd, v_db_rate,  -- tasa autoritativa
    v_effective_date, p_notes,
    v_total_cost, 0
  )
  RETURNING * INTO v_row;

  INSERT INTO public.transactions (
    transaction_type, item_name, amount_usd, amount_bs, exchange_rate,
    payment_method, status, user_email,
    store_id, plan_request_id, payment_date, notes
  ) VALUES (
    'plan_payment',
    format('Solicitud %s · %s · %s ciclo(s)', v_plan.name, v_store.name, p_months),
    COALESCE(p_amount_usd, v_total_cost),
    p_amount_bs,
    v_db_rate,
    p_payment_method,
    'pending',
    NULL,
    p_store_id,
    v_row.id,
    CURRENT_DATE,
    format('request_id=%s · ref=%s · banco=%s · total=%s',
           v_row.id,
           COALESCE(p_payment_reference, '—'),
           COALESCE(p_payment_bank, '—'),
           v_total_cost::text)
  );

  RETURN v_row;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. report_additional_payment_atomic — misma lógica de tasa del DB.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.report_additional_payment_atomic(
  p_request_id        UUID,
  p_payment_method    TEXT,
  p_payment_reference TEXT,
  p_payment_bank      TEXT,
  p_amount_bs         NUMERIC,
  p_amount_usd        NUMERIC,
  p_bcv_rate          NUMERIC,  -- ignorado, se usa la tasa del DB
  p_notes             TEXT DEFAULT NULL
)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id      UUID := auth.uid();
  v_req          public.plan_requests%ROWTYPE;
  v_store        public.stores%ROWTYPE;
  v_plan         public.plans%ROWTYPE;
  v_tx           public.transactions%ROWTYPE;
  v_db_rate      NUMERIC(14,4);
  v_expected_bs  NUMERIC(14,2);
  v_bs_tolerance NUMERIC(14,2);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Sesión inválida' USING ERRCODE = '28000';
  END IF;

  IF p_payment_method NOT IN ('transfer_bs','transfer_usd','cash_usd','cash_bs') THEN
    RAISE EXCEPTION 'Método de pago inválido: %', p_payment_method USING ERRCODE = '22023';
  END IF;
  IF p_payment_method IN ('transfer_bs','transfer_usd') THEN
    IF p_payment_reference IS NULL OR length(trim(p_payment_reference)) = 0 THEN
      RAISE EXCEPTION 'Número de referencia requerido' USING ERRCODE = '22023';
    END IF;
    IF p_payment_bank IS NULL OR length(trim(p_payment_bank)) = 0 THEN
      RAISE EXCEPTION 'Banco emisor requerido' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_payment_method IN ('transfer_bs','cash_bs') THEN
    IF p_amount_bs IS NULL OR p_amount_bs <= 0 THEN
      RAISE EXCEPTION 'Monto en Bs inválido' USING ERRCODE = '22023';
    END IF;
    IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
      RAISE EXCEPTION 'Monto en USD requerido para pagos en Bs (el Bs se deriva de USD × BCV)'
        USING ERRCODE = '22023';
    END IF;
    v_db_rate := public.current_bcv_rate();
    IF v_db_rate IS NULL OR v_db_rate <= 0 THEN
      RAISE EXCEPTION 'Tasa BCV no configurada en el sistema. Solicita a la administración refrescar la tasa antes de pagar en Bs.'
        USING ERRCODE = 'P0001';
    END IF;
    v_expected_bs  := ROUND(p_amount_usd * v_db_rate, 2);
    v_bs_tolerance := GREATEST(1, ROUND(v_expected_bs * 0.01, 2));
    IF abs(p_amount_bs - v_expected_bs) > v_bs_tolerance THEN
      RAISE EXCEPTION 'Inconsistencia en pago en Bs: reportaste Bs %, pero USD % × BCV % = Bs % (tolerancia ± Bs %). Recarga la página: la tasa BCV puede haberse actualizado.',
        to_char(p_amount_bs,    'FM999999999.00'),
        to_char(p_amount_usd,   'FM999999999.00'),
        to_char(v_db_rate,      'FM999999999.0000'),
        to_char(v_expected_bs,  'FM999999999.00'),
        to_char(v_bs_tolerance, 'FM999999999.00')
        USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_payment_method IN ('transfer_usd','cash_usd') THEN
    IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
      RAISE EXCEPTION 'Monto en USD inválido' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_req FROM public.plan_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_owns_store(v_req.store_id) THEN
    RAISE EXCEPTION 'No tienes permiso sobre esta solicitud' USING ERRCODE = '42501';
  END IF;
  IF v_req.status NOT IN ('pending','partial') THEN
    RAISE EXCEPTION 'La solicitud no admite más abonos (estado: %)', v_req.status
      USING ERRCODE = 'P0001';
  END IF;

  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RAISE EXCEPTION 'Monto del abono inválido' USING ERRCODE = '22023';
  END IF;
  IF p_amount_usd > GREATEST(COALESCE(v_req.total_amount_usd,0) - COALESCE(v_req.paid_amount_usd,0), 0) THEN
    RAISE EXCEPTION 'El abono (% USD) supera el saldo pendiente (% USD). Reporta como máximo el saldo restante.',
      p_amount_usd,
      GREATEST(COALESCE(v_req.total_amount_usd,0) - COALESCE(v_req.paid_amount_usd,0), 0)
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.transactions
     WHERE plan_request_id = v_req.id
       AND COALESCE(status,'pending') = 'pending'
  ) THEN
    RAISE EXCEPTION 'Ya tienes un pago pendiente de verificación en esta solicitud. Espera a que sea revisado antes de reportar otro.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_store FROM public.stores WHERE id = v_req.store_id;
  SELECT * INTO v_plan  FROM public.plans  WHERE plan_key = v_req.plan_key;

  INSERT INTO public.transactions (
    transaction_type, item_name, amount_usd, amount_bs, exchange_rate,
    payment_method, status, user_email,
    store_id, plan_request_id, payment_date, notes
  ) VALUES (
    'plan_payment',
    format('Abono %s · %s', COALESCE(v_plan.name, v_req.plan_key), COALESCE(v_store.name,'—')),
    p_amount_usd,
    p_amount_bs,
    v_db_rate,
    p_payment_method,
    'pending',
    NULL,
    v_req.store_id,
    v_req.id,
    CURRENT_DATE,
    format('request_id=%s · abono · ref=%s · banco=%s%s',
           v_req.id,
           COALESCE(p_payment_reference, '—'),
           COALESCE(p_payment_bank, '—'),
           CASE WHEN p_notes IS NOT NULL THEN E'\n' || p_notes ELSE '' END)
  )
  RETURNING * INTO v_tx;

  RETURN v_tx;
END $$;
