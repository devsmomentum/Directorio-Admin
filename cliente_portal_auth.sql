-- ============================================================================
-- Portal del Cliente / Aliado — Migración de Auth + RLS (Multi-tienda)
-- ----------------------------------------------------------------------------
-- 1) Crea public.users espejo de auth.users con role + datos personales
--    (full_name, cedula_numero, telefono_personal, correo_personal).
-- 2) Crea tabla pivote public.user_stores para vincular un usuario a UNA O
--    VARIAS tiendas (relación N:M).
-- 3) Crea tabla public.plan_requests para las solicitudes de plan del cliente.
-- 4) Reescribe RLS de stores, ad_campaigns, ad_impressions, transactions, etc.
--    para separar admin de cliente sin tocar el esquema auth.
-- 5) Triggers guard para que el cliente no pueda auto-promoverse a admin ni
--    cambiar campos comerciales sensibles.
--
-- IMPORTANT: ANTES de aplicar, ajusta la lista de admins en el paso 4.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabla public.users (espejo de auth.users) — sin store_id (1:N → N:M)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.users (
  id                 uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email              text        NOT NULL,
  role               text        NOT NULL DEFAULT 'cliente'
                                 CHECK (role IN ('admin','cliente')),
  full_name          text,
  cedula_numero      text,
  telefono_personal  text,
  correo_personal    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Por si la versión 1-a-1 ya se aplicó: migrar a la pivote y limpiar
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'store_id'
  ) THEN
    INSERT INTO public.user_stores (user_id, store_id)
    SELECT id, store_id FROM public.users WHERE store_id IS NOT NULL
    ON CONFLICT DO NOTHING;
    EXECUTE 'DROP INDEX IF EXISTS public.idx_users_store_id_unique';
    EXECUTE 'ALTER TABLE public.users DROP COLUMN store_id';
  END IF;
EXCEPTION WHEN undefined_table THEN
  -- user_stores aún no existe; se creará abajo. El backfill se hace después.
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_role  ON public.users(role);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tabla pivote user_stores — 1:N (un usuario varias tiendas, pero cada
--    tienda tiene UN solo usuario)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_stores (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id   uuid NOT NULL UNIQUE REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_user_stores_user_id  ON public.user_stores(user_id);
CREATE INDEX IF NOT EXISTS idx_user_stores_store_id ON public.user_stores(store_id);

-- Si la migración 1-a-1 dejó valores que no alcanzamos a copiar arriba,
-- intentamos una segunda pasada (idempotente, no falla si ya no existe la col)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'store_id'
  ) THEN
    INSERT INTO public.user_stores (user_id, store_id)
    SELECT id, store_id FROM public.users WHERE store_id IS NOT NULL
    ON CONFLICT DO NOTHING;
    EXECUTE 'DROP INDEX IF EXISTS public.idx_users_store_id_unique';
    EXECUTE 'ALTER TABLE public.users DROP COLUMN store_id';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Trigger: al crearse un auth.users, se crea su fila en public.users
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, 'cliente')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();


-- Backfill — los auth.users existentes no dispararon el trigger
INSERT INTO public.users (id, email, role)
SELECT id, email, 'cliente' FROM auth.users
ON CONFLICT (id) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Funciones helper que las RLS usarán
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Reemplaza a current_store_id() — ahora hay varias tiendas por usuario
CREATE OR REPLACE FUNCTION public.user_owns_store(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_stores
    WHERE user_id = auth.uid() AND store_id = p_store_id
  );
$$;

-- Compat: devuelve el primer store_id (útil para clientes con una sola tienda)
CREATE OR REPLACE FUNCTION public.current_store_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT store_id FROM public.user_stores WHERE user_id = auth.uid();
$$;

-- Limpiar la antigua si existe (estaba pensada para 1:1)
DROP FUNCTION IF EXISTS public.current_store_id();

