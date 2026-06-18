# Auditoría de UI/UX — Dashboard Milenium

> Informe de brechas de usabilidad, redundancias y código muerto en todo el
> dashboard (panel admin `app/panel/*` y portal cliente `app/cliente/*`).
> Hoja de ruta incremental para mejorar la UI/UX. Marca cada casilla al cerrar
> el ítem.
>
> **Estado:** `[ ]` pendiente · `[x]` hecho · `[~]` en progreso
> **Prioridad:** 🔴 Alta · 🟡 Media · 🟢 Baja
>
> Última auditoría: 2026-06-18 (6 agentes en paralelo + verificación manual).
> Los hallazgos marcados _(confirmar)_ son plausibles pero no verificados línea
> a línea; revísalos antes de tocar código.

---

## 🔴 Alta prioridad — confunde al usuario o duplica flujos críticos

### Admin

- [ ] 🔴 **Doble flujo de aprobación (campañas/banners/cupones).** Cada entidad
  vive en dos sitios: lo que crea el admin en `/campanias`, `/banners`, `/cupons`
  se publica al instante; lo que envían las tiendas espera en `/solicitudes`. No
  hay vista única ni indicación de cuántas hay pendientes. → Unificar por entidad
  con filtro de estado (Pendiente/Activa/Pausada/Rechazada) y aprobar/rechazar en
  línea, o al menos un badge "N pendientes" que enlace a `/solicitudes`.
  Archivos: `app/panel/{campanias,banners,cupons,solicitudes}/page.tsx`.

- [ ] 🔴 **Posición de banner asignada en dos lugares y sobrescrita en silencio.**
  `banners` deja elegir posición al crear, pero el RPC de aprobación en
  `solicitudes` la reasigna sin avisar. Además `banners` arranca con
  `uiPosition='home_hero'` cuando `UI_POSITIONS` solo es `['top','bottom']`. →
  Slot/posición autoritativo en un solo lugar (recomendado: al aprobar),
  de solo-lectura en el otro; corregir el default.
  Archivos: `app/panel/banners/page.tsx` (~13, ~90, ~192), `app/panel/solicitudes/page.tsx` (~277-279).

- [ ] 🔴 **No hay componentes compartidos Confirm/Toast/Modal/Spinner/EmptyState.**
  Confirmaciones ~100% `confirm()` nativo y errores con `alert()` (~30 llamadas
  en 16 páginas; `campanias` encadena doble `confirm()` al pausar). El spinner de
  carga está reimplementado ~19 veces con colores distintos por página. Mayoría de
  guardados sin feedback de éxito. → Crear `ConfirmDialog`, `useToast()`,
  `<PageSpinner/>`, `Modal`, `EmptyState` y migrar. Empezar por toast + confirm + spinner.

### Cliente

- [ ] 🔴 **Pagos/abonos gestionables desde 3 páginas.** `AbonoModal` embebido en
  `pagos` (~666), `planes` (~441) y `dashboard` (~1046); el mismo abono se reporta
  desde tres sitios. → `pagos` como único hub; en dashboard/planes una tira de
  estado que enlace a `/cliente/pagos`.

- [ ] 🔴 **Dos backends de renovación divergentes.** "Renovar plan" (`planes`) usa
  RPC `request_plan_atomic` (valida slots/solape); el alta de pago en `pagos` hace
  `transactions.insert` crudo, saltándose esa validación. → Encaminar toda
  renovación por `request_plan_atomic`.
  Archivos: `app/cliente/planes/page.tsx` (~269), `app/cliente/pagos/page.tsx` (~216).

- [ ] 🔴 **El tutorial contradice la app.** `tutorial` indica pagar por email a
  `anavidirectorios@gmail.com` y hardcodea cuentas bancarias (RIF/Bs/USD) que
  duplican `payment-fields.tsx`, mientras existe el flujo interno con tasa BCV. →
  Un solo canal; el tutorial debe apuntar a `/cliente/pagos` y leer los datos
  bancarios de la misma fuente que `payment-fields`.
  Archivos: `app/cliente/tutorial/page.tsx` (~112-163).

- [ ] 🔴 **El dashboard del cliente duplica Planes/Pagos.** El vencimiento del
  contrato aparece ~4 veces en una pantalla (alerta ~512, tarjeta "Plan vigente"
  ~641, tile "Estado contrato" ~843, y alerta similar en `pagos` ~336). → Colapsar
  a un indicador + una tira de estado.
  Archivos: `app/cliente/dashboard/page.tsx`.

---

## 🟡 Media prioridad

### Código duplicado a centralizar (`lib/`)

