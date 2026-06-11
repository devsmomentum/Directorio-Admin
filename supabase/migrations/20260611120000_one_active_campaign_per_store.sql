-- Una sola campaña activa por tienda (safety net para la validación del frontend).
-- El frontend ya gestiona el swap con confirmación; este índice previene que una
-- carrera de condición (doble-clic, llamadas paralelas) rompa la invariante en BD.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_campaign_per_store
  ON public.ad_campaigns (store_id)
  WHERE is_active = true AND store_id IS NOT NULL;
