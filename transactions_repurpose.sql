-- ============================================================
-- Repropósito de transactions: pagos de planes de clientes
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- 1. Ampliar el CHECK para aceptar 'plan_payment'
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_transaction_type_check
    CHECK (transaction_type = ANY (ARRAY[
      'coupon'::text,
      'service'::text,
      'plan_payment'::text
    ]));

-- 2. Hacer nullable los campos exclusivos del kiosco
ALTER TABLE public.transactions
  ALTER COLUMN exchange_rate DROP NOT NULL,
  ALTER COLUMN amount_bs     DROP NOT NULL,
  ALTER COLUMN kiosk_id      DROP NOT NULL,
  ALTER COLUMN kiosk_id      DROP DEFAULT;

-- 3. Nuevas columnas para pagos de planes
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS store_id     UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_date DATE,
  ADD COLUMN IF NOT EXISTS period       TEXT,   -- ej: "Mayo 2026" o "1-15 Mayo 2026"
  ADD COLUMN IF NOT EXISTS notes        TEXT;   -- nro de referencia, comprobante, etc.

-- 4. Índice para consultas de pagos de planes por fecha
CREATE INDEX IF NOT EXISTS idx_transactions_plan_payment
  ON public.transactions (transaction_type, payment_date DESC)
  WHERE transaction_type = 'plan_payment';
