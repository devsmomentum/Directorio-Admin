-- ============================================================
-- Planes Directorios — Migración (PDF "PLANES DIRECTORIOS")
-- Ejecutar en Supabase SQL Editor (idempotente)
--
-- Esta migración:
--   1) Crea/actualiza la tabla `plans` con columnas para capacidad,
--      duración de video y prioridad en el loop.
--   2) Hace seed de los 8 planes del portafolio:
--      DIAMANTE, ORO, IA_PERFORMANCE,
--      PUBLI_PROMO_DIARIO, PUBLI_PROMO_SEMANAL,
--      FLASH_COUPON_DIARIO, FLASH_COUPON_SEMANAL
--      (separados diario/semanal porque tienen precios distintos).
--   3) Amplía los CHECK de `plan_type` en ad_campaigns / stores / coupons
--      para aceptar los nuevos claves.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1) Tabla plans
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plans (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key        TEXT          NOT NULL UNIQUE,
  name            TEXT          NOT NULL,
  description     TEXT,
  duration_days   INTEGER       NOT NULL DEFAULT 30,
  price_usd       NUMERIC(10,2),
  applies_to      TEXT[]        NOT NULL DEFAULT ARRAY['stores']::TEXT[],
  features        TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  display_order   INTEGER       NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Columnas nuevas para reglas del directorio (idempotente)
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_brands     INTEGER;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS video_seconds  INTEGER NOT NULL DEFAULT 15;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS priority_level INTEGER NOT NULL DEFAULT 99;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS loop_eligible  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS has_fixed_banner BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.plans.max_brands     IS 'Tope duro de marcas activas con este plan. NULL = ilimitado/bajo demanda.';
COMMENT ON COLUMN public.plans.video_seconds  IS 'Duración de la pieza de video en el loop. 15s según PDF.';
COMMENT ON COLUMN public.plans.priority_level IS '1 = máxima prioridad (Diamante). Determina orden en el loop.';
COMMENT ON COLUMN public.plans.loop_eligible  IS 'true si el plan ocupa un slot en el loop de 3 min.';
COMMENT ON COLUMN public.plans.has_fixed_banner IS 'true si el plan incluye banner fijo permanente (Diamante).';

-- ─────────────────────────────────────────────────────────────
-- 2) Seed de los 8 planes (upsert por plan_key)
-- ─────────────────────────────────────────────────────────────
INSERT INTO public.plans
  (plan_key, name, description, duration_days, price_usd, applies_to, features,
   max_brands, video_seconds, priority_level, loop_eligible, has_fixed_banner, display_order)
VALUES
  ('DIAMANTE',
   'Slot Diamante',
   'Exclusividad de marca: video 15s + banner fijo + IA Priority 1.',
   30, 650.00,
   ARRAY['stores','campaigns'],
   ARRAY[
     'Video de 15 segundos en loop',
     'Banner fijo permanente',
     'IA Priority nivel 1 (prioridad en sugerencias)',
     'Hasta 1.100 impactos diarios por marca (5 pantallas)'
   ],
   2, 15, 1, true, true, 1),

  ('ORO',
   'Slot Oro',
   'Alcance y recordación: video 15s en loop + IA Priority 2.',
   30, 350.00,
   ARRAY['stores','campaigns'],
   ARRAY[
     'Video de 15 segundos en loop',
     'IA Priority nivel 2',
     'Frecuencia: una aparición cada 3 min (escenario base)',
     'Hasta 1.100 impactos diarios por marca (5 pantallas)'
   ],
   30, 15, 2, true, false, 2),

  ('IA_PERFORMANCE',
   'IA Performance',
   'Conversión directa: consultas IA + cupón digital, sin loop visual.',
   30, 200.00,
   ARRAY['stores','coupons'],
   ARRAY[
     'Presencia reactiva por consulta del usuario',
     'Cupón digital asociado',
     'Lead generation con captura de datos',
     'Demanda variable según interacciones'
   ],
   NULL, 0, 3, false, false, 3),

  ('PUBLI_PROMO_DIARIO',
   'Publi Promo — Diario',
   'Activación táctica: video 15s rotativo, contratación por día.',
   1, 35.00,
   ARRAY['campaigns'],
   ARRAY[
     'Video de 15 segundos',
     'Rotación cada 3 min durante la campaña',
     'Ideal para lanzamientos y fechas pico',
     'Contratación de 1 día'
   ],
   NULL, 15, 4, true, false, 4),

  ('PUBLI_PROMO_SEMANAL',
   'Publi Promo — Semanal',
   'Activación táctica: video 15s rotativo, semana de 5 días hábiles.',
   5, 150.00,
   ARRAY['campaigns'],
   ARRAY[
     'Video de 15 segundos',
     'Rotación cada 3 min durante la campaña',
     'Ideal para lanzamientos y fines de semana',
     'Semana operativa = 5 días'
   ],
   NULL, 15, 4, true, false, 5),

  ('FLASH_COUPON_DIARIO',
   'Flash Coupon — Diario',
   'Lead generation: cupón en galería con captura de datos, contratación por día.',
   1, 35.00,
   ARRAY['coupons'],
   ARRAY[
     'Cupón en galería de descuentos',
     'Captura de datos del consumidor (lead)',
     'Urgencia y consumo inmediato',
     'Hasta 20 marcas simultáneas en galería'
   ],
   20, 0, 5, false, false, 6),

  ('FLASH_COUPON_SEMANAL',
   'Flash Coupon — Semanal',
   'Lead generation: cupón en galería, semana de 5 días hábiles.',
   5, 150.00,
   ARRAY['coupons'],
   ARRAY[
     'Cupón en galería de descuentos',
     'Captura de datos del consumidor (lead)',
     'Hasta 30 cupones semanales según formato',
     'Semana operativa = 5 días'
   ],
   20, 0, 5, false, false, 7)

