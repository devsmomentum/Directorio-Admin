-- ============================================================================
-- 030_rename_coupon_discount_percent.sql
--
-- La columna coupons.price_usd nunca almacenó un precio: el portal de clientes
-- guarda ahí el PORCENTAJE de descuento del cupón (validado 1–100). El nombre
-- heredado confundía al equipo y a la app Flutter. La renombramos a
-- discount_percent y recreamos todos los objetos de BD que la referencian.
--
-- NOTA: plans.price_usd SÍ es un precio real en USD y NO se toca.
--
-- Esta migración asume una sola base de datos compartida por el panel admin
-- y la app Flutter (mismo proyecto Supabase). Es idempotente-segura salvo el
-- RENAME, que sólo corre si la columna vieja aún existe.
-- ============================================================================

-- 1. Renombrar la columna (sólo si todavía se llama price_usd).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'coupons'
       AND column_name = 'price_usd'
  ) THEN
    ALTER TABLE public.coupons RENAME COLUMN price_usd TO discount_percent;
  END IF;
END $$;


-- 2. Rotación round-robin (antes en 019) — ahora devuelve discount_percent.
--    Cambia el tipo de retorno (columna renombrada), así que hay que dropear
--    la función antes de recrearla.
DROP FUNCTION IF EXISTS public.get_flash_coupons_rotated(BOOLEAN);
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
    -- Calificar coupons.id: la columna de salida `id` del RETURNS TABLE haría
    -- ambigua una referencia pelada a `id` (42702).
    UPDATE public.coupons SET last_shown_at = NOW() WHERE coupons.id = ANY(v_ids);
  END IF;

  RETURN QUERY
    -- s.name es varchar(255); la firma declara store_name TEXT, así que casteamos
    -- explícitamente para no disparar 42804 (mismatch de tipo de retorno).
    SELECT c.id, c.store_id, s.name::text AS store_name, c.title, c.image_url, c.code,
           c.amount_available, c.discount_percent, c.category, c.plan_type,
           c.start_date, c.end_date
      FROM public.coupons c
      JOIN public.stores  s ON s.id = c.store_id
     WHERE c.id = ANY(COALESCE(v_ids, ARRAY[]::UUID[]));
END $$;

GRANT EXECUTE ON FUNCTION public.get_flash_coupons_rotated(BOOLEAN) TO anon, authenticated;


-- 3. Trigger de aprobación de cupones (versión vigente en 022) — re-disparar
--    revisión cuando cambia el descuento.
CREATE OR REPLACE FUNCTION public.guard_coupons_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_content_changed BOOLEAN;
  v_is_owner        BOOLEAN;
BEGIN
  v_is_owner := OLD.store_id IS NOT NULL AND public.user_owns_store(OLD.store_id);
  IF NOT v_is_owner THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.bypass_coupon_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

  NEW.store_id    := OLD.store_id;
  NEW.plan_type   := OLD.plan_type;
  NEW.code        := OLD.code;
  NEW.campaign_id := OLD.campaign_id;

  NEW.approval_status  := OLD.approval_status;
  NEW.rejection_reason := OLD.rejection_reason;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.reviewed_by      := OLD.reviewed_by;
  NEW.last_shown_at    := OLD.last_shown_at;

  v_content_changed :=
       NEW.title            IS DISTINCT FROM OLD.title
    OR NEW.image_url        IS DISTINCT FROM OLD.image_url
    OR NEW.amount_available IS DISTINCT FROM OLD.amount_available
    OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent
    OR NEW.start_date       IS DISTINCT FROM OLD.start_date
    OR NEW.end_date         IS DISTINCT FROM OLD.end_date
    OR NEW.category         IS DISTINCT FROM OLD.category;

  IF v_content_changed THEN
    NEW.approval_status  := 'pending';
    NEW.rejection_reason := NULL;
    NEW.reviewed_at      := NULL;
    NEW.reviewed_by      := NULL;
    NEW.is_active        := false;
    RETURN NEW;
  END IF;

  IF OLD.is_active = FALSE AND NEW.is_active = TRUE AND OLD.approval_status <> 'approved' THEN
    NEW.is_active := OLD.is_active;
  END IF;

  RETURN NEW;
END $$;


-- 4. RPC de canje (versión vigente en 20260427_coupons_publi_promo) — la columna
--    de salida pasa de coupon_price_usd a coupon_discount_percent. Igual que el
--    RPC anterior, el cambio de tipo de retorno obliga a dropear primero.
DROP FUNCTION IF EXISTS public.claim_flash_coupon(uuid, text, text, text, text);
CREATE OR REPLACE FUNCTION public.claim_flash_coupon(
  p_coupon_id   uuid,
  p_first_name  text,
  p_last_name   text,
  p_id_document text,
  p_email       text
)
RETURNS TABLE (
  lead_id                 uuid,
  coupon_code             text,
  coupon_title            text,
  coupon_image_url        text,
  coupon_discount_percent numeric,
  end_date                timestamptz,
  remaining               integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_remaining integer;
  v_code      text;
  v_title     text;
  v_image     text;
  v_discount  numeric;
  v_end_date  timestamptz;
  v_lead_id   uuid;
BEGIN
  UPDATE public.coupons
     SET amount_available = amount_available - 1
   WHERE id = p_coupon_id
     AND plan_type = 'PUBLI_PROMO'
     AND amount_available > 0
     AND end_date > now()
   RETURNING amount_available, code, title, image_url, discount_percent, end_date
        INTO v_remaining, v_code, v_title, v_image, v_discount, v_end_date;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COUPON_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.coupon_leads (
      coupon_id, first_name, last_name, id_document, email
    )
    VALUES (
      p_coupon_id, p_first_name, p_last_name, p_id_document, p_email
    )
    RETURNING id INTO v_lead_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.coupons
       SET amount_available = amount_available + 1
     WHERE id = p_coupon_id;
    RAISE EXCEPTION 'LEAD_DUPLICATE' USING ERRCODE = 'P0001';
  END;

  RETURN QUERY
  SELECT v_lead_id, v_code, v_title, v_image, v_discount, v_end_date, v_remaining;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_flash_coupon(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_flash_coupon(uuid, text, text, text, text)
  TO anon, authenticated, service_role;
