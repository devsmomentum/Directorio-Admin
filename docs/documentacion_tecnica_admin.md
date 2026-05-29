# Documentación Técnica del Proyecto: Millennium Admin Panel
> **Mall Hub — Panel Administrativo & Portal del Aliado** · Paquete `mall-admin-panel` `0.1.0`
> **Framework:** Next.js `16.2.0` (App Router) · React `19.2.4` · TypeScript `5.x`
> **Estado:** Producción · **Backend:** Supabase (PostgreSQL + Auth + Storage + Edge Functions)

---

## 1. Vista General del Proyecto

### 1.1. Descripción

**Millennium Admin Panel** (interno: `milenium-admin`, marca de UI **"Mall Hub"**) es la aplicación web que administra todo el ecosistema de kioscos interactivos del **Millennium Mall**. Es la contraparte de gestión de la app de kiosco Flutter (`milemium`): mientras el kiosco consume datos, este panel los produce y gobierna.

El proyecto sirve **dos audiencias distintas desde una sola base de código**, separadas por rol y por árbol de rutas:

1. **Panel Administrativo (`/panel/*`)** — para los operadores del mall (rol `admin`). Gestiona kioscos, tiendas, categorías, planes, banners, campañas publicitarias, cupones flash, servicios, el editor de mapas, finanzas, analíticas, auditoría y el flujo de aprobaciones.
2. **Portal del Aliado (`/cliente/*`)** — para los dueños de tienda (rol `cliente`). Permite a cada comercio gestionar su propia ficha, contratar/renovar planes, reportar pagos, crear sus campañas y cupones (que entran a un flujo de aprobación), y recibir notificaciones.

La aplicación es **multi-tenant por rol**: un único login determina si el usuario aterriza en el panel admin o en el portal del cliente. La frontera de datos entre clientes se sostiene con **Row Level Security (RLS)** en PostgreSQL más un filtrado defensivo en el cliente vía la tabla puente `user_stores`.

### 1.2. Stack Tecnológico Clave

| Dependencia | Versión | Propósito en este proyecto |
|---|---|---|
| `next` | `16.2.0` | Framework full-stack. **App Router** con mezcla de Server y Client Components. ⚠️ Esta versión tiene cambios disruptivos respecto a versiones previas (ver `AGENTS.md`). |
| `react` / `react-dom` | `19.2.4` | Librería de UI. |
| `@supabase/supabase-js` | `^2.99.2` | **Única fuente de datos remota.** Cliente para PostgREST (queries), Auth, Storage, RPC y Realtime contra el proyecto Supabase. |
| `tailwindcss` | `^4` | Sistema de estilos utility-first (Tailwind v4 con `@theme inline`). |
| `@tailwindcss/postcss` | `^4` | Integración PostCSS de Tailwind 4. |
| `dotenv` | `^17.4.2` | Carga de variables de entorno (uso en scripts/migraciones). |
| `typescript` | `^5` | Tipado estático. `strict: true`, alias `@/*` → raíz del proyecto. |
| `eslint` + `eslint-config-next` | `^9` / `16.2.0` | Análisis estático (core-web-vitals + reglas TS de Next). |
| Geist Sans / Geist Mono | (`next/font`) | Tipografías cargadas vía `next/font`. |

**Variables de entorno** (`.env.local`):

| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase (cliente público). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key para queries/auth desde el navegador. |
| `CRON_SECRET` | Secreto compartido para autenticar los cron jobs que invocan Edge Functions (`x-cron-secret`). |
| `NEXT_PUBLIC_DEBUG` | (opcional) Habilita el registro de usuarios desde `/login`. |

**Scripts** (`package.json`):

```bash
npm run dev     # next dev   — servidor de desarrollo (localhost:3000)
npm run build   # next build — compilación de producción
npm start       # next start — servidor de producción
npm run lint    # eslint
```

> **Nota de mantenimiento (AGENTS.md):** Next.js 16 introduce breaking changes. Antes de modificar APIs, convenciones o estructura de archivos, consultar la documentación local en `node_modules/next/dist/docs/`.

---

## 2. Arquitectura y Estructura de Directorios

### 2.1. Patrón Arquitectónico

El proyecto sigue el modelo **App Router de Next.js con segmentación por audiencia**:

- **Routing basado en carpetas** bajo `app/`. Cada `page.tsx` es una ruta; cada `layout.tsx` envuelve a su subárbol.
- **Dos segmentos protegidos** con su propio layout y guard de autenticación: `app/panel/` (admin) y `app/cliente/` (aliado). Cada layout aplica el guard de sesión + rol y dibuja su propio sidebar.
- **Client Components por defecto en las pantallas interactivas** (`'use client'`): toda la lógica de datos vive en el navegador y habla directo con Supabase vía la anon key + RLS. Los Server Components se limitan al layout raíz, redirecciones y contenido estático.
- **Lógica de negocio crítica delegada a PostgreSQL** mediante **RPCs `SECURITY DEFINER`** (aprobaciones, cálculo de capacidad de planes, rotación de cupones, tracking de saldos). El frontend orquesta; la base de datos decide y valida atómicamente.
- **No hay capa de API propia de Next** (no se usan Route Handlers para el dominio). El backend efectivo es Supabase: PostgREST + RPCs + Edge Functions + pg_cron.

No se usa Redux, Zustand ni librerías de estado global pesadas. El estado compartido del portal cliente se maneja con **React Context** (`ClienteStoreContext`); el resto es estado local por pantalla (`useState`/`useEffect`).

### 2.2. Árbol de Directorios Comentado

