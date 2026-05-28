-- ============================================================================
-- 023_notifications.sql
--
-- Sistema de notificaciones de aprobación entre admin y tiendas.
--
-- Dos canales:
--   * public.admin_notifications  (ya existe) — eventos para administradores.
--     Aquí añadimos triggers que avisan al admin cuando una tienda sube
--     contenido nuevo para revisión.
--
--   * public.client_notifications (NUEVO) — eventos para una tienda (su dueño).
--     Aquí registramos las decisiones del admin (aprobada / rechazada) sobre
--     campañas y cupones de la tienda.
--
-- También definimos RPCs para marcar leídas las notificaciones del lado
-- correspondiente sin necesidad de hacer UPDATE directos desde el frontend.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabla client_notifications
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'info',
  title       TEXT,
  message     TEXT,
  metadata    JSONB,
  unique_key  TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_client_notifications_store_created
  ON public.client_notifications (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_notifications_unread
  ON public.client_notifications (store_id) WHERE read_at IS NULL;

ALTER TABLE public.client_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "client_notifications_admin"      ON public.client_notifications;
DROP POLICY IF EXISTS "client_notifications_owner_read" ON public.client_notifications;
DROP POLICY IF EXISTS "client_notifications_owner_update" ON public.client_notifications;

-- Admin: acceso total (puede insertar/leer/limpiar).
CREATE POLICY "client_notifications_admin" ON public.client_notifications
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Dueño: lectura sobre su(s) tienda(s).
CREATE POLICY "client_notifications_owner_read" ON public.client_notifications
  FOR SELECT TO authenticated
  USING (public.user_owns_store(store_id));

-- Dueño: UPDATE sólo a read_at (marcar leída). Se completa con un trigger
-- guard que sólo permite tocar read_at; cualquier otro cambio se revierte.
CREATE POLICY "client_notifications_owner_update" ON public.client_notifications
  FOR UPDATE TO authenticated
  USING (public.user_owns_store(store_id))
  WITH CHECK (public.user_owns_store(store_id));

CREATE OR REPLACE FUNCTION public.guard_client_notification_owner_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF public.is_admin() THEN RETURN NEW; END IF;
  -- Dueño sólo puede mover read_at. Todo lo demás se revierte.
  NEW.store_id   := OLD.store_id;
  NEW.type       := OLD.type;
  NEW.title      := OLD.title;
  NEW.message    := OLD.message;
  NEW.metadata   := OLD.metadata;
  NEW.unique_key := OLD.unique_key;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_client_notifications_owner_update ON public.client_notifications;
CREATE TRIGGER trg_client_notifications_owner_update
  BEFORE UPDATE ON public.client_notifications
  FOR EACH ROW EXECUTE FUNCTION public.guard_client_notification_owner_update();


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Trigger: notificar al admin cuando llega contenido nuevo para revisar
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_admin_of_pending_campaign()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_store_name TEXT;
BEGIN
  IF NEW.approval_status <> 'pending' THEN
    RETURN NEW;
  END IF;
  SELECT name INTO v_store_name FROM public.stores WHERE id = NEW.store_id;

  INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
  VALUES (
    'review',
    'Campaña pendiente de revisión',
    COALESCE(v_store_name, 'Una tienda') || ' subió "' || NEW.brand_name || '" para aprobación.',
    jsonb_build_object(
      'entity',     'campaign',
      'entity_id',  NEW.id,
      'store_id',   NEW.store_id,
      'store_name', v_store_name
    ),
    'review_campaign_' || NEW.id::text
  )
  ON CONFLICT (unique_key) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_admin_campaign_pending ON public.ad_campaigns;
CREATE TRIGGER trg_notify_admin_campaign_pending
  AFTER INSERT ON public.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.notify_admin_of_pending_campaign();


CREATE OR REPLACE FUNCTION public.notify_admin_of_pending_coupon()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_store_name TEXT;
BEGIN
  IF NEW.approval_status <> 'pending' THEN
    RETURN NEW;
  END IF;
  SELECT name INTO v_store_name FROM public.stores WHERE id = NEW.store_id;

  INSERT INTO public.admin_notifications (type, title, message, metadata, unique_key)
  VALUES (
    'review',
    'Cupón pendiente de revisión',
    COALESCE(v_store_name, 'Una tienda') || ' subió "' || NEW.title || '" para aprobación.',
    jsonb_build_object(
      'entity',     'coupon',
      'entity_id',  NEW.id,
      'store_id',   NEW.store_id,
      'store_name', v_store_name
    ),
    'review_coupon_' || NEW.id::text
  )
  ON CONFLICT (unique_key) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_admin_coupon_pending ON public.coupons;
CREATE TRIGGER trg_notify_admin_coupon_pending
  AFTER INSERT ON public.coupons
  FOR EACH ROW EXECUTE FUNCTION public.notify_admin_of_pending_coupon();


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Re-crear RPCs de aprobación/rechazo para que dejen notificación al cliente
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_approve_campaign(p_campaign_id UUID)
RETURNS public.ad_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.ad_campaigns;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden aprobar campañas.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.bypass_campaign_guard', 'on', true);

  UPDATE public.ad_campaigns
     SET approval_status  = 'approved',
         rejection_reason = NULL,
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = true
   WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Campaña % no existe.', p_campaign_id USING ERRCODE = 'P0002';
  END IF;

  IF v_row.store_id IS NOT NULL THEN
    INSERT INTO public.client_notifications (store_id, type, title, message, metadata)
    VALUES (
      v_row.store_id,
      'campaign_approved',
      'Campaña aprobada',
      '"' || v_row.brand_name || '" fue aprobada y ya aparece en el K2.',
      jsonb_build_object('entity', 'campaign', 'entity_id', v_row.id)
    );
  END IF;

  RETURN v_row;
END $$;


CREATE OR REPLACE FUNCTION public.admin_reject_campaign(p_campaign_id UUID, p_reason TEXT)
RETURNS public.ad_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row    public.ad_campaigns;
  v_reason TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden rechazar campañas.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.bypass_campaign_guard', 'on', true);

  v_reason := NULLIF(btrim(p_reason), '');

  UPDATE public.ad_campaigns
     SET approval_status  = 'rejected',
         rejection_reason = v_reason,
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = false
   WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Campaña % no existe.', p_campaign_id USING ERRCODE = 'P0002';
  END IF;

  IF v_row.store_id IS NOT NULL THEN
    INSERT INTO public.client_notifications (store_id, type, title, message, metadata)
    VALUES (
      v_row.store_id,
      'campaign_rejected',
      'Campaña rechazada',
      '"' || v_row.brand_name || '" fue rechazada' ||
        CASE WHEN v_reason IS NOT NULL THEN ': ' || v_reason ELSE '.' END,
      jsonb_build_object(
        'entity',           'campaign',
        'entity_id',        v_row.id,
        'rejection_reason', v_reason
      )
    );
  END IF;

  RETURN v_row;
END $$;


CREATE OR REPLACE FUNCTION public.admin_approve_coupon(p_coupon_id UUID)
RETURNS public.coupons
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.coupons;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden aprobar cupones.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.bypass_coupon_guard', 'on', true);

  UPDATE public.coupons
     SET approval_status  = 'approved',
         rejection_reason = NULL,
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = true
   WHERE id = p_coupon_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cupón % no existe.', p_coupon_id USING ERRCODE = 'P0002';
  END IF;

  IF v_row.store_id IS NOT NULL THEN
    INSERT INTO public.client_notifications (store_id, type, title, message, metadata)
    VALUES (
      v_row.store_id,
      'coupon_approved',
      'Cupón aprobado',
      '"' || v_row.title || '" fue aprobado y ya aparece en el K2.',
      jsonb_build_object('entity', 'coupon', 'entity_id', v_row.id)
    );
  END IF;

  RETURN v_row;
END $$;


CREATE OR REPLACE FUNCTION public.admin_reject_coupon(p_coupon_id UUID, p_reason TEXT)
RETURNS public.coupons
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row    public.coupons;
  v_reason TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden rechazar cupones.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.bypass_coupon_guard', 'on', true);

  v_reason := NULLIF(btrim(p_reason), '');

  UPDATE public.coupons
     SET approval_status  = 'rejected',
         rejection_reason = v_reason,
         reviewed_at      = now(),
         reviewed_by      = auth.uid(),
         is_active        = false
   WHERE id = p_coupon_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cupón % no existe.', p_coupon_id USING ERRCODE = 'P0002';
  END IF;

  IF v_row.store_id IS NOT NULL THEN
    INSERT INTO public.client_notifications (store_id, type, title, message, metadata)
    VALUES (
      v_row.store_id,
      'coupon_rejected',
      'Cupón rechazado',
      '"' || v_row.title || '" fue rechazado' ||
        CASE WHEN v_reason IS NOT NULL THEN ': ' || v_reason ELSE '.' END,
      jsonb_build_object(
        'entity',           'coupon',
        'entity_id',        v_row.id,
        'rejection_reason', v_reason
      )
    );
  END IF;

  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_campaign(UUID)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reject_campaign(UUID, TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_approve_coupon(UUID)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reject_coupon(UUID, TEXT)     TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RPCs para marcar leídas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_client_notification_read(p_id UUID)
RETURNS public.client_notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.client_notifications;
BEGIN
  UPDATE public.client_notifications
     SET read_at = COALESCE(read_at, now())
   WHERE id = p_id
     AND (public.is_admin() OR public.user_owns_store(store_id))
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notificación % no existe o no tienes permiso.', p_id
      USING ERRCODE = '42501';
  END IF;
  RETURN v_row;
END $$;
GRANT EXECUTE ON FUNCTION public.mark_client_notification_read(UUID) TO authenticated;


CREATE OR REPLACE FUNCTION public.mark_all_client_notifications_read(p_store_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT (public.is_admin() OR public.user_owns_store(p_store_id)) THEN
    RAISE EXCEPTION 'No tienes permiso sobre esa tienda.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.client_notifications
     SET read_at = now()
   WHERE store_id = p_store_id
     AND read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION public.mark_all_client_notifications_read(UUID) TO authenticated;


CREATE OR REPLACE FUNCTION public.mark_admin_notification_read(p_id UUID)
RETURNS public.admin_notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row public.admin_notifications;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.admin_notifications
     SET read_at = COALESCE(read_at, now())
   WHERE id = p_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notificación % no existe.', p_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;
GRANT EXECUTE ON FUNCTION public.mark_admin_notification_read(UUID) TO authenticated;


CREATE OR REPLACE FUNCTION public.mark_all_admin_notifications_read()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.admin_notifications
     SET read_at = now()
   WHERE read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION public.mark_all_admin_notifications_read() TO authenticated;
