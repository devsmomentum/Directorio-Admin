-- ============================================================================
-- Fix: guard_stores_owner_update() bloqueaba a los procesos backend (cron)
-- ----------------------------------------------------------------------------
-- Problema:
--   El trigger BEFORE UPDATE 'trg_stores_guard' (cliente_portal_auth.sql) revierte
--   plan_type, contract_expiry_date, etc. salvo que is_admin() sea true. Pero
--   is_admin() = EXISTS(... WHERE id = auth.uid() AND role='admin') y en un job de
--   pg_cron NO hay JWT → auth.uid() es NULL → is_admin() = false. SECURITY DEFINER
--   no inyecta auth.uid(), solo cambia el rol de BD.
--
--   Consecuencia: activate_scheduled_plans() y la nulificación de plan_type en
--   apply_kill_switch() ejecutaban su UPDATE, el trigger lo revertía silenciosamente
--   (pero la notificación de éxito sí se insertaba), y la fila quedaba "pendiente"
--   para siempre → bucle infinito de re-activación diaria sin cambiar la fecha.
--
-- Fix:
--   El guard solo debe aplicar a sesiones de cliente AUTENTICADAS (dueños de
--   tienda). Cuando auth.uid() IS NULL el llamante es un proceso backend de
--   confianza (cron / función SECURITY DEFINER sin sesión de usuario): se permite
--   el update completo. La RLS ya bloquea a 'anon' y a usuarios no autorizados
--   antes de que el UPDATE llegue al trigger, así que abrir este camino no expone
--   las columnas a clientes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_stores_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Admin, o contexto backend sin sesión de usuario (cron / SECURITY DEFINER):
  -- permitir el update completo. El guard solo protege contra clientes dueños.
  IF public.is_admin() OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.plan_type            := OLD.plan_type;
  NEW.contract_url         := OLD.contract_url;
  NEW.mercantil_url        := OLD.mercantil_url;
  NEW.cedula_url           := OLD.cedula_url;
  NEW.contract_expiry_date := OLD.contract_expiry_date;
  NEW.rif                  := OLD.rif;
  NEW.local_number         := OLD.local_number;
  NEW.floor_level          := OLD.floor_level;
  NEW.category_id          := OLD.category_id;
  NEW.node_id              := OLD.node_id;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.guard_stores_owner_update() IS
  'Impide que un cliente dueño de tienda edite columnas sensibles (plan_type, '
  'contract_expiry_date, etc.). Permite el update a admins y a procesos backend '
  'sin sesión (auth.uid() IS NULL: cron / SECURITY DEFINER). Ver migración '
  '20260603130000.';
