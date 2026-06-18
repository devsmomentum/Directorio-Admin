'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';
import Pagination, { usePagination } from '../../components/Pagination';

// Planes BASE asignables a una tienda (PDF "PLANES DIRECTORIOS").
// Flash Coupon ya no es plan base: vive como addon en flash_coupon_plan +
// flash_coupon_expiry_date y se gestiona aparte (ver FLASH_ADDON_OPTIONS).
const PLAN_TYPES = [
  'DIAMANTE',
  'ORO',
  'IA_PERFORMANCE',
  'PUBLI_PROMO_DIARIO',
  'PUBLI_PROMO_SEMANAL',
] as const;

// Capacidad máxima de tiendas activas por plan (null = ilimitado)
const PLAN_MAX_BRANDS: Record<string, number | null> = {
  DIAMANTE: 2,
  ORO: 30,
  IA_PERFORMANCE: null,
  PUBLI_PROMO_DIARIO: null,
  PUBLI_PROMO_SEMANAL: null,
};

// Addon Flash Coupon: 20 marcas simultáneas en la galería por flavor.
const FLASH_ADDON_OPTIONS = ['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL'] as const;
const FLASH_ADDON_MAX_BRANDS = 20;

// Capacidad de cupos por plan: la fuente de verdad EDITABLE es `plans.max_brands`
// (se ajusta desde /panel/planes). Estas constantes quedan solo como FALLBACK
// para cuando la tabla `plans` no trae la fila del plan (BD incompleta), de modo
// que el comportamiento nunca empeora respecto a hoy. null = ilimitado.
const FALLBACK_PLAN_CAPS: Record<string, number | null> = {
  ...PLAN_MAX_BRANDS,
  FLASH_COUPON_DIARIO: FLASH_ADDON_MAX_BRANDS,
  FLASH_COUPON_SEMANAL: FLASH_ADDON_MAX_BRANDS,
};

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10',
  ORO: 'text-amber-400 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-400 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-400 bg-blue-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-400 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-400 bg-pink-500/10',
};

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
  FLASH_COUPON_DIARIO: 'Flash Coupon · Diario',
  FLASH_COUPON_SEMANAL: 'Flash Coupon · Semanal',
};

// Logos → bucket público 'publicidad'
async function uploadLogo(file: File, path: string): Promise<string> {
  const { error } = await supabase.storage
    .from('publicidad')
    .upload(path, file, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('publicidad').getPublicUrl(path);
  return data.publicUrl;
}

// Documentos legales → bucket privado 'documentos', devuelve solo el path
async function uploadPrivateDoc(file: File, path: string): Promise<string> {
  const { error } = await supabase.storage
    .from('documentos')
    .upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}

// Genera URL firmada de 60s y abre el documento en nueva pestaña
async function openPrivateDoc(path: string) {
  const { data, error } = await supabase.storage
    .from('documentos')
    .createSignedUrl(path, 60);
  if (error || !data) { alert('No se pudo abrir el documento.'); return; }
  window.open(data.signedUrl, '_blank');
}

// Igual que openPrivateDoc pero fuerza la descarga con un nombre amigable
async function downloadPrivateDoc(path: string, filename: string) {
  const { data, error } = await supabase.storage
    .from('documentos')
    .createSignedUrl(path, 60, { download: filename });
  if (error || !data) { alert('No se pudo descargar el documento.'); return; }
  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Extensión (con punto) de un path de storage, p.ej. ".pdf"
function fileExt(path: string): string {
  const m = String(path || '').match(/\.[a-z0-9]+$/i);
  return m ? m[0] : '';
}

// Normaliza el logo_url para tolerar tres formas históricas que conviven en BD:
//   1. URL pública completa (https://…/storage/v1/object/public/publicidad/logos/x.png) → usar tal cual
//   2. Path crudo dentro del bucket (logos/x.png) → resolver con getPublicUrl
//   3. Path con prefijo redundante (publicidad/logos/x.png o /publicidad/logos/x.png) → limpiar y resolver
// Devuelve null si no hay un valor utilizable.
function resolveLogoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v) || v.startsWith('data:') || v.startsWith('blob:')) return v;
  const cleaned = v.replace(/^\/+/, '').replace(/^publicidad\//, '');
  const { data } = supabase.storage.from('publicidad').getPublicUrl(cleaned);
  return data?.publicUrl || null;
}