GRANT EXECUTE ON FUNCTION public.is_admin()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_owns_store(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_store_ids()    TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Promover a los admins actuales — EDITAR LISTA DE EMAILS
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.users
SET role = 'admin'
WHERE email IN (
  'parraandres723@gmail.com',
  'morna@gmail.com',
  'devapmomentum@morna.studio'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Tabla plan_requests — solicitudes de plan del cliente (simulado)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plan_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  plan_key      text        NOT NULL,
  requested_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_requests_store_id ON public.plan_requests(store_id);
CREATE INDEX IF NOT EXISTS idx_plan_requests_status   ON public.plan_requests(status);


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RLS — public.users
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_self_read"   ON public.users;
DROP POLICY IF EXISTS "users_admin_write" ON public.users;
DROP POLICY IF EXISTS "users_self_update" ON public.users;

CREATE POLICY "users_self_read" ON public.users
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

CREATE POLICY "users_admin_write" ON public.users
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "users_self_update" ON public.users
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Trigger guard: el cliente NO puede cambiar su role ni email
CREATE OR REPLACE FUNCTION public.guard_users_self_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  NEW.role  := OLD.role;
  NEW.email := OLD.email;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_users_guard ON public.users;
CREATE TRIGGER trg_users_guard
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_users_self_update();


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. RLS — public.user_stores (solo admin escribe; cliente lee lo suyo)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_stores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_stores_admin"     ON public.user_stores;
DROP POLICY IF EXISTS "user_stores_self_read" ON public.user_stores;

CREATE POLICY "user_stores_admin" ON public.user_stores
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "user_stores_self_read" ON public.user_stores
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. RLS — public.plan_requests
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plan_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plan_requests_admin"        ON public.plan_requests;
DROP POLICY IF EXISTS "plan_requests_owner_read"   ON public.plan_requests;
DROP POLICY IF EXISTS "plan_requests_owner_insert" ON public.plan_requests;

CREATE POLICY "plan_requests_admin" ON public.plan_requests
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "plan_requests_owner_read" ON public.plan_requests
  FOR SELECT TO authenticated
  USING (public.user_owns_store(store_id));

CREATE POLICY "plan_requests_owner_insert" ON public.plan_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_owns_store(store_id)
    AND (requested_by IS NULL OR requested_by = auth.uid())
    AND status = 'pending'
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. RLS — public.stores
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stores_admin"        ON public.stores;
DROP POLICY IF EXISTS "stores_owner_read"   ON public.stores;
DROP POLICY IF EXISTS "stores_owner_update" ON public.stores;
DROP POLICY IF EXISTS "stores_anon_read"    ON public.stores;

CREATE POLICY "stores_admin" ON public.stores
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "stores_owner_read" ON public.stores
  FOR SELECT TO authenticated
  USING (public.user_owns_store(id));

CREATE POLICY "stores_owner_update" ON public.stores
  FOR UPDATE TO authenticated
  USING (public.user_owns_store(id))
  WITH CHECK (public.user_owns_store(id));

-- Lectura pública del directorio (kiosko anónimo)
CREATE POLICY "stores_anon_read" ON public.stores
  FOR SELECT TO anon USING (true);

-- Trigger guard: el cliente solo toca contacto + logo + descripción
CREATE OR REPLACE FUNCTION public.guard_stores_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  NEW.plan_type            := OLD.plan_type;
  NEW.contract_url         := OLD.contract_url;
  NEW.mercantil_url        := OLD.mercantil_url;
  NEW.cedula_url           := OLD.cedula_url;
  NEW.contract_expiry_date := OLD.contract_expiry_date;
  NEW.rif                  := OLD.rif;
  NEW.local_number         := OLD.local_number;
  NEW.floor_level          := OLD.floor_level;
  NEW.category_id          := OLD.category_id;
  NEW.node_id              := OLD.node_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_stores_guard ON public.stores;
CREATE TRIGGER trg_stores_guard
  BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.guard_stores_owner_update();


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. RLS — public.ad_campaigns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ad_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ad_campaigns_admin"        ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_owner_read"   ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_owner_update" ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_anon_read"    ON public.ad_campaigns;

CREATE POLICY "ad_campaigns_admin" ON public.ad_campaigns
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "ad_campaigns_owner_read" ON public.ad_campaigns
  FOR SELECT TO authenticated
  USING (public.user_owns_store(store_id));

CREATE POLICY "ad_campaigns_owner_update" ON public.ad_campaigns
  FOR UPDATE TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));

