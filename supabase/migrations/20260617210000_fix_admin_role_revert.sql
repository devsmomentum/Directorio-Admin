-- Permite actualizar el rol de usuario directamente desde la BD
-- al ignorar la regla si el ejecutor es superusuario (auth.uid() IS NULL)

CREATE OR REPLACE FUNCTION public.guard_users_self_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Permite la actualización si el usuario es admin en la app 
  -- o si la actualización se hace directo desde la base de datos (auth.uid() es NULL)
  IF public.is_admin() OR auth.uid() IS NULL THEN 
    RETURN NEW; 
  END IF;
  
  -- Si es un usuario normal (cliente) intentando cambiarse a sí mismo, se revierte su cambio
  NEW.role  := OLD.role;
  NEW.email := OLD.email;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