- [x] 🟡 **`PLAN_LABELS` / `PLAN_COLORS` definidos ~10 veces** con valores y
  estructura divergentes. → Hecho: `lib/plans.ts` es la fuente única (`planLabel`,
  `PLAN_BADGE`, `PLAN_BADGE_BORDERED`, `PLAN_COLOR_PARTS`, `PLAN_GRADIENT`,
  `isFlashPlan`, `FLASH_COUPON_PLANS`). Migrados: `panel/{solicitudes,campanias,
  cupons,tiendas,planes}` y `cliente/{dashboard,pagos,planes,promociones}`.
  Labels unificados a "Cupones Flash"; `promociones` pasó de `text-300` a `text-400`
  (unifica el sombreado que estaba inconsistente). _Pendiente:_ `campanias/
  KioskAssignment.tsx` quedó local a propósito — usa claves legacy `SOCIOS`/
  `BONO_FLASH` que no existen en el modelo actual; revisar si son código muerto.

- [~] 🟡 **Formato de fecha y moneda reinventado en ~13 archivos** con locales
  inconsistentes. → Módulo creado: `lib/format.ts` (`formatDate`, `formatDateTime`,
  `formatUSD`, `formatBs`, locale `es-VE`). _Falta migrar los call-sites_ (riesgo
  de cambios sutiles de formato; hacerlo archivo por archivo y revisar visualmente).

- [x] 🟡 **Helpers de documentos privados** (`uploadPrivateDoc`/`openPrivateDoc`/
  `downloadPrivateDoc`/`fileExt`) copiados verbatim en `clientes` y `tiendas`. →
  Hecho: movidos a `lib/storage.ts`; ambos archivos importan de ahí.

- [~] 🟡 **Subida a bucket reimplementada inline en ~9 sitios.** → `lib/storage.ts`
  ahora expone `uploadPublicidad()`; migrado el logo de `tiendas`. _Falta migrar_
  banners, campanias, cupons y promociones×3 (más `services_logos` y `mapas`, que
  usan otros buckets).

- [x] 🟡 **Helpers CSV duplicados e inconsistentes.** → Hecho: `lib/csv.ts`
  (`csvCell`/`downloadCSV`/`slugify`, con BOM + escape + revoke). Migrados
  `cliente/dashboard`, `panel/tiendas`, y los `exportCSV` de `analiticas`/`finanzas`
  (ahora delegan al helper único).

- [x] 🟡 **CSV de `finanzas` sin escape robusto.** → Hecho: quitadas las comillas
  manuales; el escape lo hace `csvCell()` del helper centralizado.

### UX inconsistente

- [ ] 🟡 **Patrón ver-vs-editar inconsistente.** `tiendas`/`clientes` tienen modal
  de detalle de solo-lectura; `categorias`/`services`/`kioscos`/`planes`/`banners`/
  `cupons` saltan directo al form. → Estandarizar: clic → detalle → "Editar".

- [ ] 🟡 **Búsqueda/paginación dispares.** `clientes` (1263 líneas) renderiza la
  lista completa sin paginación; `aliados` solo busca dentro del modal de alta.
  (`tiendas` sí pagina bien con `pg.paginated` — no tocar.) → Añadir paginación a
  `clientes` y búsqueda a `aliados`.

- [ ] 🟡 **`alert()` mezclado con el sistema de banners propio** en `promociones`
  (usa `confirm()`/`alert()` nativos aun teniendo `confirmDialog` custom) y en el
  CSV del dashboard cliente. → Unificar al toast/confirm compartido.

- [ ] 🟡 **Estados de error tragados en cliente** (`dashboard`, `pagos`, `planes`,
  `equipo`, `notificaciones`): errores sin feedback y sin refetch tras la acción →
  carga fallida se ve como "vacío" y el estado queda desincronizado.

- [ ] 🟡 **Badge de no-leídas con lag de ~30s.** El layout (admin y cliente) sondea
  cada 30s; la página de notificaciones marca como leído solo en estado local, así
  que el badge tarda hasta 30s en bajar. → Subir el contador a contexto y
  decrementarlo al marcar.
  Archivos: `app/cliente/layout.tsx` (~138-159), `app/cliente/notificaciones/page.tsx`.

- [ ] 🟡 **Filtro de rango del dashboard cliente** solo gobierna parte de las
  tarjetas (campaigns/impressions/searches/coupons); `requests` y `redeemed` se
  cargan sin rango. → Aplicar el rango a todo o aclarar visualmente qué cubre.
  Archivo: `app/cliente/dashboard/page.tsx`.

- [ ] 🟡 **Cobertura de auditoría incompleta.** De 15 `AuditEntityType` declarados,
  6 nunca se registran: `kiosco`, `categoría`, `plan`, `servicio`,
  `gasto_operativo`, `solicitud`. → Añadir `logAdminAction` en esas mutaciones o
  quitar los tipos no usados. (Verificado: 9/15 sí se registran.)

