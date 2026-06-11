-- Banners: flujo de aprobación por admin cuando el cliente los sube
-- Clientes con plan DIAMANTE pueden proponer banners desde el portal; quedan
-- en revisión hasta que el administrador los apruebe o rechace.

ALTER TABLE public.banners
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Guard INSERT: fuerza pending + inactivo para miembros de tienda.
-- El admin (no vinculado a user_stores) queda exento y sus banners siguen en
-- 'approved'. Defense-in-depth: el código cliente también lo declara.
CREATE OR REPLACE FUNCTION public.guard_banners_client_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF public.user_member_of_store(NEW.store_id) THEN
    NEW.approval_status := 'pending';
    NEW.is_active        := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_banners_guard_client_insert ON public.banners;
CREATE TRIGGER trg_banners_guard_client_insert
  BEFORE INSERT ON public.banners
  FOR EACH ROW EXECUTE FUNCTION public.guard_banners_client_insert();

-- Guard UPDATE: si el cliente cambia el archivo media, vuelve a revisión.
-- Cambios sólo de fechas/posición no reinician el estado de aprobación.
CREATE OR REPLACE FUNCTION public.guard_banners_client_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF public.user_member_of_store(NEW.store_id) AND NEW.media_url <> OLD.media_url THEN
    NEW.approval_status := 'pending';
    NEW.is_active        := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_banners_guard_client_update ON public.banners;
CREATE TRIGGER trg_banners_guard_client_update
  BEFORE UPDATE ON public.banners
  FOR EACH ROW EXECUTE FUNCTION public.guard_banners_client_update();
