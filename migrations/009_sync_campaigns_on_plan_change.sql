-- ============================================================================
-- Sincronizar ad_campaigns cuando una tienda cambia de plan
-- ----------------------------------------------------------------------------
-- Cuando un store pasa de ORO → DIAMANTE (por aprobación inmediata o por la
-- activación agendada del cron), las campañas activas de esa tienda que
-- todavía estaban marcadas con el plan VIEJO deben pasar al plan NUEVO.
-- Las campañas tácticas (PUBLI_PROMO_*, FLASH_COUPON_*) NO se tocan: son
-- contrataciones puntuales independientes del plan-tienda.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Guard de ad_campaigns: permitir bypass controlado desde RPCs autorizadas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  -- Bypass cuando una RPC SECURITY DEFINER autorizada está sincronizando
  -- el plan (sync_store_plan_to_campaigns). El flag se setea con
  -- set_config(..., true) → vive solo en la transacción.
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.payment_status := OLD.payment_status;
  NEW.is_active      := OLD.is_active;
  NEW.suspended_at   := OLD.suspended_at;
  NEW.priority_level := OLD.priority_level;
  NEW.plan_type      := OLD.plan_type;
  NEW.store_id       := OLD.store_id;
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Helper: propagar plan de tienda → campañas activas con el plan VIEJO
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sync_store_plan_to_campaigns(
  p_store_id UUID,
  p_old_plan TEXT,
  p_new_plan TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INTEGER := 0;
BEGIN
  IF p_old_plan IS NULL OR p_new_plan IS NULL OR p_old_plan = p_new_plan THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.bypass_campaign_guard', 'on', true);

  UPDATE public.ad_campaigns
     SET plan_type = p_new_plan
   WHERE store_id  = p_store_id
     AND plan_type = p_old_plan
     AND is_active = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.sync_store_plan_to_campaigns(UUID, TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_approve_plan_request → sincroniza campañas en el caso inmediato
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

  IF v_immediate THEN
    UPDATE public.stores
       SET plan_type            = v_req.plan_key,
           contract_expiry_date = v_expires_at
     WHERE id = v_req.store_id;

    -- Propaga el nuevo plan a las campañas activas con el plan viejo
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


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. activate_scheduled_plans → sincroniza campañas al activar el cambio
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.activate_scheduled_plans()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec        RECORD;
  v_count    INTEGER := 0;
  v_plan     public.plans%ROWTYPE;
  v_used     INTEGER;
  v_old_plan TEXT;
BEGIN
  FOR rec IN
    SELECT pr.*, s.plan_type AS current_plan_type
      FROM public.plan_requests pr
      JOIN public.stores s ON s.id = pr.store_id
     WHERE pr.status = 'approved'
       AND pr.effective_date IS NOT NULL
       AND pr.effective_date <= CURRENT_DATE
       AND (s.plan_type IS DISTINCT FROM pr.plan_key
            OR s.contract_expiry_date IS DISTINCT FROM pr.expires_at)
     ORDER BY pr.effective_date ASC, pr.resolved_at ASC
  LOOP
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

    v_old_plan := rec.current_plan_type;

    UPDATE public.stores
       SET plan_type            = rec.plan_key,
           contract_expiry_date = rec.expires_at
     WHERE id = rec.store_id;

    -- Propaga el cambio a las campañas activas
    PERFORM public.sync_store_plan_to_campaigns(rec.store_id, v_old_plan, rec.plan_key);

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
