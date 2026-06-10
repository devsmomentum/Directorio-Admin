-- =====================================================================
-- ROLES POR TIENDA: dueño / vendedor / publicista
-- ---------------------------------------------------------------------
-- Hasta ahora, estar vinculado a una tienda en `user_stores` implicaba ser
-- el DUEÑO con acceso total. Introducimos dos perfiles acotados, ligados a
-- la tienda, con menos permisos:
--   · seller    (vendedor)  → SOLO canje de cupones (pantalla Candidatos).
--   · advertiser(publicista)→ TODA la publicidad: CRUD de cupones y campañas
--                             (incl. stock), pero NO canjea.
--   · owner     (dueño)     → todo como antes + gestiona su propio staff.
--
-- Reparto de capacidades:
--   publicidad (coupons + ad_campaigns) = owner OR advertiser
--   canje      (coupon_leads/redeem)    = owner OR seller
--   resto (tienda, planes, pagos, ...)  = owner
--
-- Estrategia del helper conflictivo: `user_owns_store()` se usaba a la vez
-- como "vinculado a la tienda" (lecturas) y "dueño con todos los permisos"
-- (escrituras). Lo REDEFINIMOS a owner-only (las filas existentes quedan
-- 'owner' por el DEFAULT, así que TODOS los sitios owner-only siguen
-- correctos sin tocarlos) y añadimos helpers de membresía y de capacidad.
--
-- IMPORTANTE: la autorización real es RLS + RPC. La UI solo oculta.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. Columna de rol en la pivote + permitir varios usuarios por tienda.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_stores
  ADD COLUMN IF NOT EXISTS store_role text NOT NULL DEFAULT 'owner'
    CHECK (store_role IN ('owner','seller','advertiser'));

-- Belt-and-suspenders: cualquier fila preexistente es el dueño.
UPDATE public.user_stores SET store_role = 'owner' WHERE store_role IS NULL;

-- Quitar el UNIQUE(store_id) (hoy "1 tienda = 1 usuario"). Lo buscamos por
-- catálogo en vez de hardcodear el nombre autogenerado.
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT con.conname INTO v_conname
    FROM pg_constraint con
   WHERE con.conrelid = 'public.user_stores'::regclass
     AND con.contype  = 'u'
     AND con.conkey = ARRAY(
       SELECT a.attnum FROM pg_attribute a
        WHERE a.attrelid = 'public.user_stores'::regclass
          AND a.attname  = 'store_id'
     );
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_stores DROP CONSTRAINT %I', v_conname);
  END IF;
  -- Por si en algún entorno quedó como índice único suelto.
  EXECUTE 'DROP INDEX IF EXISTS public.user_stores_store_id_key';
END $$;

-- A lo sumo UN dueño por tienda (varios seller/advertiser permitidos).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_one_owner_per_store
  ON public.user_stores (store_id)
  WHERE store_role = 'owner';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Helpers de autorización.
-- ─────────────────────────────────────────────────────────────────────
-- Owner-only (firma intacta: todas las policies/triggers/RPCs que ya lo
-- usaban quedan correctos automáticamente como "solo dueño").
CREATE OR REPLACE FUNCTION public.user_owns_store(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_stores
    WHERE user_id = auth.uid() AND store_id = p_store_id AND store_role = 'owner'
  );
$$;

-- Cualquier rol vinculado (para lecturas de tienda / cargar el portal).
CREATE OR REPLACE FUNCTION public.user_member_of_store(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_stores
    WHERE user_id = auth.uid() AND store_id = p_store_id
  );
$$;

-- Canje: dueño o vendedor.
CREATE OR REPLACE FUNCTION public.user_can_redeem(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_stores
    WHERE user_id = auth.uid() AND store_id = p_store_id
      AND store_role IN ('owner','seller')
  );
$$;