CREATE POLICY "ad_campaigns_anon_read" ON public.ad_campaigns
  FOR SELECT TO anon USING (true);

CREATE OR REPLACE FUNCTION public.guard_campaigns_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  NEW.payment_status := OLD.payment_status;
  NEW.is_active      := OLD.is_active;
  NEW.suspended_at   := OLD.suspended_at;
  NEW.priority_level := OLD.priority_level;
  NEW.plan_type      := OLD.plan_type;
  NEW.store_id       := OLD.store_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_campaigns_guard ON public.ad_campaigns;
CREATE TRIGGER trg_campaigns_guard
  BEFORE UPDATE ON public.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaigns_owner_update();


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. RLS — public.ad_impressions y public.ad_impressions_daily
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "auth_read_ad_impressions"  ON public.ad_impressions;
DROP POLICY IF EXISTS "ad_impressions_admin"      ON public.ad_impressions;
DROP POLICY IF EXISTS "ad_impressions_owner"      ON public.ad_impressions;

CREATE POLICY "ad_impressions_admin" ON public.ad_impressions
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY "ad_impressions_owner" ON public.ad_impressions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.ad_campaigns c
    WHERE c.id = ad_impressions.campaign_id
      AND public.user_owns_store(c.store_id)
  ));


DROP POLICY IF EXISTS "auth_read_ad_impressions_daily" ON public.ad_impressions_daily;
DROP POLICY IF EXISTS "ad_impressions_daily_admin"     ON public.ad_impressions_daily;
DROP POLICY IF EXISTS "ad_impressions_daily_owner"     ON public.ad_impressions_daily;

CREATE POLICY "ad_impressions_daily_admin" ON public.ad_impressions_daily
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY "ad_impressions_daily_owner" ON public.ad_impressions_daily
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.ad_campaigns c
    WHERE c.id = ad_impressions_daily.campaign_id
      AND public.user_owns_store(c.store_id)
  ));


-- ─────────────────────────────────────────────────────────────────────────────
-- 13. RLS — public.transactions
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transactions_admin"         ON public.transactions;
DROP POLICY IF EXISTS "transactions_owner_read"    ON public.transactions;
DROP POLICY IF EXISTS "transactions_owner_insert"  ON public.transactions;

CREATE POLICY "transactions_admin" ON public.transactions
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "transactions_owner_read" ON public.transactions
  FOR SELECT TO authenticated
  USING (transaction_type = 'plan_payment' AND public.user_owns_store(store_id));

CREATE POLICY "transactions_owner_insert" ON public.transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    transaction_type = 'plan_payment'
    AND public.user_owns_store(store_id)
    AND status = 'pending'
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- 14. RLS — public.plans
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plans_read_all"     ON public.plans;
DROP POLICY IF EXISTS "plans_admin_write"  ON public.plans;
DROP POLICY IF EXISTS "plans_anon_read"    ON public.plans;

CREATE POLICY "plans_read_all" ON public.plans
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "plans_admin_write" ON public.plans
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "plans_anon_read" ON public.plans
  FOR SELECT TO anon USING (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- 15. RLS — operational_expenses y admin_notifications (solo admin)
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "auth_full_operational_expenses" ON public.operational_expenses;
DROP POLICY IF EXISTS "operational_expenses_admin"      ON public.operational_expenses;
CREATE POLICY "operational_expenses_admin" ON public.operational_expenses
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "auth_full_admin_notifications" ON public.admin_notifications;
DROP POLICY IF EXISTS "admin_notifications_admin"      ON public.admin_notifications;
CREATE POLICY "admin_notifications_admin" ON public.admin_notifications
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- 16. RLS — public.banners y public.coupons
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "banners_admin"      ON public.banners;
DROP POLICY IF EXISTS "banners_owner"      ON public.banners;
DROP POLICY IF EXISTS "banners_anon_read"  ON public.banners;

CREATE POLICY "banners_admin" ON public.banners
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "banners_owner" ON public.banners
  FOR ALL TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));

