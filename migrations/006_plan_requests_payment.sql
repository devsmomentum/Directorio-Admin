-- ============================================================================
-- Solicitudes de plan con datos de pago + verificación atómica de cupo
-- ----------------------------------------------------------------------------
-- 1) Extiende plan_requests con campos del pago reportado por el cliente
--    (método, referencia, banco, monto en Bs/USD, tasa BCV), vencimiento del
--    plan y la fecha en que el cambio entra en vigor.
-- 2) Crea RPC public.request_plan_atomic(...) que:
--      - Determina effective_date: hoy si la tienda no tiene plan, o el día
--        siguiente al contract_expiry_date si ya tiene plan vigente.
--      - Bloquea si la tienda ya tiene ese mismo plan, si ya tiene una
--        solicitud pendiente, o si no hay fecha de vencimiento (admin debe
--        configurarla).
--      - Verifica disponibilidad bajo advisory lock POR plan_key TANTO en la
--        fecha actual COMO en la fecha efectiva (más estricto: rechaza si hoy
--        está lleno aunque mañana se libere).
--      - Inserta atómicamente la solicitud.
-- 3) Endurece RLS: el cliente debe pasar siempre por la RPC.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columnas nuevas en plan_requests
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plan_requests
  ADD COLUMN IF NOT EXISTS months_requested  INTEGER,
  ADD COLUMN IF NOT EXISTS payment_method    TEXT,
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_bank      TEXT,
  ADD COLUMN IF NOT EXISTS amount_bs         NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS amount_usd        NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS bcv_rate          NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS effective_date    DATE,
  ADD COLUMN IF NOT EXISTS expires_at        DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_requests_months_requested_check'
  ) THEN
    ALTER TABLE public.plan_requests
      ADD CONSTRAINT plan_requests_months_requested_check
      CHECK (months_requested IS NULL OR months_requested >= 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_requests_payment_method_check'
  ) THEN
    ALTER TABLE public.plan_requests
      ADD CONSTRAINT plan_requests_payment_method_check
      CHECK (payment_method IS NULL OR payment_method = ANY (ARRAY[
        'transfer_bs',
        'transfer_usd',
        'cash_usd',
        'cash_bs'
      ]));
  END IF;
END $$;

