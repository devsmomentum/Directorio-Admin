'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [detailStore, setDetailStore] = useState<any | null>(null);
  const [usersByStore, setUsersByStore] = useState<Record<string, any>>({});

  // Basic info
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
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

  // Usuario vinculado: solo lectura. La gestión completa (crear, editar,
  // vincular/desvincular, enviar link) vive en /panel/clientes.
  const [linkedUser, setLinkedUser] = useState<any | null>(null);

  // Documents
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [contractUrl, setContractUrl] = useState('');
  const [mercantilFile, setMercantilFile] = useState<File | null>(null);
  const [mercantilUrl, setMercantilUrl] = useState('');
  const [contractExpiryDate, setContractExpiryDate] = useState('');

  // Addon Flash Coupon (independiente del plan base)
  const [flashCouponPlan, setFlashCouponPlan] = useState<string>('');
  const [flashCouponExpiryDate, setFlashCouponExpiryDate] = useState('');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [catsRes, storesRes, linksRes, usersRes] = await Promise.all([
      supabase.from('categories').select('*').order('name', { ascending: true }).limit(200),
      supabase.from('stores').select('*, categories(id, name, icon)').order('created_at', { ascending: false }).limit(500),
      supabase.from('user_stores').select('user_id, store_id'),
      supabase.from('users').select('id, email, full_name, cedula_numero, telefono_personal').eq('role', 'cliente')
    ]);
    if (catsRes.data) setCategoriesList(catsRes.data);
    
    // Armar el mapa de dueños
    const userMap = new Map((usersRes.data || []).map(u => [u.id, u]));
    const storeToUser: Record<string, any> = {};
    for (const link of (linksRes.data || [])) {
      const u = userMap.get(link.user_id);
      if (u) storeToUser[link.store_id] = u;
    }
    setUsersByStore(storeToUser);
    if (storesRes.data) setStores(storesRes.data);
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

  const validateImage = (file: File): Promise<boolean> =>
    new Promise((resolve) => {
      if (file.size > 500 * 1024) { alert('El logo debe pesar menos de 500 KB.'); resolve(false); return; }
      const img = new Image();
      img.onload = () => {
        if (img.width > 800 || img.height > 800) {
          alert(`Dimensiones excedidas (${img.width}x${img.height}). Maximo: 800x800px.`);
          resolve(false);
        } else { resolve(true); }
      };
      img.src = URL.createObjectURL(file);
    });

  const validateDoc = (file: File): boolean => {
    if (file.size > 10 * 1024 * 1024) { alert('El documento debe pesar menos de 10 MB.'); return false; }
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
    if (!file) return;
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

    // Validación de capacidad del plan base (Diamante ≤ 2, Oro ≤ 30)
    if (planType) {
      const cap = PLAN_MAX_BRANDS[planType];
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
      if (currentCount >= FLASH_ADDON_MAX_BRANDS) {
        alert(
          `Límite alcanzado: ${currentCount}/${FLASH_ADDON_MAX_BRANDS} tiendas con addon ${PLAN_LABELS[flashCouponPlan]}.\n\n` +
          `Libera un cupo desactivando el addon en otra tienda.`
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      let finalLogoUrl = logoPreview || '';
      let finalContractUrl = contractUrl;
      let finalMercantilUrl = mercantilUrl;

      if (logoFile) {
        const ext = logoFile.name.split('.').pop();
        finalLogoUrl = await uploadLogo(logoFile, `logos/logo_${Date.now()}.${ext}`);
      }
      if (contractFile) {
        const ext = contractFile.name.split('.').pop();
        finalContractUrl = await uploadPrivateDoc(contractFile, `contratos/contrato_${Date.now()}.${ext}`);
      }
      if (mercantilFile) {
        const ext = mercantilFile.name.split('.').pop();
        finalMercantilUrl = await uploadPrivateDoc(mercantilFile, `mercantil/mercantil_${Date.now()}.${ext}`);
      }

      const storeData: any = {
        name,
        category_id: categoryId || null,
        floor_level: floorLevel,
        local_number: localNumber,
        description,
        logo_url: finalLogoUrl,
        plan_type: planType || null,
        rif: rif || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        contract_url: finalContractUrl || null,
        mercantil_url: finalMercantilUrl || null,
        contract_expiry_date: contractExpiryDate || null,
        flash_coupon_plan: flashCouponPlan || null,
        flash_coupon_expiry_date: flashCouponPlan ? (flashCouponExpiryDate || null) : null,
      };

      let storeId: string | null = editingId;
      if (editingId) {
        const { error } = await supabase.from('stores').update(storeData).eq('id', editingId);
        if (error) throw error;
      } else {
        const { data: inserted, error } = await supabase.from('stores').insert([storeData]).select('id').single();
        if (error) throw error;
        storeId = inserted?.id ?? null;
      }

      // La vinculación tienda↔cliente y el envío de magic links se hace en
      // /panel/clientes. Acá solo persistimos los campos de la tienda en sí.

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
    setFloorLevel(store.floor_level || '');
    setLocalNumber(store.local_number || '');
    setDescription(store.description || '');
    setPlanType(store.plan_type || '');
    setLogoPreview(store.logo_url || '');
    setLogoFile(null);
    setRif(store.rif || '');
    setContactEmail(store.contact_email || '');
    setContactPhone(store.contact_phone || '');
    setContractUrl(store.contract_url || '');
    setContractFile(null);
    setMercantilUrl(store.mercantil_url || '');
    setMercantilFile(null);
    setContractExpiryDate(store.contract_expiry_date || '');
    setFlashCouponPlan(store.flash_coupon_plan || '');
    setFlashCouponExpiryDate(store.flash_coupon_expiry_date || '');

    // Cargar el usuario vinculado a esta tienda (read-only). La gestión vive
    // en /panel/clientes.
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
    } else {
      setLinkedUser(null);
    }

    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm('Eliminar esta tienda?')) {
      await supabase.from('stores').delete().eq('id', id);
      fetchData();
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setName(''); setCategoryId(''); setFloorLevel(''); setLocalNumber('');
    setDescription(''); setPlanType(''); setLogoFile(null); setLogoPreview('');
    setRif('');
    setContactEmail(''); setContactPhone('');
    setContractFile(null); setContractUrl('');
    setMercantilFile(null); setMercantilUrl('');
    setContractExpiryDate('');
    setFlashCouponPlan('');
    setFlashCouponExpiryDate('');
    setLinkedUser(null);
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
              const saturated = used >= FLASH_ADDON_MAX_BRANDS;
              const tight = used >= FLASH_ADDON_MAX_BRANDS - 2;
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
                  + {PLAN_LABELS[opt]} <span className="font-mono">{used}/{FLASH_ADDON_MAX_BRANDS}</span>
                </span>
              );
            })}
            {PLAN_TYPES.map(p => {
              const cap = PLAN_MAX_BRANDS[p];
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
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre de la tienda</label>
                  <input
                    type="text" required value={name} onChange={(e) => setName(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: Cinex"
                  />
                </div>
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

              {/* ── Sección: Cliente vinculado (read-only) ──
                  La gestión completa (crear, editar, vincular/desvincular,
                  enviar magic link) vive en /panel/clientes. Acá solo
                  informamos quién es el dueño actual de la tienda. */}
              <div className="border-t border-white/5 pt-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
                    Cliente vinculado
                  </p>
                  <Link
                    href="/panel/clientes"
                    className="text-[10px] text-cyan-400 hover:text-cyan-300 underline"
                  >
                    Ir a Clientes →
                  </Link>
                </div>

                {editingId && linkedUser ? (
                  <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3">
                    <p className="text-sm text-white/85 font-medium truncate">
                      {linkedUser.full_name || <span className="text-white/40 italic">Sin nombre</span>}
                    </p>
                    <p className="text-[11px] text-white/50 truncate">{linkedUser.email}</p>
                    <div className="flex gap-3 mt-1 flex-wrap">
                      {linkedUser.cedula_numero && (
                        <span className="text-[10px] text-white/40 font-mono">
                          CI: {linkedUser.cedula_numero}
                        </span>
                      )}
                      {linkedUser.telefono_personal && (
                        <span className="text-[10px] text-white/40">
                          📱 {linkedUser.telefono_personal}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-white/40 bg-white/[0.02] border border-white/5 rounded-lg p-3">
                    {editingId
                      ? 'Esta tienda no tiene cliente vinculado. Vincúlala desde Clientes.'
                      : 'Tras crear la tienda, vincúlale un cliente desde Clientes.'}
                  </p>
                )}
              </div>

              {/* ── Sección: Documentación Legal ── */}
              <div className="border-t border-white/5 pt-5 space-y-4">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Documentacion Legal</p>

                {/* Contrato */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Contrato de Cesion de Espacios
                    {editingId && contractUrl && <span className="normal-case tracking-normal text-green-400/70 ml-2">(ya cargado)</span>}
                  </label>
                  <div className="flex items-center gap-3">
                    {contractUrl && !contractFile && (
                      <button
                        type="button"
                        onClick={() => openPrivateDoc(contractUrl)}
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
                        onChange={handleContractChange}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                      />
                      <p className="text-[10px] text-white/20 mt-1">PDF, JPG o PNG — Max 10MB</p>
                    </div>
                  </div>
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
                      <p className="text-[10px] text-white/20 mt-1">PDF, JPG o PNG — Max 10MB</p>
                    </div>
                  </div>
                </div>


                {/* Vencimiento del contrato */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vencimiento del Contrato</label>
                  <input
                    type="date"
                    value={contractExpiryDate}
                    onChange={(e) => setContractExpiryDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  />
                  {contractExpiryDate && isExpiringSoon(contractExpiryDate) && (
                    <p className="text-[10px] text-amber-400 mt-1">Contrato por vencer en menos de 30 dias</p>
                  )}
                </div>
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
                    const cap = PLAN_MAX_BRANDS[pt];
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
                {planType && PLAN_MAX_BRANDS[planType] != null && (() => {
                  const cap = PLAN_MAX_BRANDS[planType]!;
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
                    const saturated = used >= FLASH_ADDON_MAX_BRANDS;
                    const isSelected = flashCouponPlan === opt;
                    return (
                      <button
                        key={opt} type="button"
                        onClick={() => { if (!saturated || isSelected) setFlashCouponPlan(opt); }}
                        disabled={saturated && !isSelected}
                        title={saturated && !isSelected ? `Addon saturado: ${used}/${FLASH_ADDON_MAX_BRANDS}` : undefined}
                        className={`py-2 text-xs font-medium rounded-lg border transition-colors ${isSelected
                          ? `${PLAN_COLORS[opt]} border-current`
                          : saturated
                            ? 'bg-red-500/5 text-red-400/50 border-red-500/20 cursor-not-allowed'
                            : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'
                          }`}
                      >
                        <div>{PLAN_LABELS[opt]}</div>
                        <div className="text-[9px] opacity-70 font-mono mt-0.5">{used}/{FLASH_ADDON_MAX_BRANDS}</div>
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
                    <p className="text-[10px] text-white/20 mt-1">Max 500KB, rec 400x400px</p>
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
                  type="submit" disabled={submitting}
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
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 bg-white/5 px-2 py-0.5 rounded-md text-xs">{getCategoryName(store)}</span>
                  </td>
                  <td className="px-5 py-3.5 max-w-[120px]">
                    <span className="text-white/50 text-xs font-mono block truncate" title={`${store.floor_level} — ${store.local_number}`}>
                      {store.floor_level} — {store.local_number}
                    </span>
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
                      {/* Contrato */}
                      <span
                        title={store.contract_url ? 'Contrato cargado' : 'Sin contrato'}
                        className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${store.contract_url ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/15'}`}
                      >
                        C
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
                      {store.plan_type ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider ${PLAN_COLORS[store.plan_type] || 'text-white/40 bg-white/5'}`}>
                          {PLAN_LABELS[store.plan_type] || store.plan_type}
                        </span>
                      ) : !store.flash_coupon_plan ? (
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
  const [events, setEvents] = useState<any[]>([]);
  const [linkedUser, setLinkedUser] = useState<any>(null);

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
            .select('id, title, plan_type, code, amount_available, price_usd, category, start_date, end_date, campaign_id, created_at')
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
            .select('id, email, full_name, cedula_numero, telefono_personal')
            .eq('id', linkRes.data.user_id)
            .maybeSingle();
          if (!cancelled) setLinkedUser(u);
        }

        const campaignIds = camps.map(c => c.id);
        const couponIds = cps.map(c => c.id);

        // 2) Impresiones diarias para las campañas de la tienda (data K2)
        let impQuery = supabase
          .from('ad_impressions_daily')
          .select('campaign_id, kiosk_id, day, count')
          .order('day', { ascending: false });
        if (campaignIds.length) impQuery = impQuery.in('campaign_id', campaignIds);
        else impQuery = impQuery.eq('campaign_id', '00000000-0000-0000-0000-000000000000'); // ninguna
        if (rangeStart) impQuery = impQuery.gte('day', rangeStart.split('T')[0]);
        const impRes = await impQuery;

        // 3) Eventos K2 ligados a la tienda: por item_id (storeId/couponId/campaignId)
        //    o por item_name = nombre de la tienda.
        const idsForEvents = [store.id, ...couponIds, ...campaignIds].filter(Boolean);
        const evBaseSelect = 'id, kiosk_id, event_type, module, item_id, item_name, created_at, event_data';
        const queries: any[] = [];

        if (idsForEvents.length) {
          let q1: any = supabase.from('analytics_events').select(evBaseSelect)
            .in('item_id', idsForEvents)
            .order('created_at', { ascending: false })
            .limit(5000);
          if (rangeStart) q1 = q1.gte('created_at', rangeStart);
          queries.push(q1);
        }
        let q2: any = supabase.from('analytics_events').select(evBaseSelect)
          .eq('item_name', store.name)
          .order('created_at', { ascending: false })
          .limit(5000);
        if (rangeStart) q2 = q2.gte('created_at', rangeStart);
        queries.push(q2);

        const evResults: any[] = await Promise.all(queries);
        if (cancelled) return;

        const dedup = new Map<string, any>();
        for (const r of evResults) {
          for (const e of (r.data || [])) dedup.set(e.id, e);
        }

        setImpressionsDaily(impRes.data || []);
        setEvents(Array.from(dedup.values()).sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ));
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

  const flashCouponIds = useMemo(() => new Set(flashCoupons.map(c => c.id)), [flashCoupons]);
  const campaignIdsSet = useMemo(() => new Set(campaigns.map(c => c.id)), [campaigns]);

  const flashShownCount = useMemo(() =>
    events.filter(e => e.event_type === 'flash_coupon_shown' && (
      flashCouponIds.has(e.item_id) || e.item_name === store.name
    )).length,
    [events, flashCouponIds, store.name]);

  const campaignImpressionsTotal = useMemo(() =>
    impressionsDaily.reduce((s, d) => s + (d.count || 0), 0),
    [impressionsDaily]);

  const storeClicks = useMemo(() =>
    events.filter(e => (e.event_type === 'click' || e.event_type === 'tap') && (
      e.item_id === store.id || e.item_name === store.name
    )).length,
    [events, store.id, store.name]);

  const searchClickCount = useMemo(() =>
    events.filter(e => e.event_type === 'search_click' && (
      e.item_id === store.id || e.item_name === store.name
    )).length,
    [events, store.id, store.name]);

  const topSearchQueries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.event_type !== 'search_click') continue;
      if (e.item_id !== store.id && e.item_name !== store.name) continue;
      const q = String(e.event_data?.query || '').trim().toLowerCase();
      if (!q) continue;
      counts.set(q, (counts.get(q) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [events, store.id, store.name]);

  const uniqueKiosks = useMemo(() => {
    const set = new Set<string>();
    for (const d of impressionsDaily) if (d.kiosk_id) set.add(d.kiosk_id);
    for (const e of events) if (e.kiosk_id) set.add(e.kiosk_id);
    return set.size;
  }, [impressionsDaily, events]);

  // ── Agregados analíticos (todos respetan el rango seleccionado) ──────────
  const analyticsBreakdown = useMemo(() => {
    const byType: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    const byKiosk: Record<string, number> = {};
    const daySet = new Set<string>();
    let first: string | null = null;
    let last: string | null = null;

    for (const e of events) {
      byType[e.event_type] = (byType[e.event_type] || 0) + 1;
      const mod = e.module || '(sin módulo)';
      byModule[mod] = (byModule[mod] || 0) + 1;
      if (e.kiosk_id) byKiosk[e.kiosk_id] = (byKiosk[e.kiosk_id] || 0) + 1;
      const day = (e.created_at || '').split('T')[0];
      if (day) daySet.add(day);
      if (!first || e.created_at < first) first = e.created_at;
      if (!last || e.created_at > last) last = e.created_at;
    }

    const impByCampaign: Record<string, number> = {};
    const impByKiosk: Record<string, number> = {};
    for (const d of impressionsDaily) {
      impByCampaign[d.campaign_id] = (impByCampaign[d.campaign_id] || 0) + (d.count || 0);
      if (d.kiosk_id) impByKiosk[d.kiosk_id] = (impByKiosk[d.kiosk_id] || 0) + (d.count || 0);
    }

    const flashByCoupon: Record<string, number> = {};
    for (const e of events) {
      if (e.event_type !== 'flash_coupon_shown') continue;
      const cid = e.item_id || '';
      if (!flashCouponIds.has(cid)) continue;
      flashByCoupon[cid] = (flashByCoupon[cid] || 0) + 1;
    }

    return { byType, byModule, byKiosk, daySet, first, last, impByCampaign, impByKiosk, flashByCoupon };
  }, [events, impressionsDaily, flashCouponIds]);

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
    const eventsTotal = events.length;
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
        ['campania_impresiones', campaignImpressionsTotal],
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
      .map(d => [d.day, byCamp[d.campaign_id] || d.campaign_id, d.campaign_id, d.kiosk_id, d.count]);
    downloadCSV(`K2_${slug}_impresiones_diarias_${stamp}.csv`,
      ['fecha', 'campania', 'campaign_id', 'kiosk_id', 'impresiones'],
      rows);
  };

  const exportEvents = () => {
    if (!events.length) { alert('Sin eventos K2 en el rango.'); return; }
    const rows = events.map(e => [
      e.id,
      new Date(e.created_at).toISOString(),
      e.event_type,
      e.module || '',
      e.item_id || '',
      e.item_name || '',
      e.kiosk_id || '',
      flashCouponIds.has(e.item_id) ? 'flash' : campaignIdsSet.has(e.item_id) ? 'campaign' : e.item_id === store.id ? 'store' : 'related',
      e.event_data ? JSON.stringify(e.event_data) : '',
    ]);
    downloadCSV(`K2_${slug}_eventos_${stamp}.csv`,
      ['event_id', 'fecha_iso', 'event_type', 'module', 'item_id', 'item_name', 'kiosk_id', 'origen', 'event_data_json'],
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
      c.price_usd,
      c.start_date || '',
      c.end_date || '',
      c.campaign_id || '',
      c.created_at,
    ]);
    downloadCSV(`K2_${slug}_cupones_${stamp}.csv`,
      ['coupon_id', 'titulo', 'codigo', 'plan_type', 'es_flash', 'categoria', 'cantidad_disponible', 'precio_usd', 'inicio', 'fin', 'campaign_id', 'creado_en'],
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
                        ? events.filter(e => e.event_type === 'flash_coupon_shown' && e.item_id === c.id).length
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
                <span className={store.contract_url ? 'text-emerald-400' : 'text-white/20'}>● Contrato</span>{' '}
                <span className={store.mercantil_url ? 'text-emerald-400' : 'text-white/20'} >● Mercantil</span>{' '}
                <span className={linkedUser?.cedula_url ? 'text-emerald-400' : 'text-white/20'}>● Cédula</span>
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
              <button onClick={exportEvents} disabled={loading || !events.length}
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
