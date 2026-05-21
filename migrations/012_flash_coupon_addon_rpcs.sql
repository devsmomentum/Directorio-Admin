-- ============================================================================
-- RPCs adaptadas para Flash Coupon como addon (ver 011_flash_coupon_addon_schema)
-- ----------------------------------------------------------------------------
-- Reescribe:
--   * plan_max_overlap_in_window — considera la columna correcta según si el
--     plan_key es base (plan_type / contract_expiry_date) o flash addon
--     (flash_coupon_plan / flash_coupon_expiry_date).
--   * request_plan_atomic — un cliente puede tener simultáneamente:
--       - 1 solicitud pendiente de plan base + 1 solicitud pendiente de
--         addon flash. La validación "ya tienes una pendiente" ahora es por
--         track (base/flash).
--       - Plan base activo (oro/diamante/...) y a la vez solicitar addon flash
--         sin que se interprete como "cambio de plan".
--   * admin_approve_plan_request — al aprobar un flash plan_key, se actualizan
--     stores.flash_coupon_plan y stores.flash_coupon_expiry_date (no plan_type).
--     No se sincronizan campañas (el addon flash no toca ad_campaigns).
--   * activate_scheduled_plans — soporta ambos tracks.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. plan_max_overlap_in_window: branch por flash vs base
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
  v_is_flash       BOOLEAN := public.is_flash_coupon_plan(p_plan_key);
BEGIN
  SELECT duration_days INTO v_plan_duration
    FROM public.plans WHERE plan_key = p_plan_key;
  IF v_plan_duration IS NULL THEN v_plan_duration := 30; END IF;

  WITH events AS (
    -- 1) Stores activos: usar plan_type/contract_expiry_date para base,
    --    flash_coupon_plan/flash_coupon_expiry_date para flash addon.
    SELECT
      p_window_start AS start_d,
      COALESCE(
        CASE WHEN v_is_flash THEN flash_coupon_expiry_date ELSE contract_expiry_date END,
        DATE '9999-12-31'
      ) AS end_d
    FROM public.stores
    WHERE (CASE WHEN v_is_flash THEN flash_coupon_plan ELSE plan_type END) = p_plan_key
      AND id IS DISTINCT FROM p_exclude_store
      AND (
        (CASE WHEN v_is_flash THEN flash_coupon_expiry_date ELSE contract_expiry_date END) IS NULL
        OR
        (CASE WHEN v_is_flash THEN flash_coupon_expiry_date ELSE contract_expiry_date END) >= p_window_start
      )

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
  bd AS (
    SELECT s AS d,                       1 AS delta FROM clipped
    UNION ALL
    SELECT (e + INTERVAL '1 day')::date, -1         FROM clipped
  ),
  cum AS (
    SELECT SUM(delta) OVER (ORDER BY d, delta DESC) AS c FROM bd
  )
  SELECT COALESCE(MAX(c), 0) INTO v_max FROM cum;

  RETURN v_max;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. request_plan_atomic: soporte addon flash (pending por track, no choca con
--    plan base, expiry independiente)
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

  -- "Pendiente en este track": base solo bloquea base; flash solo bloquea flash.
  IF EXISTS (
    SELECT 1 FROM public.plan_requests pr
     WHERE pr.store_id = p_store_id
       AND pr.status   = 'pending'
       AND public.is_flash_coupon_plan(pr.plan_key) = v_is_flash
  ) THEN
    RAISE EXCEPTION 'Ya tienes una solicitud pendiente para este tipo de plan. Espera la resolución antes de crear otra.'
      USING ERRCODE = 'P0001';
  END IF;

  -- "Aprobado pero aún no activado" en el mismo track
  IF EXISTS (
    SELECT 1 FROM public.plan_requests pr
     WHERE pr.store_id = p_store_id
       AND pr.status   = 'approved'
       AND pr.effective_date IS NOT NULL
       AND pr.effective_date > CURRENT_DATE
       AND public.is_flash_coupon_plan(pr.plan_key) = v_is_flash
  ) THEN
    RAISE EXCEPTION 'Tienes un cambio aprobado pendiente de activación en este tipo de plan. Espera a que entre en vigor antes de pedir otro.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Transacciones pendientes — chequeo global (un pago en revisión bloquea
  -- todo, sea base o flash). Mantiene consistencia con finanzas.
  IF EXISTS (
    SELECT 1 FROM public.transactions
     WHERE store_id         = p_store_id
       AND transaction_type = 'plan_payment'
       AND COALESCE(status, 'pending') = 'pending'
  ) THEN
    RAISE EXCEPTION 'Tienes un pago en revisión para esta tienda. Espera a que sea verificado antes de crear otra solicitud.'
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
      -- Plan vigente sin vencimiento → admin debe configurar uno antes de cambiar.
      RAISE EXCEPTION 'No se puede solicitar cambio: tu %s no tiene fecha de vencimiento configurada. Contacta a la administración.',
        CASE WHEN v_is_flash THEN 'addon Flash Coupon' ELSE 'contrato' END
        USING ERRCODE = 'P0001';
    END IF;
    v_effective_date := v_current_exp + INTERVAL '1 day';
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
-- 3. admin_approve_plan_request: aplica a addon flash cuando corresponda
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
  v_is_flash      BOOLEAN;
  v_current_key   TEXT;
  v_current_exp   DATE;
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

  SELECT * INTO v_req FROM public.plan_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'La solicitud ya fue resuelta (estado actual: %)', v_req.status
      USING ERRCODE = 'P0001';
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

  IF v_current_key IS NOT NULL AND v_current_key = v_req.plan_key
     AND (v_current_exp IS NULL OR v_current_exp >= v_today) THEN
    RAISE EXCEPTION 'La tienda ya tiene activo el plan solicitado; rechaza esta solicitud manualmente.'
      USING ERRCODE = 'P0001';
  END IF;

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
      RAISE EXCEPTION 'Plan % sin cupo durante el período pagado (%–%): % ocupantes simultáneos, cap=%. Rechaza la solicitud o reorganiza el calendario.',
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
      -- Addon flash no afecta ad_campaigns; no se llama sync_store_plan_to_campaigns.
    ELSE
      UPDATE public.stores
         SET plan_type            = v_req.plan_key,
             contract_expiry_date = v_expires_at
       WHERE id = v_req.store_id;
      PERFORM public.sync_store_plan_to_campaigns(v_req.store_id, v_old_plan, v_req.plan_key);
    END IF;
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
-- 4. activate_scheduled_plans: aplica al track correcto (base o flash)
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
  v_is_flash BOOLEAN;
  v_old_plan TEXT;
