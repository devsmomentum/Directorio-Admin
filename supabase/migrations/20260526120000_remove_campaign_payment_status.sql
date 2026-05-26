-- ============================================================================
-- Remover payment_status y suspended_at de ad_campaigns
-- ----------------------------------------------------------------------------
-- Los pagos son a nivel de plan/tienda (tabla transactions), no por campaña.
-- payment_status/suspended_at en ad_campaigns eran redundantes y rompían el
-- kill-switch: una campaña marcada como 'paid' nunca se desactivaba al vencer.
--
-- Pasos:
--   1. Recrear vistas que referencian payment_status sin esa columna
--   2. Recrear triggers guard_* que copiaban payment_status/suspended_at
--   3. Simplificar apply_kill_switch() para que solo verifique end_date
--   4. DROP CONSTRAINT del CHECK y DROP COLUMN
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Recrear vistas sin payment_status
-- ─────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.v_campaign_impressions;
CREATE VIEW public.v_campaign_impressions AS
SELECT
  c.id          AS campaign_id,
  c.brand_name,
  c.start_date,
  c.end_date,
  c.is_active,
  COALESCE(SUM(d.count) FILTER (WHERE d.day = CURRENT_DATE), 0)::INT      AS today,
  COALESCE(SUM(d.count) FILTER (WHERE d.day >= CURRENT_DATE - 6), 0)::INT AS last_7d,
  COALESCE(SUM(d.count) FILTER (WHERE d.day >= CURRENT_DATE - 29), 0)::INT AS last_30d,
  COALESCE(SUM(d.count), 0)::INT AS total
FROM public.ad_campaigns c
LEFT JOIN public.ad_impressions_daily d ON d.campaign_id = c.id
GROUP BY c.id;

GRANT SELECT ON public.v_campaign_impressions TO authenticated;


DROP VIEW IF EXISTS public.v_loop_status;
CREATE VIEW public.v_loop_status AS
SELECT
  COUNT(*) FILTER (WHERE plan_type = 'DIAMANTE')           AS diamante_count,
  COUNT(*) FILTER (WHERE plan_type = 'ORO')                AS oro_count,
  COUNT(*) FILTER (
    WHERE plan_type IN ('PUBLI_PROMO','PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL')
  )                                                         AS publi_promo_count,
  COUNT(*)                                                  AS loop_slots_used,
  COUNT(*) * 15                                             AS loop_duration_seconds
FROM public.ad_campaigns
WHERE is_active = true
  AND (end_date IS NULL OR end_date >= CURRENT_DATE)
  AND plan_type IN (
    'DIAMANTE','ORO','PUBLI_PROMO',
    'PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL'
  );

COMMENT ON VIEW public.v_loop_status IS
  'Estado del loop publicitario: cuántas marcas activas hay y duración resultante (15s por slot).';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Recrear triggers guard_* sin referencias a payment_status/suspended_at
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_plan_active     BOOLEAN;
  v_other_active    BOOLEAN;
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  -- Bypass para RPC SECURITY DEFINER autorizadas (sync_store_plan_to_campaigns)
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.priority_level := OLD.priority_level;
  NEW.plan_type      := OLD.plan_type;
  NEW.store_id       := OLD.store_id;

  -- Reglas para is_active cuando el dueño edita su propia campaña:
  --  · DESACTIVAR (TRUE -> FALSE): siempre permitido (pausar / liberar slot).
  --  · REACTIVAR  (FALSE -> TRUE): sólo si la tienda no tiene OTRA campaña
  --    activa Y su plan sigue vigente.
  IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
    NULL;
  ELSIF OLD.is_active = FALSE AND NEW.is_active = TRUE THEN
    SELECT (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
      INTO v_plan_active
      FROM public.stores s
     WHERE s.id = NEW.store_id;
    IF NOT COALESCE(v_plan_active, FALSE) THEN
      NEW.is_active := OLD.is_active;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.ad_campaigns c
         WHERE c.store_id  = NEW.store_id
           AND c.is_active = TRUE
           AND c.id        <> NEW.id
      ) INTO v_other_active;
      IF v_other_active THEN
        NEW.is_active := OLD.is_active;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_store_plan TEXT;
  v_expiry     DATE;
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;

  SELECT plan_type, contract_expiry_date
    INTO v_store_plan, v_expiry
    FROM public.stores
   WHERE id = NEW.store_id;

  IF v_store_plan IS NULL THEN
    RAISE EXCEPTION 'Tu tienda no tiene un plan activo. Solicita uno antes de crear campañas.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_expiry IS NULL OR v_expiry < CURRENT_DATE THEN
    RAISE EXCEPTION 'Tu plan está vencido o sin fecha de vencimiento. Renueva antes de crear campañas.'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.plan_applies_to(v_store_plan, 'campaigns') THEN
    RAISE EXCEPTION 'Tu plan (%) no incluye campañas publicitarias.', v_store_plan
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.plan_type <> v_store_plan THEN
    RAISE EXCEPTION 'El plan_type de la campaña (%) debe coincidir con el plan de tu tienda (%).',
      NEW.plan_type, v_store_plan USING ERRCODE = 'P0001';
  END IF;

  NEW.is_active := true;
  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Simplificar apply_kill_switch(): desactivar todas las vencidas activas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_kill_switch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec         RECORD;
  updated_cnt integer := 0;
  today_str   text    := to_char(CURRENT_DATE, 'YYYY-MM-DD');
BEGIN
  FOR rec IN
    SELECT c.id, c.brand_name, c.end_date, s.name AS store_name
    FROM   public.ad_campaigns c
    LEFT JOIN public.stores s ON s.id = c.store_id
    WHERE  c.is_active = true
      AND  c.end_date IS NOT NULL
      AND  c.end_date < CURRENT_DATE
  LOOP
    UPDATE public.ad_campaigns
    SET    is_active = false
    WHERE  id = rec.id;

    INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
    VALUES (
      'info',
      'Campaña vencida desactivada',
      '"' || rec.brand_name || '"' ||
        CASE WHEN rec.store_name IS NOT NULL
             THEN ' (' || rec.store_name || ')'
             ELSE '' END ||
        ' fue desactivada automáticamente. Venció el ' || to_char(rec.end_date, 'DD/MM/YYYY') || '.',
      jsonb_build_object(
        'campaign_id', rec.id,
        'store_name',  rec.store_name,
        'end_date',    rec.end_date
      ),
      'kill_switch_' || rec.id::text || '_' || today_str
    )
    ON CONFLICT (unique_key) DO NOTHING;

    updated_cnt := updated_cnt + 1;
  END LOOP;

  RETURN updated_cnt;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Eliminar columnas
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_payment_status_check;

ALTER TABLE public.ad_campaigns
  DROP COLUMN IF EXISTS payment_status,
  DROP COLUMN IF EXISTS suspended_at;
