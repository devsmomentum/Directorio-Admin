-- =====================================================================
-- owner_list_store_staff → incluir telefono_personal
--
-- El dueño reenvía el enlace de activación a un colaborador por correo o
-- WhatsApp (UI en /cliente/equipo). Para WhatsApp hace falta el teléfono;
-- antes el listado no lo devolvía y había que teclearlo de nuevo. Ahora se
-- expone telefono_personal (de public.users) para autocompletarlo.
--
-- Cambia el RETURNS TABLE → requiere DROP + CREATE (CREATE OR REPLACE no
-- permite alterar el tipo de retorno de una función existente).
-- =====================================================================

DROP FUNCTION IF EXISTS public.owner_list_store_staff(uuid);

CREATE OR REPLACE FUNCTION public.owner_list_store_staff(p_store_id uuid)
 RETURNS TABLE(
   user_id           uuid,
   email             text,
   full_name         text,
   telefono_personal text,
   store_role        text,
   created_at        timestamp with time zone
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NOT public.user_owns_store(p_store_id) THEN
    RAISE EXCEPTION 'No eres dueño de esta tienda.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT us.user_id, u.email, u.full_name, u.telefono_personal, us.store_role, us.created_at
      FROM public.user_stores us
      JOIN public.users u ON u.id = us.user_id
     WHERE us.store_id = p_store_id
       AND us.store_role IN ('seller','advertiser')
     ORDER BY us.created_at DESC;
END $function$;
