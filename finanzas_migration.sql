-- ============================================================
-- Fase 4: Revenue Share + Gastos Operativos
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.operational_expenses (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  category     TEXT          NOT NULL,
  description  TEXT,
  amount_usd   NUMERIC(10,2) NOT NULL CHECK (amount_usd > 0),
  expense_date DATE          NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

ALTER TABLE public.operational_expenses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'operational_expenses'
      AND policyname = 'auth_full_operational_expenses'
  ) THEN
    CREATE POLICY "auth_full_operational_expenses"
      ON public.operational_expenses
      FOR ALL TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

-- Índice para consultas por rango de fecha
CREATE INDEX IF NOT EXISTS idx_operational_expenses_date
  ON public.operational_expenses (expense_date DESC);
