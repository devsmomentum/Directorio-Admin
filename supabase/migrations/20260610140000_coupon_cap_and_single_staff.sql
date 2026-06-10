-- =====================================================================
-- Tope de inventario de cupones por tienda + un solo staff por rol
-- ---------------------------------------------------------------------
-- 1) Un solo usuario por (tienda, rol): a lo sumo UN dueño, UN vendedor y UN
--    publicista por tienda. Sustituye el índice parcial de solo-dueño por uno
--    sobre (store_id, store_role).
-- 2) Tope de stock de cupones flash por tienda: la SUMA de amount_available de
--    los cupones flash vigentes (no rechazados, no vencidos) no puede pasar de
--    20. Pueden repartirse en varios cupones (p.ej. 5 + 10 + 5).
--    La barrera real son los triggers guard_coupons_owner_(insert|update);
--    la UI solo muestra el presupuesto restante.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. Un solo usuario por (tienda, rol).
-- ─────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.uniq_one_owner_per_store;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_one_role_per_store
  ON public.user_stores (store_id, store_role);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Helper: stock flash vigente ya consumido por la tienda (excluyendo un
--    cupón opcional, p.ej. el que se está editando/insertando).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.store_coupon_stock_used(p_store_id uuid, p_exclude uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount_available), 0)::int
    FROM public.coupons
   WHERE store_id = p_store_id
     AND plan_type IN ('FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL')
     AND approval_status <> 'rejected'
     AND end_date >= now()
     AND (p_exclude IS NULL OR id <> p_exclude);
$$;
GRANT EXECUTE ON FUNCTION public.store_coupon_stock_used(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Guards de cupón: mismo cuerpo vivo (predicado user_can_manage_ads), con
--    el chequeo del tope de 20 añadido en el path operador.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_coupons_owner_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
DECLARE
  v_store_plan TEXT;
  v_expiry     DATE;
  v_is_owner   BOOLEAN;
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

  -- Tope de inventario flash por tienda (suma de stock vigente <= 20).
  IF public.is_flash_coupon_plan(NEW.plan_type)
     AND public.store_coupon_stock_used(NEW.store_id, NEW.id) + COALESCE(NEW.amount_available, 0) > 20 THEN
    RAISE EXCEPTION 'Superas el tope de 20 cupones de tu tienda. Ya tienes % en stock vigente; reduce el stock o espera a que venza/se canjee.',
      public.store_coupon_stock_used(NEW.store_id, NEW.id) USING ERRCODE = 'P0001';
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
  IF public.is_flash_coupon_plan(NEW.plan_type)
     AND public.store_coupon_stock_used(OLD.store_id, OLD.id) + COALESCE(NEW.amount_available, 0) > 20 THEN
    RAISE EXCEPTION 'Superas el tope de 20 cupones de tu tienda. Ya tienes % en stock vigente; reduce el stock o espera a que venza/se canjee.',
      public.store_coupon_stock_used(OLD.store_id, OLD.id) USING ERRCODE = 'P0001';
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

-- ─────────────────────────────────────────────────────────────────────
-- 4. owner_set_store_staff: rechazar si el rol ya está ocupado por OTRO
--    usuario en la tienda (mensaje claro antes del 23505 del índice único).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owner_set_store_staff(
  p_email text, p_store_id uuid, p_store_role text,
  p_full_name text DEFAULT NULL::text,
  p_cedula_numero text DEFAULT NULL::text,
  p_telefono_personal text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
DECLARE
  v_user_id     uuid;
  v_target_role text;
BEGIN
  IF NOT public.user_owns_store(p_store_id) THEN
    RAISE EXCEPTION 'No eres dueño de esta tienda.' USING ERRCODE = '42501';
  END IF;
  IF p_store_role NOT IN ('seller','advertiser') THEN
    RAISE EXCEPTION 'Rol inválido: solo seller o advertiser.' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_user_id FROM auth.users WHERE email = lower(p_email) LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = v_user_id;
  IF v_target_role = 'admin' THEN
    RAISE EXCEPTION 'No puedes asignar a un administrador como staff.' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_stores
     WHERE store_id = p_store_id AND user_id = v_user_id AND store_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Ese usuario es el dueño de la tienda.' USING ERRCODE = '42501';
  END IF;

  -- Un solo usuario por rol: si el rol ya lo tiene OTRO, exigir quitarlo antes.
  IF EXISTS (
    SELECT 1 FROM public.user_stores
     WHERE store_id = p_store_id AND store_role = p_store_role AND user_id <> v_user_id
  ) THEN
    RAISE EXCEPTION 'Ya existe un % en esta tienda. Quítalo antes de asignar otro.',
      CASE p_store_role WHEN 'seller' THEN 'vendedor' ELSE 'publicista' END
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.users (id, email, role, full_name, cedula_numero, telefono_personal)
  VALUES (v_user_id, lower(p_email), 'cliente', p_full_name, p_cedula_numero, p_telefono_personal)
  ON CONFLICT (id) DO UPDATE SET
    full_name         = COALESCE(EXCLUDED.full_name,         public.users.full_name),
    cedula_numero     = COALESCE(EXCLUDED.cedula_numero,     public.users.cedula_numero),
    telefono_personal = COALESCE(EXCLUDED.telefono_personal, public.users.telefono_personal),
    updated_at        = now();

  INSERT INTO public.user_stores (user_id, store_id, store_role)
  VALUES (v_user_id, p_store_id, p_store_role)
  ON CONFLICT (user_id, store_id)
    DO UPDATE SET store_role = EXCLUDED.store_role
    WHERE public.user_stores.store_role <> 'owner';

  RETURN v_user_id;
END $function$;
