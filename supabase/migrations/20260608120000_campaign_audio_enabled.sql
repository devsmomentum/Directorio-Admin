-- ============================================================================
-- audio_enabled en ad_campaigns
-- ----------------------------------------------------------------------------
-- El cliente decide, al guardar su campaña en el panel, si el video se
-- reproduce CON o SIN audio en el kiosco. Solo aplica al video de campaña a
-- pantalla completa (home/atract), que siempre es uno solo → sin riesgo de
-- audios encimados. Default false (mudo): solo suena si el cliente lo marca.
--
-- active_ads_live es SELECT c.* sobre ad_campaigns, así que se recrea para que
-- la nueva columna quede expuesta a Flutter (la app lee la vista, no la tabla).
-- ============================================================================

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS audio_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ad_campaigns.audio_enabled IS
  'Si true, el kiosco reproduce el video de campaña con audio (solo pantalla '
  'completa/home). Default false = mudo.';

-- Recrear la vista para que c.* incluya audio_enabled. La columna nueva se
-- agrega al final, por lo que CREATE OR REPLACE VIEW lo permite (solo añade
-- columnas al final, no reordena las existentes).
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

GRANT SELECT ON public.active_ads_live TO anon, authenticated;
