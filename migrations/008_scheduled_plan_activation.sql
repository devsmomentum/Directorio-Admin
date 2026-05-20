-- ============================================================================
-- Activación diferida de cambios de plan
-- ----------------------------------------------------------------------------
-- Comportamiento previo:
--   admin_approve_plan_request → cambiaba inmediatamente stores.plan_type al
--   nuevo plan, aunque el contrato vigente no hubiera vencido. Eso "perdía"
--   el plan actual.
--
-- Comportamiento nuevo:
--   - Si la tienda no tiene plan o el contrato ya venció: la aprobación
--     activa el plan inmediatamente (igual que antes).
--   - Si la tienda tiene plan vigente con contract_expiry_date a futuro:
--     la aprobación NO toca stores.plan_type ni stores.contract_expiry_date.
--     El ingreso se registra en finanzas igual (admin confirmó el pago)
--     y la solicitud queda 'approved' con effective_date + expires_at.
--   - Un cron diario corre public.activate_scheduled_plans() que aplica los
--     cambios cuya effective_date llegó.
--   - request_plan_atomic ahora también bloquea si la tienda ya tiene un
--     cambio aprobado pendiente de activación.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. admin_approve_plan_request — activación diferida cuando corresponde
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
  v_immediate     BOOLEAN;
  v_existing_tx   UUID;
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

  -- Recompute effective_date (puede haber cambiado contract_expiry_date desde
  -- la creación de la solicitud)
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

  -- Lock por plan_key para validación de cupo
  PERFORM pg_advisory_xact_lock(hashtextextended('plan_request:' || v_req.plan_key, 0));

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
      + (SELECT count(*) FROM public.plan_requests
          WHERE plan_key = v_req.plan_key
            AND status   = 'approved'
            AND effective_date > v_today
            AND effective_date <= v_effective
            AND id <> v_req.id)
      INTO v_used_future;

    IF v_used_future >= v_plan.max_brands THEN
      RAISE EXCEPTION 'Plan % sin cupo en la fecha de activación % (%/%). Rechaza la solicitud o espera un slot libre.',
        v_req.plan_key, v_effective, v_used_future, v_plan.max_brands
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Solo aplica el cambio en stores SI la fecha efectiva ya llegó.
  -- En caso contrario, el cambio queda agendado: la solicitud sigue como
  -- 'approved' con effective_date a futuro y activate_scheduled_plans() lo
  -- aplicará cuando corresponda.
  IF v_immediate THEN
    UPDATE public.stores
       SET plan_type            = v_req.plan_key,
           contract_expiry_date = v_expires_at
     WHERE id = v_req.store_id;
  END IF;

  -- Registra el ingreso (siempre, admin confirmó el pago)
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


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. request_plan_atomic — bloquear si hay cambio aprobado pendiente
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

  -- Cambio ya aprobado pero aún no activado (effective_date > hoy):
  -- impide encolar otra solicitud encima.
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
     WHERE store_id        = p_store_id
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

  PERFORM pg_advisory_xact_lock(hashtextextended('plan_request:' || p_plan_key, 0));

  IF v_plan.max_brands IS NOT NULL THEN
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

    SELECT
        (SELECT count(*) FROM public.stores
          WHERE plan_type = p_plan_key
            AND id <> p_store_id
            AND (contract_expiry_date IS NULL
                 OR contract_expiry_date >= v_effective_date))
      + (SELECT count(*) FROM public.plan_requests
          WHERE plan_key = p_plan_key AND status = 'pending')
      + (SELECT count(*) FROM public.plan_requests
          WHERE plan_key = p_plan_key
            AND status   = 'approved'
            AND effective_date > CURRENT_DATE
            AND effective_date <= v_effective_date)
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


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. activate_scheduled_plans — corre diariamente
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.activate_scheduled_plans()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec       RECORD;
  v_count   INTEGER := 0;
  v_plan    public.plans%ROWTYPE;
  v_used    INTEGER;
BEGIN
  FOR rec IN
    SELECT pr.*
      FROM public.plan_requests pr
     WHERE pr.status = 'approved'
       AND pr.effective_date IS NOT NULL
       AND pr.effective_date <= CURRENT_DATE
       AND EXISTS (
         SELECT 1 FROM public.stores s
          WHERE s.id = pr.store_id
            AND (s.plan_type IS DISTINCT FROM pr.plan_key
                 OR s.contract_expiry_date IS DISTINCT FROM pr.expires_at)
       )
     ORDER BY pr.effective_date ASC, pr.resolved_at ASC
  LOOP
    -- Re-verifica cupo (entre aprobación y activación el mundo pudo cambiar
    -- si admin tocó manualmente stores.plan_type).
    SELECT * INTO v_plan FROM public.plans WHERE plan_key = rec.plan_key;
    IF FOUND AND v_plan.max_brands IS NOT NULL THEN
      SELECT count(*) INTO v_used
        FROM public.stores
       WHERE plan_type = rec.plan_key
         AND id <> rec.store_id;
      IF v_used >= v_plan.max_brands THEN
        INSERT INTO public.admin_notifications (type, title, message, metadata)
        VALUES (
          'warning',
          'Activación de plan bloqueada por cupo',
          format('No se pudo activar el plan %s para la tienda (request %s): el cupo está lleno (%s/%s).',
                 rec.plan_key, rec.id, v_used, v_plan.max_brands),
          jsonb_build_object('request_id', rec.id, 'store_id', rec.store_id, 'plan_key', rec.plan_key)
        );
        CONTINUE;
      END IF;
    END IF;

    UPDATE public.stores
       SET plan_type            = rec.plan_key,
           contract_expiry_date = rec.expires_at
     WHERE id = rec.store_id;

    INSERT INTO public.admin_notifications (type, title, message, metadata)
    VALUES (
      'info',
      'Plan activado automáticamente',
      format('Se activó el plan %s para la tienda en su fecha agendada (%s).',
             rec.plan_key, rec.effective_date),
      jsonb_build_object('request_id', rec.id, 'store_id', rec.store_id, 'plan_key', rec.plan_key)
    );

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.activate_scheduled_plans() TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Cron diario: 00:05 hora Venezuela (UTC-4 → 04:05 UTC)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- Si ya existe, lo desprograma para reprogramarlo limpio
  PERFORM cron.unschedule(jobid)
    FROM cron.job
   WHERE jobname = 'activate-scheduled-plans-daily';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'activate-scheduled-plans-daily',
  '5 4 * * *',
  $$ SELECT public.activate_scheduled_plans(); $$
);