```
milenium-admin/
│
├── app/                              # App Router: rutas, layouts y UI.
│   ├── layout.tsx                    # Layout raíz (Server). Fuentes Geist, metadatos
│   │                                 # ("Mall Hub"), ThemeScript anti-flash, lang="es".
│   ├── page.tsx                      # Landing (Client). Lee sesión → redirige a /login,
│   │                                 # /panel o /cliente/dashboard según rol.
│   ├── globals.css                   # Tailwind v4 + tokens de tema + utilidades de marca.
│   ├── theme.css                     # Variables de color por tema (claro/oscuro).
│   │
│   ├── login/page.tsx                # Login email+password (signInWithPassword).
│   ├── bienvenida/page.tsx           # Onboarding / reset: define contraseña (password_set).
│   ├── abrir/page.tsx                # Gateway anti-prefetch para magic links (WhatsApp).
│   ├── auth/callback/page.tsx        # Procesa magic link / PKCE / reset; aplica sesión.
│   │
│   ├── components/                   # Componentes UI compartidos entre ambos segmentos.
│   │   ├── MallHubMark.tsx           # Marca/logo (tile + wordmark + tagline) por variante.
│   │   ├── Pagination.tsx            # Paginador reutilizable de las listas.
│   │   ├── ThemeScript.tsx           # <script> inline que fija el tema antes de hidratar.
│   │   └── ThemeToggle.tsx           # Botón claro/oscuro (persiste en localStorage).
│   │
│   ├── panel/                        # ── SEGMENTO ADMIN (rol=admin) ──
│   │   ├── layout.tsx                # Guard admin + sidebar (12 ítems) + badges de pendientes.
│   │   ├── page.tsx                  # Redirige a /panel/inicio.
│   │   ├── inicio/page.tsx           # Dashboard: estado de kioscos, alertas de vencimiento.
│   │   ├── kioscos/page.tsx          # CRUD de kioscos, binding de hardware, kiosk_mode.
│   │   ├── tiendas/page.tsx          # CRUD de tiendas (CRM: RIF, contacto, documentos, planes).
│   │   ├── clientes/page.tsx         # Identidad de aliados + vínculo a tiendas + magic link.
│   │   ├── solicitudes/page.tsx      # Centro de aprobaciones (pagos, campañas, cupones).
│   │   ├── cupons/page.tsx           # Gestión de cupones flash.
│   │   ├── banners/page.tsx          # Banners de UI (solo plan DIAMANTE).
│   │   ├── campanias/page.tsx        # Campañas del ad-loop + asignación a kioscos.
│   │   │   └── KioskAssignment.tsx   # Sub-componente: override de campañas por kiosco.
│   │   ├── analiticas/page.tsx       # Tráfico, rankings, impresiones y heatmap.
│   │   ├── finanzas/page.tsx         # Ingresos, gastos y reparto (revenue share).
│   │   ├── notificaciones/page.tsx   # Bandeja de notificaciones del admin.
│   │   ├── auditoria/page.tsx        # Bitácora de acciones administrativas.
│   │   ├── categorias/page.tsx       # CRUD de categorías (fuera del sidebar).
│   │   ├── planes/page.tsx           # Definición de planes y reglas de loop (fuera del sidebar).
│   │   ├── services/page.tsx         # Directorio de servicios de terceros (fuera del sidebar).
│   │   └── mapa/page.tsx             # Editor de mapas en canvas, multi-piso (fuera del sidebar).
│   │
│   └── cliente/                      # ── SEGMENTO ALIADO (rol=cliente) ──
│       ├── layout.tsx                # Guard cliente + sidebar (7 ítems) + selector de tienda.
│       ├── store-context.tsx         # ClienteStoreContext: tiendas del usuario + tienda activa.
│       ├── dashboard/page.tsx        # Métricas de la tienda, plan, impresiones, cupones.
│       ├── cuenta/page.tsx           # "Mi Tienda": edita descripción y datos personales.
│       ├── planes/page.tsx           # Catálogo de planes + solicitud de cambio + capacidad.
│       ├── promociones/page.tsx      # CRUD de cupones y campañas propias (entran a aprobación).
│       ├── pagos/page.tsx            # Solicitudes, reporte de renovaciones y abonos, historial.
│       ├── notificaciones/page.tsx   # Notificaciones del cliente (aprobaciones/rechazos).
│       ├── tutorial/page.tsx         # Guía estática: specs de arte y protocolo de pago.
│       ├── abono-modal.tsx           # Modal para reportar abonos (pagos parciales).
│       └── payment-fields.tsx        # Campos de pago reutilizables (método + tasa BCV).
│
├── lib/                              # Helpers de infraestructura (sin UI).
│   ├── supabase.ts                   # Cliente Supabase singleton (anon key).
│   ├── audit.ts                      # logAdminAction(): inserta en admin_audit_logs.
│   └── storage.ts                    # Helpers del bucket 'publicidad' (path/borrado).
│
├── supabase/                         # Backend gestionado.
│   ├── config.toml                   # Config de Edge Functions (verify_jwt por función).
│   ├── functions/                    # Edge Functions (Deno/TypeScript).
│   │   ├── send-magic-link/          # Crea usuario + envía magic link (email/WhatsApp).
│   │   ├── update-rate/              # Scrapea/consulta la tasa BCV diaria.
│   │   ├── deactivate-expired-coupons/  # Desactiva cupones flash vencidos.
│   │   ├── kill-switch/              # Apaga campañas/planes vencidos.
│   │   ├── send-contract-expiry-reminders/   # Recordatorios de vencimiento por email (Resend).
│   │   └── send-whatsapp-expiry-reminders/   # Recordatorios por WhatsApp (SuperAPI).
│   ├── migrations/                   # Migraciones versionadas por Supabase CLI.
│   └── templates/magic-link.html     # Plantilla de correo del magic link.
│
├── migrations/                       # Migraciones SQL manuales (001–029): RPCs, RLS, cron.
├── schem.sql                         # Dump del esquema completo (solo contexto, no ejecutable).
├── *.sql (raíz)                      # Migraciones standalone (impresiones, finanzas, auth, etc.).
│
├── public/                           # Assets estáticos (svg de marca por defecto de Next).
├── next.config.ts · tsconfig.json · eslint.config.mjs · postcss.config.mjs
├── README.md · ROADMAP.md · AGENTS.md · CLAUDE.md
└── package.json
```

