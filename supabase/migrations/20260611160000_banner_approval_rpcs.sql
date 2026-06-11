-- ============================================================================
-- 20260611160000_banner_approval_rpcs.sql
--
-- RPCs de aprobación/rechazo de banners por el admin.
-- Actualización de la política de RLS de banners para soportar el rol 'publicista' (user_can_manage_ads).
-- Robustez en los triggers para evitar manipulaciones de campos sensibles.
-- ============================================================================

-- 1. Actualizar RLS policy para permitir a publicistas ('advertiser') gestionar banners
DROP POLICY IF EXISTS "banners_owner" ON public.banners;
CREATE POLICY "banners_owner" ON public.banners
  FOR ALL TO authenticated
  USING (public.user_can_manage_ads(store_id))
  WITH CHECK (public.user_can_manage_ads(store_id));

-- 2. Asegurar que guard_banners_client_insert sea robusto
CREATE OR REPLACE FUNCTION public.guard_banners_client_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Si es admin, no forzamos nada
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- Si es miembro de la tienda (dueño o publicista)
  IF public.user_member_of_store(NEW.store_id) THEN
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.is_active        := false;
  ELSE
    RAISE EXCEPTION 'No tienes permisos sobre esta tienda.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Asegurar que guard_banners_client_update sea robusto y proteja campos sensibles
CREATE OR REPLACE FUNCTION public.guard_banners_client_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Si es admin, no hacemos bypass de seguridad pero retornamos directamente
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- Si es miembro de la tienda
  IF public.user_member_of_store(NEW.store_id) THEN
    -- Campos inmutables para el cliente
    NEW.store_id         := OLD.store_id;
    NEW.approval_status  := OLD.approval_status;
    NEW.rejection_reason := OLD.rejection_reason;

    -- Si cambió el media_url, vuelve a revisión
    IF NEW.media_url IS DISTINCT FROM OLD.media_url THEN
      NEW.approval_status  := 'pending';
      NEW.rejection_reason := NULL;
      NEW.is_active        := false;
    END IF;
  ELSE
    RAISE EXCEPTION 'No tienes permisos sobre esta tienda.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- 4. RPC: admin_approve_banner
DROP FUNCTION IF EXISTS public.admin_approve_banner(UUID);
CREATE OR REPLACE FUNCTION public.admin_approve_banner(p_banner_id UUID)
RETURNS public.banners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.banners;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden aprobar banners.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.banners
     SET approval_status  = 'approved',
         rejection_reason = NULL,
         is_active        = true
   WHERE id = p_banner_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Banner % no existe.', p_banner_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_banner(UUID) TO authenticated;

-- 5. RPC: admin_reject_banner
DROP FUNCTION IF EXISTS public.admin_reject_banner(UUID, TEXT);
CREATE OR REPLACE FUNCTION public.admin_reject_banner(p_banner_id UUID, p_reason TEXT)
RETURNS public.banners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.banners;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden rechazar banners.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.banners
     SET approval_status  = 'rejected',
         rejection_reason = NULLIF(btrim(p_reason), ''),
         is_active        = false
   WHERE id = p_banner_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Banner % no existe.', p_banner_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_reject_banner(UUID, TEXT) TO authenticated;
