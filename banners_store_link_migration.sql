-- =====================================================================
-- Módulo: Banners ↔ Tienda (PDF "PLANES DIRECTORIOS")
-- Objetivo: cada banner del kiosco debe pertenecer a una tienda con plan
-- DIAMANTE. Esa es la única vía de adquisición del slot de banner en la UI;
-- el FK + trigger garantizan que la regla no se pueda violar desde el SDK.
-- =====================================================================

-- ── 1. Columna FK ────────────────────────────────────────────────────
ALTER TABLE public.banners
  ADD COLUMN IF NOT EXISTS store_id UUID;

-- Restablecer FK (idempotente: lo dropea si existía con otra config).
ALTER TABLE public.banners
  DROP CONSTRAINT IF EXISTS banners_store_id_fkey;

ALTER TABLE public.banners
  ADD CONSTRAINT banners_store_id_fkey
  FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_banners_store_id
  ON public.banners (store_id);

-- ── 2. Trigger: la tienda vinculada debe tener plan_type = 'DIAMANTE' ─
-- Política comercial: el slot de banner es exclusivo del plan Diamante.
-- Si la tienda cambia de plan después, los banners viejos siguen vivos
-- (no se borran retroactivamente) pero un INSERT/UPDATE nuevo es bloqueado.
CREATE OR REPLACE FUNCTION public.enforce_banner_diamante()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_plan TEXT;
BEGIN
  IF NEW.store_id IS NULL THEN
    RAISE EXCEPTION 'banner sin tienda vinculada (store_id requerido)'
      USING ERRCODE = '23514';
  END IF;

  SELECT plan_type INTO v_plan FROM public.stores WHERE id = NEW.store_id;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'tienda % no existe', NEW.store_id
      USING ERRCODE = '23503';
  END IF;

  IF v_plan <> 'DIAMANTE' THEN
    RAISE EXCEPTION 'tienda % no es DIAMANTE (plan_type=%); banners solo aplican a plan Diamante', NEW.store_id, v_plan
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_banners_enforce_diamante ON public.banners;
CREATE TRIGGER trg_banners_enforce_diamante
  BEFORE INSERT OR UPDATE OF store_id ON public.banners
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_banner_diamante();

-- ── 3. NOT NULL después del backfill manual ──────────────────────────
-- Si hay banners legacy sin store_id, completalos antes de correr este bloque
-- (UPDATE public.banners SET store_id = '<uuid-diamante>' WHERE store_id IS NULL;)
-- Una vez verificado que no quedan NULLs, descomentar:
--
-- ALTER TABLE public.banners
--   ALTER COLUMN store_id SET NOT NULL;

-- ── 4. Verificación ──────────────────────────────────────────────────
SELECT
  COUNT(*) FILTER (WHERE store_id IS NULL)       AS banners_sin_tienda,
  COUNT(*) FILTER (WHERE store_id IS NOT NULL)   AS banners_con_tienda,
  COUNT(*)                                       AS total
FROM public.banners;