### 2.3. Rutas fuera del sidebar

El sidebar admin expone 12 destinos, pero existen cuatro rutas operativas adicionales no listadas en el menú, accesibles por URL directa o enlazadas desde otras pantallas:

- `/panel/categorias` — administración de categorías de tienda.
- `/panel/planes` — definición de planes y sus reglas de loop.
- `/panel/services` — directorio de servicios de terceros.
- `/panel/mapa` — editor de mapas en canvas.

---

## 3. Cliente Supabase y Acceso a Datos

### 3.1. El singleton `lib/supabase.ts`

Toda la app comparte **una sola instancia** del cliente, construida con la anon key:

```ts
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,   // ← decisión clave (ver abajo)
  },
  global: {
    fetch: (url, options) => fetch(url, { ...options, cache: 'no-store' }),
  },
});
```

Dos decisiones de configuración no triviales:

- **`detectSessionInUrl: false`** — Se desactiva la detección automática de tokens en la URL porque **nuestro** endpoint `/auth/callback` los procesa explícitamente. Si se dejara en `true`, el SDK consumiría el token al cargar cualquier página y el callback recibiría un *"already used / expired"* — el síntoma reportado de "el magic link expiró".
- **`fetch` con `cache: 'no-store'`** — Anula la caché agresiva de Next.js para evitar que se guarden respuestas anónimas (arrays vacíos) emitidas antes de que la sesión termine de inicializarse.

### 3.2. Patrón de acceso a datos

- Las pantallas (Client Components) consultan directamente: `supabase.from('tabla').select(...)`, `.insert/.update/.delete`, y **RLS** decide qué filas son visibles/editables según `auth.uid()` y el rol.
- Las operaciones que requieren validación atómica o privilegios elevados pasan por **`supabase.rpc('funcion', args)`** (funciones `SECURITY DEFINER` en PostgreSQL).
- La subida de archivos usa **`supabase.storage.from('bucket')`**.
- **Realtime** se usa de forma ligera; el patrón dominante para "frescura" es **refresco por intervalo (30s) y al recuperar foco de ventana** (badges de pendientes en los layouts, contador de no leídos).

### 3.3. Helpers de `lib/`

- **`audit.ts → logAdminAction(payload)`** — Inserta un registro en `admin_audit_logs` con el `admin_id`/`admin_email` de la sesión, el `action_type` (`CREAR`, `EDITAR`, `ELIMINAR`, `APROBAR`, `RECHAZAR`, `ACTIVAR`, `DESACTIVAR`, `VINCULAR`, `DESVINCULAR`), el `entity_type` (`tienda`, `campaña`, `banner`, `cupón`, `kiosco`, `categoría`, `plan`, `servicio`, `gasto_operativo`, `pago`, `solicitud`) y un `details` JSON opcional. Falla silenciosamente (loguea, no rompe la operación del usuario).
- **`storage.ts`** — `pathFromPublicidadUrl(url)` extrae el path interno (`campaigns/foo.mp4`, `coupons/bar.jpg`) de una URL pública del bucket `publicidad`; `removePublicidadFile(url)` borra ese archivo silenciando errores (el borrado de la fila en DB es la fuente de verdad; un archivo huérfano es preferible a abortar la operación).

---

## 4. Autenticación y Autorización

### 4.1. Modelo de autenticación

Auth se apoya enteramente en **Supabase Auth** (respaldado por PostgreSQL). El esquema:

1. **Entrada (`app/page.tsx`)** — Lee `supabase.auth.getSession()`. Sin sesión → `/login`. Con sesión → consulta `users.role` y redirige a `/panel` (admin) o `/cliente/dashboard` (cliente).
2. **Login (`/login`)** — Email + contraseña vía `signInWithPassword()`. Incluye recuperación de contraseña (`resetPasswordForEmail`).
3. **Ruteo post-login** —
   - Si `user_metadata.password_set ≠ true` → `/bienvenida` (onboarding).
   - Si `users.role === 'admin'` → `/panel`.
   - Si `users.role === 'cliente'` → `/cliente/dashboard`.
4. **Magic link / PKCE / reset (`/auth/callback`)** — Endpoint unificado. Captura `access_token`/`refresh_token` del hash o el `code` (PKCE) del query, limpia la URL con `history.replaceState()` (seguridad), aplica la sesión con `setSession()` o `exchangeCodeForSession()`, y redirige según `recover`, `password_set` y rol. Usa un *guard* a nivel de módulo para evitar el doble procesamiento de React StrictMode.
5. **Onboarding / reset (`/bienvenida`)** — Define contraseña (mín. 8 caracteres, letras + números), marca `password_set: true` vía `updateUser`, hace `signOut({ scope: 'local' })` y reenvía a `/login?just_set_password=1`.
6. **Gateway de magic link (`/abrir`)** — Recibe `?next=<url>`, valida que sea `http(s)` absoluto y navega por click manual. Evita que los bots de previsualización de WhatsApp/mensajería **pre-consuman** el token de un solo uso del magic link.
7. **Logout** — `signOut({ scope: 'local' })` → `/login`.

### 4.2. Roles y guards

