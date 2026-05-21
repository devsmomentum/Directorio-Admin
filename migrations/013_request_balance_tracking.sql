-- ============================================================================
-- Estado de cuenta por solicitud — saldo pendiente y multi-pago
-- ----------------------------------------------------------------------------
-- Problema previo:
--   admin_approve_plan_request activaba el plan inmediatamente, sin verificar
--   que amount_usd cubriera price_usd × months_requested. Si el cliente
--   reportaba un pago menor, igual se le otorgaba el plan completo.
--
-- Modelo nuevo:
--   * plan_requests gana total_amount_usd (price × ciclos) y paid_amount_usd
--     (suma de pagos APROBADOS contra esta solicitud).
--   * Cada solicitud tiene 1..N transactions enlazadas (transactions.plan_request_id).
--     Cuando el cliente solicita un plan, se crea la solicitud + la PRIMERA
--     transaction en pending. Si después necesita abonar, se crean nuevas
--     transactions también pending enlazadas a la misma solicitud.
--   * El admin aprueba PAGOS, no solicitudes. Al aprobar un pago:
--       - paid_amount_usd += amount_usd del pago.
--       - Si paid_amount_usd >= total_amount_usd → se activa el plan
--         (lógica completa: cupo, fecha efectiva, addon flash vs base,
--         sync de campañas). La solicitud pasa a 'approved'.
--       - Si no alcanza → la solicitud queda en 'partial', y el cliente
--         puede reportar más abonos.
--   * Solicitudes históricas ya 'approved' se marcan liquidadas
--     (paid_amount_usd = total_amount_usd) para no romper el flujo existente.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Schema: columnas nuevas
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plan_requests
  ADD COLUMN IF NOT EXISTS total_amount_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS paid_amount_usd  NUMERIC(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.plan_requests.total_amount_usd IS
  'Costo total de la solicitud (price_usd × ciclos). Se fija al crear y no cambia.';
COMMENT ON COLUMN public.plan_requests.paid_amount_usd IS
  'Suma de transactions.amount_usd aprobadas (status=completed) enlazadas a esta solicitud.';

-- Ampliar CHECK de status para incluir 'partial' (saldo pendiente)
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.plan_requests'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%'
    AND pg_get_constraintdef(oid) ILIKE '%pending%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.plan_requests DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.plan_requests
  ADD CONSTRAINT plan_requests_status_check
  CHECK (status IN ('pending','partial','approved','rejected'));

-- Enlace transactions → plan_requests
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS plan_request_id UUID
    REFERENCES public.plan_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_plan_request_id
  ON public.transactions(plan_request_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Backfill
-- ─────────────────────────────────────────────────────────────────────────────

-- 2a. total_amount_usd: price_usd × months_requested (fallback a amount_usd si
--      el plan ya no existe en el catálogo).
UPDATE public.plan_requests pr
   SET total_amount_usd = COALESCE(
         (SELECT pl.price_usd * COALESCE(pr.months_requested, 1)
            FROM public.plans pl WHERE pl.plan_key = pr.plan_key),
         pr.amount_usd,
         0
       )
 WHERE total_amount_usd IS NULL;

-- 2b. Solicitudes ya 'approved' (históricas) → liquidadas
UPDATE public.plan_requests
   SET paid_amount_usd = total_amount_usd
 WHERE status = 'approved'
   AND paid_amount_usd < COALESCE(total_amount_usd, 0);

-- 2c. Enlazar transactions existentes a su plan_request via notes
UPDATE public.transactions tx
   SET plan_request_id = pr.id
  FROM public.plan_requests pr
 WHERE tx.transaction_type = 'plan_payment'
   AND tx.plan_request_id IS NULL
   AND tx.notes ILIKE '%request_id=' || pr.id::text || '%';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helper: aplica una solicitud al store (activación) cuando se cubre saldo
--    Lógica idéntica a la rama "immediate" de admin_approve_plan_request,
--    extraída para reusar desde admin_approve_plan_payment.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._activate_plan_request(p_request_id UUID)
RETURNS public.plan_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_req         public.plan_requests%ROWTYPE;
  v_plan        public.plans%ROWTYPE;
  v_store       public.stores%ROWTYPE;
  v_today       DATE := CURRENT_DATE;
  v_is_flash    BOOLEAN;
  v_current_key TEXT;
  v_current_exp DATE;
  v_effective   DATE;
  v_expires_at  DATE;
  v_max_overlap INTEGER;
  v_immediate   BOOLEAN;
  v_old_plan    TEXT;
BEGIN
  SELECT * INTO v_req FROM public.plan_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud no encontrada' USING ERRCODE = 'P0002';
  END IF;

  v_is_flash := public.is_flash_coupon_plan(v_req.plan_key);

  SELECT * INTO v_plan FROM public.plans
   WHERE plan_key = v_req.plan_key AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El plan % ya no está activo en el catálogo', v_req.plan_key
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_store FROM public.stores WHERE id = v_req.store_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La tienda asociada ya no existe' USING ERRCODE = 'P0002';
  END IF;

  IF v_is_flash THEN
    v_current_key := v_store.flash_coupon_plan;
    v_current_exp := v_store.flash_coupon_expiry_date;
  ELSE
    v_current_key := v_store.plan_type;
    v_current_exp := v_store.contract_expiry_date;
  END IF;
  v_old_plan := v_current_key;

  IF v_current_key IS NULL OR (v_current_exp IS NOT NULL AND v_current_exp < v_today) THEN
    v_effective := v_today;
  ELSE
    v_effective := COALESCE(v_current_exp, v_today) + INTERVAL '1 day';
  END IF;

  v_expires_at := v_effective + (COALESCE(v_req.months_requested, 1) * v_plan.duration_days) - 1;
  v_immediate  := (v_effective <= v_today);

  PERFORM pg_advisory_xact_lock(hashtextextended('plan_request:' || v_req.plan_key, 0));

  IF v_plan.max_brands IS NOT NULL THEN
    v_max_overlap := public.plan_max_overlap_in_window(
      v_req.plan_key, v_effective, v_expires_at, v_req.store_id, v_req.id
    );
    IF v_max_overlap + 1 > v_plan.max_brands THEN
      RAISE EXCEPTION 'Plan % sin cupo durante el período pagado (%–%): % ocupantes simultáneos, cap=%.',
        v_req.plan_key, v_effective, v_expires_at, v_max_overlap, v_plan.max_brands
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_immediate THEN
    IF v_is_flash THEN
      UPDATE public.stores
         SET flash_coupon_plan        = v_req.plan_key,
             flash_coupon_expiry_date = v_expires_at
       WHERE id = v_req.store_id;
    ELSE
      UPDATE public.stores
         SET plan_type            = v_req.plan_key,
             contract_expiry_date = v_expires_at
       WHERE id = v_req.store_id;
      PERFORM public.sync_store_plan_to_campaigns(v_req.store_id, v_old_plan, v_req.plan_key);
    END IF;
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


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. request_plan_atomic: crea solicitud + 1ra transaction (status=pending)
--    Sólo bloquea nuevas solicitudes si ya hay una activa en el mismo track
--    (la nueva regla de "abonar" usa report_additional_payment_atomic).
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
  v_is_flash       BOOLEAN := public.is_flash_coupon_plan(p_plan_key);
  v_current_key    TEXT;
  v_current_exp    DATE;
  v_effective_date DATE;
  v_expires_at     DATE;
  v_total_cost     NUMERIC(10,2);
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

  -- Pendiente o parcial en este track → no permitir otra solicitud nueva
  -- (para abonar saldo se usa report_additional_payment_atomic)
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

  -- "Aprobado pero aún no activado" (scheduled) en el mismo track
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

  -- El primer pago reportado no puede exceder el costo total del plan.
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
    p_amount_bs, p_amount_usd, p_bcv_rate,
    v_effective_date, p_notes,
    v_total_cost, 0
  )
  RETURNING * INTO v_row;

  -- Primera transaction enlazada (status=pending)
  INSERT INTO public.transactions (
    transaction_type, item_name, amount_usd, amount_bs, exchange_rate,
    payment_method, status, user_email,
    store_id, plan_request_id, payment_date, notes
  ) VALUES (
    'plan_payment',
    format('Solicitud %s · %s · %s ciclo(s)', v_plan.name, v_store.name, p_months),
    COALESCE(p_amount_usd, v_total_cost),
    p_amount_bs,
    p_bcv_rate,
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
-- 5. report_additional_payment_atomic: el cliente abona a una solicitud
--    pending/partial existente (no crea nueva solicitud).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.report_additional_payment_atomic(
  p_request_id        UUID,
  p_payment_method    TEXT,
  p_payment_reference TEXT,
  p_payment_bank      TEXT,
  p_amount_bs         NUMERIC,
  p_amount_usd        NUMERIC,
  p_bcv_rate          NUMERIC,
  p_notes             TEXT DEFAULT NULL
)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id   UUID := auth.uid();
  v_req       public.plan_requests%ROWTYPE;
  v_store     public.stores%ROWTYPE;
  v_plan      public.plans%ROWTYPE;
  v_tx        public.transactions%ROWTYPE;
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
    IF p_bcv_rate IS NULL OR p_bcv_rate <= 0 THEN
      RAISE EXCEPTION 'Tasa BCV requerida para pagos en Bs' USING ERRCODE = '22023';
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

  -- El abono no puede superar el saldo pendiente (total - pagado).
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RAISE EXCEPTION 'Monto del abono inválido' USING ERRCODE = '22023';
  END IF;
  IF p_amount_usd > GREATEST(COALESCE(v_req.total_amount_usd,0) - COALESCE(v_req.paid_amount_usd,0), 0) THEN
    RAISE EXCEPTION 'El abono (% USD) supera el saldo pendiente (% USD). Reporta como máximo el saldo restante.',
      p_amount_usd,
      GREATEST(COALESCE(v_req.total_amount_usd,0) - COALESCE(v_req.paid_amount_usd,0), 0)
      USING ERRCODE = 'P0001';
  END IF;

  -- Bloquear nuevos pagos si ya hay otro pago propio en revisión.
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
    p_bcv_rate,
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

GRANT EXECUTE ON FUNCTION public.report_additional_payment_atomic(
  UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT
) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. admin_approve_plan_payment: rumbo correcto según si la transaction está
--    enlazada a una solicitud (saldo) o no (renovación pura del legacy).
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_approve_plan_payment(UUID);

CREATE OR REPLACE FUNCTION public.admin_approve_plan_payment(p_transaction_id UUID)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tx          public.transactions%ROWTYPE;
  v_req         public.plan_requests%ROWTYPE;
  v_store       public.stores%ROWTYPE;
  v_plan        public.plans%ROWTYPE;
  v_today       DATE := CURRENT_DATE;
  v_start       DATE;
  v_new_expiry  DATE;
  v_new_paid    NUMERIC(10,2);
  v_required    NUMERIC(10,2);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede aprobar pagos' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_tx FROM public.transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transacción no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_tx.transaction_type <> 'plan_payment' THEN
    RAISE EXCEPTION 'La transacción no es de tipo plan_payment' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_tx.status,'pending') = 'completed' THEN
    RAISE EXCEPTION 'Esta transacción ya fue aprobada' USING ERRCODE = 'P0001';
  END IF;
  IF v_tx.amount_usd IS NULL OR v_tx.amount_usd <= 0 THEN
    RAISE EXCEPTION 'La transacción no tiene monto USD válido' USING ERRCODE = '22023';
  END IF;

  -- ─── Caso A: pago enlazado a una plan_request (nuevo flujo) ───────────────
  IF v_tx.plan_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.plan_requests
     WHERE id = v_tx.plan_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La solicitud enlazada ya no existe' USING ERRCODE = 'P0002';
    END IF;
    IF v_req.status IN ('rejected') THEN
      RAISE EXCEPTION 'La solicitud asociada está rechazada; no se puede aprobar este pago.'
        USING ERRCODE = 'P0001';
    END IF;

    v_new_paid := COALESCE(v_req.paid_amount_usd,0) + v_tx.amount_usd;

    -- Marca transaction completada
    UPDATE public.transactions
       SET status = 'completed',
           payment_date = COALESCE(payment_date, v_today),
           notes  = COALESCE(notes,'') ||
                    format(E'\n[APROBADO %s] paid=%s/%s', v_today, v_new_paid, v_req.total_amount_usd)
     WHERE id = v_tx.id
     RETURNING * INTO v_tx;

    -- Actualiza paid_amount_usd y derive status
    UPDATE public.plan_requests
       SET paid_amount_usd = v_new_paid,
           status = CASE
             WHEN v_new_paid >= COALESCE(total_amount_usd, 0) THEN status  -- se setea abajo en _activate
             ELSE 'partial'
           END
     WHERE id = v_req.id
     RETURNING * INTO v_req;

    -- ¿Saldo cubierto? → activa el plan
    IF v_new_paid >= COALESCE(v_req.total_amount_usd, 0) THEN
      PERFORM public._activate_plan_request(v_req.id);
    END IF;

    RETURN v_tx;
  END IF;

  -- ─── Caso B: renovación pura (sin plan_request asociada — legacy) ─────────
  -- Extiende contract_expiry_date validando que cubra el costo proporcional.
  IF v_tx.store_id IS NULL THEN
    RAISE EXCEPTION 'La transacción no tiene tienda asociada' USING ERRCODE = '22023';
  END IF;

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

  v_required := ROUND(v_plan.price_usd * COALESCE(v_tx.months_paid,1), 2);
  IF v_tx.amount_usd < v_required THEN
    RAISE EXCEPTION 'Monto insuficiente para renovación: reportado %s USD, requerido %s USD (%s × %s ciclos). Rechaza el pago o pide al cliente que reporte el faltante.',
      v_tx.amount_usd, v_required, v_plan.price_usd, COALESCE(v_tx.months_paid,1)
      USING ERRCODE = 'P0001';
  END IF;

  IF v_store.contract_expiry_date IS NULL OR v_store.contract_expiry_date < v_today THEN
    v_start := v_today;
  ELSE
    v_start := v_store.contract_expiry_date + INTERVAL '1 day';
  END IF;
  v_new_expiry := v_start + (COALESCE(v_tx.months_paid,1) * v_plan.duration_days) - 1;

  UPDATE public.stores SET contract_expiry_date = v_new_expiry WHERE id = v_store.id;

  UPDATE public.transactions
     SET status = 'completed',
         payment_date = COALESCE(payment_date, v_today),
         notes  = COALESCE(notes,'') ||
                  format(E'\n[APROBADO %s] vigencia %s → %s', v_today, v_start, v_new_expiry)
   WHERE id = v_tx.id
   RETURNING * INTO v_tx;

  RETURN v_tx;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_plan_payment(UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. admin_approve_plan_request: deprecada. La activación pasa por aprobar
--    pagos. Si alguien la llama, le explicamos el cambio.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_approve_plan_request(UUID);

CREATE OR REPLACE FUNCTION public.admin_approve_plan_request(p_request_id UUID)
RETURNS public.plan_requests
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin_approve_plan_request está deprecado. Aprueba los pagos asociados (admin_approve_plan_payment); el plan se activa al cubrirse el saldo total.'
    USING ERRCODE = 'P0001';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. admin_reject_plan_request: ahora también rechaza las transactions
--    pendientes enlazadas (auditoría coherente).
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
DECLARE v_req public.plan_requests%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede rechazar solicitudes' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req FROM public.plan_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status NOT IN ('pending','partial') THEN
    RAISE EXCEPTION 'La solicitud ya fue resuelta (estado actual: %)', v_req.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Rechazar también pagos pendientes asociados (los completed quedan, son ingreso registrado)
  UPDATE public.transactions
     SET status = 'rejected',
         notes  = COALESCE(notes,'') ||
                  CASE WHEN p_reason IS NOT NULL AND length(trim(p_reason))>0
                       THEN E'\n[RECHAZO SOLICITUD] ' || p_reason
                       ELSE '' END
   WHERE plan_request_id = v_req.id
     AND COALESCE(status,'pending') = 'pending';

  UPDATE public.plan_requests
     SET status      = 'rejected',
         notes       = COALESCE(notes,'') ||
                       CASE WHEN p_reason IS NOT NULL AND length(trim(p_reason))>0
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
-- 9. Vista helper: estado de cuenta por solicitud (para UI)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_plan_request_balance AS
SELECT
  pr.id,
  pr.store_id,
  pr.plan_key,
  pr.status,
  pr.total_amount_usd,
  pr.paid_amount_usd,
  GREATEST(COALESCE(pr.total_amount_usd,0) - COALESCE(pr.paid_amount_usd,0), 0) AS outstanding_amount_usd,
  pr.months_requested,
  pr.created_at,
  pr.effective_date,
  pr.expires_at
FROM public.plan_requests pr;

GRANT SELECT ON public.v_plan_request_balance TO authenticated;
