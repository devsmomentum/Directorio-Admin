-- ============================================================================
-- 029_admin_audit_logs.sql
--
-- Crea la tabla `admin_audit_logs` para registrar las acciones importantes
-- que realizan los administradores (crear, editar, eliminar, aprobar, rechazar, etc.)
-- en el panel de control.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL,
  admin_email TEXT NOT NULL,
  action_type TEXT NOT NULL, -- 'CREAR', 'EDITAR', 'ELIMINAR', 'APROBAR', 'RECHAZAR', 'ACTIVAR', 'DESACTIVAR'
  entity_type TEXT NOT NULL, -- 'tienda', 'campaña', 'banner', 'cupón', 'kiosco', 'categoría', 'plan', 'servicio', 'gasto_operativo', 'pago'
  entity_id   TEXT,
  entity_name TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_audit_logs_pkey PRIMARY KEY (id)
);

-- Habilitar Row Level Security (RLS)
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- Políticas de Seguridad RLS
-- 1. Solo los administradores pueden consultar los registros de auditoría
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'admin_audit_logs' 
      AND policyname = 'admin_audit_logs_select'
  ) THEN
    CREATE POLICY "admin_audit_logs_select" ON public.admin_audit_logs
      FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
END $$;

-- 2. Permitir inserciones a los usuarios autenticados que son administradores
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'admin_audit_logs' 
      AND policyname = 'admin_audit_logs_insert'
  ) THEN
    CREATE POLICY "admin_audit_logs_insert" ON public.admin_audit_logs
      FOR INSERT TO authenticated WITH CHECK (public.is_admin());
  END IF;
END $$;

-- Dar permisos de ejecución
GRANT SELECT, INSERT ON public.admin_audit_logs TO authenticated;