- La **fuente de verdad del rol** es la columna `users.role` (`admin` | `cliente`) en PostgreSQL, no el metadata del token.
- Cada layout protegido aplica su guard al montar:
  - **`panel/layout.tsx`**: exige sesión, `password_set`, y `role === 'admin'`. Redirige: sin sesión → `/login`; sin password → `/bienvenida`; no admin → `/cliente/dashboard`.
  - **`cliente/layout.tsx`**: exige sesión y `password_set`; si el rol es admin → `/panel`. Resuelve las tiendas del usuario vía `user_stores` (defensa en profundidad además de RLS).

### 4.3. Row Level Security (defensa en el servidor)

Como el navegador usa la anon key, **la seguridad real vive en las políticas RLS** de PostgreSQL. Temas de política:

- **`is_admin()`** — acceso completo de lectura/escritura a tablas restringidas.
- **`user_owns_store(store_id)`** — el aliado puede gestionar campañas/cupones de *su* tienda, pero no puede modificar `plan_type`, fechas de contrato ni `rif`.
- **`service_role` exclusivo** — `admin_notifications`, `admin_audit_logs` y los logs de recordatorios (`plan_expiry_reminders_log`, `plan_whatsapp_reminders_log`).
- **Catálogos públicos** (`plans`, `services`, `categories`, promociones) — legibles por `anon`/`authenticated` para que el kiosco y el portal los consuman.

---

## 5. Navegación y Layouts

### 5.1. Panel Admin (`/panel/layout.tsx`)

Client Component. Dibuja el sidebar (responsive, con drawer en móvil) y el `ThemeToggle`. **Sidebar (12 ítems):** Inicio · Kioscos · Tiendas · Clientes · Solicitudes · Cupones y Combos · Banners · Campañas · Analíticas · Finanzas · Notificaciones · Auditoría.

**Badges de pendientes:** cuenta y muestra contadores que se refrescan cada **30 s** y al recuperar foco. Las fuentes:

- `plan_requests` con `status = 'pending'`
- `transactions` con `transaction_type = 'plan_payment'` y `status = 'pending'`
- `ad_campaigns` con `approval_status = 'pending'`
- `coupons` con `approval_status = 'pending'`
- `admin_notifications` con `read_at IS NULL`

(Los primeros cuatro alimentan el badge de **Solicitudes**; el quinto, el de **Notificaciones**.)

### 5.2. Portal Cliente (`/cliente/layout.tsx`)

Client Component. **Sidebar (7 ítems):** Dashboard · Mi Tienda · Planes · Promociones · Pagos · Notificaciones · Tutorial. Provee el **selector de tienda** (para aliados con varias tiendas) y persiste la selección en `localStorage` (`cliente.selectedStoreId`). El badge de **Notificaciones** cuenta los `client_notifications` no leídos (refresco 30 s + foco). Envuelve el subárbol con `ClienteStoreContext`.

### 5.3. `ClienteStoreContext` (`cliente/store-context.tsx`)

Contexto que expone:

```ts
{
  stores: ClienteStore[];               // todas las tiendas del usuario
  selectedStore: ClienteStore | null;   // tienda activa
  setSelectedStoreId: (id) => void;
  refreshStores: () => Promise<void>;
}
```

`ClienteStore` incluye plan, fechas de contrato, addon flash coupon y las categorías anidadas. Todas las pantallas del portal leen la tienda activa desde aquí vía `useClienteStore()`.

---

## 6. Módulos del Panel Administrativo

> Todas las pantallas son Client Components (`'use client'`), comparten el paginador `Pagination`, el patrón de modal para crear/editar/borrar, y registran acciones sensibles vía `logAdminAction()`.

### 6.1. Inicio (`/panel/inicio`)
Dashboard de monitoreo de hardware. Estado online/offline de cada kiosco (online = `last_ping` dentro de 10 min, mostrado en tiempo relativo: *Ahora, Xm, Xh, Xd*), conteo de tiendas y campañas, y alerta de contratos por vencer (tiendas con `contract_expiry_date` dentro de 30 días). **Tablas:** `kiosks`, `stores`, `ad_campaigns`, `admin_notifications`.

### 6.2. Kioscos (`/panel/kioscos`)
CRUD de kioscos (`name`, `location`). Acciones: binding/unbinding de hardware (pone `hardware_id` a `null`), toggle de `kiosk_mode`, toggle de `binding_enabled`. Búsqueda por nombre/ubicación. **Tabla:** `kiosks`.

### 6.3. Tiendas (`/panel/tiendas`)
CRUD integral con formulario multi-sección — el **CRM** del mall:
- **Básico:** nombre, categoría, piso, local, descripción, `plan_type` (`DIAMANTE` / `ORO` / `IA_PERFORMANCE` / `PUBLI_PROMO_DIARIO` / `PUBLI_PROMO_SEMANAL`), logo.
- **CRM:** `rif`, email y teléfono de contacto.
- **Documentos:** contrato + `contract_expiry_date`, registro mercantil (bucket privado `documentos`, URLs firmadas de 60 s).
- **Addon Flash Coupon:** `flash_coupon_plan` (`FLASH_COUPON_DIARIO`/`SEMANAL`) + `flash_coupon_expiry_date` (track de plan independiente del plan base).
- **Validaciones:** logo ≤ 500 KB y ≤ 800×800 px; documentos ≤ 10 MB. **Capacidad por plan:** DIAMANTE 2, ORO 30, PUBLI_PROMO ilimitado; addon flash cap 20 por sabor.
- El usuario vinculado se muestra en solo-lectura (la gestión vive en `/panel/clientes`). Resuelve tolerantemente tres formatos históricos de `logo_url`. **Tablas:** `stores`, `categories`, `user_stores`, `users`.

