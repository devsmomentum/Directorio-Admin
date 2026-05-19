-- ============================================================================
-- Migración: endurecer RLS de stores y vecinas (catálogo del cliente)
-- ----------------------------------------------------------------------------
-- Reporte del usuario: "el cliente sigue teniendo acceso a información de
-- tiendas que no están vinculadas a él". Posibles causas:
--   - Policy vieja "auth_full_*" o "authenticated read all" que sobrevivió
--     a la migración cliente_portal_auth.sql.
--   - RLS no habilitada en alguna tabla relacionada.
--   - public.stores tiene una policy abierta a 'authenticated'.
--
-- Este script:
--   1. Habilita RLS en las tablas afectadas (idempotente).
--   2. Borra TODAS las policies actuales de esas tablas y recrea sólo las
--      necesarias. Más radical que "DROP IF EXISTS lista nombres", porque
--      atrapa cualquier nombre olvidado.
--   3. Mantiene la lectura anónima para 'stores' (catálogo del kiosko) pero
--      NUNCA para 'authenticated' fuera de user_owns_store / is_admin.
-- ============================================================================


-- Helper para drop masivo de policies en una tabla
CREATE OR REPLACE FUNCTION pg_temp.drop_all_policies(p_schema text, p_table text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = p_schema AND tablename = p_table
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, p_schema, p_table);
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- public.stores
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','stores');

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

-- Catálogo público (kiosko anónimo)
CREATE POLICY "stores_anon_read" ON public.stores
  FOR SELECT TO anon USING (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- public.user_stores  — vínculo usuario↔tienda; el cliente lee SÓLO el suyo
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_stores ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','user_stores');

CREATE POLICY "user_stores_admin" ON public.user_stores
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "user_stores_self_read" ON public.user_stores
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ─────────────────────────────────────────────────────────────────────────────
-- public.ad_campaigns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.ad_campaigns ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','ad_campaigns');

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


-- ─────────────────────────────────────────────────────────────────────────────
-- public.coupons + public.banners (mismo patrón: owner + anon read)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','coupons');

CREATE POLICY "coupons_admin" ON public.coupons
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "coupons_owner" ON public.coupons
  FOR ALL TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));
CREATE POLICY "coupons_anon_read" ON public.coupons
  FOR SELECT TO anon USING (true);


ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','banners');

CREATE POLICY "banners_admin" ON public.banners
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "banners_owner" ON public.banners
  FOR ALL TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));
CREATE POLICY "banners_anon_read" ON public.banners
  FOR SELECT TO anon USING (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- public.transactions  — el cliente sólo ve plan_payment de sus tiendas
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','transactions');

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
-- public.ad_impressions y _daily  (sólo SELECT propio)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.ad_impressions ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','ad_impressions');

CREATE POLICY "ad_impressions_admin" ON public.ad_impressions
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "ad_impressions_owner" ON public.ad_impressions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.ad_campaigns c
    WHERE c.id = ad_impressions.campaign_id
      AND public.user_owns_store(c.store_id)
  ));


ALTER TABLE public.ad_impressions_daily ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','ad_impressions_daily');

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
-- public.plan_requests  — cliente sólo crea/lee las suyas
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.plan_requests ENABLE ROW LEVEL SECURITY;
SELECT pg_temp.drop_all_policies('public','plan_requests');

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
-- Verificación opcional (descomenta y corre como el cliente):
--   SET ROLE authenticated;
--   SET request.jwt.claim.sub TO '<uuid-del-cliente>';
--   SELECT id, name FROM public.stores;       -- debería listar SÓLO sus tiendas
--   SELECT count(*) FROM public.transactions; -- 0 si no es admin
--   RESET ROLE;
-- ============================================================================
