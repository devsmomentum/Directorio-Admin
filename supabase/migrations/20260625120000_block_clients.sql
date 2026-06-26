-- ============================================================================
-- Bloqueo de clientes
-- ----------------------------------------------------------------------------
-- El admin puede bloquear el acceso de un cliente al portal. El bloqueo:
--   * Marca public.users.is_blocked = true y guarda una razón OBLIGATORIA,
--     quién lo bloqueó y cuándo. La razón es de uso administrativo: al cliente
--     solo se le informa que se comunique con Mall Hub, nunca se le muestra.
--   * Corta el acceso a datos: user_owns_store() devuelve false para un dueño
--     bloqueado, así sus tiendas / campañas / pagos quedan inaccesibles vía RLS.
--   * El portal (cliente/layout) y el login redirigen al cliente bloqueado a
--     /bloqueado.
--
-- Endurecimiento: la policy users_self_update deja al cliente editar su propia
-- fila. Para que un cliente bloqueado NO pueda auto-desbloquearse vía API, el
-- trigger guard_users_self_update() revierte las columnas de bloqueo en
-- cualquier UPDATE hecho por un no-admin.
-- ============================================================================

-- ── 1. Columnas de bloqueo ────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_blocked   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_reason text,
  ADD COLUMN IF NOT EXISTS blocked_at   timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.users.is_blocked   IS 'Si true, el cliente no puede acceder al portal ni a sus datos (RLS).';
COMMENT ON COLUMN public.users.block_reason IS 'Razón administrativa del bloqueo. NO se muestra al cliente.';
COMMENT ON COLUMN public.users.blocked_at   IS 'Momento en que se bloqueó al cliente.';
COMMENT ON COLUMN public.users.blocked_by   IS 'Admin que ejecutó el bloqueo.';

CREATE INDEX IF NOT EXISTS idx_users_is_blocked ON public.users(is_blocked) WHERE is_blocked;


-- ── 2. user_owns_store: un dueño bloqueado deja de "poseer" sus tiendas ─────────
-- Se preserva el cuerpo VIVO de la función (incluye store_role = 'owner', que NO
-- aparece en cliente_portal_auth.sql porque ese archivo está desfasado) y solo
-- se añade el filtro de bloqueo. El bloqueo aplica al dueño; el staff
-- (seller/advertiser) usa otros helpers y no se ve afectado por esta función.
CREATE OR REPLACE FUNCTION public.user_owns_store(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_stores us
      JOIN public.users u ON u.id = us.user_id
     WHERE us.user_id   = auth.uid()
       AND us.store_id  = p_store_id
       AND us.store_role = 'owner'
       AND u.is_blocked IS NOT TRUE
  );
$$;
GRANT EXECUTE ON FUNCTION public.user_owns_store(uuid) TO authenticated;


-- ── 3. Guard: el cliente no puede auto-modificar su estado de bloqueo ───────────
-- Extiende el guard existente (revertía role + email) añadiendo las columnas de
-- bloqueo. Un UPDATE de un no-admin nunca podrá cambiarlas.
CREATE OR REPLACE FUNCTION public.guard_users_self_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Permite la actualización si el usuario es admin en la app
  -- o si la actualización se hace directo desde la base de datos (auth.uid() es NULL)
  IF public.is_admin() OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Usuario normal (cliente) actualizándose a sí mismo: se revierten las
  -- columnas que no le corresponde tocar, incluido su estado de bloqueo.
  NEW.role         := OLD.role;
  NEW.email        := OLD.email;
  NEW.is_blocked   := OLD.is_blocked;
  NEW.block_reason := OLD.block_reason;
  NEW.blocked_at   := OLD.blocked_at;
  NEW.blocked_by   := OLD.blocked_by;
  NEW.updated_at   := now();
  RETURN NEW;
END $$;


-- ── 4. RPC: bloquear cliente ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_block_client(
  p_user_id uuid,
  p_reason  text
)
RETURNS public.users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_user   public.users%ROWTYPE;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede bloquear clientes' USING ERRCODE = '42501';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'La razón del bloqueo es obligatoria' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente no encontrado' USING ERRCODE = 'P0002';
  END IF;

  IF v_user.role <> 'cliente' THEN
    RAISE EXCEPTION 'Solo se pueden bloquear clientes' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.users
     SET is_blocked   = true,
         block_reason = left(v_reason, 500),
         blocked_at   = now(),
         blocked_by   = auth.uid()
   WHERE id = p_user_id
   RETURNING * INTO v_user;

  RETURN v_user;
END $$;
GRANT EXECUTE ON FUNCTION public.admin_block_client(uuid, text) TO authenticated;


-- ── 5. RPC: desbloquear cliente ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_unblock_client(p_user_id uuid)
RETURNS public.users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo el admin puede desbloquear clientes' USING ERRCODE = '42501';
  END IF;

  UPDATE public.users
     SET is_blocked   = false,
         block_reason = NULL,
         blocked_at   = NULL,
         blocked_by   = NULL
   WHERE id = p_user_id
   RETURNING * INTO v_user;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente no encontrado' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_user;
END $$;
GRANT EXECUTE ON FUNCTION public.admin_unblock_client(uuid) TO authenticated;
