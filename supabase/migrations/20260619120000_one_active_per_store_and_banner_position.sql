-- =====================================================================
-- Invariantes de slots únicos (refuerzo en BD, no solo en la app)
--
--  1) Campañas: máximo UNA campaña activa+vigente por tienda. Aplica también
--     a las reactivaciones (el trigger corre BEFORE INSERT OR UPDATE). El admin
--     ya NO puede apilar varias (antes el cap era 5 para is_admin()). Las
--     tiendas aliadas conservan su ally_campaign_limit (feature intencional).
--  2) Banners: máximo UN banner activo+vigente por posición (top / bottom),
--     o sea hasta 2 en pantalla. Aplica a admin y cliente por igual. Cuando se
--     agregue la dimensión por K2, este check se extenderá a (ui_position, k2).
--
-- Nota: el cap de campañas solo se evalúa cuando el actor es admin (is_admin())
-- o gestor de la tienda (user_can_manage_ads). El service-role del backend
-- (crons/sync) queda exento, igual que antes, y el bypass
-- app.bypass_campaign_guard sigue vigente para el kill-switch.
-- =====================================================================

-- ── 1. Campañas: cap por TIENDA, independiente de quién edita ─────────
CREATE OR REPLACE FUNCTION public.enforce_active_campaign_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_cap int; v_count int; v_is_ally boolean; v_ally_cap int; v_acting_admin boolean;
BEGIN
  -- Solo nos importa cuando la fila quedaría activa.
  IF NOT COALESCE(NEW.is_active, false) THEN RETURN NEW; END IF;
  -- El kill-switch / cron usan este bypass para reconciliar sin pelear el guard.
  IF current_setting('app.bypass_campaign_guard', true) = 'on' THEN RETURN NEW; END IF;

  v_acting_admin := public.is_admin();

  -- El cap aplica cuando hay tienda y el actor es admin o gestor de esa tienda.
  IF NEW.store_id IS NULL THEN
    RETURN NEW;
  ELSIF NOT (v_acting_admin OR public.user_can_manage_ads(NEW.store_id)) THEN
    RETURN NEW;
  END IF;

  -- El tope depende de la TIENDA, no del actor: 1 para tiendas normales,
  -- ally_campaign_limit para aliadas. (Antes el admin tenía un tope fijo de 5
  -- que permitía apilar campañas activas de la misma tienda.)
  SELECT is_ally, ally_campaign_limit INTO v_is_ally, v_ally_cap
    FROM public.stores WHERE id = NEW.store_id;
  IF COALESCE(v_is_ally, false) THEN
    v_cap := GREATEST(1, COALESCE(v_ally_cap, 1));
  ELSE
    v_cap := 1;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('camp_cap:' || NEW.store_id::text, 0));

  -- Solo cuentan las OTRAS campañas activas que sigan vigentes (en-vivo); una
  -- vencida ya no ocupa slot aunque conserve is_active=true sin reconciliar.
  SELECT count(*) INTO v_count
    FROM public.ad_campaigns c
   WHERE c.store_id = NEW.store_id AND c.is_active = true AND c.id <> NEW.id
     AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE);

  IF v_count + 1 > v_cap THEN
    IF v_acting_admin THEN
      RAISE EXCEPTION 'La tienda ya tiene % campaña(s) activa(s) (máximo). Pausa una antes de activar otra.', v_cap
        USING ERRCODE = 'P0001';
    ELSE
      -- Para dueños/anunciantes revertimos en silencio; la app detecta que
      -- is_active no quedó como pidió y muestra el aviso correspondiente.
      NEW.is_active := false;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- ── 2. Banners: un activo por posición (top / bottom) ─────────────────
CREATE OR REPLACE FUNCTION public.enforce_one_active_banner_per_position()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_count int;
BEGIN
  -- Solo importa cuando el banner quedaría activo Y vigente.
  IF NOT COALESCE(NEW.is_active, false) THEN RETURN NEW; END IF;
  IF NEW.end_date IS NOT NULL AND NEW.end_date < now() THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('banner_pos:' || COALESCE(NEW.ui_position, ''), 0));

  -- Otros banners activos y vigentes en la misma posición.
  SELECT count(*) INTO v_count
    FROM public.banners b
   WHERE b.ui_position = NEW.ui_position
     AND b.is_active = true
     AND b.id <> NEW.id
     AND (b.end_date IS NULL OR b.end_date >= now());

  IF v_count >= 1 THEN
    RAISE EXCEPTION 'Ya hay un banner activo en la posición "%". Solo se permite uno por posición. Pausa el actual antes de activar otro.', NEW.ui_position
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS tr_enforce_one_active_banner_per_position ON public.banners;
CREATE TRIGGER tr_enforce_one_active_banner_per_position
  BEFORE INSERT OR UPDATE ON public.banners
  FOR EACH ROW EXECUTE FUNCTION public.enforce_one_active_banner_per_position();
