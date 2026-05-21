-- ============================================================================
-- Promociones (cupones y campañas): lectura pública, escritura admin/dueño.
-- ----------------------------------------------------------------------------
-- Antes:
--   * ad_campaigns: el authenticated sólo veía/actualizaba sus propias filas.
--     No tenía INSERT ni DELETE. El anon sí podía SELECT (para el kiosco).
--   * coupons: el authenticated dueño podía hacer todo sobre sus filas; el
--     anon podía SELECT. Otros authenticated (otra tienda) no veían nada.
-- Después (lo que pidió el cliente):
--   * Cualquiera (anon o authenticated) puede SELECT cupones y campañas.
--     Así aparecen en el kiosco, en el portal del cliente (incluyendo la
--     galería flash que necesita ver marcas de otras tiendas), y en el admin.
--   * Sólo el admin o el dueño de la tienda pueden INSERT/UPDATE/DELETE.
--
-- Conserva los triggers existentes (`trg_campaigns_guard`) que evitan que el
-- dueño toque campos comerciales (payment_status, is_active, suspended_at).
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- ad_campaigns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ad_campaigns ENABLE ROW LEVEL SECURITY;

-- Limpiamos todas las policies viejas para no acumular nombres distintos.
DROP POLICY IF EXISTS "ad_campaigns_admin"        ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_owner_read"   ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_owner_update" ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_owner_write"  ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_anon_read"    ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_public_read"  ON public.ad_campaigns;

-- SELECT abierto a todo el mundo (anon + authenticated).
CREATE POLICY "ad_campaigns_public_read" ON public.ad_campaigns
  FOR SELECT TO public
  USING (true);

-- Admin puede insertar/actualizar/eliminar cualquier campaña.
CREATE POLICY "ad_campaigns_admin_write" ON public.ad_campaigns
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Dueño de la tienda puede insertar/actualizar/eliminar SUS campañas.
-- El trigger `trg_campaigns_guard` impide que toque campos comerciales.
CREATE POLICY "ad_campaigns_owner_write" ON public.ad_campaigns
  FOR ALL TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));


-- ─────────────────────────────────────────────────────────────────────────────
-- coupons
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coupons_admin"        ON public.coupons;
DROP POLICY IF EXISTS "coupons_owner"        ON public.coupons;
DROP POLICY IF EXISTS "coupons_owner_write"  ON public.coupons;
DROP POLICY IF EXISTS "coupons_anon_read"    ON public.coupons;
DROP POLICY IF EXISTS "coupons_public_read"  ON public.coupons;

-- SELECT abierto: el portal del cliente necesita ver cupones de otras tiendas
-- para calcular el cap de la galería Flash, y el kiosco los necesita siempre.
CREATE POLICY "coupons_public_read" ON public.coupons
  FOR SELECT TO public
  USING (true);

CREATE POLICY "coupons_admin_write" ON public.coupons
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "coupons_owner_write" ON public.coupons
  FOR ALL TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));