// Iniciales para placeholder cuando no hay logo o falla la carga.
function storeInitials(name: string | null | undefined): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Color estable derivado del nombre — placeholder consistente entre renders.
function nameHue(name: string | null | undefined): number {
  if (!name) return 0;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function StoreLogo({
  store,
  size = 32,
  className = '',
  rounded = 'rounded-md',
}: {
  store: { name?: string; logo_url?: string | null };
  size?: number;
  className?: string;
  rounded?: string;
}) {
  // Recalculamos la URL si cambia logo_url (clave fuerza remount al re-subir).
  const resolved = useMemo(() => resolveLogoUrl(store.logo_url), [store.logo_url]);
  const [errored, setErrored] = useState(false);

  // Si cambia el src resuelto (ej. tras editar), resetear el flag de error.
  useEffect(() => { setErrored(false); }, [resolved]);

  const showImg = resolved && !errored;
  const hue = nameHue(store.name);
  const style: React.CSSProperties = { width: size, height: size };

  return (
    <div
      style={style}
      className={`bg-[#0A0A0A] border border-white/5 overflow-hidden shrink-0 flex items-center justify-center ${rounded} ${className}`}
    >
      {showImg ? (
        <img
          key={resolved}
          src={resolved}
          alt={store.name || 'Logo'}
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 60% 22%), hsl(${(hue + 40) % 360} 60% 14%))`,
            color: `hsl(${hue} 70% 78%)`,
          }}
          className="w-full h-full flex items-center justify-center font-semibold tracking-tight"
        >
          <span style={{ fontSize: Math.max(10, Math.round(size * 0.36)) }}>
            {storeInitials(store.name)}
          </span>
        </span>
      )}
    </div>
  );
}

export default function TiendasCRUD() {
  const [stores, setStores] = useState<any[]>([]);
  const [categoriesList, setCategoriesList] = useState<any[]>([]);
  const [malls, setMalls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [detailStore, setDetailStore] = useState<any | null>(null);
  const [usersByStore, setUsersByStore] = useState<Record<string, any>>({});
  const [contractCountByStore, setContractCountByStore] = useState<Record<string, number>>({});

  // Basic info
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  // Centro comercial al que pertenece la tienda. '' = tienda externa (sin CC):
  // en ese caso no aplica piso/local físico y el kiosco no la lista.
  const [mallId, setMallId] = useState('');
  const [floorLevel, setFloorLevel] = useState('');
  const [localNumber, setLocalNumber] = useState('');
  const [description, setDescription] = useState('');
  const [planType, setPlanType] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState('');

  // CRM fields
  const [rif, setRif] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');

  // Cliente vinculado a la tienda. Se puede vincular un cliente YA EXISTENTE al
  // crear/editar la tienda (reusa la RPC admin_link_store_user). Crear clientes
  // nuevos / enviar magic link sigue viviendo en /panel/clientes.
  const [linkedUser, setLinkedUser] = useState<any | null>(null);
  const [clientsList, setClientsList] = useState<any[]>([]);
  // Si la carga de clientes falla (RLS, columna inexistente, etc.) lo mostramos
  // explícitamente en vez de un dropdown vacío silencioso.
  const [clientsError, setClientsError] = useState<string | null>(null);
  // Cliente elegido en el formulario ('' = sin vincular) + texto de búsqueda
  // para filtrar por nombre / cédula / email.
  const [linkClientId, setLinkClientId] = useState('');
  const [clientSearch, setClientSearch] = useState('');

  // Documents
  // Los contratos son un historial (varios por tienda → tabla store_contracts).
  // Aquí, en el formulario, se puede subir UN contrato al crear/editar la tienda
  // (se inserta como una fila más en el historial). La gestión completa (ver
  // todos, eliminar) está en el detalle de la tienda (StoreDetailModal).
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [contractTitle, setContractTitle] = useState('Contrato');
  const [contractExpiry, setContractExpiry] = useState('');
  // El registro mercantil sigue siendo un archivo único reemplazable aquí.
  const [mercantilFile, setMercantilFile] = useState<File | null>(null);
  const [mercantilUrl, setMercantilUrl] = useState('');
  // El vencimiento del contrato ya no es manual: se calcula en
  // `computedContractExpiry` a partir del plan asignado.

  // Addon Flash Coupon (independiente del plan base)
  const [flashCouponPlan, setFlashCouponPlan] = useState<string>('');
  const [flashCouponExpiryDate, setFlashCouponExpiryDate] = useState('');

  // Capacidad de cupos por plan leída de `plans.max_brands` (editable desde
  // /panel/planes). Vacío hasta que carga; capFor() cae al fallback mientras.
  const [planCaps, setPlanCaps] = useState<Record<string, number | null>>({});
  // Duración (días) por plan, leída de `plans.duration_days`. Se usa para
  // calcular automáticamente el vencimiento del contrato. Fallback: 30 días.
  const [planDurations, setPlanDurations] = useState<Record<string, number>>({});

  // Intervalos de ocupación por plan (RPC plan_capacity_intervals, SECURITY
  // DEFINER → ve TODAS las tiendas). Sirve para validar que al asignar un plan
  // no choque con otro contrato vigente ni con un cambio futuro, igual que en
  // el portal del cliente (request_plan_atomic / plan_capacity_intervals).
  type CapacityInterval = { plan_key: string; start_d: string; end_d: string; source: string };
  const [capacityIntervals, setCapacityIntervals] = useState<CapacityInterval[]>([]);

  // Mall por defecto para tiendas nuevas: Millennium si existe, si no el primero.
  const defaultMallId = useMemo(
    () => malls.find(m => m.code === 'MILLENNIUM')?.id || malls[0]?.id || '',
    [malls]
  );

  // Vencimiento del contrato calculado automáticamente (no manual):
  //   - Sin plan → null (sin plan no hay contrato).
  //   - Editando y el plan NO cambió → se conserva el vencimiento ya guardado.
  //   - Plan nuevo o cambiado → hoy + duración del plan (plans.duration_days,
  //     fallback 30 días). El cupo del plan ya se valida aparte (capFor),
  //     así que solo se asigna cuando hay disponibilidad.
  const FALLBACK_DURATION_DAYS = 30;
  const computedContractExpiry = useMemo<string | null>(() => {
    if (!planType) return null;
    const editingStore = editingId ? stores.find(s => s.id === editingId) : null;
    if (editingStore && editingStore.plan_type === planType && editingStore.contract_expiry_date) {
      return editingStore.contract_expiry_date;
    }
    const days = planDurations[planType] ?? FALLBACK_DURATION_DAYS;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }, [planType, planDurations, editingId, stores]);

  // Réplica del sweep-line del backend (plan_max_overlap_in_window) usando los
  // intervalos anonimizados de plan_capacity_intervals. Devuelve la ocupación
  // máxima simultánea de OTROS contratos/cambios del plan en la ventana dada.
  const computeMaxOverlapInWindow = (
    planKey: string,
    windowStart: string,
    windowEnd: string,
  ): number => {
    const clipped: Array<[string, string]> = [];
    for (const iv of capacityIntervals) {
      if (iv.plan_key !== planKey) continue;
      const rawStart = iv.source === 'store'
        ? (windowStart > iv.start_d ? windowStart : iv.start_d)
        : iv.start_d;
      const s = rawStart > windowStart ? rawStart : windowStart;
      const e = iv.end_d < windowEnd ? iv.end_d : windowEnd;
      if (s <= windowEnd && e >= windowStart && s <= e) {
        clipped.push([s, e]);
      }
    }
    if (clipped.length === 0) return 0;

    const evts: Array<[string, number]> = [];
    for (const [s, e] of clipped) {
      evts.push([s, 1]);
      const nxt = new Date(e + 'T00:00:00');
      nxt.setDate(nxt.getDate() + 1);
      evts.push([nxt.toISOString().split('T')[0], -1]);
    }
    evts.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : b[1] - a[1]);
    let count = 0, max = 0;
    for (const [, delta] of evts) {
      count += delta;
      if (count > max) max = count;
    }
    return max;
  };

  // ¿El plan base seleccionado choca con otro contrato/cambio futuro en la
  // ventana del contrato? (igual criterio que el cliente). Solo aplica cuando se
  // asigna un plan NUEVO o se CAMBIA de plan; una renovación del mismo plan usa
  // su propio cupo y no se revalida.
  const planCollision = useMemo(() => {
    if (!planType || !computedContractExpiry) return null;
    // cap inline (capFor se define más abajo): plans.max_brands o fallback.
    const cap = planType in planCaps
      ? planCaps[planType]
      : (planType in FALLBACK_PLAN_CAPS ? FALLBACK_PLAN_CAPS[planType] : null);
    if (cap == null) return null;
    const editingStore = editingId ? stores.find(s => s.id === editingId) : null;
    const planChanged = !editingStore || editingStore.plan_type !== planType;
    if (!planChanged) return null;
    const start = new Date().toISOString().split('T')[0];
    const overlap = computeMaxOverlapInWindow(planType, start, computedContractExpiry);
    if (overlap >= cap) {
      return { start, end: computedContractExpiry, overlap, cap };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planType, computedContractExpiry, editingId, stores, capacityIntervals]);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [catsRes, storesRes, linksRes, usersRes, plansRes, mallsRes, capRes, contractsRes] = await Promise.all([
      supabase.from('categories').select('*').order('name', { ascending: true }).limit(200),
      supabase.from('stores').select('*, categories(id, name, icon)').order('created_at', { ascending: false }).limit(500),
      supabase.from('user_stores').select('user_id, store_id'),
      supabase.from('users').select('id, email, full_name, cedula_numero, telefono_personal').eq('role', 'cliente'),
      supabase.from('plans').select('plan_key, max_brands, duration_days').limit(200),
      supabase.from('malls').select('id, name, code').order('name', { ascending: true }),
      supabase.rpc('plan_capacity_intervals'),
      supabase.from('store_contracts').select('store_id'),
    ]);
    if (catsRes.data) setCategoriesList(catsRes.data);
    if (mallsRes.data) setMalls(mallsRes.data);
    setCapacityIntervals((capRes.data as CapacityInterval[]) || []);
    
    // Lista de clientes para el selector de vinculación del formulario.
    if (usersRes.error) {
      console.warn('[tiendas] no se pudieron cargar los clientes:', usersRes.error);
      setClientsError(usersRes.error.message);
    } else {
      setClientsError(null);
    }
    setClientsList(usersRes.data || []);

    // Armar el mapa de dueños
    const userMap = new Map((usersRes.data || []).map(u => [u.id, u]));
    const storeToUser: Record<string, any> = {};
    for (const link of (linksRes.data || [])) {
      const u = userMap.get(link.user_id);
      if (u) storeToUser[link.store_id] = u;
    }
    setUsersByStore(storeToUser);

    // Conteo de contratos por tienda (para el badge "C" de la lista).
    const contractCounts: Record<string, number> = {};
    for (const row of (contractsRes.data || [])) {
      contractCounts[row.store_id] = (contractCounts[row.store_id] || 0) + 1;
    }
    setContractCountByStore(contractCounts);

    if (storesRes.data) setStores(storesRes.data);

    // Mapa clave→max_brands desde la BD. Si la tabla `plans` no existe o falla,
    // planCaps queda vacío y capFor() usa el fallback hardcodeado.
    const caps: Record<string, number | null> = {};
    const durations: Record<string, number> = {};
    for (const p of (plansRes.data || [])) {
      if (p.plan_key) {
        caps[p.plan_key] = p.max_brands ?? null;
        if (p.duration_days) durations[p.plan_key] = p.duration_days;
      }
    }
    setPlanCaps(caps);
    setPlanDurations(durations);

    setLoading(false);
    setRefreshing(false);
  };

  // Tiendas agrupadas por plan asignado.
  // Cuenta TODAS las tiendas que tengan el plan asignado en BD, sin filtrar
  // por vencimiento de contrato: el cap se aplica al slot del plan, no al
  // estado comercial del contrato. Una tienda con contrato vencido sigue
  // ocupando su cupo de Diamante/Oro/Flash hasta que se reasigne explícitamente.
  const planUsage = useMemo(() => {
    const byPlan: Record<string, number> = {};
    for (const s of stores) {
      if (!s.plan_type) continue;
      byPlan[s.plan_type] = (byPlan[s.plan_type] || 0) + 1;
    }
    return byPlan;
  }, [stores]);

  // Uso por flavor de addon Flash Coupon (FLASH_COUPON_DIARIO / SEMANAL)
  const flashAddonUsage = useMemo(() => {
    const byPlan: Record<string, number> = {};
    for (const s of stores) {
      if (!s.flash_coupon_plan) continue;
      byPlan[s.flash_coupon_plan] = (byPlan[s.flash_coupon_plan] || 0) + 1;
    }
    return byPlan;
  }, [stores]);

  // Capacidad efectiva del cupo de un plan: `plans.max_brands` de la BD
  // (editable en /panel/planes) o, si la fila no está cargada, el fallback
  // hardcodeado. null = ilimitado. Es la única fuente de cap en toda la página.
  const capFor = (key: string): number | null =>
    key in planCaps ? planCaps[key] : (key in FALLBACK_PLAN_CAPS ? FALLBACK_PLAN_CAPS[key] : null);

  const validateImage = (file: File): Promise<boolean> =>
    new Promise((resolve) => {
      if (file.size > 2 * 1024 * 1024) { alert('El logo debe pesar menos de 2 MB.'); resolve(false); return; }
      const img = new Image();
      img.onload = () => {
        if (img.width > 4000 || img.height > 4000) {
          alert(`Dimensiones excedidas (${img.width}x${img.height}). Maximo: 4000x4000px.`);
          resolve(false);
        } else { resolve(true); }
      };
      img.src = URL.createObjectURL(file);
    });

  const validateDoc = (file: File): boolean => {
    if (file.size > 50 * 1024 * 1024) { alert('El documento debe pesar menos de 50 MB.'); return false; }
    return true;
  };

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await validateImage(file);
    if (ok) { setLogoFile(file); setLogoPreview(URL.createObjectURL(file)); }
    else e.target.value = '';
  };

  const handleContractChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { setContractFile(null); return; }
    if (validateDoc(file)) setContractFile(file);
    else e.target.value = '';
  };

  const handleMercantilChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (validateDoc(file)) setMercantilFile(file);
    else e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validación de capacidad del plan base (cupo leído de plans.max_brands)
    if (planType) {
      const cap = capFor(planType);
      if (cap != null) {
        // Excluir la tienda que se está editando si ya tenía ese plan
        const editingStore = editingId ? stores.find(s => s.id === editingId) : null;
        const wasSamePlan = editingStore?.plan_type === planType;
        const currentCount = (planUsage[planType] || 0) - (wasSamePlan ? 1 : 0);
        if (currentCount >= cap) {
          alert(
            `Límite alcanzado: ${currentCount}/${cap} tiendas activas con plan ${PLAN_LABELS[planType] || planType}.\n\n` +
            `Para asignar este plan, libera un cupo desactivando o cambiando de plan a otra tienda con el mismo plan.`
          );
          return;
        }
      }
    }

    // Validación de capacidad del addon Flash Coupon (≤ 20 marcas por flavor)
    if (flashCouponPlan) {
      const editingStore = editingId ? stores.find(s => s.id === editingId) : null;
      const wasSameAddon = editingStore?.flash_coupon_plan === flashCouponPlan;
      const currentCount = (flashAddonUsage[flashCouponPlan] || 0) - (wasSameAddon ? 1 : 0);
      const flashCap = capFor(flashCouponPlan);
      if (flashCap != null && currentCount >= flashCap) {
        alert(
          `Límite alcanzado: ${currentCount}/${flashCap} tiendas con addon ${PLAN_LABELS[flashCouponPlan]}.\n\n` +
          `Libera un cupo desactivando el addon en otra tienda.`
        );
        return;
      }
    }

    // Validación de solapamiento del plan base (igual que el portal del cliente):
    // que el plan no choque con otro contrato vigente o un cambio futuro ya
    // aprobado/pendiente dentro de la ventana del contrato.
    if (planCollision) {
      alert(
        `Sin cupo para ${PLAN_LABELS[planType] || planType} en el período ` +
        `${planCollision.start} – ${planCollision.end}.\n\n` +
        `Ocupación máxima proyectada: ${planCollision.overlap}/${planCollision.cap} ` +
        `(cuenta contratos vigentes y cambios futuros). Elige otro plan o libera un cupo ` +
        `antes de asignarlo.`
      );
      return;
    }

    setSubmitting(true);
    try {
      let finalLogoUrl = logoPreview || '';
      let finalMercantilUrl = mercantilUrl;

      if (logoFile) {
        const ext = logoFile.name.split('.').pop();
        finalLogoUrl = await uploadLogo(logoFile, `logos/logo_${Date.now()}.${ext}`);
      }
      if (mercantilFile) {
        const ext = mercantilFile.name.split('.').pop();
        finalMercantilUrl = await uploadPrivateDoc(mercantilFile, `mercantil/mercantil_${Date.now()}.${ext}`);
      }

      // Tienda externa (sin CC): no tiene ubicación física en un mall, así que
      // no arrastramos piso/local.
      const isExternal = !mallId;
      const storeData: any = {
        name,
        // Las tiendas externas no se listan en el directorio, así que no usan
        // categoría.
        category_id: isExternal ? null : (categoryId || null),
        mall_id: mallId || null,
        floor_level: isExternal ? null : floorLevel,
        local_number: isExternal ? null : localNumber,
        description,
        logo_url: finalLogoUrl,
        plan_type: planType || null,
        rif: rif || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        // El/los contrato(s) se gestionan aparte (store_contracts) desde el
        // detalle de la tienda; aquí no se toca `contract_url`.
        mercantil_url: finalMercantilUrl || null,
        // El vencimiento del contrato se calcula automáticamente según la
        // duración del plan (no es manual). Sin plan = sin vencimiento.
        contract_expiry_date: computedContractExpiry,
        flash_coupon_plan: flashCouponPlan || null,
        flash_coupon_expiry_date: flashCouponPlan ? (flashCouponExpiryDate || null) : null,
      };

      let storeId: string | null = editingId;
      if (editingId) {
        const { error } = await supabase.from('stores').update(storeData).eq('id', editingId);
        if (error) throw error;
        await logAdminAction({
          action_type: 'EDITAR',
          entity_type: 'tienda',
          entity_id: editingId,
          entity_name: storeData.name,
          details: storeData
        });
      } else {
        const { data: inserted, error } = await supabase.from('stores').insert([storeData]).select('id').single();
        if (error) throw error;
        storeId = inserted?.id ?? null;
        if (storeId) {
          await logAdminAction({
            action_type: 'CREAR',
            entity_type: 'tienda',
            entity_id: storeId,
            entity_name: storeData.name,
            details: storeData
          });
        }
      }

      // Reconciliar el cliente vinculado (cliente ya existente). Crear clientes
      // nuevos / enviar magic link sigue en /panel/clientes.
      if (storeId) {
        const previousUserId = linkedUser?.id ?? null;
        if (linkClientId && linkClientId !== previousUserId) {
          // Vincular el cliente elegido (reemplaza al dueño previo si lo había).
          const client = clientsList.find(c => c.id === linkClientId);
          if (client?.email) {
            const { data: linkedId, error: linkErr } = await supabase.rpc('admin_link_store_user', {
              p_email: client.email,
              p_store_id: storeId,
            });
            if (linkErr) throw linkErr;
            if (!linkedId) {
              alert(
                `La tienda se guardó, pero "${client.email}" aún no tiene cuenta activa. ` +
                `Envíale el magic link desde Clientes para completar la vinculación.`
              );
            }
          }
        } else if (!linkClientId && previousUserId) {
          // Se quitó el cliente: desvincular.
          const { error: unlinkErr } = await supabase.rpc('admin_unlink_store_user', {
            p_user_id: previousUserId,
            p_store_id: storeId,
          });
          if (unlinkErr) throw unlinkErr;
        }
      }

      // Contrato adjunto en el formulario: se sube e inserta en el historial
      // (store_contracts). Sirve para cargar el contrato al CREAR la tienda
      // sin tener que abrir el detalle después.
      if (storeId && contractFile) {
        const ext = contractFile.name.split('.').pop();
        const path = await uploadPrivateDoc(contractFile, `contratos/${storeId}/${Date.now()}.${ext}`);
        const { data: auth } = await supabase.auth.getUser();
        const { error: contractErr } = await supabase.from('store_contracts').insert({
          store_id: storeId,
          title: contractTitle.trim() || 'Contrato',
          file_path: path,
          expiry_date: contractExpiry || null,
          uploaded_by: auth?.user?.id ?? null,
        });
        if (contractErr) throw contractErr;
        await logAdminAction({
          action_type: 'CREAR', entity_type: 'contrato_tienda', entity_id: storeId,
          entity_name: `${storeData.name} · ${contractTitle.trim() || 'Contrato'}`,
          details: { title: contractTitle.trim() || 'Contrato', file_path: path, expiry_date: contractExpiry || null },
        });
      }

      resetForm();
      fetchData();
    } catch (err: any) {
      alert('Error al guardar: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (store: any) => {
    setEditingId(store.id);
    setName(store.name || '');
    setCategoryId(store.category_id || '');
    setMallId(store.mall_id || '');
    setFloorLevel(store.floor_level || '');
    setLocalNumber(store.local_number || '');
    setDescription(store.description || '');
    setPlanType(store.plan_type || '');
    setLogoPreview(store.logo_url || '');
    setLogoFile(null);
    setRif(store.rif || '');
    setContactEmail(store.contact_email || '');
    setContactPhone(store.contact_phone || '');
    setContractFile(null); setContractTitle('Contrato'); setContractExpiry('');
    setMercantilUrl(store.mercantil_url || '');
    setMercantilFile(null);
    setFlashCouponPlan(store.flash_coupon_plan || '');
    setFlashCouponExpiryDate(store.flash_coupon_expiry_date || '');

    // Cargar el cliente vinculado a esta tienda y preseleccionarlo en el selector.
    const { data: link } = await supabase
      .from('user_stores')
      .select('user_id')
      .eq('store_id', store.id)
      .maybeSingle();

    if (link?.user_id) {
      const { data: user } = await supabase
        .from('users')
        .select('id, email, full_name, cedula_numero, telefono_personal')
        .eq('id', link.user_id)
        .maybeSingle();
      setLinkedUser(user);
      setLinkClientId(link.user_id);
    } else {
      setLinkedUser(null);
      setLinkClientId('');
    }
    setClientSearch('');

    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    const store = stores.find((s) => s.id === id);
    const storeName = store ? store.name : 'Desconocida';
    if (confirm(`Eliminar esta tienda "${storeName}"?`)) {
      await supabase.from('stores').delete().eq('id', id);
      await logAdminAction({
        action_type: 'ELIMINAR',
        entity_type: 'tienda',
        entity_id: id,
        entity_name: storeName,
        details: { name: storeName }
      });
      fetchData();
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setName(''); setCategoryId(''); setMallId(defaultMallId);
    setFloorLevel(''); setLocalNumber('');
    setDescription(''); setPlanType(''); setLogoFile(null); setLogoPreview('');
    setRif('');
    setContactEmail(''); setContactPhone('');
    setContractFile(null); setContractTitle('Contrato'); setContractExpiry('');
    setMercantilFile(null); setMercantilUrl('');
    setFlashCouponPlan('');
    setFlashCouponExpiryDate('');
    setLinkedUser(null);
    setLinkClientId('');
    setClientSearch('');
    setShowForm(false);
  };

  const getCategoryName = (store: any): string => store.categories?.name ?? 'Sin categoría';

  const filtered = useMemo(() => {
    let result = stores;
    if (search) {
      const q = search.toLowerCase();
      result = stores.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.floor_level || '').toLowerCase().includes(q) ||
        (s.rif || '').toLowerCase().includes(q) ||
        (usersByStore[s.id]?.full_name || '').toLowerCase().includes(q) ||
        (usersByStore[s.id]?.email || '').toLowerCase().includes(q) ||
        getCategoryName(s).toLowerCase().includes(q)
      );
    }
    const planWeight: Record<string, number> = {
      DIAMANTE: 5, ORO: 4,
      PUBLI_PROMO_SEMANAL: 3, PUBLI_PROMO_DIARIO: 2,
      IA_PERFORMANCE: 1,
    };
    return [...result].sort((a, b) => {
      const diff = (planWeight[b.plan_type] || 0) - (planWeight[a.plan_type] || 0);
      return diff !== 0 ? diff : (a.name || '').localeCompare(b.name || '');
    });
  }, [stores, search, usersByStore]);

  const pg = usePagination(filtered);

  // Check if contract is expiring soon (≤30 days)
  const isExpiringSoon = (dateStr: string | null): boolean => {
    if (!dateStr) return false;
    const diff = (new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return diff <= 30 && diff >= 0;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Directorio</p>
          <h2 className="text-2xl font-bold text-white">Tiendas</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchData}
            disabled={refreshing}
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-2 text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white rounded-lg px-4 py-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
            Nueva tienda
          </button>
        </div>
      </div>

      {/* Capacidad por plan (PDF "PLANES DIRECTORIOS") */}
      <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium mb-1">Capacidad de planes</p>
            <p className="text-white/40 text-xs">Tiendas con cada plan asignado en BD</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {FLASH_ADDON_OPTIONS.map(opt => {
              const used = flashAddonUsage[opt] || 0;
              const cap = capFor(opt);
              const saturated = cap != null && used >= cap;
              const tight = cap != null && used >= cap - 2;
              return (
                <span
                  key={opt}
                  title="Addon Flash Coupon (no es plan base)"
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border ${saturated
                    ? 'bg-red-500/15 text-red-400 border-red-500/30'
                    : tight
                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                      : `${PLAN_COLORS[opt]} border-transparent`
                  }`}
                >
                  + {PLAN_LABELS[opt]} <span className="font-mono">{used}/{cap ?? '∞'}</span>
                </span>
              );
            })}
            {PLAN_TYPES.map(p => {
              const cap = capFor(p);
              const used = planUsage[p] || 0;
              if (cap == null) {
                return (
                  <span key={p} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium ${PLAN_COLORS[p]}`}>
                    {PLAN_LABELS[p]} <span className="font-mono">{used}</span>
                  </span>
                );
              }
              const saturated = used >= cap;
              const tight = used >= cap - 2;
              return (
                <span
                  key={p}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border ${saturated
                    ? 'bg-red-500/15 text-red-400 border-red-500/30'
                    : tight
                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                      : `${PLAN_COLORS[p]} border-transparent`
                    }`}
                >
                  {PLAN_LABELS[p]} <span className="font-mono">{used}/{cap}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, RIF, email, categoria o piso..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">
                {editingId ? 'Editar ficha de tienda' : 'Nueva tienda'}
              </h3>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">

              {/* ── Sección: Info del Local ── */}
              <div className="space-y-4">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Info del Local</p>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Centro comercial</label>
                  <select
                    value={mallId} onChange={(e) => setMallId(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  >
                    {malls.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                    <option value="">Tienda externa (sin centro comercial)</option>
                  </select>
                  <p className="text-[10px] text-white/20 mt-1">
                    {mallId
                      ? 'Tienda dentro del centro comercial: define su piso y local.'
                      : 'Tienda externa: no aparece en el directorio/mapa del kiosco, pero puede adquirir planes.'}
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre de la tienda</label>
                  <input
                    type="text" required value={name} onChange={(e) => setName(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: Cinex"
                  />
                </div>
                {mallId && (
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Categoria</label>
                    <select
                      required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    >
                      <option value="">Seleccionar...</option>
                      {categoriesList.map(cat => (
                        <option key={cat.id} value={cat.id}>{cat.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {mallId && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Piso</label>
                      <select
                        required value={floorLevel} onChange={(e) => setFloorLevel(e.target.value)}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      >
                        <option value="">Elegir...</option>
                        <option value="C4">Nivel C4</option>
                        <option value="C3">Nivel C3</option>
                        <option value="C2">Nivel C2</option>
                        <option value="C1">Nivel C1</option>
                        <option value="RG">Nivel RG</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Local N</label>
                      <input
                        type="text" required value={localNumber} onChange={(e) => setLocalNumber(e.target.value)}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                        placeholder="Ej: L-45"
                      />
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripcion</label>
                  <textarea
                    required value={description} onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors resize-none"
                    placeholder="Breve descripcion del local..."
                  />
                </div>
              </div>

              {/* ── Sección: Datos de la Tienda (Empresa) ── */}
              <div className="border-t border-white/5 pt-5 space-y-4">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Datos de la Tienda (Empresa)</p>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">RIF</label>
                  <input
                    type="text" value={rif} onChange={(e) => setRif(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: J-12345678-9"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Correo de la tienda</label>
                    <input
                      type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="contacto@tienda.com"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Teléfono de la tienda</label>
                    <input
                      type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="Ej: +58 412-1234567"
                    />
                  </div>
                </div>
              </div>

              {/* ── Sección: Cliente vinculado ──
                  Se puede vincular un cliente YA EXISTENTE al crear/editar la
                  tienda. Para crear un cliente nuevo o enviar el magic link, se
                  usa /panel/clientes. */}
              <div className="border-t border-white/5 pt-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
                    Cliente vinculado
                  </p>
                  <Link
                    href="/panel/clientes"
                    className="text-[10px] text-cyan-400 hover:text-cyan-300 underline"
                  >
                    ¿Cliente nuevo? Créalo en Clientes →
                  </Link>
                </div>

                <p className="text-[11px] text-white/40 bg-white/[0.02] border border-white/5 rounded-lg p-2.5 leading-relaxed">
                  Opcional: la tienda puede crearse <span className="text-white/60">sin cliente vinculado</span> y
                  asignárselo más tarde. Aquí solo puedes vincular clientes ya existentes.
                </p>

                {clientsError && (
                  <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">
                    No se pudieron cargar los clientes: {clientsError}
                  </p>
                )}
                {!clientsError && clientsList.length === 0 && (
                  <p className="text-[11px] text-amber-300/80 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-2.5">
                    No hay clientes registrados (rol «cliente»). Créalos en{' '}
                    <Link href="/panel/clientes" className="underline">Clientes</Link>.
                  </p>
                )}
                {(() => {
                  const sel = clientsList.find(c => c.id === linkClientId);

                  // Cliente ya elegido: tarjeta + botón para cambiarlo/quitarlo.
                  if (sel) {
                    return (
                      <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm text-white/85 font-medium truncate">
                              {sel.full_name || <span className="text-white/40 italic">Sin nombre</span>}
                            </p>
                            <p className="text-[11px] text-white/50 truncate">{sel.email}</p>
                            <div className="flex gap-3 mt-1 flex-wrap">
                              {sel.cedula_numero && (
                                <span className="text-[10px] text-white/40 font-mono">CI: {sel.cedula_numero}</span>
                              )}
                              {sel.telefono_personal && (
                                <span className="text-[10px] text-white/40">📱 {sel.telefono_personal}</span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setLinkClientId(''); setClientSearch(''); }}
                            className="text-[10px] text-cyan-400 hover:text-cyan-300 underline shrink-0"
                          >
                            Cambiar
                          </button>
                        </div>
                      </div>
                    );
                  }

                  if (clientsList.length === 0) return null; // cubierto por el aviso de arriba

                  // Buscador por nombre / cédula / correo.
                  const q = clientSearch.trim().toLowerCase();
                  const matches = (q
                    ? clientsList.filter(c =>
                        (c.full_name || '').toLowerCase().includes(q) ||
                        (c.cedula_numero || '').toLowerCase().includes(q) ||
                        (c.email || '').toLowerCase().includes(q))
                    : clientsList
                  ).slice(0, 8);

                  return (
                    <div className="space-y-2">
                      <div className="relative">
                        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                        <input
                          type="text"
                          value={clientSearch}
                          onChange={(e) => setClientSearch(e.target.value)}
                          placeholder="Buscar cliente por nombre, cédula o correo..."
                          className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-pink-500/50 transition-colors"
                        />
                      </div>
                      <div className="max-h-48 overflow-y-auto rounded-lg border border-white/5 divide-y divide-white/5">
                        {matches.length === 0 ? (
                          <p className="text-[11px] text-white/30 p-3">Sin coincidencias para «{clientSearch}».</p>
                        ) : matches.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setLinkClientId(c.id)}
                            className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors"
                          >
                            <p className="text-sm text-white/85 truncate">{c.full_name || 'Sin nombre'}</p>
                            <div className="flex gap-2 flex-wrap">
                              <span className="text-[10px] text-white/40 truncate">{c.email}</span>
                              {c.cedula_numero && (
                                <span className="text-[10px] text-white/40 font-mono">CI: {c.cedula_numero}</span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-white/40">
                        Busca y elige un cliente existente para vincularlo
                        {editingId ? ' a esta tienda.' : ' al crear la tienda.'}
                      </p>
                    </div>
                  );
                })()}
              </div>

              {/* ── Sección: Documentación Legal ── */}
              <div className="border-t border-white/5 pt-5 space-y-4">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Documentacion Legal</p>

                {/* Contrato — se puede subir al crear/editar la tienda. Se guarda
                    como una fila más del historial (store_contracts). La gestión
                    completa (ver todos / eliminar) está en el detalle de la tienda. */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    {editingId ? 'Añadir contrato' : 'Contrato'}
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                    <input
                      type="text"
                      value={contractTitle}
                      onChange={e => setContractTitle(e.target.value)}
                      placeholder="Título (ej. Contrato 2026)"
                      className="bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder:text-white/25"
                    />
                    <div>
                      <input
                        type="date"
                        value={contractExpiry}
                        onChange={e => setContractExpiry(e.target.value)}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/60"
                      />
                      <p className="text-[10px] text-white/20 mt-0.5">Vencimiento (opcional)</p>
                    </div>
                  </div>
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    onChange={handleContractChange}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                  />
                  <p className="text-[10px] text-white/20 mt-1">
                    PDF, JPG o PNG — Máx 25MB.{' '}
                    {editingId
                      ? 'Se añade al historial sin reemplazar los contratos existentes.'
                      : 'Opcional. Puedes añadir más contratos luego desde el detalle de la tienda.'}
                  </p>
                </div>

                {/* Registro Mercantil */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Registro Mercantil
                    {editingId && mercantilUrl && <span className="normal-case tracking-normal text-green-400/70 ml-2">(ya cargado)</span>}
                  </label>
                  <div className="flex items-center gap-3">
                    {mercantilUrl && !mercantilFile && (
                      <button
                        type="button"
                        onClick={() => openPrivateDoc(mercantilUrl)}
                        className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 px-2.5 py-1.5 rounded-md shrink-0 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        Ver doc
                      </button>
                    )}
                    <div className="flex-1">
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        onChange={handleMercantilChange}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                      />
                      <p className="text-[10px] text-white/20 mt-1">PDF, JPG o PNG — Max 25MB</p>
                    </div>
                  </div>
                </div>


                {/* Vencimiento del contrato — calculado automáticamente según el
                    plan (no editable). Solo aplica si hay plan asignado. */}
                {planType && (
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vencimiento del Contrato</label>
                  <div className="w-full bg-[#0A0A0A]/60 border border-white/5 rounded-lg px-3 py-2.5 text-sm text-white/70 font-mono">
                    {computedContractExpiry || '—'}
                  </div>
                  <p className="text-[10px] text-white/20 mt-1">
                    {editingId && stores.find(s => s.id === editingId)?.plan_type === planType && stores.find(s => s.id === editingId)?.contract_expiry_date
                      ? 'Se conserva el vencimiento actual mientras no cambies de plan.'
                      : `Calculado: hoy + ${planDurations[planType] ?? FALLBACK_DURATION_DAYS} días (duración del plan).`}
                  </p>
                  {computedContractExpiry && isExpiringSoon(computedContractExpiry) && (
                    <p className="text-[10px] text-amber-400 mt-1">Contrato por vencer en menos de 30 dias</p>
                  )}
                </div>
                )}
              </div>

              {/* ── Sección: Plan Publicitario ── */}
              <div className="border-t border-white/5 pt-5">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-3">Plan Publicitario</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button" onClick={() => setPlanType('')}
                    className={`py-2 text-xs font-medium rounded-lg border transition-colors ${!planType
                      ? 'bg-white/10 text-white border-white/20'
                      : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'}`}
                  >
                    Sin plan
                  </button>
                  {PLAN_TYPES.map(pt => {
                    const cap = capFor(pt);
                    const editingStore = editingId ? stores.find(s => s.id === editingId) : null;
                    const wasSamePlan = editingStore?.plan_type === pt;
                    const used = (planUsage[pt] || 0) - (wasSamePlan ? 1 : 0);
                    const saturated = cap != null && used >= cap;
                    const isSelected = planType === pt;
                    return (
                      <button
                        key={pt} type="button"
                        onClick={() => { if (!saturated || isSelected) setPlanType(pt); }}
                        disabled={saturated && !isSelected}
                        title={saturated && !isSelected ? `Plan saturado: ${used}/${cap}` : undefined}
                        className={`py-2 text-xs font-medium rounded-lg border transition-colors ${isSelected
                          ? `${PLAN_COLORS[pt]} border-current`
                          : saturated
                            ? 'bg-red-500/5 text-red-400/50 border-red-500/20 cursor-not-allowed'
                            : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'
                          }`}
                      >
                        <div>{PLAN_LABELS[pt]}</div>
                        {cap != null && (
                          <div className="text-[9px] opacity-70 font-mono mt-0.5">{used}/{cap}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* Aviso de cupo */}
                {planType && capFor(planType) != null && (() => {
                  const cap = capFor(planType)!;
                  const editingStore = editingId ? stores.find(s => s.id === editingId) : null;
                  const wasSamePlan = editingStore?.plan_type === planType;
                  const used = (planUsage[planType] || 0) - (wasSamePlan ? 1 : 0);
                  const remaining = cap - used;
                  return (
                    <p className={`text-[10px] mt-2 ${remaining <= 0 ? 'text-red-400' : remaining <= 2 ? 'text-amber-400' : 'text-white/40'}`}>
                      {remaining <= 0
                        ? `Plan saturado (${used}/${cap}) — no podrás guardar`
                        : `Disponibles: ${remaining}/${cap}`}
                    </p>
                  );
                })()}

                {/* Aviso de solapamiento con otro contrato / cambio futuro */}
                {planCollision && (
                  <div className="mt-2 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">
                    <p className="text-[11px] text-red-300 font-semibold">
                      Choca con otro contrato o cambio futuro
                    </p>
                    <p className="text-[10px] text-white/50 mt-0.5">
                      En el período {planCollision.start} – {planCollision.end} la ocupación
                      máxima proyectada es {planCollision.overlap}/{planCollision.cap}.
                      No podrás guardar este plan hasta que se libere un cupo.
                    </p>
                  </div>
                )}
              </div>

              {/* ── Sección: Addon Flash Coupon ── */}
              <div className="border-t border-white/5 pt-5">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-1">Addon Flash Coupon</p>
                <p className="text-[11px] text-white/40 mb-3">
                  Cupones flash en la galería con captura de datos. Es independiente del plan base:
                  una tienda con plan Oro o Diamante puede acumular este addon sin renunciar a su plan.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button" onClick={() => { setFlashCouponPlan(''); setFlashCouponExpiryDate(''); }}
                    className={`py-2 text-xs font-medium rounded-lg border transition-colors ${!flashCouponPlan
                      ? 'bg-white/10 text-white border-white/20'
                      : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'}`}
                  >
                    Sin addon
                  </button>
                  {FLASH_ADDON_OPTIONS.map(opt => {
                    const editingStore = editingId ? stores.find(s => s.id === editingId) : null;
                    const wasSameAddon = editingStore?.flash_coupon_plan === opt;
                    const used = (flashAddonUsage[opt] || 0) - (wasSameAddon ? 1 : 0);
                    const cap = capFor(opt);
                    const saturated = cap != null && used >= cap;
                    const isSelected = flashCouponPlan === opt;
                    return (
                      <button
                        key={opt} type="button"
                        onClick={() => { if (!saturated || isSelected) setFlashCouponPlan(opt); }}
                        disabled={saturated && !isSelected}
                        title={saturated && !isSelected ? `Addon saturado: ${used}/${cap ?? '∞'}` : undefined}
                        className={`py-2 text-xs font-medium rounded-lg border transition-colors ${isSelected
                          ? `${PLAN_COLORS[opt]} border-current`
                          : saturated
                            ? 'bg-red-500/5 text-red-400/50 border-red-500/20 cursor-not-allowed'
                            : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'
                          }`}
                      >
                        <div>{PLAN_LABELS[opt]}</div>
                        <div className="text-[9px] opacity-70 font-mono mt-0.5">{used}/{cap ?? '∞'}</div>
                      </button>
                    );
                  })}
                </div>
                {flashCouponPlan && (
                  <div className="mt-3">
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                      Vencimiento del addon
                    </label>
                    <input
                      type="date"
                      value={flashCouponExpiryDate}
                      onChange={(e) => setFlashCouponExpiryDate(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    />
                    {flashCouponExpiryDate && new Date(flashCouponExpiryDate) < new Date(new Date().toDateString()) && (
                      <p className="text-[10px] text-red-400 mt-1">
                        Addon vencido: la tienda no podrá subir cupones flash hasta renovarlo.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ── Sección: Logo ── */}
              <div className="border-t border-white/5 pt-5">
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Logo {editingId && <span className="normal-case tracking-normal">(dejar vacio para mantener)</span>}
                </label>
                <div className="flex items-center gap-3">
                  <StoreLogo
                    store={{ name: name || 'Preview', logo_url: logoPreview }}
                    size={48}
                    rounded="rounded-lg"
                  />
                  <div className="flex-1">
                    <input
                      type="file" accept="image/*" onChange={handleLogoChange}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                    />
                    <p className="text-[10px] text-white/20 mt-1">Max 2MB, hasta 4000x4000px</p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  type="button" onClick={resetForm}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit" disabled={submitting || !!planCollision}
                  title={planCollision ? 'El plan choca con otro contrato o cambio futuro' : undefined}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear tienda'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Table */}
      {stores.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
          <p className="text-white/30 text-sm">No hay tiendas registradas</p>
          <p className="text-white/15 text-xs mt-1">Haz clic en "Nueva tienda" para empezar</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Tienda</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Categoria</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Ubicacion</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Contacto</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Docs</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Plan</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pg.paginated.map((store) => (
                <tr key={store.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <StoreLogo store={store} size={32} />
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => setDetailStore(store)}
                          title="Ver toda la información y exportar data K2 de la tienda"
                          className="text-white font-medium text-sm block truncate text-left hover:text-pink-400 transition-colors max-w-full"
                        >
                          {store.name}
                        </button>
                        {store.rif && (
                          <span className="text-white/30 text-[10px] font-mono block">{store.rif}</span>
                        )}
                        {!store.mall_id && (
                          <span className="inline-block mt-0.5 text-[9px] font-medium text-orange-300 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded">
                            Externa
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 bg-white/5 px-2 py-0.5 rounded-md text-xs">{getCategoryName(store)}</span>
                  </td>
                  <td className="px-5 py-3.5 max-w-[120px]">
                    {store.mall_id ? (
                      <span className="text-white/50 text-xs font-mono block truncate" title={`${store.floor_level} — ${store.local_number}`}>
                        {store.floor_level} — {store.local_number}
                      </span>
                    ) : (
                      <span className="text-white/20 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 max-w-[160px]">
                    {usersByStore[store.id] ? (
                      <div className="space-y-0.5">
                        <span className="text-white/70 text-xs block truncate">{usersByStore[store.id].full_name || <span className="text-white/20">Sin nombre</span>}</span>
                        <span className="text-white/40 text-[10px] block truncate">{usersByStore[store.id].email}</span>
                        {usersByStore[store.id].telefono_personal && <span className="text-white/40 text-[10px] block truncate">{usersByStore[store.id].telefono_personal}</span>}
                      </div>
                    ) : (
                      <span className="text-white/15 text-xs italic">Sin vincular</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5">
                      {/* Contratos (historial) */}
                      <span
                        title={contractCountByStore[store.id] ? `${contractCountByStore[store.id]} contrato(s) cargado(s)` : 'Sin contratos'}
                        className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${contractCountByStore[store.id] ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/15'}`}
                      >
                        {contractCountByStore[store.id] ? contractCountByStore[store.id] : 'C'}
                      </span>
                      {/* Mercantil */}
                      <span
                        title={store.mercantil_url ? 'Registro mercantil cargado' : 'Sin registro mercantil'}
                        className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${store.mercantil_url ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/15'}`}
                      >
                        M
                      </span>
                      {/* Cédula */}
                      <span
                        title={usersByStore[store.id]?.cedula_url ? 'Cédula cargada' : 'Sin cédula del dueño'}
                        className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${usersByStore[store.id]?.cedula_url ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/15'}`}
                      >
                        CI
                      </span>
                      {/* Alerta vencimiento */}
                      {isExpiringSoon(store.contract_expiry_date) && (
                        <span title="Contrato por vencer" className="w-5 h-5 rounded flex items-center justify-center bg-amber-500/15 text-amber-400">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex flex-col items-start gap-1">
                      {store.is_ally && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider text-emerald-300 bg-emerald-500/15" title="Marca aliada (campañas + flash sin pagar plan)">
                          🤝 ALIADO
                        </span>
                      )}
                      {store.plan_type ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider ${PLAN_COLORS[store.plan_type] || 'text-white/40 bg-white/5'}`}>
                          {PLAN_LABELS[store.plan_type] || store.plan_type}
                        </span>
                      ) : !store.flash_coupon_plan && !store.is_ally ? (
                        <span className="text-white/15 text-xs">—</span>
                      ) : null}
                      {store.flash_coupon_plan && (() => {
                        const exp = store.flash_coupon_expiry_date as string | null;
                        const expired = exp ? exp < new Date().toISOString().split('T')[0] : false;
                        return (
                          <span
                            title={exp ? `Addon vence ${exp}` : 'Addon sin fecha de vencimiento'}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider ${
                              expired
                                ? 'text-red-400 bg-red-500/10 line-through'
                                : PLAN_COLORS[store.flash_coupon_plan]
                            }`}
                          >
                            +{PLAN_LABELS[store.flash_coupon_plan] || store.flash_coupon_plan}
                          </span>
                        );
                      })()}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleEdit(store)}
                        title="Editar"
                        className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDelete(store.id)}
                        title="Eliminar"
                        className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {pg.totalPages > 1 && (
            <Pagination
              page={pg.page}
              totalPages={pg.totalPages}
              total={pg.total}
              perPage={pg.perPage}
              label="tiendas"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </div>
      )}

      {detailStore && (
        <StoreDetailModal
          store={detailStore}
          onClose={() => setDetailStore(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StoreDetailModal — vista completa de la tienda + export de data K2 (kioscos)
// ─────────────────────────────────────────────────────────────────────────────

type RangePreset = '7d' | '30d' | '90d' | 'all';

const RANGE_LABELS: Record<RangePreset, string> = {
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
  '90d': 'Últimos 90 días',
  'all': 'Todo el histórico',
};

const FLASH_PLAN_SET = new Set(['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL']);

function rangeStartISO(preset: RangePreset): string | null {
  if (preset === 'all') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const days = preset === '7d' ? 6 : preset === '30d' ? 29 : 89;
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// CSV-safe: comillas dobladas, comillas envolventes si hay coma/quote/newline.
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCSV(filename: string, headers: string[], rows: (unknown[])[]) {
  // BOM para que Excel respete UTF-8.
  const body = [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(s: string): string {
  return (s || 'tienda')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function StoreDetailModal({ store, onClose }: { store: any; onClose: () => void }) {
  const [range, setRange] = useState<RangePreset>('30d');
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [impressionsDaily, setImpressionsDaily] = useState<any[]>([]);
  const [interactions, setInteractions] = useState<any[]>([]);
  const [searchRows, setSearchRows] = useState<any[]>([]);
  const [couponStats, setCouponStats] = useState<any[]>([]);
  const [linkedUser, setLinkedUser] = useState<any>(null);

  // ── Documentos: contratos (historial), mercantil y cédula ────────────────
  const [contracts, setContracts] = useState<any[]>([]);
  const [showAddContract, setShowAddContract] = useState(false);
  const [newContractFile, setNewContractFile] = useState<File | null>(null);
  const [newContractTitle, setNewContractTitle] = useState('');
  const [newContractExpiry, setNewContractExpiry] = useState('');
  const [newContractNotes, setNewContractNotes] = useState('');
  const [savingContract, setSavingContract] = useState(false);
  // Espejos locales para reflejar reemplazos sin refrescar todo el modal.
  const [mercantilUrlLocal, setMercantilUrlLocal] = useState<string | null>(store.mercantil_url || null);
  const [cedulaUrlLocal, setCedulaUrlLocal] = useState<string | null>(null);
  const [uploadingMercantil, setUploadingMercantil] = useState(false);
  const [uploadingCedula, setUploadingCedula] = useState(false);

  const loadContracts = async () => {
    const { data } = await supabase
      .from('store_contracts')
      .select('id, title, file_path, expiry_date, notes, created_at')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });
    setContracts(data || []);
  };

  useEffect(() => { loadContracts(); /* eslint-disable-next-line */ }, [store.id]);
  useEffect(() => { setCedulaUrlLocal(linkedUser?.cedula_url ?? null); }, [linkedUser]);

  const handleAddContract = async () => {
    if (!newContractFile || !newContractTitle.trim()) {
      alert('El archivo y el título del contrato son obligatorios.');
      return;
    }
    if (newContractFile.size > 25 * 1024 * 1024) { alert('El documento debe pesar menos de 25 MB.'); return; }
    setSavingContract(true);
    try {
      const ext = newContractFile.name.split('.').pop();
      const path = await uploadPrivateDoc(newContractFile, `contratos/${store.id}/${Date.now()}.${ext}`);
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase.from('store_contracts').insert({
        store_id: store.id,
        title: newContractTitle.trim(),
        file_path: path,
        expiry_date: newContractExpiry || null,
        notes: newContractNotes.trim() || null,
        uploaded_by: auth?.user?.id ?? null,
      });
      if (error) throw error;
      await logAdminAction({
        action_type: 'CREAR', entity_type: 'contrato_tienda', entity_id: store.id,
        entity_name: `${store.name} · ${newContractTitle.trim()}`,
        details: { title: newContractTitle.trim(), file_path: path, expiry_date: newContractExpiry || null },
      });
      setNewContractFile(null); setNewContractTitle(''); setNewContractExpiry(''); setNewContractNotes('');
      setShowAddContract(false);
      await loadContracts();
    } catch (err: any) {
      alert('Error al subir el contrato: ' + err.message);
    } finally {
      setSavingContract(false);
    }
  };

  const handleDeleteContract = async (c: any) => {
    if (!confirm(`¿Eliminar el contrato "${c.title}" del historial de esta tienda?`)) return;
    const { error } = await supabase.from('store_contracts').delete().eq('id', c.id);
    if (error) { alert('Error al eliminar: ' + error.message); return; }
    await logAdminAction({
      action_type: 'ELIMINAR', entity_type: 'contrato_tienda', entity_id: store.id,
      entity_name: `${store.name} · ${c.title}`,
    });
    await loadContracts();
  };

  const handleReplaceMercantil = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { alert('El documento debe pesar menos de 25 MB.'); e.target.value = ''; return; }
    setUploadingMercantil(true);
    try {
      const ext = file.name.split('.').pop();
      const path = await uploadPrivateDoc(file, `mercantil/${store.id}_${Date.now()}.${ext}`);
      const { error } = await supabase.from('stores').update({ mercantil_url: path }).eq('id', store.id);
      if (error) throw error;
      setMercantilUrlLocal(path);
      await logAdminAction({
        action_type: 'EDITAR', entity_type: 'tienda', entity_id: store.id,
        entity_name: store.name, details: { mercantil_url: path },
      });
    } catch (err: any) {
      alert('Error al subir el registro mercantil: ' + err.message);
    } finally {
      setUploadingMercantil(false);
      e.target.value = '';
    }
  };

  const handleReplaceCedula = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!linkedUser?.id) { alert('No hay cliente dueño vinculado a esta tienda.'); e.target.value = ''; return; }
    if (file.size > 25 * 1024 * 1024) { alert('El documento debe pesar menos de 25 MB.'); e.target.value = ''; return; }
    setUploadingCedula(true);
    try {
      const ext = file.name.split('.').pop();
      const path = await uploadPrivateDoc(file, `cedulas/${linkedUser.id}_${Date.now()}.${ext}`);
      const { error } = await supabase.from('users').update({ cedula_url: path }).eq('id', linkedUser.id);
      if (error) throw error;
      setCedulaUrlLocal(path);
      await logAdminAction({
        action_type: 'EDITAR', entity_type: 'cliente', entity_id: linkedUser.id,
        entity_name: linkedUser.full_name || linkedUser.email || linkedUser.id, details: { cedula_url: path },
      });
    } catch (err: any) {
      alert('Error al subir la cédula: ' + err.message);
    } finally {
      setUploadingCedula(false);
      e.target.value = '';
    }
  };

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);
  const rangeStart = useMemo(() => rangeStartISO(range), [range]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // 1) Campañas y cupones de la tienda (siempre el histórico completo;
        //    el filtro de rango aplica a impresiones y eventos K2).
        const [campRes, couponsRes, linkRes] = await Promise.all([
          supabase
            .from('ad_campaigns')
            .select('id, brand_name, plan_type, start_date, end_date, is_active, created_at')
            .eq('store_id', store.id)
            .order('created_at', { ascending: false }),
          supabase
            .from('coupons')
            .select('id, title, plan_type, code, amount_available, discount_percent, category, start_date, end_date, campaign_id, created_at')
            .eq('store_id', store.id)
            .order('created_at', { ascending: false }),
          supabase
            .from('user_stores')
            .select('user_id')
            .eq('store_id', store.id)
            .maybeSingle(),
        ]);

        if (cancelled) return;
        const camps = campRes.data || [];
        const cps = couponsRes.data || [];
        setCampaigns(camps);
        setCoupons(cps);

        if (linkRes?.data?.user_id) {
          const { data: u } = await supabase
            .from('users')
            .select('id, email, full_name, cedula_numero, telefono_personal, cedula_url')
            .eq('id', linkRes.data.user_id)
            .maybeSingle();
          if (!cancelled) setLinkedUser(u);
        }

        const campaignIds = camps.map(c => c.id);
        const couponIds = cps.map(c => c.id);

        // 2) Impresiones diarias para las campañas de la tienda (data K2)
        let impQuery = supabase
          .from('ad_impressions_daily')
          .select('campaign_id, kiosk_id, day, count, impressions_valid, full_views')
          .order('day', { ascending: false });
        if (campaignIds.length) impQuery = impQuery.in('campaign_id', campaignIds);
        else impQuery = impQuery.eq('campaign_id', '00000000-0000-0000-0000-000000000000'); // ninguna
        if (rangeStart) impQuery = impQuery.gte('day', rangeStart.split('T')[0]);
        const impRes = await impQuery;

        // 3) Métricas K2 de la tienda desde los AGREGADOS diarios (las tablas
        //    crudas se purgan a los 30 días, así que ya no se consultan):
        //      • interaction_daily_stats → clicks/selects/navegación (store_id)
        //      • search_daily_stats      → veces buscada (store_id_target)
        //      • coupon_daily_stats      → apariciones/canjes de cupón (store_id)
        const startDay = rangeStart ? rangeStart.split('T')[0] : null;

        let interQ: any = supabase.from('interaction_daily_stats')
          .select('date, kiosk_id, module, event_type, item_id, item_name, count')
          .eq('store_id', store.id);
        if (startDay) interQ = interQ.gte('date', startDay);

        let searchQ: any = supabase.from('search_daily_stats')
          .select('date, search_term, search_count')
          .eq('store_id_target', store.id);
        if (startDay) searchQ = searchQ.gte('date', startDay);

        let couponQ: any = supabase.from('coupon_daily_stats')
          .select('coupon_id, date, shown, clicks, redeemed')
          .eq('store_id', store.id);
        if (startDay) couponQ = couponQ.gte('date', startDay);

        const [interRes, searchRes, couponRes] = await Promise.all([interQ, searchQ, couponQ]);
        if (cancelled) return;

        setImpressionsDaily(impRes.data || []);
        setInteractions(interRes.data || []);
        setSearchRows(searchRes.data || []);
        setCouponStats(couponRes.data || []);
      } catch (err) {
        console.error('StoreDetailModal fetch error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [store.id, store.name, range, rangeStart]);

  // ── Métricas derivadas ────────────────────────────────────────────────────
  const planVigente = !store.contract_expiry_date || store.contract_expiry_date >= today;
  const activeCampaign = useMemo(() => {
    if (!planVigente) return null;
    return campaigns.find(c =>
      c.is_active &&
      (!c.end_date || c.end_date >= today) &&
      (!c.start_date || c.start_date <= today)
    ) || null;
  }, [campaigns, today, planVigente]);

  const activeCoupons = useMemo(() => coupons.filter(c =>
    (!c.end_date || c.end_date.split('T')[0] >= today) &&
    (!c.start_date || c.start_date.split('T')[0] <= today)
  ), [coupons, today]);

  const flashCoupons = useMemo(() => coupons.filter(c => FLASH_PLAN_SET.has(c.plan_type)), [coupons]);
  const activeFlashCoupons = useMemo(() => activeCoupons.filter(c => FLASH_PLAN_SET.has(c.plan_type)), [activeCoupons]);

  const flashShownCount = useMemo(() =>
    couponStats.reduce((s, r) => s + (r.shown || 0), 0),
    [couponStats]);

  const campaignImpressionsTotal = useMemo(() =>
    impressionsDaily.reduce((s, d) => s + (((d.impressions_valid ?? d.count) || 0)), 0),
    [impressionsDaily]);

  const campaignFullViewsTotal = useMemo(() =>
    impressionsDaily.reduce((s, d) => s + (d.full_views || 0), 0),
    [impressionsDaily]);

  const campaignPartialViewsTotal = useMemo(() =>
    Math.max(0, campaignImpressionsTotal - campaignFullViewsTotal),
    [campaignImpressionsTotal, campaignFullViewsTotal]);

  const storeClicks = useMemo(() =>
    searchRows
      .filter(r => r.search_term === '(directo)' || r.search_term === '(mapa)')
      .reduce((s, r) => s + (r.search_count || 0), 0),
    [searchRows]);

  const searchClickCount = useMemo(() =>
    searchRows
      .filter(r => r.search_term !== '(directo)' && r.search_term !== '(mapa)')
      .reduce((s, r) => s + (r.search_count || 0), 0),
    [searchRows]);

  const topSearchQueries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of searchRows) {
      const q = String(r.search_term || '').trim();
      if (!q || q === '(directo)' || q === '(mapa)') continue;
      counts.set(q, (counts.get(q) || 0) + (r.search_count || 0));
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [searchRows]);

  const uniqueKiosks = useMemo(() => {
    const set = new Set<string>();
    for (const d of impressionsDaily) if (d.kiosk_id) set.add(d.kiosk_id);
    for (const e of interactions) if (e.kiosk_id) set.add(e.kiosk_id);
    return set.size;
  }, [impressionsDaily, interactions]);

  // ── Agregados analíticos (todos respetan el rango seleccionado) ──────────
  const analyticsBreakdown = useMemo(() => {
    const byType: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    const byKiosk: Record<string, number> = {};
    const daySet = new Set<string>();
    let first: string | null = null;
    let last: string | null = null;

    for (const e of interactions) {
      const n = e.count || 0;
      byType[e.event_type] = (byType[e.event_type] || 0) + n;
      const mod = e.module || '(sin módulo)';
      byModule[mod] = (byModule[mod] || 0) + n;
      if (e.kiosk_id) byKiosk[e.kiosk_id] = (byKiosk[e.kiosk_id] || 0) + n;
      const day = e.date as string;
      if (day) {
        daySet.add(day);
        if (!first || day < first) first = day;
        if (!last || day > last) last = day;
      }
    }

    // Sintetizamos los clicks directos y búsquedas que ahora viven en searchRows (search_daily_stats)
    for (const r of searchRows) {
      const n = r.search_count || 0;
      const isDirect = r.search_term === '(directo)' || r.search_term === '(mapa)';
      const type = isDirect ? 'click' : 'search_click';
      const mod = 'directory';

      byType[type] = (byType[type] || 0) + n;
      byModule[mod] = (byModule[mod] || 0) + n;
      const day = r.date as string;
      if (day) {
        daySet.add(day);
        if (!first || day < first) first = day;
        if (!last || day > last) last = day;
      }
    }

    const impByCampaign: Record<string, number> = {};
    const impByKiosk: Record<string, number> = {};
    for (const d of impressionsDaily) {
      const valid = (d.impressions_valid ?? d.count) || 0;
      impByCampaign[d.campaign_id] = (impByCampaign[d.campaign_id] || 0) + valid;
      if (d.kiosk_id) impByKiosk[d.kiosk_id] = (impByKiosk[d.kiosk_id] || 0) + valid;
    }

    const flashByCoupon: Record<string, number> = {};
    for (const r of couponStats) {
      if (!r.shown) continue;
      flashByCoupon[r.coupon_id] = (flashByCoupon[r.coupon_id] || 0) + r.shown;
    }

    return { byType, byModule, byKiosk, daySet, first, last, impByCampaign, impByKiosk, flashByCoupon };
  }, [interactions, searchRows, impressionsDaily, couponStats]);

  // ── Exportadores K2 ───────────────────────────────────────────────────────
  const slug = slugify(store.name);
  const stamp = new Date().toISOString().split('T')[0];

  const fmtBreakdown = (
    counts: Record<string, number>,
    labelFor: (key: string) => string = (k) => k,
  ) => Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${labelFor(k)} (${n.toLocaleString('es-VE')})`)
    .join(' | ');

  const exportSummary = () => {
    const { byType, byModule, byKiosk, daySet, first, last, impByCampaign, impByKiosk, flashByCoupon } = analyticsBreakdown;
    const eventsTotal = interactions.reduce((s, e) => s + (e.count || 0), 0);
    const activeDays = daySet.size;
    const avgPerDay = activeDays ? (eventsTotal / activeDays) : 0;
    const campNameById: Record<string, string> = {};
    campaigns.forEach(c => { campNameById[c.id] = c.brand_name; });
    const couponTitleById: Record<string, string> = {};
    coupons.forEach(c => { couponTitleById[c.id] = c.title; });

    downloadCSV(`K2_${slug}_resumen_${stamp}.csv`,
      ['metrica', 'valor'],
      [
        // ── Identidad de la tienda ──────────────────────────────────────
        ['tienda', store.name],
        ['rif', store.rif || ''],
        ['categoria', store.categories?.name || ''],
        ['plan', store.plan_type || ''],
        ['piso', store.floor_level || ''],
        ['local', store.local_number || ''],
        ['rango_export', RANGE_LABELS[range]],

        // ── Campañas y cupones (estado) ─────────────────────────────────
        ['campania_activa', activeCampaign ? activeCampaign.brand_name : 'no'],
        ['campanias_total', campaigns.length],
        ['cupones_activos', activeCoupons.length],
        ['cupones_total', coupons.length],
        ['flash_coupons_total', flashCoupons.length],
        ['flash_coupons_activos', activeFlashCoupons.length],

        // ── Analíticas: totales agregados ───────────────────────────────
        ['eventos_total', eventsTotal],
        ['eventos_dias_con_actividad', activeDays],
        ['eventos_promedio_por_dia', avgPerDay ? avgPerDay.toFixed(2) : '0'],
        ['eventos_primer_evento_iso', first || ''],
        ['eventos_ultimo_evento_iso', last || ''],
        ['campania_impresiones_validas', campaignImpressionsTotal],
        ['campania_vistas_completas', campaignFullViewsTotal],
        ['campania_vistas_parciales', campaignPartialViewsTotal],
        ['flash_coupon_apariciones', flashShownCount],
        ['clicks_directorio', storeClicks],
        ['veces_buscada', searchClickCount],
        ['kioscos_unicos', uniqueKiosks],

        // ── Analíticas: desgloses ───────────────────────────────────────
        ['eventos_por_tipo', fmtBreakdown(byType)],
        ['eventos_por_modulo', fmtBreakdown(byModule)],
        ['eventos_por_kiosco', fmtBreakdown(byKiosk)],
        ['impresiones_por_campania', fmtBreakdown(impByCampaign, id => campNameById[id] || id)],
        ['impresiones_por_kiosco', fmtBreakdown(impByKiosk)],
        ['apariciones_por_flash_coupon', fmtBreakdown(flashByCoupon, id => couponTitleById[id] || id)],
        ['top_terminos_busqueda', topSearchQueries.map(([q, n]) => `${q} (${n})`).join(' | ')],

        // ── CRM ─────────────────────────────────────────────────────────
        ['contacto_email', store.contact_email || ''],
        ['contacto_telefono', store.contact_phone || ''],
        ['contrato_vencimiento', store.contract_expiry_date || ''],
      ]);
  };

  const exportImpressions = () => {
    if (!impressionsDaily.length) { alert('Sin impresiones de campaña en el rango.'); return; }
    const byCamp: Record<string, string> = {};
    campaigns.forEach(c => { byCamp[c.id] = c.brand_name; });
    const rows = impressionsDaily
      .slice()
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .map(d => {
        const valid = (d.impressions_valid ?? d.count) || 0;
        const full = d.full_views || 0;
        const partial = Math.max(0, valid - full);
        return [d.day, byCamp[d.campaign_id] || d.campaign_id, d.campaign_id, d.kiosk_id, valid, full, partial];
      });
    downloadCSV(`K2_${slug}_impresiones_diarias_${stamp}.csv`,
      ['fecha', 'campania', 'campaign_id', 'kiosk_id', 'impresiones_validas', 'vistas_completas', 'vistas_parciales'],
      rows);
  };

  const exportEvents = () => {
    if (!interactions.length && !searchRows.length) { alert('Sin interacciones K2 en el rango.'); return; }
    const rows: any[] = [];
    
    interactions.forEach(e => {
      rows.push([
        e.date,
        e.event_type,
        e.module || '',
        e.item_id || '',
        e.item_name || '',
        e.kiosk_id || '',
        String(e.count ?? 0),
      ]);
    });

    searchRows.forEach(r => {
      const isDirect = r.search_term === '(directo)' || r.search_term === '(mapa)';
      rows.push([
        r.date,
        isDirect ? 'click' : 'search_click',
        'directory',
        store.id,
        isDirect ? `Click ${r.search_term}` : `Búsqueda: ${r.search_term}`,
        'N/A',
        String(r.search_count ?? 0),
      ]);
    });

    rows.sort((a, b) => (a[0] < b[0] ? 1 : -1));

    downloadCSV(`K2_${slug}_interacciones_diarias_${stamp}.csv`,
      ['fecha', 'event_type', 'module', 'item_id', 'item_name', 'kiosk_id', 'cantidad'],
      rows);
  };

  const exportCoupons = () => {
    if (!coupons.length) { alert('Esta tienda no tiene cupones.'); return; }
    const rows = coupons.map(c => [
      c.id,
      c.title,
      c.code || '',
      c.plan_type,
      FLASH_PLAN_SET.has(c.plan_type) ? 'si' : 'no',
      c.category || '',
      c.amount_available,
      c.discount_percent,
      c.start_date || '',
      c.end_date || '',
      c.campaign_id || '',
      c.created_at,
    ]);
    downloadCSV(`K2_${slug}_cupones_${stamp}.csv`,
      ['coupon_id', 'titulo', 'codigo', 'plan_type', 'es_flash', 'categoria', 'cantidad_disponible', 'descuento_pct', 'inicio', 'fin', 'campaign_id', 'creado_en'],
      rows);
  };

  // KPI tile helper.
  const Tile = ({ label, value, accent, sub }: { label: string; value: React.ReactNode; accent?: string; sub?: string }) => (
    <div className="bg-[#0A0A0A] border border-white/5 rounded-lg p-3.5">
      <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium mb-1.5">{label}</p>
      <p className={`text-xl font-semibold ${accent || 'text-white'} leading-none`}>{value}</p>
      {sub && <p className="text-[10px] text-white/30 mt-1.5">{sub}</p>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0E0E0E] border border-white/10 rounded-xl w-full max-w-4xl shadow-2xl max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#0E0E0E] border-b border-white/5 px-6 py-4 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <StoreLogo store={store} size={40} />
            <div className="min-w-0">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Detalle de tienda · Data K2</p>
              <h3 className="text-base font-semibold text-white truncate">{store.name}</h3>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {store.is_ally && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider text-emerald-300 bg-emerald-500/15" title="Marca aliada · gestiónala en la sección Aliados">
                    🤝 ALIADO
                  </span>
                )}
                {store.plan_type && (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider ${PLAN_COLORS[store.plan_type] || 'text-white/40 bg-white/5'}`}>
                    {PLAN_LABELS[store.plan_type] || store.plan_type}
                  </span>
                )}
                {store.categories?.name && (
                  <span className="text-white/40 bg-white/5 px-2 py-0.5 rounded text-[10px]">{store.categories.name}</span>
                )}
                {store.floor_level && (
                  <span className="text-white/30 text-[10px] font-mono">{store.floor_level} · {store.local_number}</span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors shrink-0">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Range selector */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1.5 bg-white/[0.03] border border-white/10 rounded-lg p-1">
              {(['7d', '30d', '90d', 'all'] as RangePreset[]).map(p => (
                <button
                  key={p}
                  onClick={() => setRange(p)}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${range === p ? 'bg-pink-500/20 text-pink-300' : 'text-white/40 hover:text-white/70'
                    }`}
                >
                  {RANGE_LABELS[p]}
                </button>
              ))}
            </div>
            {loading && (
              <span className="text-[10px] text-white/30 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-pink-500/60 animate-pulse" />
                Consultando K2…
              </span>
            )}
          </div>

          {/* KPI grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile
              label="Campaña activa"
              accent={activeCampaign ? 'text-emerald-400' : 'text-white/40'}
              value={activeCampaign ? 'Sí' : 'No'}
              sub={activeCampaign ? `${activeCampaign.brand_name} · vence ${activeCampaign.end_date || '—'}` : `${campaigns.length} campañas totales`}
            />
            <Tile
              label="Cupones activos"
              accent="text-cyan-400"
              value={activeCoupons.length}
              sub={`${coupons.length} históricos`}
            />
            <Tile
              label="Flash coupons"
              accent={flashCoupons.length ? 'text-pink-400' : 'text-white/40'}
              value={flashCoupons.length ? 'Sí' : 'No'}
              sub={`${activeFlashCoupons.length} activos · ${flashCoupons.length} totales`}
            />
            <Tile
              label="Apariciones flash"
              accent="text-pink-400"
              value={flashShownCount.toLocaleString('es-VE')}
              sub={`Eventos flash_coupon_shown · ${RANGE_LABELS[range].toLowerCase()}`}
            />
            <Tile
              label="Impresiones campaña"
              accent="text-orange-400"
              value={campaignImpressionsTotal.toLocaleString('es-VE')}
              sub={`Reproducciones en K2 · ${RANGE_LABELS[range].toLowerCase()}`}
            />
            <Tile
              label="Clicks en directorio"
              accent="text-violet-400"
              value={storeClicks.toLocaleString('es-VE')}
              sub="click + tap sobre la tienda"
            />
            <Tile
              label="Veces buscada"
              accent={searchClickCount ? 'text-sky-400' : 'text-white/40'}
              value={searchClickCount.toLocaleString('es-VE')}
              sub={`Clic tras búsqueda · ${RANGE_LABELS[range].toLowerCase()}`}
            />
            <Tile
              label="Kioscos únicos"
              value={uniqueKiosks}
              sub="K2 que registraron actividad"
            />
            <Tile
              label="Estado contrato"
              accent={store.contract_expiry_date && store.contract_expiry_date < today ? 'text-red-400' : 'text-white/70'}
              value={store.contract_expiry_date
                ? (store.contract_expiry_date < today ? 'Vencido' : 'Vigente')
                : '—'}
              sub={store.contract_expiry_date ? `Vence ${store.contract_expiry_date}` : 'Sin contrato cargado'}
            />
          </div>

          {/* Campañas */}
          <div>
            <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Campañas ({campaigns.length})</p>
            {campaigns.length === 0 ? (
              <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4 text-center text-white/30 text-xs">
                Sin campañas registradas para esta tienda.
              </div>
            ) : (
              <div className="bg-white/[0.02] border border-white/5 rounded-lg overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                      <th className="px-3 py-2 font-medium">Marca</th>
                      <th className="px-3 py-2 font-medium">Plan</th>
                      <th className="px-3 py-2 font-medium">Vigencia</th>
                      <th className="px-3 py-2 font-medium">Estado</th>
                      <th className="px-3 py-2 font-medium text-right">Impresiones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map(c => {
                      const imp = impressionsDaily
                        .filter(d => d.campaign_id === c.id)
                        .reduce((s, d) => s + (d.count || 0), 0);
                      const live = c.is_active && (!c.end_date || c.end_date >= today);
                      return (
                        <tr key={c.id} className="border-b border-white/[0.03]">
                          <td className="px-3 py-2 text-white/80">{c.brand_name}</td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
                              {PLAN_LABELS[c.plan_type] || c.plan_type}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-white/40 font-mono">{c.start_date || '—'} → {c.end_date || '∞'}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[10px] font-medium ${live ? 'text-emerald-400' : 'text-white/30'}`}>
                              {live ? 'Activa' : 'Inactiva'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-white/70">{imp.toLocaleString('es-VE')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Cupones (todos) */}
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Cupones ({coupons.length})</p>
              {flashCoupons.length > 0 && (
                <p className="text-[10px] text-white/40">
                  <span className="text-pink-400 font-medium">{flashCoupons.length}</span> flash · <span className="text-pink-400 font-medium">{flashShownCount.toLocaleString('es-VE')}</span> apariciones
                </p>
              )}
            </div>
            {coupons.length === 0 ? (
              <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4 text-center text-white/30 text-xs">
                Esta tienda no ha creado cupones.
              </div>
            ) : (
              <div className="bg-white/[0.02] border border-white/5 rounded-lg overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                      <th className="px-3 py-2 font-medium">Cupón</th>
                      <th className="px-3 py-2 font-medium">Plan</th>
                      <th className="px-3 py-2 font-medium">Vigencia</th>
                      <th className="px-3 py-2 font-medium text-right">Apariciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coupons.map(c => {
                      const isFlash = FLASH_PLAN_SET.has(c.plan_type);
                      const shown = isFlash
                        ? couponStats.filter(s => s.coupon_id === c.id).reduce((sum, s) => sum + (s.shown || 0), 0)
                        : 0;
                      const live = (!c.end_date || c.end_date.split('T')[0] >= today) &&
                        (!c.start_date || c.start_date.split('T')[0] <= today);
                      return (
                        <tr key={c.id} className="border-b border-white/[0.03]">
                          <td className="px-3 py-2 text-white/80">
                            {c.title}
                            <span className={`ml-2 text-[9px] ${live ? 'text-emerald-400' : 'text-white/30'}`}>
                              {live ? '● activo' : '○ vencido'}
                            </span>
                            {isFlash && (
                              <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-300 font-semibold tracking-wider uppercase">
                                Flash
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
                              {PLAN_LABELS[c.plan_type] || c.plan_type}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-white/40 font-mono">
                            {(c.start_date || '').split('T')[0] || '—'} → {(c.end_date || '').split('T')[0] || '∞'}
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${isFlash ? 'text-pink-400' : 'text-white/20'}`}>
                            {isFlash ? shown.toLocaleString('es-VE') : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Contratos (historial) — solo el admin sube/edita; el cliente solo ve */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Contratos</p>
              <button
                onClick={() => setShowAddContract(v => !v)}
                className="text-[10px] px-2.5 py-1 rounded-md bg-pink-500/15 hover:bg-pink-500/25 text-pink-300 border border-pink-500/30 transition-colors"
              >
                {showAddContract ? 'Cancelar' : '+ Añadir contrato'}
              </button>
            </div>

            {showAddContract && (
              <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 mb-2 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Título (ej. Contrato 2026, Adenda IA)"
                    value={newContractTitle}
                    onChange={e => setNewContractTitle(e.target.value)}
                    className="bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder:text-white/25"
                  />
                  <div>
                    <input
                      type="date"
                      value={newContractExpiry}
                      onChange={e => setNewContractExpiry(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/60"
                    />
                    <p className="text-[10px] text-white/20 mt-0.5">Vencimiento (opcional)</p>
                  </div>
                </div>
                <input
                  type="text"
                  placeholder="Notas (opcional)"
                  value={newContractNotes}
                  onChange={e => setNewContractNotes(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder:text-white/25"
                />
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={e => setNewContractFile(e.target.files?.[0] ?? null)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                />
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/20">PDF, JPG o PNG — Máx 25MB</p>
                  <button
                    onClick={handleAddContract}
                    disabled={savingContract}
                    className="text-xs px-3 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition-colors disabled:opacity-40"
                  >
                    {savingContract ? 'Guardando…' : 'Guardar contrato'}
                  </button>
                </div>
              </div>
            )}

            <div className="bg-white/[0.02] border border-white/5 rounded-lg divide-y divide-white/[0.04]">
              {contracts.length === 0 ? (
                <p className="text-xs text-white/25 italic px-3 py-3">Sin contratos cargados.</p>
              ) : contracts.map(c => {
                const exp = c.expiry_date as string | null;
                const vencido = !!exp && exp < today;
                const diffDays = exp ? (new Date(exp).getTime() - Date.now()) / 86400000 : null;
                const porVencer = diffDays != null && diffDays >= 0 && diffDays <= 30;
                return (
                  <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-white/30 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-white/80 truncate">{c.title}</span>
                          {exp && (
                            <span className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded ${vencido ? 'bg-red-500/15 text-red-400' : porVencer ? 'bg-amber-500/15 text-amber-400' : 'bg-white/5 text-white/40'}`}>
                              {vencido ? 'vencido' : porVencer ? `vence ${exp}` : `vence ${exp}`}
                            </span>
                          )}
                        </div>
                        {c.notes && <p className="text-[10px] text-white/30 truncate">{c.notes}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => openPrivateDoc(c.file_path)} className="text-[10px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 transition-colors">Ver</button>
                      <button onClick={() => downloadPrivateDoc(c.file_path, `${slug}_${slugify(c.title)}${fileExt(c.file_path)}`)} className="text-[10px] px-2 py-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 transition-colors">Descargar</button>
                      <button onClick={() => handleDeleteContract(c)} className="text-[10px] px-2 py-1 rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-colors">Eliminar</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Otros documentos — archivo único reemplazable (mercantil y cédula) */}
          <div>
            <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Otros documentos</p>
            <div className="bg-white/[0.02] border border-white/5 rounded-lg divide-y divide-white/[0.04]">
              {[
                {
                  label: 'Registro mercantil', key: 'mercantil', path: mercantilUrlLocal,
                  onUpload: handleReplaceMercantil, uploading: uploadingMercantil, disabled: false,
                },
                {
                  label: 'Cédula del dueño', key: 'cedula', path: cedulaUrlLocal,
                  onUpload: handleReplaceCedula, uploading: uploadingCedula, disabled: !linkedUser?.id,
                },
              ].map(doc => (
                <div key={doc.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-4 h-4 text-white/30 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    <span className="text-xs text-white/80 truncate">{doc.label}</span>
                    <span className={`text-[10px] shrink-0 ${doc.path ? 'text-emerald-400' : 'text-white/25'}`}>
                      {doc.path ? 'cargado' : 'no cargado'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {doc.path && (
                      <>
                        <button onClick={() => openPrivateDoc(doc.path!)} className="text-[10px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 transition-colors">Ver</button>
                        <button onClick={() => downloadPrivateDoc(doc.path!, `${slug}_${doc.key}${fileExt(doc.path!)}`)} className="text-[10px] px-2 py-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 transition-colors">Descargar</button>
                      </>
                    )}
                    <label className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${doc.disabled ? 'bg-white/5 text-white/20 border-white/5 cursor-not-allowed' : 'bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border-cyan-500/25 cursor-pointer'}`}>
                      {doc.uploading ? 'Subiendo…' : doc.path ? 'Reemplazar' : 'Subir'}
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        disabled={doc.disabled || doc.uploading}
                        onChange={doc.onUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            {!linkedUser?.id && (
              <p className="text-[10px] text-white/25 mt-1">La cédula se gestiona cuando hay un cliente dueño vinculado.</p>
            )}
          </div>

          {/* CRM / Docs resumen */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4 space-y-1.5">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Dueño Vinculado</p>
              
              {linkedUser ? (
                <div className="space-y-1">
                  <p className="text-xs text-white/90">{linkedUser.full_name || <span className="text-white/20">Sin nombre</span>}</p>
                  {linkedUser.email && <p className="text-xs text-white/50">{linkedUser.email}</p>}
                  {linkedUser.telefono_personal && <p className="text-xs text-white/50">{linkedUser.telefono_personal}</p>}
                </div>
              ) : (
                <p className="text-xs text-white/30 italic">Ningún cliente vinculado a esta tienda todavía.</p>
              )}
            </div>
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4 space-y-1.5">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-1">Datos Tienda</p>
              <p className="text-xs">
                <span className={contracts.length ? 'text-emerald-400' : 'text-white/20'}>● {contracts.length || 'Sin'} contrato{contracts.length === 1 ? '' : 's'}</span>{' '}
                <span className={mercantilUrlLocal ? 'text-emerald-400' : 'text-white/20'} >● Mercantil</span>{' '}
                <span className={cedulaUrlLocal ? 'text-emerald-400' : 'text-white/20'}>● Cédula</span>
              </p>
              <p className="text-xs text-white/50">RIF: <span className="font-mono">{store.rif || '—'}</span></p>
              <p className="text-xs text-white/50">Correo: <span className="font-mono">{store.contact_email || '—'}</span></p>
              <p className="text-xs text-white/50">Teléfono: <span className="font-mono">{store.contact_phone || '—'}</span></p>
              <p className="text-xs text-white/50">Vence contrato: <span className="font-mono">{store.contract_expiry_date || '—'}</span></p>
            </div>
          </div>

          {/* Exports K2 */}
          <div className="border-t border-white/5 pt-5">
            <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Exportar data K2</p>
                <p className="text-xs text-white/40 mt-0.5">CSV UTF-8 con BOM · respeta el rango seleccionado ({RANGE_LABELS[range].toLowerCase()})</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <button onClick={exportSummary} disabled={loading}
                className="px-3 py-2.5 text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 rounded-lg transition-colors disabled:opacity-40">
                Resumen
              </button>
              <button onClick={exportImpressions} disabled={loading || !impressionsDaily.length}
                className="px-3 py-2.5 text-xs font-medium bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 text-orange-300 rounded-lg transition-colors disabled:opacity-40">
                Impresiones diarias
              </button>
              <button onClick={exportEvents} disabled={loading || !interactions.length}
                className="px-3 py-2.5 text-xs font-medium bg-pink-500/10 hover:bg-pink-500/20 border border-pink-500/30 text-pink-300 rounded-lg transition-colors disabled:opacity-40">
                Eventos K2
              </button>
              <button onClick={exportCoupons} disabled={loading || !coupons.length}
                className="px-3 py-2.5 text-xs font-medium bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 rounded-lg transition-colors disabled:opacity-40">
                Cupones
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
