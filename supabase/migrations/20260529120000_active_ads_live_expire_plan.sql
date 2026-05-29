-- ============================================================================
-- Vista active_ads_live + limpiar plan_type en contratos vencidos
-- ----------------------------------------------------------------------------
-- 1. active_ads_live: vista que aplica todos los filtros de vigencia en tiempo
--    real para que Flutter nunca muestre campañas expiradas entre corridas del
--    kill-switch (cron nocturno).
-- 2. apply_kill_switch(): también pone plan_type = NULL en tiendas cuyo
--    contract_expiry_date ya pasó, para que Flutter no muestre el plan.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Vista active_ads_live
--    Equivalente a kiosk_active_campaigns pero sin la dimensión de kiosco.
--    Flutter la usa en lugar de ad_campaigns para garantizar que solo
--    aparezcan campañas cuyo plan-tienda Y fechas propias estén vigentes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.active_ads_live AS
SELECT c.*
FROM public.ad_campaigns c
LEFT JOIN public.stores s ON s.id = c.store_id
WHERE c.is_active = true
  AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
  AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE)
  AND (c.store_id IS NULL
       OR s.contract_expiry_date IS NULL
       OR s.contract_expiry_date >= CURRENT_DATE);

COMMENT ON VIEW public.active_ads_live IS
  'Campañas vigentes en tiempo real: activas, dentro de fechas y con plan-tienda no vencido. Usada por Flutter.';

GRANT SELECT ON public.active_ads_live TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. apply_kill_switch(): agrega nulificación de plan_type en tiendas vencidas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_kill_switch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_cnt integer := 0;
  batch_cnt   integer := 0;
BEGIN
  -- Desactivar campañas vinculadas a plan de tienda vencido o con end_date pasado
  UPDATE public.ad_campaigns c
  SET    is_active = false
  FROM   public.stores s
  WHERE  c.store_id = s.id
    AND  c.is_active = true
    AND ( (c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE)
       OR (s.contract_expiry_date IS NOT NULL AND s.contract_expiry_date < CURRENT_DATE) );

  GET DIAGNOSTICS batch_cnt = ROW_COUNT;
  updated_cnt := updated_cnt + batch_cnt;

  -- Desactivar campañas sin tienda (admin) con end_date pasado
  UPDATE public.ad_campaigns
  SET    is_active = false
  WHERE  is_active = true
    AND  store_id IS NULL
    AND  end_date IS NOT NULL
    AND  end_date < CURRENT_DATE;

  GET DIAGNOSTICS batch_cnt = ROW_COUNT;
  updated_cnt := updated_cnt + batch_cnt;

  -- Nulificar plan_type en tiendas con contrato vencido para que Flutter
  -- no muestre el plan como activo en el directorio
  UPDATE public.stores
  SET    plan_type = NULL
  WHERE  contract_expiry_date IS NOT NULL
    AND  contract_expiry_date < CURRENT_DATE
    AND  plan_type IS NOT NULL;

  RETURN updated_cnt;
END;
$$;
