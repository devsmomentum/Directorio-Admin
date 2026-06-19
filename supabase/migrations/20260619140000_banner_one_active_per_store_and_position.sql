-- Refuerzo: además de "1 activo por posición", un banner debe ser ÚNICO activo
-- por TIENDA ("uno solo por plan"). Antes, una tienda con un banner activo en
-- 'bottom' podía aprobar otro en 'top' y quedar con DOS activos. Ahora el
-- trigger bloquea ambos casos (posición ocupada o tienda con otro activo).
--
-- El flujo de aprobación admin (app/panel/solicitudes) detecta el conflicto y
-- pregunta si se desactiva el banner actual (swap) antes de aprobar; este
-- trigger es el backstop en BD para cualquier ruta (panel, toggle, RPC).
CREATE OR REPLACE FUNCTION public.enforce_one_active_banner_per_position()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_pos_count int; v_store_count int;
BEGIN
  -- Solo importa cuando el banner quedaría activo Y vigente.
  IF NOT COALESCE(NEW.is_active, false) THEN RETURN NEW; END IF;
  IF NEW.end_date IS NOT NULL AND NEW.end_date < now() THEN RETURN NEW; END IF;

  -- Serializamos por posición y por tienda para evitar carreras en swaps.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('banner_pos:' || COALESCE(NEW.ui_position, ''), 0));
  IF NEW.store_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('banner_store:' || NEW.store_id::text, 0));
  END IF;

  -- (1) Un activo por posición (top / bottom) — entre todas las tiendas.
  SELECT count(*) INTO v_pos_count
    FROM public.banners b
   WHERE b.ui_position = NEW.ui_position
     AND b.is_active = true
     AND b.id <> NEW.id
     AND (b.end_date IS NULL OR b.end_date >= now());
  IF v_pos_count >= 1 THEN
    RAISE EXCEPTION 'Ya hay un banner activo en la posición "%". Solo se permite uno por posición. Pausa el actual antes de activar otro.', NEW.ui_position
      USING ERRCODE = 'P0001';
  END IF;

  -- (2) Un activo por TIENDA ("uno por plan"): la misma tienda no puede tener
  -- dos banners activos (p.ej. uno en top y otro en bottom) a la vez.
  IF NEW.store_id IS NOT NULL THEN
    SELECT count(*) INTO v_store_count
      FROM public.banners b
     WHERE b.store_id = NEW.store_id
       AND b.is_active = true
       AND b.id <> NEW.id
       AND (b.end_date IS NULL OR b.end_date >= now());
    IF v_store_count >= 1 THEN
      RAISE EXCEPTION 'Esta tienda ya tiene un banner activo. Desactiva el actual antes de activar otro.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END $function$;
