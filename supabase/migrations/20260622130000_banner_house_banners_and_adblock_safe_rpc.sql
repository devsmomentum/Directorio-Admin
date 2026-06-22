-- Banners: (1) permitir "banners propios" del admin sin tienda vinculada, y
-- (2) exponer las operaciones del navegador mediante RPC con nombre neutral.
--
-- Contexto del bug de producción:
--   El panel admin pedía los banners con supabase.from('banners')... lo que
--   genera la URL /rest/v1/banners. Las listas EasyList (uBlock, AdBlock, etc.)
--   bloquean cualquier request cuya URL contenga "banners"/"ad" devolviendo
--   ERR_BLOCKED_BY_CLIENT (TypeError: Failed to fetch). Por eso campañas y
--   cupones cargaban pero los banners no. El kiosco (app nativa, sin adblock)
--   no se ve afectado, así que el acceso directo a la tabla se mantiene para él.
--
--   Solución: el navegador usa RPCs con nombre neutral (/rest/v1/rpc/directorio_*)
--   que el adblocker no bloquea. Las funciones son SECURITY INVOKER, de modo que
--   la RLS y los triggers existentes siguen aplicando exactamente igual.

-- (1) Banner propio del admin: store_id NULL permitido.
--     Cuando hay tienda, se mantiene la regla "solo DIAMANTE".
--     Solo el admin puede crear banners sin tienda: la RLS WITH CHECK de
--     banners_owner exige user_can_manage_ads(store_id), que es falso para NULL.
CREATE OR REPLACE FUNCTION public.enforce_banner_diamante()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_plan TEXT;
BEGIN
  -- Banner propio del directorio (sin tienda) para promocionar los espacios.
  IF NEW.store_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT plan_type INTO v_plan FROM public.stores WHERE id = NEW.store_id;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'tienda % no existe', NEW.store_id
      USING ERRCODE = '23503';
  END IF;

  IF v_plan <> 'DIAMANTE' THEN
    RAISE EXCEPTION 'tienda % no es DIAMANTE (plan_type=%); banners solo aplican a plan Diamante', NEW.store_id, v_plan
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

-- (2) Capa RPC con nombre neutral (esquiva adblockers). SECURITY INVOKER =>
--     la RLS y los triggers de la tabla banners siguen aplicando al llamador.

-- Lista completa con tienda y campaña embebidas, con la misma forma que devolvía
-- el select anidado anterior (stores{...} / ad_campaigns{...}).
CREATE OR REPLACE FUNCTION public.directorio_paneles_list()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', b.id,
        'media_url', b.media_url,
        'media_type', b.media_type,
        'ui_position', b.ui_position,
        'start_date', b.start_date,
        'end_date', b.end_date,
        'is_active', b.is_active,
        'campaign_id', b.campaign_id,
        'store_id', b.store_id,
        'slot_position', b.slot_position,
        'approval_status', b.approval_status,
        'rejection_reason', b.rejection_reason,
        'ad_campaigns', CASE WHEN c.id IS NOT NULL
          THEN jsonb_build_object('brand_name', c.brand_name) END,
        'stores', CASE WHEN s.id IS NOT NULL
          THEN jsonb_build_object('id', s.id, 'name', s.name, 'logo_url', s.logo_url, 'plan_type', s.plan_type) END
      )
      ORDER BY b.ui_position, b.slot_position NULLS LAST
    ),
    '[]'::jsonb
  )
  FROM public.banners b
  LEFT JOIN public.ad_campaigns c ON c.id = b.campaign_id
  LEFT JOIN public.stores s ON s.id = b.store_id;
$function$;

-- Conteo de pendientes para el badge del panel.
CREATE OR REPLACE FUNCTION public.directorio_paneles_pending()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT COUNT(*)::int FROM public.banners WHERE approval_status = 'pending';
$function$;

-- Alta / edición. p_id NULL => insert. store_id puede ser NULL (banner propio).
CREATE OR REPLACE FUNCTION public.directorio_paneles_save(
  p_id            uuid,
  p_ui_position   text,
  p_slot_position integer,
  p_media_url     text,
  p_media_type    text,
  p_is_active     boolean,
  p_store_id      uuid,
  p_campaign_id   uuid,
  p_start_date    timestamptz,
  p_end_date      timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.banners
      (ui_position, slot_position, media_url, media_type, is_active, store_id, campaign_id, start_date, end_date)
    VALUES
      (p_ui_position, p_slot_position, p_media_url, p_media_type, p_is_active, p_store_id, p_campaign_id, p_start_date, p_end_date)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.banners SET
      ui_position   = p_ui_position,
      slot_position = p_slot_position,
      media_url     = p_media_url,
      media_type    = p_media_type,
      is_active     = p_is_active,
      store_id      = p_store_id,
      campaign_id   = p_campaign_id,
      start_date    = p_start_date,
      end_date      = p_end_date
    WHERE id = p_id
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.directorio_paneles_set_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $function$
  UPDATE public.banners SET is_active = p_active WHERE id = p_id;
$function$;

CREATE OR REPLACE FUNCTION public.directorio_paneles_delete(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $function$
  DELETE FROM public.banners WHERE id = p_id;
$function$;

GRANT EXECUTE ON FUNCTION public.directorio_paneles_list()                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.directorio_paneles_pending()                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.directorio_paneles_save(uuid, text, integer, text, text, boolean, uuid, uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.directorio_paneles_set_active(uuid, boolean)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.directorio_paneles_delete(uuid)                 TO authenticated;