COMMENT ON COLUMN public.plan_requests.months_requested  IS 'Ciclos (de duration_days) que el cliente quiere pagar por adelantado.';
COMMENT ON COLUMN public.plan_requests.payment_method    IS 'transfer_bs | transfer_usd | cash_usd | cash_bs';
COMMENT ON COLUMN public.plan_requests.payment_reference IS 'Número de referencia bancaria completo (solo para transferencias).';
COMMENT ON COLUMN public.plan_requests.payment_bank      IS 'Banco o plataforma emisora (solo para transferencias).';
COMMENT ON COLUMN public.plan_requests.amount_bs         IS 'Monto pagado en bolívares (transfer_bs / cash_bs).';
COMMENT ON COLUMN public.plan_requests.amount_usd        IS 'Monto pagado en USD; siempre se guarda el equivalente al precio del plan × ciclos.';
COMMENT ON COLUMN public.plan_requests.bcv_rate          IS 'Tasa BCV declarada (solo para métodos en Bs).';
COMMENT ON COLUMN public.plan_requests.effective_date    IS 'Fecha en que el plan solicitado entra en vigor (hoy para tiendas sin plan; día siguiente al contract_expiry_date si ya tienen plan).';
COMMENT ON COLUMN public.plan_requests.expires_at        IS 'Fecha de vencimiento del plan; la fija el admin al aprobar.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RPC: request_plan_atomic
--    Atomicidad: advisory lock por plan_key. Verifica cupo en HOY y en la
--    fecha efectiva. Bloquea solicitudes inválidas según el estado del store.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop firmas anteriores para reaplicar sin conflictos
DROP FUNCTION IF EXISTS public.request_plan_atomic(UUID, TEXT, INTEGER, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.request_plan_atomic(UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT);

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
  v_used_today     INTEGER;
  v_used_future    INTEGER;
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

  -- Validación de campos requeridos por método
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

  -- Estado de la tienda
  SELECT * INTO v_store FROM public.stores WHERE id = p_store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tienda no encontrada' USING ERRCODE = 'P0002';
  END IF;

  -- ¿Ya tiene una solicitud pendiente? (cualquier plan)
  IF EXISTS (
    SELECT 1 FROM public.plan_requests
     WHERE store_id = p_store_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Ya tienes una solicitud pendiente. Espera la resolución antes de crear otra.'
      USING ERRCODE = 'P0001';
  END IF;

  -- ¿Ya tiene un pago/renovación pendiente para esta tienda?
  IF EXISTS (
    SELECT 1 FROM public.transactions
     WHERE store_id        = p_store_id
       AND transaction_type = 'plan_payment'
       AND COALESCE(status, 'pending') = 'pending'
  ) THEN
    RAISE EXCEPTION 'Tienes un pago en revisión para esta tienda. Espera a que sea verificado antes de crear otra solicitud.'
      USING ERRCODE = 'P0001';
  END IF;

  -- ¿Pide el mismo plan que ya tiene activo?
  IF v_store.plan_type IS NOT NULL AND v_store.plan_type = p_plan_key THEN
    RAISE EXCEPTION 'Ya tienes este plan activo. Para extenderlo, registra un pago de renovación.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Cálculo de fecha efectiva
  IF v_store.plan_type IS NULL THEN
    -- Sin plan vigente → activa hoy
    v_effective_date := CURRENT_DATE;
  ELSE
    -- Cambio de plan → activa al día siguiente del vencimiento
    IF v_store.contract_expiry_date IS NULL THEN
      RAISE EXCEPTION 'No se puede solicitar cambio: tu contrato no tiene fecha de vencimiento configurada. Contacta a la administración.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_store.contract_expiry_date < CURRENT_DATE THEN
      -- Contrato ya venció → puede entrar en vigor hoy
      v_effective_date := CURRENT_DATE;
    ELSE
      v_effective_date := v_store.contract_expiry_date + INTERVAL '1 day';
    END IF;
  END IF;

  -- Validar plan
  SELECT * INTO v_plan
    FROM public.plans
   WHERE plan_key = p_plan_key
     AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan % no disponible', p_plan_key USING ERRCODE = 'P0001';
  END IF;

  -- Serializa concurrencia por plan_key
  PERFORM pg_advisory_xact_lock(hashtextextended('plan_request:' || p_plan_key, 0));

  -- Cupo: verifica HOY y en la fecha efectiva (más estricto).
  -- Se excluye la propia tienda del conteo (libera su slot al cambiar de plan).
  IF v_plan.max_brands IS NOT NULL THEN
    -- HOY: stores activas con ese plan + solicitudes pendientes para ese plan
    SELECT
        (SELECT count(*) FROM public.stores
          WHERE plan_type = p_plan_key
            AND id <> p_store_id)
      + (SELECT count(*) FROM public.plan_requests
          WHERE plan_key = p_plan_key AND status = 'pending')
      INTO v_used_today;

    IF v_used_today >= v_plan.max_brands THEN
      RAISE EXCEPTION 'Plan % sin cupo disponible hoy (%/%)',
        p_plan_key, v_used_today, v_plan.max_brands
        USING ERRCODE = 'P0001';
    END IF;

    -- FECHA EFECTIVA: stores que aún ocuparán slot en esa fecha
    -- (contract_expiry_date NULL = sin vencimiento conocido, asumimos siguen)
    SELECT
        (SELECT count(*) FROM public.stores
          WHERE plan_type = p_plan_key
            AND id <> p_store_id
            AND (contract_expiry_date IS NULL
                 OR contract_expiry_date >= v_effective_date))
      + (SELECT count(*) FROM public.plan_requests
          WHERE plan_key = p_plan_key AND status = 'pending')
      INTO v_used_future;

    IF v_used_future >= v_plan.max_brands THEN
      RAISE EXCEPTION 'Plan % sin cupo disponible para la fecha de cambio % (%/%)',
        p_plan_key, v_effective_date, v_used_future, v_plan.max_brands
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

GRANT EXECUTE ON FUNCTION public.request_plan_atomic(
  UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT
) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS: el cliente ya NO inserta directamente; obligado a usar la RPC
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "plan_requests_owner_insert" ON public.plan_requests;
