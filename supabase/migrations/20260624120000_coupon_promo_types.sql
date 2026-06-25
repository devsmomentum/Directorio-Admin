-- Promociones de cupón más allá del % de descuento: 2x1/NxM, precio fijo/combo,
-- regalo y texto libre. Todo ADITIVO y RETROCOMPATIBLE: el binario de Flutter ya
-- desplegado sigue leyendo `discount_percent` sin enterarse de estas columnas.
--
-- Contrato de badge (mismo en admin, web y app):
--   mostrar offer_label si existe; si no y discount_percent > 0 -> "X% OFF"; si no, nada.
-- Por eso `percentage` deja offer_label NULL (el cliente arma "X% OFF" desde discount_percent),
-- y los demás tipos guardan en offer_label la etiqueta lista para mostrar.

ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS offer_type  text NOT NULL DEFAULT 'percentage',
  ADD COLUMN IF NOT EXISTS offer_label text,
  ADD COLUMN IF NOT EXISTS offer_value jsonb;

ALTER TABLE public.coupons
  DROP CONSTRAINT IF EXISTS coupons_offer_type_check;
ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_offer_type_check
  CHECK (offer_type IN ('percentage','nxm','fixed_price','gift','text'));

COMMENT ON COLUMN public.coupons.offer_type IS
  'Tipo de promoción: percentage | nxm | fixed_price | gift | text. Default percentage (retrocompatible).';
COMMENT ON COLUMN public.coupons.offer_label IS
  'Etiqueta lista para el badge (ej. "2x1", "$9.99", "Regalo"). NULL en percentage: el cliente arma "X% OFF" desde discount_percent.';
COMMENT ON COLUMN public.coupons.offer_value IS
  'Payload estructurado de la promo (nxm: {"buy":N,"pay":M}; fixed_price: {"price":x}; gift: {"item":"..."}). NULL en percentage/text.';

-- get_flash_coupons_rotated: agrega offer_type/offer_label/offer_value al retorno
-- para que el popup del kiosko pueda renderizar el badge correcto. Cambiar el
-- RETURNS TABLE obliga a DROP+CREATE. Las columnas extra son ignoradas por el
-- binario actual de Flutter (lee solo las claves que conoce) -> seguro en producción.
DROP FUNCTION IF EXISTS public.get_flash_coupons_rotated(boolean);

CREATE OR REPLACE FUNCTION public.get_flash_coupons_rotated(p_commit boolean DEFAULT true)
 RETURNS TABLE(
   id uuid, store_id uuid, store_name text, title text, image_url text, code text,
   amount_available integer, discount_percent numeric, category text, plan_type text,
   start_date timestamp with time zone, end_date timestamp with time zone,
   offer_type text, offer_label text, offer_value jsonb
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_ids UUID[];
BEGIN
  WITH eligible AS (
    SELECT DISTINCT ON (c.store_id) c.id
      FROM public.coupons c
      JOIN public.stores  s ON s.id = c.store_id
     WHERE c.is_active = true
       AND c.amount_available > 0
       AND c.end_date >= NOW()
       AND s.flash_coupon_plan IS NOT NULL
       AND (s.flash_coupon_expiry_date IS NULL
            OR s.flash_coupon_expiry_date >= CURRENT_DATE)
     ORDER BY c.store_id, c.last_shown_at NULLS FIRST, c.id
  )
  SELECT array_agg(eligible.id) INTO v_ids FROM eligible;

  IF p_commit AND v_ids IS NOT NULL THEN
    UPDATE public.coupons SET last_shown_at = NOW() WHERE coupons.id = ANY(v_ids);
  END IF;

  RETURN QUERY
    SELECT c.id, c.store_id, s.name::text AS store_name, c.title, c.image_url, c.code,
           c.amount_available, c.discount_percent, c.category, c.plan_type,
           c.start_date, c.end_date, c.offer_type, c.offer_label, c.offer_value
      FROM public.coupons c
      JOIN public.stores  s ON s.id = c.store_id
     WHERE c.id = ANY(COALESCE(v_ids, ARRAY[]::UUID[]));
END $function$;

GRANT EXECUTE ON FUNCTION public.get_flash_coupons_rotated(boolean)
  TO anon, authenticated, service_role;
