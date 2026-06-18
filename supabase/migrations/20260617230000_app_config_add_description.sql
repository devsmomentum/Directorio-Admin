-- La tabla app_config existía antes de la migración 20260617200000 con solo
-- key/value/updated_at/updated_by. Añadimos description que el código usa.
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS description text;