CREATE POLICY "banners_anon_read" ON public.banners
  FOR SELECT TO anon USING (true);


ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coupons_admin"      ON public.coupons;
DROP POLICY IF EXISTS "coupons_owner"      ON public.coupons;
DROP POLICY IF EXISTS "coupons_anon_read"  ON public.coupons;

CREATE POLICY "coupons_admin" ON public.coupons
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "coupons_owner" ON public.coupons
  FOR ALL TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));

CREATE POLICY "coupons_anon_read" ON public.coupons
  FOR SELECT TO anon USING (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- 17. RPC para vincular tienda <-> usuario desde el admin (1:N)
-- ─────────────────────────────────────────────────────────────────────────────
-- Inserta en public.user_stores y actualiza datos personales del usuario.
-- Relación 1:N: un usuario puede tener varias tiendas, pero cada tienda tiene
-- un solo usuario. Si la tienda ya estaba vinculada a OTRO usuario, ese
-- vínculo se reemplaza. NO desvincula al nuevo usuario de sus otras tiendas.

CREATE OR REPLACE FUNCTION public.admin_link_store_user(
  p_email             text,
  p_store_id          uuid,
  p_full_name         text DEFAULT NULL,
  p_cedula_numero     text DEFAULT NULL,
  p_telefono_personal text DEFAULT NULL,
  p_correo_personal   text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede vincular usuarios a tiendas';
  END IF;

  SELECT id INTO v_user_id FROM auth.users WHERE email = p_email LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN NULL; -- el auth user aún no existe; el admin debe enviar el magic link primero
  END IF;

  -- Upsert datos personales del usuario (sin tocar role)
  INSERT INTO public.users (id, email, role, full_name, cedula_numero, telefono_personal, correo_personal)
  VALUES (v_user_id, p_email, 'cliente', p_full_name, p_cedula_numero, p_telefono_personal, p_correo_personal)
  ON CONFLICT (id) DO UPDATE SET
    full_name         = COALESCE(EXCLUDED.full_name,         public.users.full_name),
    cedula_numero     = COALESCE(EXCLUDED.cedula_numero,     public.users.cedula_numero),
    telefono_personal = COALESCE(EXCLUDED.telefono_personal, public.users.telefono_personal),
    correo_personal   = COALESCE(EXCLUDED.correo_personal,   public.users.correo_personal),
    updated_at        = now();

  -- 1 tienda = 1 usuario: si la tienda ya tenía otro dueño, reemplazarlo.
  -- Si era el mismo, no hacemos nada (idempotente).
  DELETE FROM public.user_stores
  WHERE store_id = p_store_id AND user_id <> v_user_id;

  INSERT INTO public.user_stores (user_id, store_id)
  VALUES (v_user_id, p_store_id)
  ON CONFLICT (user_id, store_id) DO NOTHING;

  RETURN v_user_id;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_link_store_user(text, uuid, text, text, text, text) TO authenticated;


-- Helper para desvincular (sin borrar el auth.user)
CREATE OR REPLACE FUNCTION public.admin_unlink_store_user(p_user_id uuid, p_store_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede desvincular usuarios';
  END IF;
  DELETE FROM public.user_stores WHERE user_id = p_user_id AND store_id = p_store_id;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_unlink_store_user(uuid, uuid) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 18. Smoke tests (descomenta para validar)
-- ─────────────────────────────────────────────────────────────────────────────
-- Como admin: deberías ver TODO
--   SELECT count(*) FROM public.operational_expenses;
--   SELECT count(*) FROM public.stores;
--
-- Como cliente con 2 tiendas:
--   SELECT count(*) FROM public.stores;           -- 2
--   SELECT count(*) FROM public.user_stores;      -- 2
--   SELECT count(*) FROM public.operational_expenses; -- 0
--   UPDATE public.users SET role='admin' WHERE id=auth.uid(); -- silenciado
