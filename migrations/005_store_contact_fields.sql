-- ============================================================================
-- 005 — Store contact fields: contact_email + contact_phone en stores
-- ============================================================================
-- Repone los campos de contacto de la tienda (empresa) que se usan en el
-- panel de admin (/panel/tiendas) y en el export CSV. Distintos del
-- correo/teléfono personal del cliente vinculado (users).
-- ============================================================================

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text;

-- Refrescar el schema cache de PostgREST para que Supabase reconozca las
-- nuevas columnas sin reinicio manual.
NOTIFY pgrst, 'reload schema';
