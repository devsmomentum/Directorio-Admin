-- ============================================================================
-- RPCs de aprobación admin: solicitudes de plan (plan_requests) y
-- renovaciones (transactions plan_payment).
-- ----------------------------------------------------------------------------
-- Diseño:
--   * Las RPCs corren en SECURITY DEFINER con auth.uid() = admin.
--   * Para concurrencia entre admins se usa:
--       - SELECT ... FOR UPDATE sobre la fila (plan_request o transaction):
--         el primer admin obtiene el lock; el segundo espera. Cuando el
--         primero hace COMMIT, el segundo ve status<>'pending' y aborta.
--       - pg_advisory_xact_lock(plan_key) cuando se va a tocar el cupo del
--         plan, replicando la misma serialización que usa request_plan_atomic.
--   * Al aprobar, se asegura:
--       - Que el cupo (max_brands) aún se respete en la fecha efectiva.
--       - Se actualiza stores.plan_type y stores.contract_expiry_date.
--       - Se inserta/actualiza una transactions con status='completed' para
--         que finanzas la cuente como ingreso bruto.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. transactions: columna months_paid + relajar RLS para que el RPC SECURITY
--    DEFINER pueda insertar la fila aprobada (los inserts admin ya pasan, pero
--    queremos también auditarlas como completed desde el path de solicitud).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS months_paid INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_months_paid_check'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_months_paid_check
      CHECK (months_paid IS NULL OR months_paid >= 1);
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.months_paid IS 'Ciclos (de duration_days del plan) cubiertos por el pago. Usado al aprobar para extender contract_expiry_date.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RPC: admin_approve_plan_request
--    Aprueba una solicitud de plan inicial / cambio.
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
  v_used_future   INTEGER;
  v_existing_tx   UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede aprobar solicitudes' USING ERRCODE = '42501';
  END IF;

  -- Lock pesimista de la fila: el segundo admin queda esperando aquí.
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

  -- Plan
  SELECT * INTO v_plan
    FROM public.plans
   WHERE plan_key = v_req.plan_key AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El plan % ya no está activo en el catálogo', v_req.plan_key
      USING ERRCODE = 'P0001';
  END IF;

  -- Tienda
  SELECT * INTO v_store FROM public.stores WHERE id = v_req.store_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La tienda asociada ya no existe' USING ERRCODE = 'P0002';
  END IF;

  -- Fecha efectiva (igual lógica que request_plan_atomic, recomputada por si
  -- el contract_expiry_date cambió desde la creación de la solicitud).
  IF v_store.plan_type IS NULL THEN
    v_effective := v_today;
  ELSIF v_store.plan_type = v_req.plan_key THEN
    -- Caso raro: solicitud quedó pendiente y admin ya le había puesto el plan
    -- manualmente. La rechazamos para que el admin la marque rejected.
    RAISE EXCEPTION 'La tienda ya tiene activo el plan solicitado; rechaza esta solicitud manualmente.'
      USING ERRCODE = 'P0001';
  ELSIF v_store.contract_expiry_date IS NULL THEN
    v_effective := v_today;
  ELSIF v_store.contract_expiry_date < v_today THEN
    v_effective := v_today;
  ELSE
    v_effective := v_store.contract_expiry_date + INTERVAL '1 day';
  END IF;

  v_expires_at := v_effective + (COALESCE(v_req.months_requested, 1) * v_plan.duration_days) - 1;

  -- Serializa la verificación de cupo por plan_key
  PERFORM pg_advisory_xact_lock(hashtextextended('plan_request:' || v_req.plan_key, 0));

  -- Cupo en la fecha efectiva: stores que aún ocupan slot + otras solicitudes
  -- pendientes (excluida esta).
  IF v_plan.max_brands IS NOT NULL THEN
    SELECT
        (SELECT count(*) FROM public.stores
          WHERE plan_type = v_req.plan_key
            AND id <> v_req.store_id
            AND (contract_expiry_date IS NULL
                 OR contract_expiry_date >= v_effective))
      + (SELECT count(*) FROM public.plan_requests
          WHERE plan_key = v_req.plan_key
            AND status   = 'pending'
            AND id <> v_req.id)
      INTO v_used_future;

    IF v_used_future >= v_plan.max_brands THEN
      RAISE EXCEPTION 'Plan % sin cupo en la fecha de activación % (%/%). Rechaza la solicitud o espera un slot libre.',
        v_req.plan_key, v_effective, v_used_future, v_plan.max_brands
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Actualiza tienda
  UPDATE public.stores
     SET plan_type            = v_req.plan_key,
         contract_expiry_date = v_expires_at
   WHERE id = v_req.store_id;

  -- Registra la transacción como ingreso (status=completed para finanzas).
  -- Evita duplicar si ya existe una transaction enlazada a esta request via notes.
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
      format('Activación %s · %s · %s ciclo(s)', v_plan.name, v_store.name, COALESCE(v_req.months_requested, 1)),
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
        'request_id=%s · ref=%s · banco=%s · activa=%s · vence=%s',
        v_req.id,
        COALESCE(v_req.payment_reference, '—'),
        COALESCE(v_req.payment_bank, '—'),
        v_effective::text,
        v_expires_at::text
      )
    );
  END IF;

  -- Marca la solicitud como aprobada
  UPDATE public.plan_requests
     SET status      = 'approved',
         expires_at  = v_expires_at,
         effective_date = v_effective,
         resolved_at = now(),
         resolved_by = auth.uid()
   WHERE id = v_req.id
   RETURNING * INTO v_req;

  RETURN v_req;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_plan_request(UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RPC: admin_reject_plan_request
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_reject_plan_request(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.admin_reject_plan_request(
  p_request_id UUID,
  p_reason     TEXT DEFAULT NULL
)
RETURNS public.plan_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_req public.plan_requests%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede rechazar solicitudes' USING ERRCODE = '42501';
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

  UPDATE public.plan_requests
     SET status      = 'rejected',
         notes       = COALESCE(notes, '') ||
                       CASE WHEN p_reason IS NOT NULL AND length(trim(p_reason)) > 0
                            THEN E'\n[RECHAZO] ' || p_reason
                            ELSE '' END,
         resolved_at = now(),
         resolved_by = auth.uid()
   WHERE id = v_req.id
   RETURNING * INTO v_req;

  RETURN v_req;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_reject_plan_request(UUID, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RPC: admin_approve_plan_payment (renovación)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_approve_plan_payment(UUID);

CREATE OR REPLACE FUNCTION public.admin_approve_plan_payment(p_transaction_id UUID)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tx           public.transactions%ROWTYPE;
  v_store        public.stores%ROWTYPE;
  v_plan         public.plans%ROWTYPE;
  v_today        DATE := CURRENT_DATE;
  v_start        DATE;
  v_new_expiry   DATE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede aprobar pagos' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transacción no encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_tx.transaction_type <> 'plan_payment' THEN
    RAISE EXCEPTION 'La transacción no es de tipo plan_payment' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(v_tx.status, 'pending') = 'completed' THEN
    RAISE EXCEPTION 'Esta transacción ya fue aprobada' USING ERRCODE = 'P0001';
  END IF;

  IF v_tx.store_id IS NULL THEN
    RAISE EXCEPTION 'La transacción no tiene tienda asociada' USING ERRCODE = '22023';
  END IF;

  -- Tienda
  SELECT * INTO v_store FROM public.stores WHERE id = v_tx.store_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La tienda asociada ya no existe' USING ERRCODE = 'P0002';
  END IF;

  IF v_store.plan_type IS NULL THEN
    RAISE EXCEPTION 'La tienda no tiene plan activo; no se puede renovar' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_plan FROM public.plans WHERE plan_key = v_store.plan_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El plan % no existe en el catálogo', v_store.plan_type USING ERRCODE = 'P0002';
  END IF;

  -- Cálculo de extensión
  IF v_store.contract_expiry_date IS NULL OR v_store.contract_expiry_date < v_today THEN
    v_start := v_today;
  ELSE
    v_start := v_store.contract_expiry_date + INTERVAL '1 day';
  END IF;

  v_new_expiry := v_start + (COALESCE(v_tx.months_paid, 1) * v_plan.duration_days) - 1;

  -- Extiende vencimiento de la tienda
  UPDATE public.stores
     SET contract_expiry_date = v_new_expiry
   WHERE id = v_store.id;

  -- Marca la transacción como ingreso
  UPDATE public.transactions
     SET status       = 'completed',
         payment_date = COALESCE(payment_date, v_today),
         notes        = COALESCE(notes, '') ||
                        format(E'\n[APROBADO %s] vigencia %s → %s',
                               v_today, v_start, v_new_expiry)
   WHERE id = v_tx.id
   RETURNING * INTO v_tx;

  RETURN v_tx;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_plan_payment(UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RPC: admin_reject_plan_payment
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_reject_plan_payment(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.admin_reject_plan_payment(
  p_transaction_id UUID,
  p_reason         TEXT DEFAULT NULL
)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede rechazar pagos' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transacción no encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_tx.status, 'pending') <> 'pending' THEN
    RAISE EXCEPTION 'La transacción no está pendiente (estado: %)', COALESCE(v_tx.status, 'pending')
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.transactions
     SET status = 'rejected',
         notes  = COALESCE(notes, '') ||
                  CASE WHEN p_reason IS NOT NULL AND length(trim(p_reason)) > 0
                       THEN E'\n[RECHAZO] ' || p_reason
                       ELSE '' END
   WHERE id = v_tx.id
   RETURNING * INTO v_tx;

  RETURN v_tx;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_reject_plan_payment(UUID, TEXT) TO authenticated;
