-- ============================================================================
-- Migración: marcar a los admins existentes como password_set=true
-- ----------------------------------------------------------------------------
-- Justificación: el flujo nuevo de auth añade un onboarding en /bienvenida
-- al que se llega cuando auth.users.raw_user_meta_data->>'password_set' no es
-- 'true'. Los admins actuales YA tienen contraseña en auth.users — no deben
-- pasar por onboarding. Este script los marca como ya completados.
--
-- Idempotente: corregir-y-correr todas las veces que haga falta. No toca a los
-- clientes (sólo afecta a users con role='admin' en public.users).
-- ============================================================================

UPDATE auth.users AS au
SET raw_user_meta_data = COALESCE(au.raw_user_meta_data, '{}'::jsonb)
                         || jsonb_build_object('password_set', true)
FROM public.users AS pu
WHERE pu.id = au.id
  AND pu.role = 'admin';

-- Verificación (opcional, descomentar):
-- SELECT pu.email, au.raw_user_meta_data->>'password_set' AS password_set
-- FROM public.users pu
-- JOIN auth.users au ON au.id = pu.id
-- WHERE pu.role = 'admin';
