-- Historial de porcentajes de reparto por aliado, con VIGENCIA (fechas efectivas).
-- Resuelve el caso de cambios a mitad de período: cada cambio abre un tramo nuevo
-- y cierra el anterior, de modo que Finanzas prorratea (un aliado solo cobra desde
-- su fecha efectiva; un cambio aplica desde su fecha, no retroactivamente).
--
-- Intervalo semiabierto [effective_from, effective_to): el tramo cubre el día X
-- si effective_from <= X < effective_to (effective_to NULL = vigente).
-- stores.ally_revenue_pct / ally_revenue_base se conservan como "valor actual"
-- (cache para el editor); la FUENTE DE VERDAD del cálculo es esta tabla.

CREATE TABLE IF NOT EXISTS public.ally_revenue_shares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  pct            numeric(5,2) NOT NULL CHECK (pct >= 0 AND pct <= 100),
  base           text NOT NULL CHECK (base IN ('gross','net')),
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT chk_ally_share_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_ally_revenue_shares_store ON public.ally_revenue_shares(store_id, effective_from);
-- A lo sumo un tramo abierto (vigente) por tienda.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ally_share_open
  ON public.ally_revenue_shares(store_id) WHERE effective_to IS NULL;

ALTER TABLE public.ally_revenue_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ally_shares_admin_all ON public.ally_revenue_shares;
CREATE POLICY ally_shares_admin_all ON public.ally_revenue_shares
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS ally_shares_member_read ON public.ally_revenue_shares;
CREATE POLICY ally_shares_member_read ON public.ally_revenue_shares
  FOR SELECT TO authenticated
  USING (public.user_member_of_store(store_id));

-- Backfill: cada aliado actual con % > 0 obtiene un tramo abierto desde su alta
-- (ally_since) o desde hoy si no hay fecha.
INSERT INTO public.ally_revenue_shares (store_id, pct, base, effective_from)
SELECT s.id, s.ally_revenue_pct, COALESCE(s.ally_revenue_base, 'net'),
       COALESCE(s.ally_since::date, CURRENT_DATE)
FROM public.stores s
WHERE s.is_ally = true AND s.ally_revenue_pct > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.ally_revenue_shares a
    WHERE a.store_id = s.id AND a.effective_to IS NULL
  );
