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
  | 'DESVINCULAR';

export type AuditEntityType = 
  | 'tienda' 
  | 'campaña' 
  | 'banner' 
  | 'cupón' 
  | 'kiosco' 
  | 'categoría' 
  | 'plan' 
  | 'servicio' 
  | 'gasto_operativo' 
  | 'pago'
  | 'solicitud';

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