### 6.4. Clientes (`/panel/clientes`)
Gestión de identidad y acceso del aliado. Campos: email (login), `full_name`, `doc_tipo` (V/E), `cedula_numero`, `cedula_url` (bucket privado `documentos`), `telefono_personal`. **Validación/saneo fuerte:** email RFC simplificado, nombres solo letras Unicode, cédula 6–15 dígitos, teléfono E.164; normalización NFC y eliminación de caracteres de control/zero-width/bidi. Restricciones de unicidad (cédula+tipo, teléfono, email). Vínculo N:M con tiendas vía RPC. Envío de **magic link** por email o WhatsApp. **Tablas:** `users` (role=`cliente`), `stores`, `user_stores`. **RPCs:** `admin_link_store_user`, `admin_unlink_store_user`. **Edge Function:** `send-magic-link` (`channel = none|email|whatsapp`).

### 6.5. Solicitudes (`/panel/solicitudes`)
**Centro de aprobaciones** con tres pestañas (pagos, campañas, cupones) y filtro por estado (pendiente/resuelto/todos). Modales de detalle con razón de rechazo opcional y vista previa de media (9:16 campañas, 4:3 cupones). **Tablas:** `plan_requests`, `transactions`, `ad_campaigns`, `coupons`, `stores`. **RPCs:** `admin_approve_plan_payment`, `admin_reject_plan_payment`, `admin_approve_campaign`, `admin_reject_campaign`, `admin_approve_coupon`, `admin_reject_coupon`. Audita cada acción.

### 6.6. Cupones y Combos (`/panel/cupons`)
Gestión de cupones flash. Solo planes `FLASH_COUPON_DIARIO`/`FLASH_COUPON_SEMANAL` (migración 018). Cap global: 20 marcas activas en galería. Límites por plan (diario: 10/día; semanal: 30/5 días). Campos: `store_id`, `campaign_id?`, `title`, `amount_available` (stock), `price_usd`, `plan_type`, `category`, fechas, `code` autogenerado (`CUPON-{PREFIJO}-{TIMESTAMP}`). Imagen ≤ 500 KB y ≤ 800×800 px (prefijo `coupons/` en bucket `publicidad`). **Tablas:** `stores`, `ad_campaigns`, `coupons`.

### 6.7. Banners (`/panel/banners`)
Banners de UI superpuestos. **Restricción: solo tiendas DIAMANTE.** Posiciones `top`/`bottom`, relación 5.625:1 (80×192 px). Imágenes ≤ 2 MB, videos ≤ 15 MB. Storage bajo `slots/` con patrón `{uiPosition}_{timestamp}.{ext}` (evita keywords de ad-blockers). Vínculo opcional a campaña y fechas. **Tablas:** `banners`, `ad_campaigns`, `stores`.

### 6.8. Campañas (`/panel/campanias`)
Gestión del **ad-loop** de los kioscos. Planes elegibles: DIAMANTE, ORO, PUBLI_PROMO_DIARIO/SEMANAL. Capacidad dura por plan (DIAMANTE 2, ORO 30, PUBLI_PROMO ilimitado). Loop objetivo de 12 slots × 15 s = 180 s (extensible a 22 × 15 s). Media JPEG/PNG/WEBP/GIF ≤ 5 MB, MP4/WEBM/MOV ≤ 50 MB (prefijo `campaigns/`, patrón `camp_{marca}_{timestamp}.{ext}`). Segunda pestaña **KioskAssignment** (`KioskAssignment.tsx`): override de campañas por kiosco — si un kiosco no tiene asignaciones, muestra todas las activas; si tiene, solo las seleccionadas. **Tablas:** `ad_campaigns`, `stores`, `kiosk_campaigns`. **RPCs:** `admin_approve_campaign`, `admin_reject_campaign`.

### 6.9. Analíticas (`/panel/analiticas`)
Dos pestañas: **Tráfico** (clicks, búsquedas, clic post-búsqueda, navegaciones, flash coupons; rankings por kiosco/tienda/sección; top 5 campañas por impresiones) y **Mapa de calor** (matriz kiosco × módulo). Filtros por periodo (día/semana/mes/todo) y por kiosco. Exportes CSV. Lee **estadísticas diarias pre-agregadas** (no eventos crudos). **Tablas/vistas:** `interaction_daily_stats`, `search_daily_stats`, `coupon_daily_stats`, `ad_impressions_daily`, `v_campaign_impressions`, `kiosks`, `stores`, `ad_campaigns`.

### 6.10. Finanzas (`/panel/finanzas`)
Cuatro pestañas: **Distribución** (reparto fijo Morna 36% / Sunmi 36% / Anavi 16% / Millennium 12%), **Ingresos** (pagos por método: Bancamiga Bs/USD, Efectivo, Binance, Otro), **Gastos** (`operational_expenses` por categoría), **Reporte** (export CSV). Cálculo en cascada: ingreso bruto − gastos = distribuible → aplica porcentajes. Presets de periodo y gráfico de ingreso por tienda. **Tablas:** `stores`, `transactions` (`type='plan_payment'`), `operational_expenses`.

### 6.11. Notificaciones (`/panel/notificaciones`)
Bandeja del admin con badges por tipo (REVISIÓN/INFO/AVISO/ERROR), filtro no leídas/todas, marcar individual o todas. `metadata.entity`/`entity_id` permiten deep-link a las pantallas de revisión. **Tabla:** `admin_notifications`. **RPCs:** `mark_admin_notification_read`, `mark_all_admin_notifications_read`.

### 6.12. Auditoría (`/panel/auditoria`)
Bitácora de acciones administrativas con filtros por email, entidad, tipo de acción y tipo de entidad; estadísticas (acciones totales, últimas 24 h, admins activos, entidad más modificada); filas expandibles con el payload; paginación y orden. **Tabla:** `admin_audit_logs`.

