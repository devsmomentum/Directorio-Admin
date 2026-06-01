-- ============================================================================
-- 019_coupons_rotation_rpc.sql
--
-- Round-robin determinístico de cupones flash por tienda.
--
-- get_flash_coupons_rotated(p_commit BOOLEAN) devuelve a lo sumo un cupón por
-- tienda con addon flash vigente: el menos reciente según last_shown_at
-- (NULLS FIRST → cupones que nunca se han mostrado ganan turno primero, luego
-- desempata por id para estabilidad).
--
-- Cuando p_commit = true (consumo real desde kiosk / surface pública), se
-- marca last_shown_at = NOW() en las filas devueltas, avanzando la rotación.
-- Cuando p_commit = false (preview en panel admin o en el portal de la
-- tienda), no se actualiza nada y siempre devuelve el mismo estado actual.
--
-- Consumo esperado en el kiosk:
--   const { data } = await supabase.rpc('get_flash_coupons_rotated', { p_commit: true });
-- ============================================================================


CREATE OR REPLACE FUNCTION public.get_flash_coupons_rotated(p_commit BOOLEAN DEFAULT true)
RETURNS TABLE (
  id               UUID,
  store_id         UUID,
  store_name       TEXT,
  title            TEXT,
  image_url        TEXT,
  code             TEXT,
  amount_available INTEGER,
  discount_percent NUMERIC,
  category         TEXT,
  plan_type        TEXT,
  start_date       TIMESTAMPTZ,
  end_date         TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
           c.start_date, c.end_date
      FROM public.coupons c
      JOIN public.stores  s ON s.id = c.store_id
     WHERE c.id = ANY(COALESCE(v_ids, ARRAY[]::UUID[]));
END $$;

GRANT EXECUTE ON FUNCTION public.get_flash_coupons_rotated(BOOLEAN) TO anon, authenticated;


-- Verificación rápida (sólo log, no falla la migración).
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM public.get_flash_coupons_rotated(false);
  RAISE NOTICE 'get_flash_coupons_rotated(false) preview devolvió % filas', n;
END $$;
