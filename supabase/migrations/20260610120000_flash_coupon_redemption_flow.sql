-- =====================================================================
-- FLUJO NUEVO DE FLASH CUPONES: Reserva (web) -> Redención (tienda)
-- ---------------------------------------------------------------------
-- Inversión semántica respecto al flujo anterior:
--   ANTES: el kiosco capturaba el lead y DECREMENTABA el stock al instante
--          (claim_flash_coupon / claim_catalog_coupon).
--   AHORA: el USUARIO escanea un QR -> web temporal -> crea una RESERVA en
--          estado 'PENDIENTE' (NO toca el stock). Recibe por correo un QR de
--          redención. El CLIENTE (dueño de la tienda) canjea en tienda: SOLO
--          en ese momento el stock baja y la reserva pasa a 'CANJEADO'.
--
-- El stock es deliberadamente "overbookeable": pueden existir más reservas
-- PENDIENTES que stock disponible. Gana quien llega primero a la tienda
-- mientras quede stock (mensaje "stock limitado, ve rápido").
--
-- Reutilizamos la tabla `coupon_leads` (decisión: extender, no recrear).
-- Los RPC legacy claim_flash_coupon / claim_catalog_coupon quedan en la BD
-- pero DEPRECADOS: el kiosco dejará de invocarlos (Fase 4). No los borramos
-- aún para no romper la Edge Function desplegada antes de actualizar Flutter.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. Extender coupon_leads con la máquina de estados y la redención.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.coupon_leads
  ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'PENDIENTE',
  ADD COLUMN IF NOT EXISTS store_id          uuid REFERENCES public.stores(id),
  ADD COLUMN IF NOT EXISTS telefono          text,
  ADD COLUMN IF NOT EXISTS redemption_token  text,
  ADD COLUMN IF NOT EXISTS redeemed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS redeemed_by       uuid REFERENCES auth.users(id);

-- Dominio del estado. EXPIRADO lo usará un cron cuando el cupón venza.
ALTER TABLE public.coupon_leads
  DROP CONSTRAINT IF EXISTS coupon_leads_status_check;
ALTER TABLE public.coupon_leads
  ADD CONSTRAINT coupon_leads_status_check
  CHECK (status = ANY (ARRAY['PENDIENTE'::text, 'CANJEADO'::text, 'EXPIRADO'::text]));

-- Coherencia: si está CANJEADO debe tener fecha y autor de canje.
ALTER TABLE public.coupon_leads
  DROP CONSTRAINT IF EXISTS coupon_leads_redeemed_coherence;
ALTER TABLE public.coupon_leads
  ADD CONSTRAINT coupon_leads_redeemed_coherence
  CHECK (
    status <> 'CANJEADO'
    OR (redeemed_at IS NOT NULL)
  );

-- ─────────────────────────────────────────────────────────────────────
-- 2. Backfill de filas existentes.
--    Los leads previos provienen del flujo viejo: YA consumieron stock,
--    así que se consideran 'CANJEADO' para no aparecer como candidatos.
--    store_id se deriva del cupón. Se les asigna un token para uniformidad.
-- ─────────────────────────────────────────────────────────────────────
UPDATE public.coupon_leads cl
   SET store_id = c.store_id
  FROM public.coupons c
 WHERE cl.coupon_id = c.id
   AND cl.store_id IS NULL;

UPDATE public.coupon_leads
   SET status      = 'CANJEADO',
       redeemed_at = COALESCE(redeemed_at, created_at)
 WHERE status = 'PENDIENTE'
   AND redeemed_at IS NULL
   AND created_at < now();  -- toda fila preexistente a esta migración

UPDATE public.coupon_leads
   SET redemption_token = encode(gen_random_bytes(16), 'hex')
 WHERE redemption_token IS NULL;

-- store_id ya no debe quedar nulo en filas nuevas.
ALTER TABLE public.coupon_leads
  ALTER COLUMN store_id SET NOT NULL;

-- El token identifica unívocamente la reserva en el QR del correo.
ALTER TABLE public.coupon_leads
  ALTER COLUMN redemption_token SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE public.coupon_leads
  ALTER COLUMN redemption_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS coupon_leads_redemption_token_key
  ON public.coupon_leads (redemption_token);

