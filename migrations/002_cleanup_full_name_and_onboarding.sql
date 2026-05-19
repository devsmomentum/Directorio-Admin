-- ============================================================================
-- Migración: limpieza de full_name=email y reset de onboarding pendiente
-- ----------------------------------------------------------------------------
-- Contexto: el flujo viejo permitía que clientes invitados entraran al portal
-- (vía /cliente/auth/callback) sin pasar por /bienvenida, dejando
-- public.users.full_name en NULL — y el sidebar mostraba el email como nombre.
-- Algunas filas pudieron quedar con full_name = email por otros caminos.
--
-- Esta migración:
--   1. Normaliza public.users.full_name: si está vacío o igual al email →
--      NULL (no "se guarda el correo como nombre"). El login unificado
--      mostrará "Sin nombre" hasta que el cliente complete el onboarding.
--   2. Para los clientes que aún no han definido contraseña (no pasaron por
--      /bienvenida), borra el flag password_set de raw_user_meta_data para
--      forzarlos al onboarding la próxima vez que entren.
--
-- Heurística usada para detectar "cliente sin contraseña real": existencia
-- de la fila en public.users con role='cliente' y full_name NULL/igual al
-- email. Es conservador — si un cliente ya tiene nombre real, no lo tocamos.
--
-- Idempotente.
-- ============================================================================


-- 1. Limpiar full_name sucio
UPDATE public.users
SET full_name = NULL,
    updated_at = now()
WHERE role = 'cliente'
  AND full_name IS NOT NULL
  AND (trim(full_name) = '' OR lower(trim(full_name)) = lower(trim(email)));


-- 2. Forzar onboarding a clientes sin nombre real.
-- Quitar la clave password_set del JSONB (no lo seteamos a false porque el
-- código lee `Boolean(...)` y null/undefined ya cuentan como "no").
UPDATE auth.users AS au
SET raw_user_meta_data = COALESCE(au.raw_user_meta_data, '{}'::jsonb) - 'password_set'
FROM public.users AS pu
WHERE pu.id = au.id
  AND pu.role = 'cliente'
  AND pu.full_name IS NULL;


-- Verificación opcional:
-- SELECT pu.email, pu.full_name, au.raw_user_meta_data->>'password_set' AS password_set
-- FROM public.users pu
-- JOIN auth.users au ON au.id = pu.id
-- WHERE pu.role = 'cliente';
