-- =====================================================================
-- ARCHIVO DE CONTRATOS POR TIENDA (historial multi-contrato)
-- ---------------------------------------------------------------------
-- Hasta ahora cada tienda tenía UN solo contrato (`stores.contract_url`).
-- El admin necesita poder subir VARIOS contratos por tienda, verlos todos
-- y descargarlos. El cliente (dueño) puede LEERLOS pero NUNCA editarlos.
--
-- Diseño:
--   · `store_contracts` es la fuente de verdad del ARCHIVO de contratos
--     (PDF/imagen en el bucket privado `documentos`), varios por tienda.
--   · `stores.contract_url` / `stores.contract_expiry_date` se CONSERVAN:
--     la lógica de plan y los cron de vencimiento siguen usándolas. Esta
--     tabla NO toca esa expiración por plan; `expiry_date` aquí es solo
--     informativo por documento.
--
-- Autorización: RLS. La UI solo oculta botones.
--   SELECT             → admin O dueño de la tienda
--   INSERT/UPDATE/DELETE → solo admin
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.store_contracts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  file_path   text        NOT NULL,             -- path dentro del bucket privado `documentos`
  expiry_date date,                             -- informativo por documento (opcional)
  notes       text,
  uploaded_by uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_contracts_store_id
  ON public.store_contracts (store_id);

ALTER TABLE public.store_contracts ENABLE ROW LEVEL SECURITY;

-- Lectura: admin o dueño de la tienda (reutiliza helpers existentes).
DROP POLICY IF EXISTS store_contracts_read ON public.store_contracts;
CREATE POLICY store_contracts_read ON public.store_contracts
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.user_owns_store(store_id));

-- Escritura: SOLO admin. El cliente no puede crear/editar/borrar contratos.
DROP POLICY IF EXISTS store_contracts_admin_write ON public.store_contracts;
CREATE POLICY store_contracts_admin_write ON public.store_contracts
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_contracts TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- Backfill: no perder los contratos actuales. Cada tienda con un
-- `contract_url` no nulo arranca con su contrato "histórico".
-- Idempotente: solo inserta si la tienda aún no tiene contratos.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.store_contracts (store_id, title, file_path, expiry_date)
SELECT s.id, 'Contrato (histórico)', s.contract_url, s.contract_expiry_date
  FROM public.stores s
 WHERE s.contract_url IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.store_contracts sc WHERE sc.store_id = s.id
   );
