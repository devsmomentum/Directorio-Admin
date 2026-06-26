-- ============================================================================
-- Revertir promociones "pending" atascadas → 'draft' cuando la tienda dejó de
-- tener plan vigente.
-- ----------------------------------------------------------------------------
-- Bug: una promo (campaña / cupón flash / banner) creada con plan activo entra
-- a 'pending' (cola de revisión del admin). Si luego el plan vence, los triggers
-- solo hacían draft→pending (al activar), nunca pending→draft (al vencer), así
-- que la promo quedaba atascada en 'pending' y seguía apareciendo en /panel/
-- solicitudes pese a que la tienda ya no tiene plan. apply_kill_switch() pone
-- stores.plan_type = NULL al vencer, pero no toca approval_status.
--
-- Fix: una pasada diaria revierte a 'draft' (inactivas, fuera de revisión) las
-- promos 'pending' cuyas tiendas ya no son elegibles, reusando exactamente la
-- elegibilidad de los guards de inserción (incluye excepciones de aliados y
-- excluye anuncios admin_managed). Cuando la tienda renueve y el dueño edite la
-- promo, el guard la devuelve a 'pending' como siempre.
-- ============================================================================

-- ── 1. Guards de banner: permitir mantenimiento desde la BD / cron ──────────────
-- auth.uid() es NULL en contexto cron/service-role. Igual que guard_users_self_
-- update, dejamos pasar esos UPDATE/INSERT de mantenimiento sin tropezar con la
-- verificación de membresía (que de otro modo lanzaría 'No tienes permisos').
CREATE OR REPLACE FUNCTION public.guard_banners_client_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE v_diam_active BOOLEAN;
BEGIN
  IF public.is_admin() OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.user_member_of_store(NEW.store_id) THEN
    NEW.rejection_reason := NULL;
    NEW.is_active        := false;
    SELECT (plan_type = 'DIAMANTE' AND (contract_expiry_date IS NULL OR contract_expiry_date >= CURRENT_DATE))
      INTO v_diam_active FROM public.stores WHERE id = NEW.store_id;
    IF COALESCE(v_diam_active, false) THEN
      NEW.approval_status := 'pending';
    ELSE
      -- Sin plan DIAMANTE vigente: borrador, fuera de revisión.
      NEW.approval_status := 'draft';
    END IF;
  ELSE
    RAISE EXCEPTION 'No tienes permisos sobre esta tienda.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_banners_client_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE v_diam_active BOOLEAN;
BEGIN
  IF public.is_admin() OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.user_member_of_store(NEW.store_id) THEN
    NEW.store_id         := OLD.store_id;
    NEW.approval_status  := OLD.approval_status;
    NEW.rejection_reason := OLD.rejection_reason;

    -- BORRADOR: al editarlo con plan DIAMANTE vigente, pasa a revisión.
    IF OLD.approval_status = 'draft' THEN
      SELECT (plan_type = 'DIAMANTE' AND (contract_expiry_date IS NULL OR contract_expiry_date >= CURRENT_DATE))
        INTO v_diam_active FROM public.stores WHERE id = OLD.store_id;
      IF COALESCE(v_diam_active, false) THEN
        NEW.approval_status  := 'pending';
        NEW.rejection_reason := NULL;
      ELSE
        NEW.approval_status  := 'draft';
      END IF;
      NEW.is_active := false;
      RETURN NEW;
    END IF;

    IF NEW.media_url IS DISTINCT FROM OLD.media_url THEN
      NEW.approval_status  := 'pending';
      NEW.rejection_reason := NULL;
      NEW.is_active        := false;
    END IF;
  ELSE
    RAISE EXCEPTION 'No tienes permisos sobre esta tienda.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;


-- ── 2. Función de barrido: pending → draft para tiendas no elegibles ────────────
CREATE OR REPLACE FUNCTION public.revert_stuck_pending_promotions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE n int := 0; b int := 0;
BEGIN
  -- Los guards de owner reescriben approval_status en UPDATE; los puenteamos
  -- para esta pasada de mantenimiento (mismo patrón que apply_kill_switch).
  PERFORM set_config('app.bypass_campaign_guard', 'on', true);
  PERFORM set_config('app.bypass_coupon_guard',   'on', true);

  -- Campañas de cliente (no admin_managed): elegible = aliada O plan vigente que
  -- aplique a campañas. Si no, vuelve a borrador.
  UPDATE public.ad_campaigns c
     SET approval_status = 'draft', is_active = false
    FROM public.stores s
   WHERE c.store_id = s.id
     AND c.approval_status = 'pending'
     AND NOT c.admin_managed
     AND NOT (
          COALESCE(s.is_ally, false)
          OR (s.plan_type IS NOT NULL
              AND (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE)
              AND public.plan_applies_to(s.plan_type, 'campaigns'))
     );
  GET DIAGNOSTICS b = ROW_COUNT; n := n + b;

  -- Cupones flash: elegible = aliada con flash O addon flash vigente. (Solo
  -- cupones flash: es el único camino de borrador del cliente; los cupones
  -- legacy/admin no se tocan.)
  UPDATE public.coupons c
     SET approval_status = 'draft', is_active = false
    FROM public.stores s
   WHERE c.store_id = s.id
     AND c.approval_status = 'pending'
     AND public.is_flash_coupon_plan(c.plan_type)
     AND NOT (
          (COALESCE(s.is_ally, false) AND COALESCE(s.ally_flash_enabled, false))
          OR (s.flash_coupon_plan IS NOT NULL
              AND (s.flash_coupon_expiry_date IS NULL OR s.flash_coupon_expiry_date >= CURRENT_DATE))
     );
  GET DIAGNOSTICS b = ROW_COUNT; n := n + b;

  -- Banners: elegible = plan DIAMANTE vigente.
  UPDATE public.banners bn
     SET approval_status = 'draft', is_active = false
    FROM public.stores s
   WHERE bn.store_id = s.id
     AND bn.approval_status = 'pending'
     AND NOT (s.plan_type = 'DIAMANTE'
              AND (s.contract_expiry_date IS NULL OR s.contract_expiry_date >= CURRENT_DATE));
  GET DIAGNOSTICS b = ROW_COUNT; n := n + b;

  RETURN n;
END $$;

COMMENT ON FUNCTION public.revert_stuck_pending_promotions() IS
  'Revierte a draft las promos pending de tiendas sin plan vigente. Corre a diario tras apply_kill_switch.';


-- ── 3. Cron diario (tras kill-switch de las 4:05, que anula plan_type) ──────────
SELECT cron.schedule(
  'revert-stuck-pending-promotions',
  '10 4 * * *',
  $$ SELECT public.revert_stuck_pending_promotions(); $$
);


-- ── 4. Limpieza inmediata de las filas ya atascadas ─────────────────────────────
SELECT public.revert_stuck_pending_promotions();
