-- ============================================================
-- Tabla pivot: asignación de campañas por kiosco
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Lógica:
--   • Si un kiosco NO tiene filas en esta tabla → muestra TODAS las campañas activas (modo global)
--   • Si un kiosco SÍ tiene filas → muestra SOLO esas campañas (modo override)

CREATE TABLE IF NOT EXISTS kiosk_campaigns (
  kiosk_id    uuid NOT NULL REFERENCES public.kiosks(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kiosk_campaigns_pkey PRIMARY KEY (kiosk_id, campaign_id)
);

-- Índice para consultas rápidas desde el kiosco (filtra por kiosk_id)
CREATE INDEX IF NOT EXISTS kiosk_campaigns_kiosk_idx ON kiosk_campaigns (kiosk_id);

-- RLS: solo usuarios autenticados pueden leer y escribir
ALTER TABLE kiosk_campaigns ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'kiosk_campaigns'
      AND policyname = 'auth_full_kiosk_campaigns'
  ) THEN
    CREATE POLICY "auth_full_kiosk_campaigns"
      ON kiosk_campaigns FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END$$;

-- Vista helper: qué campañas ve cada kiosco (para el firmware del kiosco)
-- Un kiosco sin asignaciones ve TODAS; uno con asignaciones ve solo las suyas.
CREATE OR REPLACE VIEW public.kiosk_active_campaigns AS
SELECT
  k.id   AS kiosk_id,
  k.name AS kiosk_name,
  c.id   AS campaign_id,
  c.brand_name,
  c.plan_type,
  c.media_url,
  c.media_type,
  c.duration_seconds,
  c.priority_level,
  c.target_frequency_seconds,
  c.slot_limit_group
FROM kiosks k
CROSS JOIN ad_campaigns c
WHERE c.is_active = true
  AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
  AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE)
  -- Modo global: kiosco sin asignaciones específicas
  AND NOT EXISTS (
    SELECT 1 FROM kiosk_campaigns kc WHERE kc.kiosk_id = k.id
  )

UNION ALL

SELECT
  k.id   AS kiosk_id,
  k.name AS kiosk_name,
  c.id   AS campaign_id,
  c.brand_name,
  c.plan_type,
  c.media_url,
  c.media_type,
  c.duration_seconds,
  c.priority_level,
  c.target_frequency_seconds,
  c.slot_limit_group
FROM kiosks k
JOIN kiosk_campaigns kc ON kc.kiosk_id = k.id
JOIN ad_campaigns    c  ON c.id = kc.campaign_id
WHERE c.is_active = true
  AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
  AND (c.end_date   IS NULL OR c.end_date   >= CURRENT_DATE);
