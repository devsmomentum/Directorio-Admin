# Roadmap: Módulo de Cobranzas y Portal del Aliado

**Fecha de análisis:** 2026-05-15  
**Proyecto:** Milenium Admin — Morna Tech

---

## Estado actual del Dashboard

| Módulo existente | Estado |
|---|---|
| Kioscos | ✅ Implementado |
| Tiendas (CRM básico) | ✅ Implementado (nombre, categoría, piso, plan, logo) |
| Cupones y Combos | ✅ Implementado |
| Banners | ✅ Implementado |
| Campañas Publicitarias | ✅ Implementado (Ad-Server con asignación a kioscos) |
| Planes (Diamante, Oro, etc.) | ✅ Implementado |
| Analíticas (tráfico + finanzas básico) | ✅ Parcial |
| Mapa de kioscos | ✅ Implementado |
| CRM publicitario completo | ❌ Falta |
| Documentación "Paperless" | ❌ Falta |
| Smart Kill-Switch (corte automático) | ❌ Falta |
| Métricas en tiempo real (impresiones) | ❌ Falta |
| Heatmap de interacción por kiosco | ❌ Falta |
| Revenue Share / cálculo de comisiones | ❌ Falta |
| Módulo de gastos operativos | ❌ Falta |
| Reportes bi-mensuales automáticos | ❌ Falta |
| Flash Coupons con cronómetro | ❌ Parcial (cupones existen, sin timer de urgencia) |
| Portal del Aliado (link externo) | ❌ Falta |
| Notificaciones automáticas (WhatsApp/Email) | ❌ Falta |

---

## Análisis de Requerimientos

### BLOQUE 1 — CRM Publicitario Completo
**Qué falta en Tiendas:**
- RIF del cliente
- Datos de contacto (teléfono, email)
- Carga de documentos: contrato PDF/JPG, cédula del representante, registro mercantil
- Campo de Nro de Tienda y Piso (existe `local_number` y `floor_level` — verificar si se está mostrando)
- Status de pauta activa con fecha de vencimiento visible

### BLOQUE 2 — Smart Kill-Switch (Automatización de corte)
**Lógica requerida:**
- Fecha de inicio + duración del plan → calcular `fecha_corte` automáticamente
- Job nocturno (00:00): si `fecha_corte` < hoy y no existe pago confirmado → marcar campaña como `paused_no_payment`
- El Ad-Server debe excluir campañas con ese estado del loop de pantallas
- Enviar notificación automática al cliente (WhatsApp via SuperAPI / Email)
- 3 días antes del corte: alerta al equipo de cobranzas

### BLOQUE 3 — Documentación Paperless
**Qué agregar a la ficha de la tienda:**
- Upload de contrato firmado (PDF)
- Upload de registro mercantil (PDF)
- Fecha de vencimiento del contrato
- Alerta automática 30 días antes del vencimiento del contrato

### BLOQUE 4 — Métricas en Tiempo Real
**Qué falta en Analíticas:**
- Contador de impresiones por campaña (reproducciones del video)
- Dato: 441 impresiones/día para Slot Diamante (loop de ~3.3 min en 20 pantallas)
- Heatmap por kiosco: clicks en "Pago de Estacionamiento" vs "Cuponera Inteligente"
- Tabla de impresiones por cliente/campaña exportable

### BLOQUE 5 — Revenue Share y Gastos Operativos
**Lógica de cálculo:**
```
Ingreso bruto
  - 10% impuestos y gastos operativos fijos
  = Base neta
    - 11.8% → C.C. Millenium
    - X%     → Morna Tech
    - X%     → Sunmi Latam
    = Ganancia Morna
```
**Módulos a crear:**
- Registro de gastos operativos (abogada, alcaldía, seguro, etc.) con fecha y monto
- Resumen financiero: ingresos - gastos = ganancia real
- Generador de reporte bi-mensual (PDF o tabla exportable)

### BLOQUE 6 — Flash Coupons con Cronómetro
**Qué falta en el módulo de cupones:**
- Campo `timer_seconds` (ej. 30 segundos)
- Vinculación del QR al email del usuario (captura de leads)
- Estado "activo relámpago" que el admin puede disparar manualmente

### BLOQUE 7 — Portal del Aliado (Link Externo)
**Nueva ruta pública** (`/aliado/[token]`):
- Vista sin autenticación, accesible por link único por cliente
- Secciones:
  1. Especificaciones técnicas de arte (video 1080×1920, imagen 1080×450)
  2. Protocolo de pagos (datos bancarios Bancamiga, instrucciones de comprobante)
  3. Status de su pauta actual (activa / pausada / días restantes)
- Generación del link desde el panel de Tiendas

---

## Plan de Implementación por Pasos

### FASE 1 — CRM Completo + Documentos (1-2 días)
1. **Migración DB:** Agregar campos a tabla `stores`:
   - `rif`, `contact_phone`, `contact_email`, `representative_name`
   - `contract_url` (PDF en storage), `mercantil_url` (PDF)
   - `contract_expiry_date`
2. **UI Tiendas:** Ampliar formulario con campos de CRM y upload de documentos
3. **Alertas de vencimiento:** Query en dashboard home que muestre contratos próximos a vencer (≤30 días)

### FASE 2 — Smart Kill-Switch (2-3 días)
4. **Migración DB:** Agregar a `ad_campaigns`:
   - `payment_status` (enum: `pending`, `paid`, `overdue`)
   - `cut_date` (calculado: `start_date + plan.duration_days`)
   - `suspended_at`
