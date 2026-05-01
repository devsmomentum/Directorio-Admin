# Millennium Admin Panel

Panel administrativo construido con **Next.js 16 (App Router)** + **Supabase** para gestionar el ecosistema de kioscos interactivos del centro comercial Millennium: kioscos, tiendas, categorías, banners publicitarios, cupones, servicios, mapas de pisos y analíticas.

> **Importante:** Este proyecto usa Next.js 16 con cambios disruptivos respecto a versiones anteriores. Antes de modificar APIs, convenciones o estructura de archivos, revisa la documentación local en `node_modules/next/dist/docs/`.

---

## Tabla de contenidos

1. [Stack](#stack)
2. [Setup y variables de entorno](#setup-y-variables-de-entorno)
3. [Estructura del proyecto](#estructura-del-proyecto)
4. [Cliente Supabase (lib/)](#cliente-supabase-lib)
5. [Autenticación](#autenticación)
6. [Layout y navegación del Dashboard](#layout-y-navegación-del-dashboard)
7. [Componentes compartidos](#componentes-compartidos)
8. [Módulos del Dashboard](#módulos-del-dashboard)
9. [Tablas de base de datos](#tablas-de-base-de-datos)
10. [Buckets de Storage](#buckets-de-storage)
11. [Patrones recurrentes](#patrones-recurrentes)
12. [Cómo agregar un nuevo módulo](#cómo-agregar-un-nuevo-módulo)

---

## Stack

| Pieza | Versión / Notas |
|-------|-----------------|
| Next.js | 16.2.0 (App Router, Server + Client Components) |
| React | 19.2.4 |
| TypeScript | 5.x |
| Estilos | Tailwind CSS 4 + PostCSS |
| Backend | Supabase (PostgreSQL + Auth + Storage) |
| SDK | `@supabase/supabase-js` ^2.99.2 |
| Fuentes | Geist Sans / Geist Mono (`next/font`) |

Scripts:

```bash
npm run dev     # Servidor de desarrollo (localhost:3000)
npm run build   # Compilación de producción
npm start       # Servidor de producción
npm run lint    # ESLint
```

---

## Setup y variables de entorno

Crear `.env.local` en la raíz:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<proyecto>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
NEXT_PUBLIC_DEBUG=true   # opcional, habilita registro de usuarios desde /login
```

Estas son las **únicas** variables que el proyecto consume. La autenticación, queries y subida de archivos se hacen contra ese proyecto Supabase usando la anon key.

---

## Estructura del proyecto

```
milenium-admin/
├── app/
│   ├── layout.tsx                    # Layout raíz (fuentes, metadatos)
│   ├── page.tsx                      # Landing → redirige a /dashboard si hay sesión
│   ├── globals.css                   # Estilos Tailwind globales
│   ├── login/page.tsx                # Login + registro (modo debug)
│   ├── components/
│   │   └── Pagination.tsx            # Hook + componente de paginación reutilizable
│   └── dashboard/
│       ├── layout.tsx                # Sidebar + guard de sesión
│       ├── page.tsx                  # Monitoreo de kioscos en tiempo casi-real
│       ├── kioscos/page.tsx          # CRUD de kioscos
│       ├── tiendas/page.tsx          # CRUD de tiendas
│       ├── categorias/page.tsx       # CRUD de categorías
│       ├── banners/page.tsx          # CRUD de campañas publicitarias
│       ├── cupons/page.tsx           # CRUD de cupones
│       ├── services/page.tsx         # CRUD de servicios
│       ├── analiticas/page.tsx       # Reportes (tráfico + finanzas)
│       └── mapa/page.tsx             # Editor vectorial del mapa
├── lib/
│   └── supabase.ts                   # Cliente Supabase (singleton)
├── public/                           # Assets estáticos
├── package.json
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs
└── eslint.config.mjs
```

---

## Cliente Supabase (`lib/`)

`lib/supabase.ts` exporta una sola instancia del cliente que **toda** la app importa:

```ts
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
```

Se usa para tres cosas:

- **Auth:** `supabase.auth.signInWithPassword`, `signUp`, `signOut`, `getSession`.
- **Base de datos:** `supabase.from('<tabla>').select/insert/update/delete()`.
- **Storage:** `supabase.storage.from('<bucket>').upload/getPublicUrl()`.

No hay capa intermedia (no repositorios ni servicios). Cada página llama a Supabase directamente. Si vas a refactorizar, este es el punto único donde se construye el cliente.

---

## Autenticación

Flujo simple basado en sesión de Supabase:

| Ruta | Archivo | Comportamiento |
|------|---------|----------------|
| `/` | `app/page.tsx` | Verifica sesión con `getSession()`. Si existe → `router.push('/dashboard')`. Si no → muestra landing con botón a `/login`. |
| `/login` | `app/login/page.tsx` | Login con email/password (`signInWithPassword`). Si `NEXT_PUBLIC_DEBUG=true`, también permite `signUp` (mínimo 6 caracteres). |
| `/dashboard/*` | `app/dashboard/layout.tsx` | Al montar verifica sesión. Sin sesión → `router.replace('/login')`. Con sesión → renderiza sidebar + contenido. |

No hay middleware (`middleware.ts`); la protección es **client-side** dentro del layout. Esto significa que el HTML inicial se sirve y el guard corre tras hidratar — adecuado para una herramienta interna, pero no para datos altamente sensibles.

Logout: botón al pie del sidebar → `supabase.auth.signOut()` → `/login`.

---

## Layout y navegación del Dashboard

`app/dashboard/layout.tsx` define:

- **Sidebar fija (`w-64`)** con header de marca, 9 enlaces de navegación, y botón de cerrar sesión.
- **Área principal** (`flex-1 overflow-y-auto p-8`) donde se renderiza la página activa.
- **Estado activo** con gradiente rosa cuando `pathname === href`.

Items del menú (en orden):

1. Monitoreo Kioscos — `/dashboard`
2. Directorio Kioscos — `/dashboard/kioscos`
3. Directorio Tiendas — `/dashboard/tiendas`
4. Directorio Categorias — `/dashboard/categorias`
5. Cupones y Combos — `/dashboard/cupons`
6. Planes — `/dashboard/planes` *(nuevo)*
7. Banners — `/dashboard/banners` *(imágenes estáticas decorativas)*
8. Campañas Publicitarias — `/dashboard/campanias` *(videos/imágenes de anunciantes)*
9. Analiticas — `/dashboard/analiticas`
10. Mapas — `/dashboard/mapa`
11. Directorio Servicios — `/dashboard/services`

Para añadir un módulo: crear la página y agregar el item al array de navegación del layout.

---

## Componentes compartidos

### `app/components/Pagination.tsx`

Dos exports:

- **Hook `usePagination<T>(items)`** — mantiene `page` y `perPage`, persiste `perPage` en `localStorage` bajo la clave `millennium_per_page`. Devuelve `{ page, setPage, perPage, changePerPage, totalPages, paginated, total }`. Opciones: `[5, 10, 20, 50]`.
- **Componente `<Pagination />`** — barra inferior con conteo total, selector de filas/página y botones anterior/siguiente + selector de página.

Lo usan **todas** las páginas con tablas (kioscos, tiendas, categorías, banners, cupones, services). Si modificas paginación global, edítalo aquí.

---

## Módulos del Dashboard

Cada módulo es un **client component** (`"use client"`) que sigue el mismo molde: estado local con `useState`, `useEffect` para hacer fetch al montar, modal para crear/editar, tabla con búsqueda y paginación, llamadas directas a Supabase para CRUD.

### 1. Monitoreo Kioscos — `/dashboard`

**Archivo:** `app/dashboard/page.tsx`
**Tablas:** `kiosks` (lectura), `stores` y `ad_campaigns` (solo conteo).

- **Lectura:** `select('*').order('created_at', desc)` sobre `kiosks` + `count` sobre `stores` y `ad_campaigns`.
- **Sin escritura.** Es solo dashboard.
- KPIs: kioscos online/offline, alertas de papel (`paper_level !== 'ok'`), última conexión (`last_ping`).
- Botón de refrescar manual.

### 2. Directorio Kioscos — `/dashboard/kioscos`

**Archivo:** `app/dashboard/kioscos/page.tsx`
**Tabla:** `kiosks`

| Operación | Cómo |
|-----------|------|
| Crear | `insert({ name, location, status: 'offline' })` |
| Leer | `select('*').order('created_at', desc)` + filtro por nombre/ubicación + paginación |
| Editar | `update({ name, location }).eq('id', editingId)` |
| Eliminar | `delete().eq('id', id)` con confirmación |
| Desvincular hardware | `update({ hardware_id: null, status: 'offline' }).eq('id', id)` |

Columnas relevantes en `kiosks`: `id, name, location, status, hardware_id, paper_level, last_ping, mac_address, created_at`.

### 3. Directorio Tiendas — `/dashboard/tiendas`

**Archivo:** `app/dashboard/tiendas/page.tsx`
**Tablas:** `stores` (CRUD), `categories` (lectura para el dropdown).
**Storage:** bucket `publicidad`, ruta `logos/{archivo}`.

- CRUD completo. Logo opcional al editar (si se sube uno nuevo, reemplaza la URL).
- Validación cliente: imagen ≤ 500KB, recomendado 400×400, formatos PNG/JPEG, dimensión máxima 800×800.
- Búsqueda por nombre/piso/categoría. Pisos: `C4, C3, C2, C1, RG`.
- Subida: `storage.from('publicidad').upload('logos/...', file)` → guardar `getPublicUrl()` en `stores.logo_url`.

### 4. Directorio Categorías — `/dashboard/categorias`

**Archivo:** `app/dashboard/categorias/page.tsx`
**Tabla:** `categories` (`id, name, icon`).

- CRUD simple: `name` + `icon` (nombre de ícono Material Symbols, p. ej. `shopping_bag`).
- Vista previa del ícono en el formulario.
- Eliminar puede dejar tiendas huérfanas (no hay cascada definida en el cliente).

### 5. Banners — `/dashboard/banners`

**Archivo:** `app/dashboard/banners/page.tsx`
**Tabla:** `banners`
**Storage:** bucket `publicidad`, ruta `banners/{titulo_timestamp.ext}`.

> ⚠️ **Diferencia con campañas:** Los banners son imágenes **estáticas decorativas** (fondos de pantalla, imágenes del mall, imágenes de bienvenida). No tienen plan de frecuencia ni son de anunciantes.

- CRUD completo + toggle `is_active` + control de `sort_order`.
- Campos: `title, image_url, screen, sort_order, is_active`.
- `screen`: `principal | directorio | servicios | mapa` — indica en qué pantalla del kiosco aparece.
- Máx 2MB. Formatos: PNG/JPEG/WebP/GIF.

### 5b. Campañas Publicitarias — `/dashboard/campanias`

**Archivo:** `app/dashboard/campanias/page.tsx`
**Tabla:** `ad_campaigns`
**Storage:** bucket `publicidad`, ruta `campaigns/{nombre_banner.ext}`.

> ⚠️ **Diferencia con banners:** Las campañas son videos/imágenes de **anunciantes externos** que pagan un plan para aparecer en rotación en los kioscos.

- CRUD + toggle `is_active` (pausar/activar).
- Tipos de plan: `DIAMANTE`, `ORO`, `SOCIOS`, `BONO_FLASH` (cada uno con su badge).
- Soporta imagen y video. `media_type` se infiere del archivo subido.
- `duration_seconds`: tiempo que se muestra por aparición. `start_date` requerido, `end_date` opcional.
- Al **borrar** una campaña, también se elimina el archivo de Storage.
- Subida con `upsert: true` para permitir reemplazar el media de una campaña existente.

### 6. Gestión de Cupones — `/dashboard/cupons`

**Archivo:** `app/dashboard/cupons/page.tsx`
**Tablas:** `coupons` (CRUD), `stores` (lectura para autocompletar).
**Storage:** bucket `coupons`, ruta `coupon_images/{timestamp}.ext`.

- CRUD completo. Selector de tienda con buscador (autocomplete).
- Genera código auto: `CUPON-{ABREV_TIENDA}-{TIMESTAMP}`.
- Campos: `title, store_id, price_usd, amount_available, image_url`.
- Indicador visual de stock: verde, ámbar (<5), rojo (=0).

### 7. Directorio Servicios — `/dashboard/services`

**Archivo:** `app/dashboard/services/page.tsx`
**Tabla:** `services`
**Storage:** bucket `services_logos`, ruta `logos/{timestamp}.ext`.

- CRUD + toggle `is_active`.
- Campos: `title, provider, description, image_url, is_active`.
- Pensado para servicios externos (CANTV, ABA, recargas, pagos, etc.).

### 8. Analíticas — `/dashboard/analiticas`

**Archivo:** `app/dashboard/analiticas/page.tsx`
**Tablas:** `analytics_events`, `transactions`, `kiosks`.

- **Solo lectura.** Procesa los datos en cliente.
- Pestaña **Tráfico:** total de interacciones, hoy, kioscos online (cálculo: `last_ping` < 5 min), tienda más buscada, top 5 tiendas/categorías/kioscos.
- Pestaña **Finanzas:** ingresos brutos USD (suma de `transactions.amount_usd` con `status='completed'`), número de ventas, ticket promedio, top 5 ítems por revenue.
- **Exporta CSV** de tráfico o ventas con nombre `Trafico_YYYY-MM-DD.csv` / `Ventas_YYYY-MM-DD.csv`.
- Parsea `analytics_events.event_data` (puede venir como string JSON) y distingue tienda vs categoría por el prefijo `Categoría:`.

### 9. Mapas — `/dashboard/mapa`

**Archivo:** `app/dashboard/mapa/page.tsx`

Editor vectorial de plano por piso (C4/C3/C2/C1/RG). Es el módulo más grande y complejo del proyecto.

- **Lectura:** `stores` y `kiosks` para vincular polígonos y rutas.
- **Persistencia:** datos del mapa (nodos, polígonos, rutas) en tablas de mapa (`map_nodes`, `map_polygons`, `map_routes` o equivalentes); imagen de fondo del piso en Storage.
- Herramientas: pan, colocar nodos (kiosco/tienda/waypoint), dibujar polígonos vinculados a tienda, trazar rutas entre nodos, seleccionar/editar.
- Canvas con zoom y pan; animación de "walker" recorriendo rutas (testing visual).
- Si vas a tocarlo, **lee el archivo entero** antes — la lógica de canvas, refs de animación y estado están entrelazados.

---

## Tablas de base de datos

Inferidas a partir de las queries en el código. Verifica la fuente de verdad en el panel de Supabase antes de migrar.

| Tabla | Campos clave | Usada por |
|-------|--------------|-----------|
| `kiosks` | `id, name, location, status, hardware_id, paper_level, last_ping, mac_address, created_at` | dashboard, kioscos, mapa, analíticas |
| `stores` | `id, name, category_id, category, floor, local_number, description, logo_url, plan_key, plan_expires_at, created_at` | tiendas, cupones, mapa, analíticas |
| `categories` | `id, name, icon` | categorías, tiendas |
| `plans` | `id, name, plan_key, description, duration_days, price_usd, applies_to, features, is_active, display_order, created_at` | planes, tiendas, cupones |
| `ad_campaigns` | `id, brand_name, plan_type, media_url, media_type, duration_seconds, start_date, end_date, is_active, created_at` | campañas |
| `banners` | `id, title, image_url, screen, sort_order, is_active, created_at` | banners |
| `coupons` | `id, title, code, store_id, image_url, price_usd, amount_available, plan_key, validity_days, created_at` | cupones |
| `services` | `id, title, provider, description, image_url, is_active, created_at` | services |
| `analytics_events` | `id, event_type, module, event_data, item_name, kiosk_id, created_at` | analíticas |
| `transactions` | `id, transaction_type, item_name, amount_usd, amount_bs, exchange_rate, payment_method, user_email, status, kiosk_id, created_at` | analíticas |
| `map_nodes` / `map_polygons` / `map_routes` | datos vectoriales por piso | mapa |

---

## Buckets de Storage

| Bucket | Ruta | Quién sube |
|--------|------|-----------|
| `publicidad` | `logos/{archivo}` | Tiendas (logos) |
| `publicidad` | `campaigns/{brand}_banner.ext` | Banners (media de campaña) |
| `coupons` | `coupon_images/{timestamp}.ext` | Cupones |
| `services_logos` | `logos/{timestamp}.ext` | Servicios |
| (mapa) | imágenes de fondo por piso | Mapa |

Todos los archivos usan `getPublicUrl()` para obtener la URL final que se guarda en la tabla.

---

## Patrones recurrentes

Todas las páginas siguen estos moldes. Consérvalos al añadir módulos nuevos.

### Fetch al montar

```ts
const [items, setItems] = useState<Item[]>([]);
const [loading, setLoading] = useState(true);

const fetchItems = async () => {
  const { data, error } = await supabase
    .from('tabla')
    .select('*')
    .order('created_at', { ascending: false });
  if (data) setItems(data);
  setLoading(false);
};

useEffect(() => { fetchItems(); }, []);
```

### Modal de crear/editar

```ts
const [showForm, setShowForm] = useState(false);
const [editingId, setEditingId] = useState<string | null>(null);

const resetForm = () => { setEditingId(null); /* limpiar campos */; setShowForm(false); };

const handleEdit = (item) => { setEditingId(item.id); /* poblar campos */; setShowForm(true); };

const handleSubmit = async () => {
  if (editingId) {
    await supabase.from('tabla').update(payload).eq('id', editingId);
  } else {
    await supabase.from('tabla').insert([payload]);
  }
  resetForm();
  await fetchItems();
};
```

### Búsqueda + paginación

```ts
const [search, setSearch] = useState('');
const filtered = items.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()));
const pg = usePagination(filtered);
// renderizar pg.paginated en la tabla y <Pagination /> abajo
```

### Subida de archivo

```ts
const ext = file.name.split('.').pop();
const path = `carpeta/${nombre}.${ext}`;
await supabase.storage.from('bucket').upload(path, file, { upsert: true });
const { data: { publicUrl } } = supabase.storage.from('bucket').getPublicUrl(path);
// guardar publicUrl en la tabla
```

### Confirmación destructiva

`confirm()` nativo del navegador antes de `delete()`. Sencillo y suficiente para la herramienta interna.

---

## Cómo agregar un nuevo módulo

1. **Crear página:** `app/dashboard/<modulo>/page.tsx` con `"use client"`.
2. **Importar el cliente:** `import { supabase } from '@/lib/supabase'`.
3. **Replicar el patrón** de fetch + modal + tabla + `usePagination`.
4. **Registrar en el sidebar:** añadir un objeto `{ name, href, icon }` al array de navegación en `app/dashboard/layout.tsx`.
5. **Storage (si aplica):** crear el bucket en Supabase Dashboard antes de hacer upload desde la app.
6. **Estilo:** seguir la paleta dark (`bg-[#050505]` fondo, `bg-[#111]` cards, acentos rosa/cyan/morado, bordes `white/5`–`white/10`).

---

## Notas y limitaciones conocidas

- La protección de `/dashboard/*` es client-side. Para datos sensibles, considera añadir un `middleware.ts` que valide la cookie de Supabase.
- No hay roles ni RBAC — todo usuario autenticado tiene acceso total.
- No hay suscripciones realtime; los datos se refrescan manualmente o al montar la página.
- UI solo en español.
- El modo debug del registro (`NEXT_PUBLIC_DEBUG=true`) **no debe** quedar activo en producción.
