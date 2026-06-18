-- Tabla de configuración general de la aplicación (clave → valor).
-- Centraliza parámetros que el admin puede ajustar en tiempo de ejecución
-- sin necesidad de migraciones adicionales.

CREATE TABLE IF NOT EXISTS public.app_config (
  key         text        PRIMARY KEY,
  value       text        NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

-- Todos pueden leer (frontend y cliente consultan sin autenticar como admin).
CREATE POLICY "app_config_read"  ON public.app_config FOR SELECT USING (true);
-- Solo admin puede escribir.
CREATE POLICY "app_config_admin" ON public.app_config FOR ALL   USING (public.is_admin());

-- Nota: el tamaño del loop publicitario NO se almacena aquí.
-- Se deriva en tiempo de ejecución de la suma de plans.max_brands
-- donde loop_eligible = true. Editable desde /panel/configuracion.

-- enforce_active_campaign_cap: chequeo de slots de loop para aliados.
-- El tamaño del loop = suma de plans.max_brands donde loop_eligible = true
-- (configurable desde /panel/configuracion → Slots por plan).
CREATE OR REPLACE FUNCTION public.enforce_active_campaign_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_cap         int;
  v_count       int;
  v_is_ally     boolean;
  v_ally_cap    int;
  v_loop_max    int;
  v_slots_used  int;
BEGIN
  IF NOT COALESCE(NEW.is_active, false) THEN RETURN NEW; END IF;
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;

  IF public.is_admin() THEN
    v_cap := 5;

  ELSIF NEW.store_id IS NOT NULL AND public.user_can_manage_ads(NEW.store_id) THEN
    SELECT is_ally, ally_campaign_limit
      INTO v_is_ally, v_ally_cap
      FROM public.stores
     WHERE id = NEW.store_id;

    IF COALESCE(v_is_ally, false) THEN
      v_cap := GREATEST(1, COALESCE(v_ally_cap, 1));

      -- Tamaño del loop = suma de max_brands de los planes con loop_eligible.
      -- Cada campaña activa ocupa 1 slot, sin importar su duración en segundos.
      SELECT COALESCE(SUM(max_brands), 12) INTO v_loop_max
        FROM public.plans
       WHERE loop_eligible = true
         AND max_brands IS NOT NULL
         AND is_active = true;

      SELECT COUNT(*) INTO v_slots_used
        FROM public.ad_campaigns c
       WHERE c.is_active = true
         AND c.id <> NEW.id
         AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE);

      IF v_slots_used + 1 > v_loop_max THEN
        NEW.is_active := false;
        RETURN NEW;
      END IF;

    ELSE
      v_cap := 1;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('camp_cap:' || COALESCE(NEW.store_id::text, 'global'), 0));

  SELECT count(*) INTO v_count
    FROM public.ad_campaigns c
   WHERE c.store_id = NEW.store_id
     AND c.is_active = true
     AND c.id <> NEW.id
     AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE);

  IF v_count + 1 > v_cap THEN
    IF public.is_admin() THEN
      RAISE EXCEPTION 'La tienda ya tiene % campañas activas (máximo). Pausa una antes de activar otra.', v_cap
        USING ERRCODE = 'P0001';
    ELSE
      NEW.is_active := false;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