### 6.13. Rutas auxiliares (fuera del sidebar)
- **Categorías (`/panel/categorias`)** — CRUD de categorías (`name`, `icon` Material Icon). **Tabla:** `categories`.
- **Planes (`/panel/planes`)** — Define planes: `plan_key`, `duration_days`, `price_usd`, `applies_to` (stores/coupons/campaigns), `features`, y reglas de loop (`max_brands`, `video_seconds`, `priority_level`, `loop_eligible`, `has_fixed_banner`). **Tabla:** `plans`.
- **Servicios (`/panel/services`)** — Directorio de servicios de terceros (CANTV, etc.). Logo en bucket `services_logos`. **Tabla:** `services`.
- **Mapa (`/panel/mapa`)** — Editor en canvas multi-piso (C4–RG). Herramientas: pan, nodo (kiosco), baño, polígono, ruta, selección; atajos 1–6, Delete/Enter/Escape; zoom y pan; animación de "caminante" sobre la ruta. Fondos de piso al bucket `mapas`. **Tablas:** `stores`, `kiosks`, `map_nodes`, `map_polygons`, `map_routes`, `bathrooms`.

---

## 7. Módulos del Portal del Aliado

### 7.1. Dashboard (`/cliente/dashboard`)
Métricas de la tienda activa: plan(es) y renovación, impresiones de campañas por kiosco, uso de flash coupons (mostrados vs. canjeados), clicks del directorio (búsqueda + directos), estado de cambios de plan. Filtro temporal (7/30/90 días / todo) y modal **AbonoModal** para reportar pagos parciales. **Tablas:** `ad_campaigns`, `coupons`, `plan_requests`, `ad_impressions_daily`, `search_daily_stats`, `coupon_daily_stats`.

### 7.2. Mi Tienda (`/cliente/cuenta`)
Edita la descripción de la tienda y los datos personales (`full_name`, `telefono_personal`). Nombre, RIF, piso, local, plan y fechas de contrato son solo-lectura. **Escribe:** `users`, `stores`.

### 7.3. Planes (`/cliente/planes`)
Catálogo de planes activos (base + addon Flash Coupon en pista paralela) y **solicitud de cambio** con pago. Muestra disponibilidad de cupos replicando el algoritmo *sweep-line* de máximo solape del backend. Maneja agendado (si el plan vence antes de la activación) y conflictos de campaña activa. **Lee:** `plans`, `plan_requests`. **RPCs:** `request_plan_atomic`, `plan_capacity_intervals`.

### 7.4. Promociones (`/cliente/promociones`)
CRUD de cupones flash y campañas propias. Todo lo creado entra con `approval_status = 'pending'` (va a revisión del admin). Solo 1 campaña activa por tienda; permite encolar la siguiente. Vista previa en mockup de kiosco 9:16. Media al bucket `publicidad`. **Tablas:** `coupons`, `ad_campaigns`.

### 7.5. Pagos (`/cliente/pagos`)
Solicitudes de plan, reporte de renovaciones, reporte de **abonos** (pagos parciales contra solicitudes abiertas) e historial. Usa `PaymentFields` (método + tasa BCV) y `AbonoModal`. **Lee:** `plan_requests`, `transactions`, `plans`. **Escribe:** `transactions.insert`, RPC `report_additional_payment_atomic`.

### 7.6. Notificaciones (`/cliente/notificaciones`)
Aprobaciones/rechazos de campañas y cupones, avisos del admin; filtro no leídas/todas; muestra razón de rechazo desde `metadata.rejection_reason`. **Tabla:** `client_notifications`. **RPCs:** `mark_client_notification_read`, `mark_all_client_notifications_read`.

### 7.7. Tutorial (`/cliente/tutorial`)
Contenido estático: specs de arte (campañas 1080×1920/15 s, cupones, banners DIAMANTE) y protocolo de pago (cuentas Bancamiga, email de soporte, tasa BCV) con botones de copiar.

### 7.8. Componentes compartidos del portal
- **`abono-modal.tsx`** — reporta abonos vía `report_additional_payment_atomic`; valida monto ≤ saldo pendiente.
- **`payment-fields.tsx`** — métodos transferencia Bs / transferencia USD / efectivo USD; en Bs calcula con la tasa BCV de `app_config.bcv_exchange_rate`; valida referencia y monto.

---

## 8. Base de Datos (Supabase / PostgreSQL)

> El esquema completo (solo de contexto) está en `schem.sql`. Resumen por dominio:

### 8.1. Autenticación y aliados
- **`users`** — cuentas (espejo de `auth.users`): `id`, `email`, `full_name`, `cedula_numero`, `telefono_personal`, `role` (`admin`/`cliente`), flag `password_set`.
- **`user_stores`** — puente usuario↔tienda (acceso del aliado a sus tiendas).

### 8.2. Tiendas y categorías
- **`stores`** — comercios: identidad, `logo_url`, `node_id` (mapa), `local_number`, `floor_level`, `category_id`, `plan_type`, CRM (`rif`, contacto), documentos (`contract_url`, `mercantil_url`, `cedula_url`, `contract_expiry_date`) y addon flash (`flash_coupon_plan`, `flash_coupon_expiry_date`).
- **`categories`** — tipo de tienda (`name`, `icon`).

### 8.3. Planes, campañas y banners
- **`plans`** — tiers de servicio: `plan_key` (único), `duration_days`, `price_usd`, `applies_to[]`, `features[]`, `max_brands`, `video_seconds`, `priority_level`, `loop_eligible`, `has_fixed_banner`, `display_order`, `is_active`.
- **`ad_campaigns`** — anuncios del loop por tienda: `brand_name`, `plan_type`, `media_url/type`, `duration_seconds`, fechas, `priority_level`, `slot_limit_group`, `target_frequency_seconds`, `payment_status`, `suspended_at`, y workflow de aprobación (`approval_status`, `rejection_reason`, `reviewed_at/by`).
- **`banners`** — overlays de UI: `media_url`, `ui_position`, fechas, `campaign_id`, `store_id`.
- **`kiosk_campaigns`** — puente kiosco↔campaña (PK compuesta), para el override por kiosco.