5. **Edge Function / Cron:** Supabase Edge Function que corra a las 00:05 diarias:
   - Detecta campañas con `cut_date` = ayer y `payment_status != paid`
   - Marca `is_active = false`, `payment_status = overdue`
   - Llama a SuperAPI para enviar notificación al cliente
6. **Alerta de cobranzas:** 3 días antes del `cut_date` → notificación interna en el dashboard
7. **UI Campañas:** Badge de status de pago + botón "Marcar como Pagado"

### FASE 3 — Métricas e Impresiones (2 días)
8. **Tabla `impression_events`:** Registrar cada reproducción de video (kiosk_id, campaign_id, timestamp)
9. **UI Analíticas:** Sección "Impresiones" con:
   - Total por campaña
   - Gráfico por día
   - Tabla exportable CSV
10. **Heatmap:** Usar datos existentes de `analytics_events` (eventos de parking y cuponera por kiosco) — agregar visualización tipo grid de calor

### FASE 4 — Revenue Share y Gastos (1-2 días)
11. **Tabla `operational_expenses`:** `id, category, description, amount_usd, date, created_by`
12. **UI nueva sección "Finanzas":**
    - CRUD de gastos operativos
    - Panel de distribución (ingresos → deducciones → comisiones → ganancia)
    - Generador de reporte bi-mensual (tabla con botón "Exportar PDF/CSV")

### FASE 5 — Flash Coupons con Timer (1 día)
13. **Migración DB:** Agregar `timer_seconds`, `lead_capture_email` a tabla `coupons`
14. **UI Cupones:** Campo de duración timer + toggle "Modo Relámpago"
15. **Kiosk-side:** El Ad-Server consume el timer y muestra el countdown

### FASE 6 — Portal del Aliado (2 días)
16. **Ruta pública** `app/aliado/[token]/page.tsx`
17. **Tabla `ally_tokens`:** `id, store_id, token (uuid), created_at, expires_at`
18. **UI Portal:** Diseño limpio con:
    - Sección specs técnicas de arte
    - Recuadro de pagos (datos bancarios + instrucciones)
    - Status de pauta en tiempo real
19. **Generación de link** desde la ficha de la tienda con botón "Copiar link para WhatsApp"

---

## Prioridad de Entrega

| # | Fase | Prioridad | Estimado |
|---|---|---|---|
| 1 | CRM Completo + Documentos | 🔴 Alta | 1-2 días |
| 2 | Portal del Aliado | 🔴 Alta (solicitado para el viernes) | 2 días |
| 3 | Smart Kill-Switch | 🔴 Alta | 2-3 días |
| 4 | Revenue Share + Gastos | 🟡 Media | 1-2 días |
| 5 | Métricas e Impresiones | 🟡 Media | 2 días |
| 6 | Flash Coupons con Timer | 🟢 Baja | 1 día |

---

## Tablas DB a crear/modificar

```sql
-- Fase 1: Ampliar stores
ALTER TABLE stores ADD COLUMN rif TEXT;
ALTER TABLE stores ADD COLUMN contact_phone TEXT;
ALTER TABLE stores ADD COLUMN contact_email TEXT;
ALTER TABLE stores ADD COLUMN representative_name TEXT;
ALTER TABLE stores ADD COLUMN contract_url TEXT;
ALTER TABLE stores ADD COLUMN mercantil_url TEXT;
ALTER TABLE stores ADD COLUMN contract_expiry_date DATE;

-- Fase 2: Ampliar ad_campaigns
ALTER TABLE ad_campaigns ADD COLUMN payment_status TEXT DEFAULT 'pending'
  CHECK (payment_status IN ('pending', 'paid', 'overdue'));
ALTER TABLE ad_campaigns ADD COLUMN cut_date DATE;
ALTER TABLE ad_campaigns ADD COLUMN suspended_at TIMESTAMPTZ;

-- Fase 3: Impresiones
CREATE TABLE impression_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kiosk_id UUID REFERENCES kiosks(id),
  campaign_id UUID REFERENCES ad_campaigns(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Fase 4: Gastos operativos
CREATE TABLE operational_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  description TEXT,
  amount_usd NUMERIC(10,2) NOT NULL,
  expense_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Fase 5: Ampliar coupons
ALTER TABLE coupons ADD COLUMN timer_seconds INT DEFAULT 30;
ALTER TABLE coupons ADD COLUMN is_flash BOOLEAN DEFAULT false;

-- Fase 6: Tokens de portal
CREATE TABLE ally_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);
```

---

## Datos bancarios para Portal del Aliado

> **CENTRO DE PAGOS — ANAVI DIRECTORIOS**  
> Email: anavidirectorios@gmail.com  
> Asunto: `[C.C.] + [Nombre Tienda] + [Nro Tienda]`

| Tipo | Detalle |
|---|---|
| RIF | J506637529 |
| Bolívares (Bancamiga) | 01720125521255415786 |
| Dólares (Bancamiga) | 01720125571255412486 |
| Efectivo | Disponible |
| Binance | Solicitar link de pago |

---

## Specs técnicas de arte (para Portal del Aliado)

| Formato | Resolución | Duración | Archivo |
|---|---|---|---|
| Video (Diamante/Oro) | 1080 × 1920 px vertical | Máx 15 seg | .MP4 (H.264) |
| Imagen (Banners menú) | 1080 × 450 px | — | .PNG o .JPG alta calidad |
| Cupón QR | — | — | QR como protagonista, menos texto |
