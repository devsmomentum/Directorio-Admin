-- ============================================================================
-- Fix: notificaciones repetidas en el panel de admin
--
-- Problema A: notify_expired_plans() usaba today_str en el unique_key,
--   generando una notificación NUEVA por cada día que el plan seguía vencido.
--   Fix: usar la fecha de vencimiento del plan (inmutable) como discriminador.
--
-- Problema B: activate_scheduled_plans() insertaba sin unique_key,
--   permitiendo duplicados si el cron procesaba la misma solicitud más de una vez.
--   Fix: unique_key = 'plan_activated_' || request_id (idempotente).
--   Bonus: incluir el nombre de la tienda en el mensaje.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- Fix A: notify_expired_plans — unique_key por fecha de vencimiento del plan,
--        no por fecha de hoy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_expired_plans()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count integer := 0;
BEGIN
  INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
  SELECT
    'error' AS type,
    'Plan vencido sin renovar' AS title,
    'El plan de la tienda "' || s.name || '" venció el ' ||
      to_char(s.contract_expiry_date, 'DD/MM/YYYY') || '.' AS message,
    jsonb_build_object(
      'store_id',             s.id,
      'store_name',           s.name,
      'plan_type',            s.plan_type,
      'contract_expiry_date', s.contract_expiry_date
    ) AS metadata,
    -- Discriminador por fecha de vencimiento del plan (no por hoy):
    -- una sola notificación por ciclo de vencimiento.
    'expired_plan_' || s.id::text || '_exp_' || to_char(s.contract_expiry_date, 'YYYY-MM-DD') AS unique_key
  FROM public.stores s
  WHERE s.contract_expiry_date IS NOT NULL
    AND s.contract_expiry_date < CURRENT_DATE
  ON CONFLICT (unique_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Fix B: activate_scheduled_plans — unique_key por request_id + nombre de tienda.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.activate_scheduled_plans()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
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
           s.flash_coupon_plan   AS current_flash_plan,
           s.name                AS store_name
      FROM public.plan_requests pr
      JOIN public.stores s ON s.id = pr.store_id
     WHERE pr.status = 'approved'
       AND pr.effective_date IS NOT NULL
       AND pr.effective_date <= CURRENT_DATE
       AND COALESCE(pr.expires_at, DATE '9999-12-31') >= CURRENT_DATE
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
        INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
        VALUES (
          'warning',
          'Activación de plan bloqueada por cupo',
          format('No se pudo activar el plan %s para "%s" (solicitud %s): el cupo está lleno (%s/%s).',
                 rec.plan_key, rec.store_name, rec.id, v_used, v_plan.max_brands),
          jsonb_build_object('request_id', rec.id, 'store_id', rec.store_id, 'plan_key', rec.plan_key),
          'plan_blocked_' || rec.id::text
        )
        ON CONFLICT (unique_key) DO NOTHING;
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

    INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
    VALUES (
      'info',
      'Plan activado automáticamente',
      format('Se activó el plan %s para "%s" en su fecha agendada (%s).',
             rec.plan_key, rec.store_name, rec.effective_date),
      jsonb_build_object('request_id', rec.id, 'store_id', rec.store_id, 'plan_key', rec.plan_key),
      'plan_activated_' || rec.id::text
    )
    ON CONFLICT (unique_key) DO NOTHING;

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