BEGIN
  FOR rec IN
    SELECT pr.*,
           s.plan_type           AS current_plan_type,
           s.flash_coupon_plan   AS current_flash_plan
      FROM public.plan_requests pr
      JOIN public.stores s ON s.id = pr.store_id
     WHERE pr.status = 'approved'
       AND pr.effective_date IS NOT NULL
       AND pr.effective_date <= CURRENT_DATE
       AND (
         (NOT public.is_flash_coupon_plan(pr.plan_key)
          AND (s.plan_type IS DISTINCT FROM pr.plan_key
               OR s.contract_expiry_date IS DISTINCT FROM pr.expires_at))
         OR
         (public.is_flash_coupon_plan(pr.plan_key)
          AND (s.flash_coupon_plan IS DISTINCT FROM pr.plan_key
               OR s.flash_coupon_expiry_date IS DISTINCT FROM pr.expires_at))
       )
     ORDER BY pr.effective_date ASC, pr.resolved_at ASC
  LOOP
    v_is_flash := public.is_flash_coupon_plan(rec.plan_key);

    SELECT * INTO v_plan FROM public.plans WHERE plan_key = rec.plan_key;
    IF FOUND AND v_plan.max_brands IS NOT NULL THEN
      IF v_is_flash THEN
        SELECT count(*) INTO v_used
          FROM public.stores
         WHERE flash_coupon_plan = rec.plan_key
           AND id <> rec.store_id;
      ELSE
        SELECT count(*) INTO v_used
          FROM public.stores
         WHERE plan_type = rec.plan_key
           AND id <> rec.store_id;
      END IF;

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

    IF v_is_flash THEN
      UPDATE public.stores
         SET flash_coupon_plan        = rec.plan_key,
             flash_coupon_expiry_date = rec.expires_at
       WHERE id = rec.store_id;
    ELSE
      v_old_plan := rec.current_plan_type;
      UPDATE public.stores
         SET plan_type            = rec.plan_key,
             contract_expiry_date = rec.expires_at
       WHERE id = rec.store_id;
      PERFORM public.sync_store_plan_to_campaigns(rec.store_id, v_old_plan, rec.plan_key);
    END IF;

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
