-- ============================================================================
-- Chequeo de cupo: máximo simultáneo dentro de la ventana pagada (sweep-line)
-- ----------------------------------------------------------------------------
-- Problema con el chequeo anterior:
--   Las RPCs verificaban el cupo solo en dos puntos: HOY y la fecha efectiva
--   del nuevo request. Si el cliente pagaba por N meses, los meses
--   intermedios (donde podían entrar/salir otros stores) NO se validaban.
--   Caso concreto que reportó el cliente:
--     - DIAMANTE 2/2 libre
--     - Empresa A pide cambio para "el siguiente mes" (1 mes)
--     - Cliente B pide DIAMANTE por 3 meses empezando HOY
--   Bajo el cap=2 esto está bien (durante el mes solapado son 2 simultáneos),
--   pero bajo otros caps el chequeo lo dejaba pasar erróneamente.
--
-- Solución:
--   Computar el máximo de ocupantes simultáneos durante la ventana
--   [v_effective, v_expires_at] de la nueva solicitud usando un sweep-line
--   sobre tres fuentes:
--     1. Stores activos con ese plan_type (intervalo [hoy/inicio_ventana,
--        contract_expiry_date | +infinito])
--     2. plan_requests 'approved' con [effective_date, expires_at] propio
--     3. plan_requests 'pending' con período computado:
--        [pr.effective_date, pr.effective_date + months * duration_days - 1]
--   Si max_simultáneos + 1 > plan.max_brands → rechazar.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helper: máximo de ocupantes simultáneos en una ventana
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.plan_max_overlap_in_window(
  p_plan_key        TEXT,
  p_window_start    DATE,
  p_window_end      DATE,
  p_exclude_store   UUID,
  p_exclude_request UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max            INTEGER;
  v_plan_duration  INTEGER;
BEGIN
  SELECT duration_days INTO v_plan_duration
    FROM public.plans WHERE plan_key = p_plan_key;
  IF v_plan_duration IS NULL THEN v_plan_duration := 30; END IF;

  WITH events AS (
    -- 1) Stores activos con ese plan_type — su intervalo se considera desde
    -- el inicio de la ventana hasta contract_expiry_date (o "infinito" si NULL).
    SELECT
      p_window_start AS start_d,
      COALESCE(contract_expiry_date, DATE '9999-12-31') AS end_d
    FROM public.stores
    WHERE plan_type = p_plan_key
      AND id IS DISTINCT FROM p_exclude_store
      AND (contract_expiry_date IS NULL OR contract_expiry_date >= p_window_start)

    UNION ALL

    -- 2) Approved con su propio [effective_date, expires_at]
    SELECT
      effective_date,
      COALESCE(expires_at, DATE '9999-12-31')
    FROM public.plan_requests
    WHERE plan_key = p_plan_key
      AND status   = 'approved'
      AND id IS DISTINCT FROM p_exclude_request
      AND effective_date IS NOT NULL

    UNION ALL

    -- 3) Pending con período computado a partir de months_requested
    SELECT
      effective_date,
      effective_date + (COALESCE(months_requested, 1) * v_plan_duration) - 1
    FROM public.plan_requests
    WHERE plan_key = p_plan_key
      AND status   = 'pending'
      AND id IS DISTINCT FROM p_exclude_request
      AND effective_date IS NOT NULL
  ),
  clipped AS (
    SELECT GREATEST(start_d, p_window_start) AS s,
           LEAST(end_d,   p_window_end)   AS e
    FROM events
    WHERE start_d <= p_window_end
      AND end_d   >= p_window_start
  ),
  -- Eventos +1 al inicio, -1 al día siguiente del fin (intervalos inclusivos)
  bd AS (
    SELECT s AS d,                      1 AS delta FROM clipped
    UNION ALL
    SELECT (e + INTERVAL '1 day')::date, -1        FROM clipped
  ),
  cum AS (
    -- ORDER BY (d, delta DESC) → en la misma fecha procesamos los +1 antes
    -- de los -1, para captar correctamente el momento de superposición.
    SELECT SUM(delta) OVER (ORDER BY d, delta DESC) AS c FROM bd
  )
  SELECT COALESCE(MAX(c), 0) INTO v_max FROM cum;

  RETURN v_max;