ON CONFLICT (plan_key) DO UPDATE SET
  name             = EXCLUDED.name,
  description      = EXCLUDED.description,
  duration_days    = EXCLUDED.duration_days,
  price_usd        = EXCLUDED.price_usd,
  applies_to       = EXCLUDED.applies_to,
  features         = EXCLUDED.features,
  max_brands       = EXCLUDED.max_brands,
  video_seconds    = EXCLUDED.video_seconds,
  priority_level   = EXCLUDED.priority_level,
  loop_eligible    = EXCLUDED.loop_eligible,
  has_fixed_banner = EXCLUDED.has_fixed_banner,
  display_order    = EXCLUDED.display_order,
  updated_at       = now();

-- ─────────────────────────────────────────────────────────────
-- 3) Ampliar CHECK constraints de plan_type
--    Conservar valores existentes (BONO_PREMIADO, PUBLI_PROMO,
--    PROMO_FLASH se mantienen como alias legacy) y añadir los nuevos.
-- ─────────────────────────────────────────────────────────────

-- ad_campaigns.plan_type
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.ad_campaigns'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%plan_type%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.ad_campaigns DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_plan_type_check
  CHECK (plan_type = ANY (ARRAY[
    'DIAMANTE',
    'ORO',
    'IA_PERFORMANCE',
    'PUBLI_PROMO',
    'PUBLI_PROMO_DIARIO',
    'PUBLI_PROMO_SEMANAL',
    'FLASH_COUPON_DIARIO',
    'FLASH_COUPON_SEMANAL'
  ]));

-- stores.plan_type
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.stores'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%plan_type%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stores DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.stores
  ADD CONSTRAINT stores_plan_type_check
  CHECK (plan_type IS NULL OR plan_type = ANY (ARRAY[
    'DIAMANTE',
    'ORO',
    'IA_PERFORMANCE',
    'PROMO_FLASH',
    'PUBLI_PROMO_DIARIO',
    'PUBLI_PROMO_SEMANAL',
    'FLASH_COUPON_DIARIO',
    'FLASH_COUPON_SEMANAL'
  ]));

-- coupons.plan_type
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.coupons'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%plan_type%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.coupons DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_plan_type_check
  CHECK (plan_type = ANY (ARRAY[
    'DIAMANTE',
    'ORO',
    'IA_PERFORMANCE',
    'BONO_PREMIADO',
    'PUBLI_PROMO',
    'FLASH_COUPON_DIARIO',
    'FLASH_COUPON_SEMANAL'
  ]));

-- ─────────────────────────────────────────────────────────────
-- 4) Vista helper: estado del loop por kiosco / global
--    Útil para el admin: "X/12 slots usados, loop = Y segundos".
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_loop_status AS
SELECT
  COUNT(*) FILTER (WHERE plan_type = 'DIAMANTE')           AS diamante_count,
  COUNT(*) FILTER (WHERE plan_type = 'ORO')                AS oro_count,
  COUNT(*) FILTER (
    WHERE plan_type IN ('PUBLI_PROMO','PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL')
  )                                                         AS publi_promo_count,
  COUNT(*)                                                  AS loop_slots_used,
  COUNT(*) * 15                                             AS loop_duration_seconds
FROM public.ad_campaigns
WHERE is_active = true
  AND COALESCE(payment_status, 'pending') <> 'overdue'
  AND (end_date IS NULL OR end_date >= CURRENT_DATE)
  AND plan_type IN (
    'DIAMANTE','ORO','PUBLI_PROMO',
    'PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL'
  );

COMMENT ON VIEW public.v_loop_status IS
  'Estado del loop publicitario: cuántas marcas activas hay y duración resultante (15s por slot).';
