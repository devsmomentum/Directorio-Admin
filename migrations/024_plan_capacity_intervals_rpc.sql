-- ============================================================================
-- RPC: plan_capacity_intervals
-- ----------------------------------------------------------------------------
-- Devuelve los intervalos de ocupación de cada plan, anonimizados, para que el
-- portal del cliente pueda calcular disponibilidad SIN violar RLS.
--
-- Problema que resuelve:
--   El portal del cliente necesita saber cuántos ocupantes simultáneos habrá
--   durante el período que está solicitando (mismo sweep-line que ejecuta el
--   backend en plan_max_overlap_in_window). Sin embargo, RLS sobre
--   public.stores y public.plan_requests limita la vista a las filas que
--   pertenecen al usuario — el cliente no ve renovaciones aprobadas o
--   solicitudes pendientes de OTRAS tiendas que ya están ocupando ese slot.
--
--   Esto causa que la UI muestre "disponible" para una fecha en la que el
--   backend rechaza con "sin cupo durante el período".
--
-- Diseño:
--   Esta función es SECURITY DEFINER y solo expone los campos estrictamente
--   necesarios para el cálculo de capacidad: el plan, el inicio y el fin del
--   intervalo, y el origen ('store', 'approved', 'pending'). No filtra
--   store_id, montos, métodos de pago ni ningún otro dato sensible.
--
--   Las tres fuentes reflejan exactamente las que usa plan_max_overlap_in_window:
--     1) stores con plan_type activo  → [hoy, contract_expiry_date | infinito]
--     2) plan_requests approved      → [effective_date, expires_at | infinito]
--     3) plan_requests pending       → [effective_date, effective_date + months*duration - 1]
--
--   La info expuesta es equivalente al agregado "X/Y ocupados" que ya muestra
--   la UI hoy, solo que con la dimensión temporal añadida.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.plan_capacity_intervals()
RETURNS TABLE (
  plan_key TEXT,
  start_d  DATE,
  end_d    DATE,
  source   TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  -- 1) Stores activos con un plan_type
  SELECT plan_type AS plan_key,
         CURRENT_DATE AS start_d,
         COALESCE(contract_expiry_date, DATE '9999-12-31') AS end_d,
         'store'::TEXT AS source
    FROM public.stores
   WHERE plan_type IS NOT NULL
     AND (contract_expiry_date IS NULL OR contract_expiry_date >= CURRENT_DATE)

  UNION ALL

  -- 2) plan_requests aprobadas con activación o vencimiento futuros
  SELECT pr.plan_key,
         pr.effective_date,
         COALESCE(pr.expires_at, DATE '9999-12-31'),
         'approved'::TEXT
    FROM public.plan_requests pr
   WHERE pr.status = 'approved'
     AND pr.effective_date IS NOT NULL
     AND COALESCE(pr.expires_at, DATE '9999-12-31') >= CURRENT_DATE

  UNION ALL

  -- 3) plan_requests pendientes (incluye 'partial') con período computado a
  --    partir de months_requested * duration_days del plan
  SELECT pr.plan_key,
         pr.effective_date,
         pr.effective_date
           + (COALESCE(pr.months_requested, 1)
              * COALESCE(
                  (SELECT p.duration_days FROM public.plans p WHERE p.plan_key = pr.plan_key),
                  30
              )) - 1,
         CASE WHEN pr.status = 'partial' THEN 'partial'::TEXT ELSE 'pending'::TEXT END
    FROM public.plan_requests pr
   WHERE pr.status IN ('pending', 'partial')
     AND pr.effective_date IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION public.plan_capacity_intervals() TO authenticated;

COMMENT ON FUNCTION public.plan_capacity_intervals() IS
  'Devuelve intervalos de ocupación por plan (stores + approved + pending), '
  'anonimizados, para que el portal del cliente compute disponibilidad por '
  'fecha sin violar RLS. Equivalente en datos al sweep-line del backend.';
