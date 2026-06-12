-- =====================================================================
-- Tope de inventario de cupones por tienda - Límite general por Plan/Addon
-- y que incluye los cupones canjeados (coupon_leads).
-- =====================================================================

-- 1. Revertir columna temporal en stores si existía
ALTER TABLE public.stores DROP COLUMN IF EXISTS coupon_stock_cap;

-- 2. Agregar columna coupon_stock_cap a public.plans si no existe
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS coupon_stock_cap integer;

-- 3. Función helper para obtener el tope de cupones de una tienda de forma dinámica.
--    Busca en plans.coupon_stock_cap del addon y fallback a 20.
CREATE OR REPLACE FUNCTION public.store_coupon_stock_cap(p_store_id uuid)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_cap INT;
BEGIN
  -- Intentar obtener el tope del plan/addon asignado
  SELECT p.coupon_stock_cap INTO v_cap
    FROM public.stores s
    JOIN public.plans p ON s.flash_coupon_plan = p.plan_key
   WHERE s.id = p_store_id;

  -- Fallback por defecto si no hay addon o el límite es NULL
  RETURN COALESCE(v_cap, 20);
END;
$$;
GRANT EXECUTE ON FUNCTION public.store_coupon_stock_cap(uuid) TO authenticated;

-- 4. Actualizar store_coupon_stock_used para sumar el stock disponible Y las reservas (leads)
--    de cupones activos (no rechazados, no vencidos).
CREATE OR REPLACE FUNCTION public.store_coupon_stock_used(p_store_id uuid, p_exclude uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT (
    COALESCE((
      SELECT SUM(amount_available)
        FROM public.coupons
       WHERE store_id = p_store_id
         AND plan_type IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL')
         AND approval_status <> 'rejected'
         AND end_date >= now()
         AND (p_exclude IS NULL OR id <> p_exclude)
    ), 0) +
    COALESCE((
      SELECT COUNT(cl.id)
        FROM public.coupon_leads cl
        JOIN public.coupons c ON cl.coupon_id = c.id
       WHERE c.store_id = p_store_id
         AND c.plan_type IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL')
         AND c.approval_status <> 'rejected'
         AND c.end_date >= now()
         AND (p_exclude IS NULL OR c.id <> p_exclude)
    ), 0)
  )::int;
$$;
GRANT EXECUTE ON FUNCTION public.store_coupon_stock_used(uuid, uuid) TO authenticated;

-- 5. Actualizar triggers de guard de cupones para aplicar el tope dinámico general
CREATE OR REPLACE FUNCTION public.guard_coupons_owner_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
DECLARE
  v_store_plan TEXT;
  v_expiry     DATE;
  v_is_owner   BOOLEAN;
  v_cap        INTEGER;
BEGIN
  v_is_owner := NEW.store_id IS NOT NULL AND public.user_can_manage_ads(NEW.store_id);

  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;

  IF NOT public.is_flash_coupon_plan(NEW.plan_type) THEN
    IF NEW.plan_type IN ('BONO_PREMIADO','PUBLI_PROMO') THEN
      RAISE EXCEPTION 'El plan_type % es legacy/administrativo; sólo el admin puede usarlo.',
        NEW.plan_type USING ERRCODE = '42501';
    END IF;

    SELECT plan_type, contract_expiry_date
      INTO v_store_plan, v_expiry
      FROM public.stores
     WHERE id = NEW.store_id;

    IF v_store_plan IS NULL THEN
      RAISE EXCEPTION 'Tu tienda no tiene plan base activo. Para subir cupones flash adquiere el addon Flash Coupon.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_expiry IS NULL OR v_expiry < CURRENT_DATE THEN
      RAISE EXCEPTION 'Tu plan está vencido o sin fecha de vencimiento. Renueva antes de subir cupones.'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT public.plan_applies_to(v_store_plan, 'coupons') THEN
      RAISE EXCEPTION 'Tu plan (%) no incluye cupones.', v_store_plan
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.plan_type <> v_store_plan THEN
      RAISE EXCEPTION 'El plan_type del cupón (%) debe coincidir con el plan de tu tienda (%) o ser FLASH_COUPON_* con addon activo.',
        NEW.plan_type, v_store_plan USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Tope de inventario flash por tienda (suma de stock vigente <= v_cap).
  v_cap := public.store_coupon_stock_cap(NEW.store_id);
  IF public.is_flash_coupon_plan(NEW.plan_type)
     AND public.store_coupon_stock_used(NEW.store_id, NEW.id) + COALESCE(NEW.amount_available, 0) > v_cap THEN
    RAISE EXCEPTION 'Superas el tope de % cupones de tu tienda. Ya tienes % en stock vigente (incluye canjeados); reduce el stock o espera a que venza/se canjee.',
      v_cap, public.store_coupon_stock_used(NEW.store_id, NEW.id) USING ERRCODE = 'P0001';
  END IF;

  NEW.is_active        := false;
  NEW.approval_status  := 'pending';
  NEW.rejection_reason := NULL;
  NEW.reviewed_at      := NULL;
  NEW.reviewed_by      := NULL;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_coupons_owner_update()
RETURNS trigger LANGUAGE plpgsql
AS $function$
DECLARE
  v_content_changed BOOLEAN;
  v_is_owner        BOOLEAN;
  v_cap             INTEGER;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_can_manage_ads(OLD.store_id);
  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.bypass_coupon_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  NEW.store_id    := OLD.store_id;
  NEW.plan_type   := OLD.plan_type;
  NEW.code        := OLD.code;
  NEW.campaign_id := OLD.campaign_id;

  -- Tope de inventario flash por tienda al editar el stock.
  v_cap := public.store_coupon_stock_cap(OLD.store_id);
  IF public.is_flash_coupon_plan(NEW.plan_type)
     AND public.store_coupon_stock_used(OLD.store_id, OLD.id) + COALESCE(NEW.amount_available, 0) > v_cap THEN
    RAISE EXCEPTION 'Superas el tope de % cupones de tu tienda. Ya tienes % en stock vigente (incluye canjeados); reduce el stock o espera a que venza/se canjee.',
      v_cap, public.store_coupon_stock_used(OLD.store_id, OLD.id) USING ERRCODE = 'P0001';
  END IF;

  NEW.approval_status  := OLD.approval_status;
  NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.reviewed_by      := OLD.reviewed_by;
  NEW.last_shown_at    := OLD.last_shown_at;

  v_content_changed :=
       NEW.title            IS DISTINCT FROM OLD.title
    OR NEW.image_url        IS DISTINCT FROM OLD.image_url
    OR NEW.amount_available IS DISTINCT FROM OLD.amount_available
    OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent
    OR NEW.start_date       IS DISTINCT FROM OLD.start_date
    OR NEW.end_date         IS DISTINCT FROM OLD.end_date
    OR NEW.category         IS DISTINCT FROM OLD.category;

  IF v_content_changed THEN
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.reviewed_at      := NULL;
    NEW.reviewed_by      := NULL;
    NEW.is_active        := false;
    RETURN NEW;
  END IF;

  IF OLD.is_active = FALSE AND NEW.is_active = TRUE AND OLD.approval_status <> 'approved' THEN
    NEW.is_active := OLD.is_active;
  END IF;

  RETURN NEW;
END $function$;
