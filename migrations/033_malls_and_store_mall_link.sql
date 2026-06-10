-- ============================================================================
-- Migración: centros comerciales (malls) y vínculo de tiendas/kioscos a un mall
-- ----------------------------------------------------------------------------
-- Contexto: hasta ahora el sistema asumía que TODA tienda pertenece al CC
-- Millennium (el alta exigía piso/local físicos y el kiosco listaba todas las
-- tiendas). El proyecto se adaptará a OTROS centros comerciales, así que se
-- modela la pertenencia con un catálogo `malls` y una FK `stores.mall_id`
-- (NULL = tienda externa, sin centro comercial). Una tienda externa puede ser
-- cliente y adquirir planes igual que cualquier otra; simplemente no aparece en
-- el directorio/mapa físico del kiosco.
--
-- Este script:
--   1. Crea `public.malls` y siembra "CC Millennium".
--   2. Agrega `stores.mall_id` y hace backfill de TODAS las tiendas actuales a
--      Millennium (estado de hoy).
--   3. Agrega `kiosks.mall_id` (cada kiosco filtra tiendas por su mall) y hace
--      el mismo backfill.
--   4. Habilita RLS de lectura del catálogo `malls` (kiosco anónimo + panel).
-- Idempotente: usa IF NOT EXISTS / ON CONFLICT donde aplica.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Catálogo de centros comerciales
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.malls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  code       text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.malls (name, code)
VALUES ('CC Millennium', 'MILLENNIUM')
ON CONFLICT (code) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. stores.mall_id  (NULL = tienda externa)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS mall_id uuid REFERENCES public.malls(id);

-- Backfill: todas las tiendas existentes quedan vinculadas a Millennium.
UPDATE public.stores
   SET mall_id = (SELECT id FROM public.malls WHERE code = 'MILLENNIUM')
 WHERE mall_id IS NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. kiosks.mall_id  (cada kiosco lista sólo tiendas de su mall)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.kiosks
  ADD COLUMN IF NOT EXISTS mall_id uuid REFERENCES public.malls(id);

UPDATE public.kiosks
   SET mall_id = (SELECT id FROM public.malls WHERE code = 'MILLENNIUM')
 WHERE mall_id IS NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS: el catálogo de malls es de lectura pública (kiosco anónimo + panel)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.malls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "malls_read_all" ON public.malls;
CREATE POLICY "malls_read_all" ON public.malls
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "malls_admin_write" ON public.malls;
CREATE POLICY "malls_admin_write" ON public.malls
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación opcional:
--   SELECT count(*) FROM public.stores WHERE mall_id IS NULL;   -- 0
--   SELECT id, name, code FROM public.malls;                    -- CC Millennium
--   SELECT count(*) FROM public.kiosks WHERE mall_id IS NULL;   -- 0
-- ============================================================================
