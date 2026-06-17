-- Finanzas data-driven por aliados: cada aliado define si su porcentaje aplica
-- sobre el BRUTO del ingreso (como lo hacía Anavi) o sobre LO DEMÁS (neto, ya
-- descontados los % sobre bruto y los gastos). El admin asigna % y base.
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS ally_revenue_base text NOT NULL DEFAULT 'net';

ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS chk_ally_revenue_base,
  ADD  CONSTRAINT chk_ally_revenue_base CHECK (ally_revenue_base IN ('gross','net'));

-- El dueño NO puede auto-editar la base de reparto: solo el admin. (Re-emitimos el
-- guard agregando el pin de ally_revenue_base a OLD.)
CREATE OR REPLACE FUNCTION public.guard_stores_owner_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF public.is_admin() OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.plan_type            := OLD.plan_type;
  NEW.contract_url         := OLD.contract_url;
  NEW.mercantil_url        := OLD.mercantil_url;
  NEW.cedula_url           := OLD.cedula_url;
  NEW.contract_expiry_date := OLD.contract_expiry_date;
  NEW.rif                  := OLD.rif;
  NEW.local_number         := OLD.local_number;
  NEW.floor_level          := OLD.floor_level;
  NEW.category_id          := OLD.category_id;
  NEW.node_id              := OLD.node_id;
  NEW.is_ally              := OLD.is_ally;
  NEW.ally_campaign_limit  := OLD.ally_campaign_limit;
  NEW.ally_flash_enabled   := OLD.ally_flash_enabled;
  NEW.ally_revenue_pct     := OLD.ally_revenue_pct;
  NEW.ally_revenue_base    := OLD.ally_revenue_base;
  NEW.ally_since           := OLD.ally_since;
  RETURN NEW;
END $function$;
