import { supabase } from './supabase';

export type AuditActionType = 
  | 'CREAR' 
  | 'EDITAR' 
  | 'ELIMINAR' 
  | 'APROBAR' 
  | 'RECHAZAR' 
  | 'ACTIVAR'
  | 'DESACTIVAR'
  | 'VINCULAR'
  | 'DESVINCULAR'
  | 'BLOQUEAR'
  | 'DESBLOQUEAR';

export type AuditEntityType =
  | 'tienda'
  | 'aliado'
  | 'contrato_tienda'
  | 'cliente'
  | 'campaña'
  | 'banner'
  | 'cupón'
  | 'kiosco'
  | 'categoría'
  | 'plan'
  | 'servicio'
  | 'pago'
  | 'configuracion';

/** Fila de `admin_audit_logs` tal como se lee en el panel de Auditoría. */
export interface AdminAuditLog {
  id: string;
  admin_id: string;
  admin_email: string;
  action_type: AuditActionType;
  entity_type: AuditEntityType;
  entity_id: string | null;
  entity_name: string | null;
  details: Record<string, any> | null;
  created_at: string;
}

export interface AuditActionPayload {
  action_type: AuditActionType;
  entity_type: AuditEntityType;
  entity_id?: string;
  entity_name?: string;
  details?: Record<string, any> | null;
}

/**
 * Registra una acción administrativa importante en la tabla `admin_audit_logs`.
 */
export async function logAdminAction(payload: AuditActionPayload) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      console.warn('Intento de registrar auditoría sin sesión activa.');
      return;
    }

    const { error } = await supabase.from('admin_audit_logs').insert({
      admin_id: session.user.id,
      admin_email: session.user.email ?? 'desconocido',
      action_type: payload.action_type,
      entity_type: payload.entity_type,
      entity_id: payload.entity_id,
      entity_name: payload.entity_name,
      details: payload.details || null,
    });

    if (error) {
      console.error('Error al insertar registro de auditoría:', error);
    }
  } catch (err) {
    console.error('Error inesperado al registrar auditoría:', err);
  }
}