- [ ] 🟡 **Errores silenciados en admin.** `mapa` ignora fallos de tablas
  inexistentes con `catch {}` (~270); `inicio` usa `any[]` en varios estados
  (~8-12) y `auditoria` (~8). → Mostrar estado de error y tipar.

---

## 🟢 Baja prioridad — limpieza / código muerto

- [ ] 🟢 **Páginas huérfanas sin nav:** `/panel/categorias`, `/panel/services`,
  `/panel/mapa` (funcionales, 0 enlaces en el sidebar de `layout.tsx`). →
  Re-enlazar o eliminar.
- [x] 🟢 **`clientes`:** función `sendLink` comentada (~36 líneas) y bloque de email
  comentado → borrados.
- [x] 🟢 **`analiticas`:** estado `impressionTotals` + query `v_campaign_impressions`
  + tipo `CampaignImpressionTotals` escritos pero nunca leídos → borrados.
- [x] 🟢 **`mapa`:** `animateWalker` definido y nunca usado → borrado.
- [x] 🟢 **`finanzas`:** prop `large` en `WRow` sin call-site → borrada.
- [x] 🟢 **`kioscos`:** cabecera duplicada/mal etiquetada (257 y 259 ambas
  "Vinculación") → renombradas a "Estado hardware" / "Permitir vinculación".
- [x] 🟢 **`cliente/planes`:** input de ciclos sin tope → `max=12` + clamp.
- [x] 🟢 **`cliente/cuenta`:** tres nombres para un destino (nav "Mi Tienda", eyebrow
  "Mi cuenta", h2 "Mis Tiendas") → nav unificado a "Mi cuenta".
- [ ] 🟢 **Código muerto adicional _(confirmar)_:**
  - `tiendas`: `clientsError` capturado nunca recuperado; `contractCountByStore`
    calculado y nunca mostrado; `detailStore` sin UI de detalle.
  - `campanias`: `slot_limit_group`/`slotLimitGroup` guardado en BD nunca leído.
  - `cliente/dashboard`: `summaryMetrics()`/`SUMMARY_COLUMNS` solo usados en export,
    métricas en pantalla se recalculan inline.
  - `cliente/promociones`: parámetro `activeConflict` en `persistCampaign` sin uso.
  - `mapa`: estado `showRoutesPanel` nunca leído.
- [ ] 🟢 **Campos guardados pero no expuestos _(confirmar)_:** `campanias`
  (`slot_limit_group`, `priority_level`, `target_frequency`); `cupons` (`category`
  texto libre sin selector, `campaign_id` nunca mostrado); método de pago `cash_bs`
  manejado en código pero nunca ofrecido en UI.
- [ ] 🟢 **Inconsistencia de claves de plan _(confirmar)_:** `finanzas` usa
  `PROMO_FLASH` mientras otros usan `FLASH_COUPON_DIARIO/SEMANAL`. → Confirmar la
  verdad en BD y unificar (encaja con `lib/plans.ts`).
- [ ] 🟢 **Tokens de tema:** `abrir`/`bienvenida` y `mapa` (colores de canvas,
  `inicio` spinner `border-pink-500`) hardcodean hex en vez de tokens. → Tokenizar.

---

## Orden de ejecución sugerido

1. **Quick wins de limpieza** (bajo riesgo) — código muerto confirmado, default de
   `banners`, tokens de tema. _(parcialmente hecho ✅)_
2. **Centralizar helpers** — `lib/plans.ts` ✅, `lib/csv.ts` ✅, ampliar
   `lib/storage.ts` (docs privados ✅ + upload genérico ~), `lib/format.ts`
   (módulo ✅, falta migrar call-sites). _(mayormente hecho)_
3. **Componentes compartidos** — `useToast()` + `ConfirmDialog` + `<PageSpinner/>`,
   luego `Modal`/`EmptyState`. Migrar `alert()`/`confirm()` por página.
4. **Sincronización y estados** — badge en contexto, errores visibles en cliente,
   rango del dashboard, cobertura de auditoría (6 entidades).
5. **Decisiones de producto** (requieren criterio del equipo) — unificar flujos de
   aprobación, consolidar pagos del cliente, reconciliar tutorial, decidir destino
   de `categorias`/`services`/`mapa`.

---

## Nota sobre falsos positivos descartados en esta auditoría

Verificados y **NO** son problemas (no actuar):
- Paginación de `tiendas` funciona (`pg.paginated.map`, ~1425).
- Modal de reactivación de campaña en `cliente/promociones` se renderiza y
  funciona (~1947, `reactivateWithDates`).
- `confirmDialog` en `cliente/promociones` sí se usa (~1528, ~1797, ~2241).
- La cobertura de auditoría no es "1/15": se registran 9 entidades.