END $$;

GRANT EXECUTE ON FUNCTION public.plan_max_overlap_in_window(TEXT, DATE, DATE, UUID, UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. request_plan_atomic — usa sweep-line
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
  p_bcv_rate          NUMERIC,
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
  v_effective_date DATE;
  v_expires_at     DATE;
  v_max_overlap    INTEGER;
  v_row            public.plan_requests%ROWTYPE;
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
    IF p_bcv_rate IS NULL OR p_bcv_rate <= 0 THEN
      RAISE EXCEPTION 'Tasa BCV requerida para pagos en Bs' USING ERRCODE = '22023';
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
    SELECT 1 FROM public.plan_requests
     WHERE store_id = p_store_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Ya tienes una solicitud pendiente. Espera la resolución antes de crear otra.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.plan_requests
     WHERE store_id = p_store_id
       AND status   = 'approved'
       AND effective_date IS NOT NULL
       AND effective_date > CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'Tienes un cambio de plan aprobado pendiente de activación. Espera a que entre en vigor antes de pedir otro.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.transactions
     WHERE store_id         = p_store_id
       AND transaction_type = 'plan_payment'
       AND COALESCE(status, 'pending') = 'pending'
  ) THEN
    RAISE EXCEPTION 'Tienes un pago en revisión para esta tienda. Espera a que sea verificado antes de crear otra solicitud.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_store.plan_type IS NOT NULL AND v_store.plan_type = p_plan_key THEN
    RAISE EXCEPTION 'Ya tienes este plan activo. Para extenderlo, registra un pago de renovación.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_store.plan_type IS NULL THEN
    v_effective_date := CURRENT_DATE;
  ELSE
    IF v_store.contract_expiry_date IS NULL THEN
      RAISE EXCEPTION 'No se puede solicitar cambio: tu contrato no tiene fecha de vencimiento configurada. Contacta a la administración.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_store.contract_expiry_date < CURRENT_DATE THEN
      v_effective_date := CURRENT_DATE;
    ELSE
      v_effective_date := v_store.contract_expiry_date + INTERVAL '1 day';
    END IF;
  END IF;

  SELECT * INTO v_plan
    FROM public.plans
   WHERE plan_key = p_plan_key
     AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan % no disponible', p_plan_key USING ERRCODE = 'P0001';
  END IF;

  v_expires_at := v_effective_date + (p_months * v_plan.duration_days) - 1;

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
    effective_date, notes
  ) VALUES (
    p_store_id, p_plan_key, v_user_id, 'pending',
    p_months, p_payment_method,
    NULLIF(trim(coalesce(p_payment_reference,'')), ''),
    NULLIF(trim(coalesce(p_payment_bank,'')), ''),
    p_amount_bs, p_amount_usd, p_bcv_rate,
    v_effective_date, p_notes
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_approve_plan_request — usa sweep-line + mantiene sync de campañas
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_approve_plan_request(UUID);

CREATE OR REPLACE FUNCTION public.admin_approve_plan_request(p_request_id UUID)
RETURNS public.plan_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_req           public.plan_requests%ROWTYPE;
  v_plan          public.plans%ROWTYPE;
  v_store         public.stores%ROWTYPE;
  v_today         DATE := CURRENT_DATE;
  v_effective     DATE;
  v_expires_at    DATE;
  v_max_overlap   INTEGER;
  v_immediate     BOOLEAN;
  v_existing_tx   UUID;
  v_old_plan      TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede aprobar solicitudes' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req
    FROM public.plan_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'La solicitud ya fue resuelta (estado actual: %)', v_req.status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_plan
    FROM public.plans
   WHERE plan_key = v_req.plan_key AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El plan % ya no está activo en el catálogo', v_req.plan_key
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_store FROM public.stores WHERE id = v_req.store_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La tienda asociada ya no existe' USING ERRCODE = 'P0002';
  END IF;

  v_old_plan := v_store.plan_type;

  IF v_store.plan_type IS NULL THEN
    v_effective := v_today;
  ELSIF v_store.plan_type = v_req.plan_key THEN
    RAISE EXCEPTION 'La tienda ya tiene activo el plan solicitado; rechaza esta solicitud manualmente.'
      USING ERRCODE = 'P0001';
  ELSIF v_store.contract_expiry_date IS NULL OR v_store.contract_expiry_date < v_today THEN
    v_effective := v_today;
  ELSE
    v_effective := v_store.contract_expiry_date + INTERVAL '1 day';
  END IF;

  v_expires_at := v_effective + (COALESCE(v_req.months_requested, 1) * v_plan.duration_days) - 1;
  v_immediate  := (v_effective <= v_today);

  PERFORM pg_advisory_xact_lock(hashtextextended('plan_request:' || v_req.plan_key, 0));

  IF v_plan.max_brands IS NOT NULL THEN
    v_max_overlap := public.plan_max_overlap_in_window(
      v_req.plan_key, v_effective, v_expires_at, v_req.store_id, v_req.id
    );

    IF v_max_overlap + 1 > v_plan.max_brands THEN
      RAISE EXCEPTION 'Plan % sin cupo durante el período pagado (%–%): % ocupantes simultáneos, cap=%. Rechaza la solicitud o reorganiza el calendario.',
        v_req.plan_key, v_effective, v_expires_at, v_max_overlap, v_plan.max_brands
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_immediate THEN
    UPDATE public.stores
       SET plan_type            = v_req.plan_key,
           contract_expiry_date = v_expires_at
     WHERE id = v_req.store_id;

    PERFORM public.sync_store_plan_to_campaigns(v_req.store_id, v_old_plan, v_req.plan_key);
  END IF;

  SELECT id INTO v_existing_tx
    FROM public.transactions
   WHERE transaction_type = 'plan_payment'
     AND store_id = v_req.store_id
     AND notes ILIKE '%request_id=' || v_req.id::text || '%'
   LIMIT 1;

  IF v_existing_tx IS NULL THEN
    INSERT INTO public.transactions (
      transaction_type, item_name, amount_usd, amount_bs, exchange_rate,
      payment_method, status, user_email, store_id, payment_date,
      period, months_paid, notes
    ) VALUES (
      'plan_payment',
      format('Activación %s · %s · %s ciclo(s)%s',
             v_plan.name, v_store.name, COALESCE(v_req.months_requested, 1),
             CASE WHEN v_immediate THEN '' ELSE ' (agendado)' END),
      COALESCE(v_req.amount_usd, v_plan.price_usd * COALESCE(v_req.months_requested,1)),
      v_req.amount_bs,
      v_req.bcv_rate,
      COALESCE(v_req.payment_method, 'otro'),
      'completed',
      NULL,
      v_req.store_id,
      v_today,
      to_char(v_effective, 'TMMonth YYYY'),
      COALESCE(v_req.months_requested, 1),
      format(
        'request_id=%s · ref=%s · banco=%s · activa=%s · vence=%s%s',
        v_req.id,
        COALESCE(v_req.payment_reference, '—'),
        COALESCE(v_req.payment_bank, '—'),
        v_effective::text,
        v_expires_at::text,
        CASE WHEN v_immediate THEN '' ELSE ' · AGENDADO' END
      )
    );
  END IF;

  UPDATE public.plan_requests
     SET status         = 'approved',
         expires_at     = v_expires_at,
         effective_date = v_effective,
         resolved_at    = now(),
         resolved_by    = auth.uid()
   WHERE id = v_req.id
   RETURNING * INTO v_req;

  RETURN v_req;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_plan_request(UUID) TO authenticated;
