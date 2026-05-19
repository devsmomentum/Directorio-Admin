-- ============================================================================
-- 004 — Client identity validation: unique phone/doc/email + doc_tipo column
-- ============================================================================
-- Agrega:
--   1. Columna doc_tipo ('V' | 'E') para el tipo de documento de identidad.
--   2. Índice UNIQUE parcial en (doc_tipo, cedula_numero) para clientes.
--   3. Índice UNIQUE parcial en telefono_personal para clientes.
--   4. Índice UNIQUE parcial en correo_personal para clientes.
-- ============================================================================

-- 1. Agregar la columna doc_tipo con default 'V'
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS doc_tipo text DEFAULT 'V'
    CHECK (doc_tipo IN ('V', 'E'));

-- 2. Documento de identidad único por tipo (solo para clientes con dato no nulo)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_doc
  ON public.users (doc_tipo, cedula_numero)
  WHERE role = 'cliente' AND cedula_numero IS NOT NULL;

-- 3. Teléfono único (solo para clientes con dato no nulo)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_telefono
  ON public.users (telefono_personal)
  WHERE role = 'cliente' AND telefono_personal IS NOT NULL;