### 8.4. Cupones
- **`coupons`** — ofertas flash: `store_id`, `image_url`, `code` (único), `amount_available`, `title`, `price_usd`, `campaign_id`, `plan_type`, fechas, `category`, `last_shown_at` (rotación round-robin) y workflow de aprobación.
- **`coupon_leads`** — captura de datos de quien reclama un cupón (`email`, documento, `email_sent_at`).

### 8.5. Kioscos y navegación (wayfinding)
- **`kiosks`** — unidades de señalización: `name`, `status`, `node_id`, `hardware_id` (único), `last_ping`, `is_emergency_active`, `floor_level`, `kiosk_mode`, `binding_enabled`.
- **`map_nodes` / `map_edges`** — grafo de navegación (coordenadas, `node_type`, soporte 3D, conectores entre pisos).
- **`map_calibration`** — matrices de transformación por piso.
- **`map_polygons` / `map_routes`** — zonas y rutas pre-calculadas (puntos en JSONB).
- **`bathrooms` / `exits`** — baños y salidas de emergencia con su `node_id`.

### 8.6. Analítica
- **`analytics_events` / `search_analytics`** — logs crudos de eventos y búsquedas.
- **`interaction_daily_stats` / `coupon_search_daily_stats` / `coupon_daily_stats` / `search_daily_stats`** — roll-ups diarios que alimentan el dashboard.
- **`ad_impressions` / `ad_impressions_daily`** — impresiones por reproducción y su agregado diario.

### 8.7. Finanzas
- **`transactions`** — pagos (`transaction_type` = `coupon`/`service`/`plan_payment`), `amount_usd/bs`, `exchange_rate`, `status`, `months_paid`, `plan_request_id`.
- **`plan_requests`** — solicitudes de plan/cambio: `plan_key`, `status` (`pending`/`partial`/`approved`/`rejected`), `effective_date`, `expires_at`, `total_amount_usd`, `paid_amount_usd`.
- **`operational_expenses`** — gastos operativos por categoría.
- **`app_config`** — clave-valor (incl. `bcv_exchange_rate`).
- **`exchange_rate_history`** — bitácora de la tasa BCV.

### 8.8. Notificaciones y auditoría
- **`admin_notifications` / `client_notifications`** — bandejas (tipo, título, mensaje, `metadata`, `unique_key`, `read_at`).
- **`admin_audit_logs`** — bitácora de acciones admin (`admin_id`, `action_type`, `entity_type`, `details`).
- **`plan_expiry_reminders_log` / `plan_whatsapp_reminders_log`** — idempotencia de recordatorios (email/WhatsApp).

### 8.9. Otros
- **`services`** — servicios de terceros del directorio.
- **`parking_tickets` / `pap_payment_orders`** — tickets de parqueo y órdenes del gateway (consumidos por la app de kiosco).

---

## 9. Lógica de Negocio en PostgreSQL (RPCs)

> Las migraciones `migrations/001–029` y `supabase/migrations/` definen funciones `SECURITY DEFINER` que concentran la lógica crítica. Las principales:

**Ciclo de vida de planes**
- `request_plan_atomic(...)` — el aliado solicita/cambia plan con datos de pago; valida capacidad (sweep-line de máximo solape), impide solapes durante la ventana pagada y bloquea si ya hay un cambio pendiente/aprobado.
- `admin_approve_plan_request(request_id)` — re-valida capacidad, actualiza `plan_type` + `contract_expiry_date` (o agenda), inserta transacción completada. Bifurca para el addon flash (`is_flash_coupon_plan`).
- `admin_reject_plan_request(request_id, reason)`.
- `admin_approve_plan_payment` / `admin_reject_plan_payment` — aprueba/rechaza renovaciones (extiende contrato según `months_paid`).
- `activate_scheduled_plans()` — **cron diario**: aplica solicitudes aprobadas cuyo `effective_date` llegó, re-chequeando capacidad.
- `plan_max_overlap_in_window(...)` / `plan_capacity_intervals(...)` — helpers de capacidad (sweep-line) usados por panel y portal.

**Aprobación de campañas/cupones (migración 021)**
- `admin_approve_campaign` / `admin_reject_campaign` / `admin_approve_coupon` / `admin_reject_coupon`.
- **Triggers** sobre inserciones/updates del aliado: fuerzan `approval_status = 'pending'` + inactivo, y re-disparan revisión si cambia el contenido.

**Cupones flash**
- `get_flash_coupons_rotated(p_commit)` — selección round-robin (orden por `last_shown_at` NULLS FIRST); con `p_commit=true` avanza la rotación. Lo consume el kiosco al mostrar.
- `deactivate_expired_flash_coupons()` — desactiva cupones sin addon vigente, vencidos o sin stock.

**Notificaciones / auth helpers**
- `mark_admin_notification_read` / `mark_all_admin_notifications_read` / `mark_client_notification_read` / `mark_all_client_notifications_read`.
- `admin_link_store_user` / `admin_unlink_store_user`.
- `report_additional_payment_atomic(...)` — registra abonos contra una solicitud, incrementando `paid_amount_usd`.
- `is_admin()`, `user_owns_store(store_id)`, `is_flash_coupon_plan(plan_key)`, `plan_applies_to(plan_key, feature)`.

---

## 10. Edge Functions (Supabase / Deno)

`supabase/config.toml` fija `verify_jwt` por función. Las invocadas por cron usan `verify_jwt=false` + cabecera `x-cron-secret`; `send-magic-link` usa `verify_jwt=true` (la llama el panel con JWT y valida rol admin internamente).