-- Anti-duplicado: un mismo correo NO puede tener dos reservas PENDIENTES del
-- mismo cupón (sostiene el handler `unique_violation` -> LEAD_DUPLICATE del RPC
-- reserve_flash_coupon). Es PARCIAL a propósito:
--   · no choca con las filas legacy que el backfill marcó 'CANJEADO';
--   · permite volver a reservar si una reserva previa expiró o ya se canjeó.
-- lower(email) lo hace insensible a mayúsculas (el RPC inserta el correo tal
-- cual; la web y la Edge Function lo normalizan, pero el índice no depende de eso).
CREATE UNIQUE INDEX IF NOT EXISTS coupon_leads_pending_email_coupon_key
  ON public.coupon_leads (coupon_id, lower(email))
  WHERE status = 'PENDIENTE';

-- Índices para la pantalla "Candidatos" (filtra por tienda + estado) y
-- para las búsquedas por cédula / correo del CLIENTE al canjear.
CREATE INDEX IF NOT EXISTS coupon_leads_store_status_idx
  ON public.coupon_leads (store_id, status);
CREATE INDEX IF NOT EXISTS coupon_leads_id_document_idx
  ON public.coupon_leads (id_document);

-- ─────────────────────────────────────────────────────────────────────
-- 3. RLS: el CLIENTE ve los candidatos de SU tienda; el ADMIN ve todo.
--    La escritura sigue cerrada: solo entra por los RPC SECURITY DEFINER.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.coupon_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coupon_leads_admin       ON public.coupon_leads;
DROP POLICY IF EXISTS coupon_leads_owner_read  ON public.coupon_leads;

CREATE POLICY coupon_leads_admin
  ON public.coupon_leads
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY coupon_leads_owner_read
  ON public.coupon_leads
  FOR SELECT
  TO authenticated
  USING (public.user_owns_store(store_id));