-- Publicidad (cupones + campañas): dueño o publicista.
CREATE OR REPLACE FUNCTION public.user_can_manage_ads(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_stores
    WHERE user_id = auth.uid() AND store_id = p_store_id
      AND store_role IN ('owner','advertiser')
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_member_of_store(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_redeem(uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_manage_ads(uuid)   TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Re-apuntar policies (conservando nombres).
-- ─────────────────────────────────────────────────────────────────────
-- stores: el staff (cualquier rol) debe poder LEER su tienda para cargar el
-- portal. La edición sigue siendo solo-dueño (stores_owner_update intacta).
DROP POLICY IF EXISTS stores_owner_read ON public.stores;
CREATE POLICY stores_owner_read ON public.stores
  FOR SELECT TO authenticated
  USING (public.user_member_of_store(id));

-- coupon_leads: leer candidatos = dueño o vendedor.
DROP POLICY IF EXISTS coupon_leads_owner_read ON public.coupon_leads;
CREATE POLICY coupon_leads_owner_read ON public.coupon_leads
  FOR SELECT TO authenticated
  USING (public.user_can_redeem(store_id));

-- coupons: escritura = dueño o publicista.
DROP POLICY IF EXISTS coupons_owner_write ON public.coupons;
CREATE POLICY coupons_owner_write ON public.coupons
  FOR ALL TO authenticated
  USING (public.user_can_manage_ads(store_id))
  WITH CHECK (public.user_can_manage_ads(store_id));

-- ad_campaigns: escritura = dueño o publicista.
DROP POLICY IF EXISTS ad_campaigns_owner_write ON public.ad_campaigns;
CREATE POLICY ad_campaigns_owner_write ON public.ad_campaigns
  FOR ALL TO authenticated
  USING (public.user_can_manage_ads(store_id))
  WITH CHECK (public.user_can_manage_ads(store_id));

-- ─────────────────────────────────────────────────────────────────────
-- 4. Guards de moderación. Reproducen el CUERPO VIVO EXACTO (leído de
--    pg_proc); el ÚNICO cambio es el predicado `v_is_owner`, que pasa de
--    user_owns_store (ahora owner-only) a user_can_manage_ads (owner O
--    publicista). Sin esto, al volverse user_owns_store owner-only, el
--    publicista caería en el path admin/system y AUTO-APROBARÍA sus
--    cupones/campañas saltándose la cola de revisión.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
DECLARE
  v_store_plan TEXT;
  v_expiry     DATE;
  v_is_owner   BOOLEAN;
BEGIN
  -- "operador de publicidad" (dueño o publicista), no admin/system.
  v_is_owner := NEW.store_id IS NOT NULL AND public.user_can_manage_ads(NEW.store_id);

  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;

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

  NEW.is_active        := false;
  NEW.approval_status  := 'pending';
  NEW.rejection_reason := NULL;
  NEW.reviewed_at      := NULL;
  NEW.reviewed_by      := NULL;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
RETURNS trigger LANGUAGE plpgsql
AS $function$
DECLARE
  v_plan_active     BOOLEAN;
  v_other_active    BOOLEAN;
  v_content_changed BOOLEAN;
  v_is_owner        BOOLEAN;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_can_manage_ads(OLD.store_id);

  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  NEW.priority_level := OLD.priority_level;
  NEW.plan_type      := OLD.plan_type;
  NEW.store_id       := OLD.store_id;

  NEW.approval_status  := OLD.approval_status;
  NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.reviewed_by      := OLD.reviewed_by;

  -- Solo el medio o el texto relevante disparan re-aprobación.
  v_content_changed :=
       NEW.brand_name  IS DISTINCT FROM OLD.brand_name
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.media_url   IS DISTINCT FROM OLD.media_url
    OR NEW.media_type  IS DISTINCT FROM OLD.media_type;

  IF v_content_changed THEN
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.reviewed_at      := NULL;
    NEW.reviewed_by      := NULL;
    NEW.is_active        := false;
    RETURN NEW;
  END IF;

  IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
    NULL;
  ELSIF OLD.is_active = FALSE AND NEW.is_active = TRUE THEN
    IF OLD.approval_status <> 'approved' THEN
      NEW.is_active := OLD.is_active;
    ELSE
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
  END IF;

  RETURN NEW;
END $function$;

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
-- 5. Canje: autorizar a dueño O vendedor (cuerpo vivo, solo cambia el
--    predicado de autorización).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_coupon(p_claim_id uuid, p_coupon_id uuid)
RETURNS TABLE(lead_id uuid, status text, redeemed_at timestamp with time zone, remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
DECLARE
  v_lead      public.coupon_leads%ROWTYPE;
  v_remaining integer;
  v_now       timestamptz := now();
BEGIN
  SELECT * INTO v_lead
    FROM public.coupon_leads
   WHERE id = p_claim_id
     AND coupon_id = p_coupon_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLAIM_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Autorización: admin, dueño o vendedor de la tienda del lead.
  IF NOT (public.is_admin() OR public.user_can_redeem(v_lead.store_id)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  IF v_lead.status <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'ALREADY_REDEEMED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.coupons
     SET amount_available = amount_available - 1
   WHERE id = p_coupon_id
     AND amount_available > 0
   RETURNING amount_available INTO v_remaining;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUT_OF_STOCK' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.coupon_leads
     SET status      = 'CANJEADO',
         redeemed_at = v_now,
         redeemed_by = auth.uid()
   WHERE id = p_claim_id;

  RETURN QUERY
  SELECT p_claim_id, 'CANJEADO'::text, v_now, v_remaining;
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_redeemable_claims(p_query text, p_store_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(lead_id uuid, coupon_id uuid, store_id uuid, first_name text, last_name text, id_document text, telefono text, email text, status text, created_at timestamp with time zone, coupon_title text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $function$
  SELECT cl.id, cl.coupon_id, cl.store_id,
         cl.first_name, cl.last_name, cl.id_document, cl.telefono, cl.email,
         cl.status, cl.created_at, c.title
    FROM public.coupon_leads cl
    JOIN public.coupons c ON c.id = cl.coupon_id
   WHERE cl.status = 'PENDIENTE'
     AND (public.is_admin() OR public.user_can_redeem(cl.store_id))
     AND (p_store_id IS NULL OR cl.store_id = p_store_id)
     AND (
          cl.redemption_token = p_query
       OR cl.id_document      ILIKE '%' || p_query || '%'
       OR cl.email            ILIKE '%' || p_query || '%'
       OR (coalesce(cl.first_name,'') || ' ' || coalesce(cl.last_name,''))
                              ILIKE '%' || p_query || '%'
     )
   ORDER BY cl.created_at DESC
   LIMIT 50;
$function$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. admin_link_store_user: ahora la tabla admite varios usuarios por
--    tienda. El admin SIEMPRE crea/asegura al DUEÑO; el DELETE de
--    "reemplazar dueño previo" debe acotarse a store_role='owner' para NO
--    borrar al staff (seller/advertiser).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_link_store_user(
  p_email text, p_store_id uuid, p_full_name text DEFAULT NULL::text,
  p_cedula_numero text DEFAULT NULL::text, p_telefono_personal text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede vincular usuarios a tiendas';
  END IF;

  SELECT id INTO v_user_id FROM auth.users WHERE email = p_email LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.users (id, email, role, full_name, cedula_numero, telefono_personal)
  VALUES (v_user_id, p_email, 'cliente', p_full_name, p_cedula_numero, p_telefono_personal)
  ON CONFLICT (id) DO UPDATE SET
    full_name         = COALESCE(EXCLUDED.full_name,         public.users.full_name),
    cedula_numero     = COALESCE(EXCLUDED.cedula_numero,     public.users.cedula_numero),
    telefono_personal = COALESCE(EXCLUDED.telefono_personal, public.users.telefono_personal),
    updated_at        = now();

  -- 1 dueño = 1 tienda: si la tienda tenía OTRO dueño, reemplazarlo.
  -- Acotado a 'owner' para no tocar al staff.
  DELETE FROM public.user_stores
  WHERE store_id = p_store_id AND user_id <> v_user_id AND store_role = 'owner';

  INSERT INTO public.user_stores (user_id, store_id, store_role)
  VALUES (v_user_id, p_store_id, 'owner')
  ON CONFLICT (user_id, store_id) DO UPDATE SET store_role = 'owner';

  RETURN v_user_id;
END $function$;

-- ─────────────────────────────────────────────────────────────────────
-- 7. Staff autoservicio del DUEÑO (SECURITY DEFINER, gateadas por
--    user_owns_store = owner-only). Anti-escalada: solo seller/advertiser,
--    nunca admin/owner, solo en tiendas propias, sin pisar la fila del dueño.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owner_set_store_staff(
  p_email text, p_store_id uuid, p_store_role text,
  p_full_name text DEFAULT NULL::text,
  p_cedula_numero text DEFAULT NULL::text,
  p_telefono_personal text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
DECLARE
  v_user_id    uuid;
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
    -- El auth.user aún no existe; la edge function debe crearlo + invitar primero.
    RETURN NULL;
  END IF;

  -- No enganchar a un admin como staff.
  SELECT role INTO v_target_role FROM public.users WHERE id = v_user_id;
  IF v_target_role = 'admin' THEN
    RAISE EXCEPTION 'No puedes asignar a un administrador como staff.' USING ERRCODE = '42501';
  END IF;

  -- No degradar al dueño de esta tienda mediante esta vía.
  IF EXISTS (
    SELECT 1 FROM public.user_stores
     WHERE store_id = p_store_id AND user_id = v_user_id AND store_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Ese usuario es el dueño de la tienda.' USING ERRCODE = '42501';
  END IF;

  -- Datos personales (sin tocar users.role).
  INSERT INTO public.users (id, email, role, full_name, cedula_numero, telefono_personal)
  VALUES (v_user_id, lower(p_email), 'cliente', p_full_name, p_cedula_numero, p_telefono_personal)
  ON CONFLICT (id) DO UPDATE SET
    full_name         = COALESCE(EXCLUDED.full_name,         public.users.full_name),
    cedula_numero     = COALESCE(EXCLUDED.cedula_numero,     public.users.cedula_numero),
    telefono_personal = COALESCE(EXCLUDED.telefono_personal, public.users.telefono_personal),
    updated_at        = now();

  -- Vincular con el rol. El WHERE impide pisar una fila 'owner'.
  INSERT INTO public.user_stores (user_id, store_id, store_role)
  VALUES (v_user_id, p_store_id, p_store_role)
  ON CONFLICT (user_id, store_id)
    DO UPDATE SET store_role = EXCLUDED.store_role
    WHERE public.user_stores.store_role <> 'owner';

  RETURN v_user_id;
END $function$;

CREATE OR REPLACE FUNCTION public.owner_list_store_staff(p_store_id uuid)
RETURNS TABLE(user_id uuid, email text, full_name text, store_role text, created_at timestamp with time zone)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth
AS $function$
BEGIN
  IF NOT public.user_owns_store(p_store_id) THEN
    RAISE EXCEPTION 'No eres dueño de esta tienda.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT us.user_id, u.email, u.full_name, us.store_role, us.created_at
      FROM public.user_stores us
      JOIN public.users u ON u.id = us.user_id
     WHERE us.store_id = p_store_id
       AND us.store_role IN ('seller','advertiser')
     ORDER BY us.created_at DESC;
END $function$;

CREATE OR REPLACE FUNCTION public.owner_remove_store_staff(p_user_id uuid, p_store_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $function$
BEGIN
  IF NOT public.user_owns_store(p_store_id) THEN
    RAISE EXCEPTION 'No eres dueño de esta tienda.' USING ERRCODE = '42501';
  END IF;
  -- El filtro de rol impide que el dueño se borre a sí mismo o a otro dueño.
  DELETE FROM public.user_stores
   WHERE user_id = p_user_id AND store_id = p_store_id
     AND store_role IN ('seller','advertiser');
END $function$;

REVOKE ALL ON FUNCTION public.owner_set_store_staff(text, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owner_list_store_staff(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owner_remove_store_staff(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_set_store_staff(text, uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_list_store_staff(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_remove_store_staff(uuid, uuid) TO authenticated;