| Función | Disparo | Hace | Servicios externos |
|---|---|---|---|
| `send-magic-link` | HTTP (panel admin) | Crea el `auth.user` si no existe, persiste perfil, y envía magic link por email (OTP) o WhatsApp (envuelto en `/abrir` para no quemar el token). | Supabase Auth, SuperAPI (WhatsApp) |
| `update-rate` | Cron diario | Obtiene la tasa BCV de varias fuentes con fallback (dolarapi, pydolarvenezuela, scraping BCV, proxies CORS), valida y hace upsert en `app_config` + `exchange_rate_history`. | BCV, dolarapi, pydolarvenezuela, proxies |
| `deactivate-expired-coupons` | Cron diario | Llama a `deactivate_expired_flash_coupons()`. | — |
| `kill-switch` | Cron / manual | Apaga campañas vencidas (`is_active=false`) y limpia `plan_type` de tiendas con contrato vencido. | — |
| `send-contract-expiry-reminders` | Cron diario | `enqueue_contract_expiry_reminders()` → email T-5/-3/-1/-0 vía Resend; registra idempotencia. | Resend (email) |
| `send-whatsapp-expiry-reminders` | Cron diario | Igual pero por WhatsApp (formato E.164 SuperAPI), 30 min después del email. | SuperAPI (WhatsApp) |

`supabase/templates/magic-link.html` es la plantilla de correo del magic link ("Activa tu cuenta · Millennium Mall", expira en 1 h, un solo uso).

---

## 11. Cron Jobs (pg_cron)

Programados con `pg_cron` + `pg_net.http_post` hacia las Edge Functions. Horarios en UTC (Venezuela = UTC-4):

| Job | UTC | VET | Acción |
|---|---|---|---|
| `update-bcv-rate` | 01:04 | 00:01 | Actualiza tasa BCV (`update-rate`). |
| `activate-scheduled-plans-daily` | 04:05 | 00:05 | `activate_scheduled_plans()`. |
| `deactivate-expired-coupons` | 05:04 | 00:05 | Desactiva cupones flash vencidos. |
| `send-contract-expiry-reminders` | 13:00 | 09:00 | Recordatorios por email (Resend). |
| `send-whatsapp-expiry-reminders` | 13:30 | 09:30 | Recordatorios por WhatsApp (SuperAPI). |

---

## 12. Storage (Supabase)

| Bucket | Visibilidad | Contenido | Patrón |
|---|---|---|---|
| `publicidad` | Público | Logos de tienda, campañas, banners, cupones. | `campaigns/camp_{marca}_{ts}.{ext}`, `coupons/...`, `slots/{pos}_{ts}.{ext}` (evita keywords de ad-blockers). |
| `documentos` | Privado | Contratos, registro mercantil, cédulas. | URLs firmadas de 60 s. |
| `mapas` | — | Fondos de piso del editor de mapas. | `plano_c4.png`, `plano_rg.png`, … |
| `services_logos` | Público | Logos de servicios de terceros. | URL pública. |

Helpers de borrado de `publicidad` en `lib/storage.ts` (borran el archivo silenciando errores; la fila en DB es la fuente de verdad).

---

## 13. Sistema de Temas

Tailwind v4 con `@theme inline` y variables CSS por tema (claro/oscuro) en `globals.css` + `theme.css`. El tema se fija **antes de hidratar** vía `ThemeScript` (lee `localStorage.millennium.theme`, con fallback a `prefers-color-scheme`) para evitar parpadeo (FOUC); `ThemeToggle` lo conmuta y persiste. Utilidades de marca: gradientes `.brand-admin`/`.brand-cliente`/`.brand-mix`, vidrio esmerilado `.surface-glass`, halos `.halo-admin`/`.halo-cliente`, esquinas HUD `.hud-corners-4`, y animaciones (`orb-float`, `shimmer`, `pulse-glow`). La marca **Mall Hub** se compone en `MallHubMark.tsx`.

---

## 14. Patrones Recurrentes y Convenciones

- **Client Components para pantallas, Supabase directo + RLS.** La seguridad real es server-side (RLS/RPC); el cliente nunca es la barrera de confianza.
- **Modal CRUD + `Pagination`** reutilizados en todas las listas.
- **Frescura por polling 30 s + foco**, no Realtime pesado.
- **Operaciones sensibles vía RPC atómica** (aprobaciones, capacidad, abonos, vínculos).
- **Auditoría** (`logAdminAction`) en tiendas, campañas, cupones, solicitudes, clientes, etc.
- **Workflow de aprobación** para todo lo creado por el aliado: `pending → approved/rejected` con notificación al cliente.
- **Saneo/validación estricta de inputs** (email, cédula, teléfono E.164, tamaños y dimensiones de archivo, Unicode sin caracteres de control).
- **UI responsive dual** (tabla en desktop, tarjetas en móvil) y tema oscuro por defecto.
- **Texto en español**; rutas y código en español/inglés mezclados según dominio.

---

## 15. Análisis Estático y Notas de Mantenimiento

- **ESLint:** `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript` (`eslint.config.mjs`). `npm run lint`.
- **TypeScript:** `strict: true`, `noEmit`, `moduleResolution: bundler`, alias `@/*`. La carpeta `supabase/` se excluye del `tsconfig` (corre en Deno).
- **No hay suite de tests automatizados** en el repo; la validación crítica se concentra en las RPCs de PostgreSQL.
- **⚠️ Next.js 16:** breaking changes respecto a versiones anteriores. Antes de tocar APIs/convenciones, leer `node_modules/next/dist/docs/` (ver `AGENTS.md`).
- **`ROADMAP.md`** documenta el módulo de Cobranzas y Portal del Aliado y el estado de cada feature.