-- ─────────────────────────────────────────────────────────────────────
-- 4. RPC: reserva desde la web temporal (USUARIO anónimo).
--    NO decrementa stock. Crea el lead 'PENDIENTE' y devuelve el token
--    + datos para que la Edge Function envíe el correo con el QR.
--    Solo permite reservar mientras el cupón esté vigente y con stock>0
--    (cuando el stock real se agota por canjes, ya no aceptamos reservas).
-- Errores (SQLSTATE P0001):
--   COUPON_UNAVAILABLE -> agotado / inactivo / no aprobado / vencido / inexistente
--   LEAD_DUPLICATE     -> ese correo ya reservó este cupón
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_flash_coupon(
  p_coupon_id uuid,
  p_nombre    text,
  p_cedula    text,
  p_telefono  text,
  p_email     text
)
RETURNS TABLE (
  lead_id                 uuid,
  redemption_token        text,
  status                  text,
  coupon_code             text,
  coupon_title            text,
  coupon_image_url        text,
  coupon_discount_percent numeric,
  store_id                uuid,
  store_name              text,
  end_date                timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_coupon       public.coupons%ROWTYPE;
  v_store_name   text;
  v_token        text;
  v_lead_id      uuid;
BEGIN
  -- Validamos el cupón SIN tocar el stock. FOR SHARE evita que un canje
  -- concurrente borre/expire el cupón a mitad de la reserva.
  SELECT * INTO v_coupon
    FROM public.coupons
   WHERE id = p_coupon_id
     AND plan_type = 'PUBLI_PROMO'
     AND is_active = true
     AND approval_status = 'approved'
     AND amount_available > 0
     AND end_date > now()
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COUPON_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  SELECT name INTO v_store_name FROM public.stores WHERE id = v_coupon.store_id;

  BEGIN
    INSERT INTO public.coupon_leads (
      coupon_id, store_id, first_name, id_document, telefono, email, status
    )
    VALUES (
      p_coupon_id, v_coupon.store_id, p_nombre, p_cedula, p_telefono, p_email, 'PENDIENTE'
    )
    RETURNING id, coupon_leads.redemption_token
         INTO v_lead_id, v_token;
  EXCEPTION WHEN unique_violation THEN
    -- Mismo correo + mismo cupón: ya hay una reserva. No creamos otra.
    RAISE EXCEPTION 'LEAD_DUPLICATE' USING ERRCODE = 'P0001';
  END;

  RETURN QUERY
  SELECT v_lead_id,
         v_token,
         'PENDIENTE'::text,
         v_coupon.code,
         v_coupon.title,
         v_coupon.image_url,
         v_coupon.discount_percent,
         v_coupon.store_id,
         v_store_name,
         v_coupon.end_date;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_flash_coupon(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_flash_coupon(uuid, text, text, text, text)
  TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 5. RPC ATÓMICO de redención (lo ejecuta el CLIENTE en la tienda).
--    Race-safe: si dos personas escanean el MISMO QR a la vez, el
--    SELECT ... FOR UPDATE sobre el lead serializa; el segundo verá
--    'CANJEADO' y abortará. El stock se decrementa condicionalmente
--    (amount_available > 0) en un único UPDATE.
-- Errores (SQLSTATE P0001):
--   CLAIM_NOT_FOUND    -> la reserva no existe o no corresponde al cupón
--   NOT_AUTHORIZED     -> el usuario no es dueño de esa tienda (ni admin)
--   ALREADY_REDEEMED   -> la reserva ya fue canjeada (o expiró)
--   OUT_OF_STOCK       -> el cupón se quedó sin stock
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_coupon(
  p_claim_id  uuid,
  p_coupon_id uuid
)
RETURNS TABLE (
  lead_id      uuid,
  status       text,
  redeemed_at  timestamptz,
  remaining    integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_lead      public.coupon_leads%ROWTYPE;
  v_remaining integer;
  v_now       timestamptz := now();
BEGIN
  -- 1) Bloqueamos la reserva. Esta es la barrera anti-doble-canje:
  --    la segunda transacción concurrente espera aquí.
  SELECT * INTO v_lead
    FROM public.coupon_leads
   WHERE id = p_claim_id
     AND coupon_id = p_coupon_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLAIM_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 2) Autorización: solo el dueño de la tienda del lead, o un admin.
  IF NOT (public.is_admin() OR public.user_owns_store(v_lead.store_id)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  -- 3) Idempotencia / estado. Una vez liberado el lock, si ya no está
  --    PENDIENTE significa que otro lo canjeó (o expiró).
  IF v_lead.status <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'ALREADY_REDEEMED' USING ERRCODE = 'P0001';
  END IF;

  -- 4) Decremento atómico del stock. Solo aquí baja el inventario.
  UPDATE public.coupons
     SET amount_available = amount_available - 1
   WHERE id = p_coupon_id
     AND amount_available > 0
   RETURNING amount_available INTO v_remaining;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUT_OF_STOCK' USING ERRCODE = 'P0001';
  END IF;

  -- 5) Marcamos la reserva como canjeada.
  UPDATE public.coupon_leads
     SET status      = 'CANJEADO',
         redeemed_at = v_now,
         redeemed_by = auth.uid()
   WHERE id = p_claim_id;

  RETURN QUERY
  SELECT p_claim_id, 'CANJEADO'::text, v_now, v_remaining;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_coupon(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_coupon(uuid, uuid)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Helper de búsqueda para el panel "Candidatos": el CLIENTE escanea el
--    QR (token) o busca por cédula / nombre / correo. Devuelve SOLO leads
--    PENDIENTES de tiendas que el usuario posee (o todas si es admin).
--    Pensado para resolver el QR -> claim_id antes de llamar redeem_coupon.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_redeemable_claims(
  p_query    text,
  p_store_id uuid DEFAULT NULL
)
RETURNS TABLE (
  lead_id      uuid,
  coupon_id    uuid,
  store_id     uuid,
  first_name   text,
  last_name    text,
  id_document  text,
  telefono     text,
  email        text,
  status       text,
  created_at   timestamptz,
  coupon_title text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT cl.id, cl.coupon_id, cl.store_id,
         cl.first_name, cl.last_name, cl.id_document, cl.telefono, cl.email,
         cl.status, cl.created_at, c.title
    FROM public.coupon_leads cl
    JOIN public.coupons c ON c.id = cl.coupon_id
   WHERE cl.status = 'PENDIENTE'
     AND (public.is_admin() OR public.user_owns_store(cl.store_id))
     AND (p_store_id IS NULL OR cl.store_id = p_store_id)
     AND (
          cl.redemption_token = p_query
       OR cl.id_document      ILIKE '%' || p_query || '%'
       OR cl.email            ILIKE '%' || p_query || '%'
       OR (coalesce(cl.first_name,'') || ' ' || coalesce(cl.last_name,''))
                              ILIKE '%' || p_query || '%'
     )
   ORDER BY cl.created_at DESC
   LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.find_redeemable_claims(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_redeemable_claims(text, uuid)
  TO authenticated, service_role;
