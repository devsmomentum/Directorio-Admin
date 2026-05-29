-- ============================================================================
-- SCRIPT DE AUDITORÍA DE ADMINISTRADORES
-- Ejecuta este script en el editor SQL de Supabase (Supabase Dashboard > SQL Editor)
-- para crear la tabla de auditoría y configurar sus permisos.
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
DROP POLICY IF EXISTS "admin_audit_logs_select" ON public.admin_audit_logs;
CREATE POLICY "admin_audit_logs_select" ON public.admin_audit_logs
  FOR SELECT TO authenticated USING (public.is_admin());

-- 2. Permitir inserciones a los usuarios autenticados que son administradores
DROP POLICY IF EXISTS "admin_audit_logs_insert" ON public.admin_audit_logs;
CREATE POLICY "admin_audit_logs_insert" ON public.admin_audit_logs
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

-- Dar permisos de ejecución
GRANT SELECT, INSERT ON public.admin_audit_logs TO authenticated;
