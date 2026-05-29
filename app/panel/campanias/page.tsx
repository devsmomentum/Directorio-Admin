'use client';

import { Suspense, useState, useEffect, useMemo, ChangeEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '../../../lib/supabase';
import { removePublicidadFile } from '../../../lib/storage';
import Pagination, { usePagination } from '../../components/Pagination';
import KioskAssignment from './KioskAssignment';

function getDaysUntilExpiry(endDate: string | null): number | null {
  if (!endDate) return null;
  const diff = new Date(endDate).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function getExpiryUrgency(endDate: string | null): 'critical' | 'warning' | null {
  const days = getDaysUntilExpiry(endDate);
  if (days === null || days < 0) return null;
  if (days <= 3) return 'critical';
  if (days <= 7) return 'warning';
  return null;
}

// Planes elegibles para el loop publicitario de directorios (PDF "PLANES DIRECTORIOS")
const PLAN_TYPES = ['DIAMANTE', 'ORO', 'PUBLI_PROMO_DIARIO', 'PUBLI_PROMO_SEMANAL'] as const;

// Capacidad máxima de marcas activas por plan (hard cap)
const PLAN_MAX_BRANDS: Record<string, number | null> = {
  DIAMANTE: 2,
  ORO: 30,
  PUBLI_PROMO_DIARIO: null,
  PUBLI_PROMO_SEMANAL: null,
};

// Frecuencia objetivo del loop por plan (cada cuántos segundos aparece la marca)
const PLAN_FREQUENCY_SECONDS: Record<string, number> = {
  DIAMANTE: 180,
  ORO: 180,
  PUBLI_PROMO_DIARIO: 180,
  PUBLI_PROMO_SEMANAL: 180,
};

const CAMPAIGN_DURATION_SECONDS = 15;
const LOOP_TARGET_SLOTS = 12;          // 12 slots × 15s = 180s = 3 min
const LOOP_EXTENDED_SLOTS = 22;        // Escenario ampliado: 22 slots × 15s = 330s = 5,5 min

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  ORO: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  PUBLI_PROMO_DIARIO: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  PUBLI_PROMO_SEMANAL: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
};

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
};

interface Store { id: string; name: string; }

interface Campaign {
  id: string;
  brand_name: string;
  plan_type: string;
  media_url: string;
  media_type: string;
  duration_seconds: number;
  start_date: string;
  end_date: string | null;
  is_active: boolean;
  description: string | null;
  priority_level: number;
  slot_limit_group: string | null;
  target_frequency_seconds: number | null;
  store_id: string | null;
  stores?: { name: string; contract_expiry_date: string | null };
}

type Tab = 'campaigns' | 'kioscos';

function CampaniasAdminInner() {
  const searchParams = useSearchParams();
  const highlightExpiring = searchParams.get('highlight') === 'expiring';

  const [activeTab, setActiveTab] = useState<Tab>('campaigns');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Kill-switch state
  const [killSwitchCandidates, setKillSwitchCandidates] = useState<Campaign[]>([]);
  const [applyingKillSwitch, setApplyingKillSwitch] = useState(false);

  // Form Fields
  const [editingId, setEditingId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState('');
  const [planType, setPlanType] = useState<string>('ORO');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState<string>('');
  const [storeId, setStoreId] = useState<string>('');
  const [priorityLevel, setPriorityLevel] = useState<number>(1);
  const [slotLimitGroup, setSlotLimitGroup] = useState<string>('');
  const [isActive, setIsActive] = useState<boolean>(true);

  // File handling
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState('');
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [campRes, storesRes] = await Promise.all([
      supabase.from('ad_campaigns').select('*, stores(name, contract_expiry_date)').order('created_at', { ascending: false }).limit(200),
      supabase.from('stores').select('id, name').order('name').limit(500)
    ]);
    if (campRes.data) {
      const data = campRes.data as Campaign[];
      setCampaigns(data);
      // Campañas activas que deberían estar apagadas: vencidas o con plan-tienda vencido
      const today = new Date().toISOString().split('T')[0];
      const overdue = data.filter(c => {
        if (!c.is_active) return false;
        const expiredEnd = c.end_date && c.end_date < today;
        const expiredPlan = c.stores?.contract_expiry_date && c.stores.contract_expiry_date < today;
        return expiredEnd || expiredPlan;
      });
      setKillSwitchCandidates(overdue);
    }
    if (storesRes.data) setStores(storesRes.data);
    setLoading(false);
    setRefreshing(false);
  };

  // Estado actual del loop: marcas activas, vigentes y pagas que ocupan slots
  const loopStatus = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const loopPlans = new Set<string>(['DIAMANTE', 'ORO', 'PUBLI_PROMO', 'PUBLI_PROMO_DIARIO', 'PUBLI_PROMO_SEMANAL']);
    const live = campaigns.filter(c =>
      c.is_active &&
      loopPlans.has(c.plan_type) &&
      (!c.end_date || c.end_date >= today) &&
      (!c.stores?.contract_expiry_date || c.stores.contract_expiry_date >= today)
    );
    const byPlan = live.reduce<Record<string, number>>((acc, c) => {
      acc[c.plan_type] = (acc[c.plan_type] || 0) + 1;
      return acc;
    }, {});
    const slots = live.length;
    return {
      slots,
      durationSeconds: slots * CAMPAIGN_DURATION_SECONDS,
      byPlan,
      overTarget: slots > LOOP_TARGET_SLOTS,
      overExtended: slots > LOOP_EXTENDED_SLOTS,
    };
  }, [campaigns]);

  const resetForm = () => {
    setEditingId(null);
    setBrandName(''); setPlanType('ORO'); setDescription('');
    setStartDate(new Date().toISOString().split('T')[0]);
    setEndDate(''); setStoreId(''); setPriorityLevel(1);
    setSlotLimitGroup(''); setIsActive(true);
    setMediaFile(null); setMediaPreview(''); setMediaType('image');
    setShowForm(false);
  };

  const urgencyRank = (c: Campaign) => {
    const u = getExpiryUrgency(c.end_date);
    if (u === 'critical') return 0;
    if (u === 'warning') return 1;
    return 2;
  };

  const filtered = useMemo(() => {
    let result = campaigns;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(c =>
        c.brand_name.toLowerCase().includes(q) ||
        c.plan_type.toLowerCase().includes(q) ||
        (c.stores?.name || '').toLowerCase().includes(q)
      );
    }
    if (highlightExpiring) {
      result = [...result].sort((a, b) => urgencyRank(a) - urgencyRank(b));
    }
    return result;
  }, [campaigns, search, highlightExpiring]);

  const pg = usePagination(filtered);

  const handleEdit = (c: Campaign) => {
    setEditingId(c.id);
    setBrandName(c.brand_name);
    setPlanType((PLAN_TYPES as readonly string[]).includes(c.plan_type) ? c.plan_type : 'ORO');
    setDescription(c.description || '');
    setStartDate(c.start_date || '');
    setEndDate(c.end_date || '');
    setStoreId(c.store_id || '');
    setPriorityLevel(c.priority_level || 1);
    setSlotLimitGroup(c.slot_limit_group || '');
    setIsActive(c.is_active);
    setMediaPreview(c.media_url);
    setMediaType(c.media_type as 'image' | 'video');
    setMediaFile(null);
    setShowForm(true);
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const isVideo = file.type.startsWith('video/');
      const isImage = file.type.startsWith('image/');

      if (!isVideo && !isImage) {
        alert('Formato no soportado. Sube una imagen (JPG/PNG/WEBP) o un video (MP4/WEBM).');
        e.target.value = '';
        return;
      }

      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const allowedImageExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
      const allowedVideoExt = ['mp4', 'webm', 'mov', 'm4v'];
      if (isImage && !allowedImageExt.includes(ext)) {
        alert(`Extensión "${ext}" no permitida para imagen. Usa: ${allowedImageExt.join(', ')}.`);
        e.target.value = '';
        return;
      }
      if (isVideo && !allowedVideoExt.includes(ext)) {
        alert(`Extensión "${ext}" no permitida para video. Usa: ${allowedVideoExt.join(', ')}.`);
        e.target.value = '';
        return;
      }

      const maxSize = isVideo ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > maxSize) {
        alert(`El archivo excede el límite (${isVideo ? '50MB para video' : '5MB para imagen'}).`);
        e.target.value = '';
        return;
      }
      setMediaFile(file);
      setMediaType(isVideo ? 'video' : 'image');
      setMediaPreview(URL.createObjectURL(file));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId && !mediaFile) { alert('Debes subir un archivo multimedia.'); return; }

    // Validación de capacidad: bloquear si el plan está saturado
    const cap = PLAN_MAX_BRANDS[planType];
    if (cap != null && isActive) {
      const today = new Date().toISOString().split('T')[0];
      const currentActive = campaigns.filter(c =>
        c.id !== editingId &&
        c.plan_type === planType &&
        c.is_active &&
        (!c.end_date || c.end_date >= today) &&
        (!c.stores?.contract_expiry_date || c.stores.contract_expiry_date >= today)
      ).length;
      if (currentActive >= cap) {
        alert(
          `Límite alcanzado: ${currentActive}/${cap} marcas activas con plan ${PLAN_LABELS[planType] || planType}.\n\n` +
          `Para añadir esta campaña, libera un slot pausando o dejando vencer otra marca con el mismo plan.`
        );
        return;
      }
    }

    setIsSaving(true);

    try {
      const previousMediaUrl = editingId
        ? campaigns.find(c => c.id === editingId)?.media_url ?? null
        : null;

      let finalUrl = mediaPreview;
      if (mediaFile) {
        const ext = mediaFile.name.split('.').pop();
        const safeBrand = brandName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = `camp_${safeBrand}_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage.from('publicidad').upload(`campaigns/${fileName}`, mediaFile, { upsert: true });
        if (upErr) throw upErr;
        const { data: pubData } = supabase.storage.from('publicidad').getPublicUrl(`campaigns/${fileName}`);
        finalUrl = pubData.publicUrl;
      }

      const payload: any = {
        brand_name: brandName,
        plan_type: planType,
        media_url: finalUrl,
        media_type: mediaType,
        duration_seconds: CAMPAIGN_DURATION_SECONDS,
        start_date: startDate ? new Date(startDate).toISOString().split('T')[0] : null,
        end_date: endDate ? new Date(endDate).toISOString().split('T')[0] : null,
        is_active: isActive,
        description: description,
        priority_level: priorityLevel,
        slot_limit_group: slotLimitGroup || null,
        target_frequency_seconds: PLAN_FREQUENCY_SECONDS[planType] || null,
        store_id: storeId || null,
      };

      if (editingId) {
        const { error } = await supabase.from('ad_campaigns').update(payload).eq('id', editingId);
        if (error) throw error;
        if (mediaFile && previousMediaUrl && previousMediaUrl !== finalUrl) {
          await removePublicidadFile(previousMediaUrl);
        }
      } else {
        const { error } = await supabase.from('ad_campaigns').insert([payload]);
        if (error) throw error;
      }

      resetForm();
      fetchData();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string, url: string) => {
    if (!confirm('Eliminar campaña permanentemente?')) return;
    try {
      const { error } = await supabase.from('ad_campaigns').delete().eq('id', id);
      if (error) throw error;
      await removePublicidadFile(url);
      fetchData();
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  const handleToggleActive = async (id: string, current: boolean) => {
    if (current) {
      if (!confirm('¿Deseas pausar esta campaña?')) return;
      if (!confirm('¿Confirmas pausar la campaña?')) return;
    }
    const { error } = await supabase.from('ad_campaigns').update({ is_active: !current }).eq('id', id);
    if (!error) {
      setCampaigns(prev => prev.map(c => c.id === id ? { ...c, is_active: !current } : c));
    }
  };

  const handleApplyKillSwitch = async () => {
    if (!killSwitchCandidates.length) return;
    const names = killSwitchCandidates.map(c => `• ${c.brand_name}`).join('\n');
    if (!confirm(`Desactivar ${killSwitchCandidates.length} campaña(s) vencida(s):\n\n${names}\n\nSe quitarán del loop de pantallas.`)) return;

    setApplyingKillSwitch(true);
    try {
      const ids = killSwitchCandidates.map(c => c.id);
      const { error } = await supabase
        .from('ad_campaigns')
        .update({ is_active: false })
        .in('id', ids);
      if (error) throw error;
      setKillSwitchCandidates([]);
      fetchData();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setApplyingKillSwitch(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-y-3">
        <div className="min-w-0">
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Publicidad</p>
          <h2 className="text-2xl font-bold text-white">Campañas Publicitarias</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={fetchData} disabled={refreshing} className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50">
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? 'Actualizando...' : 'Actualizar'}
          </button>
          {activeTab === 'campaigns' && (
            <button onClick={() => { resetForm(); setShowForm(true); }} className="flex items-center gap-2 text-sm font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20 hover:bg-orange-500/20 rounded-lg px-4 py-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
              Nueva Campaña
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 bg-white/[0.03] border border-white/5 rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveTab('campaigns')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'campaigns' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/25' : 'text-white/40 hover:text-white/70'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.882V15a1 1 0 01-1.447.894L15 13.5M4 6a2 2 0 012-2h9a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" /></svg>
          Campañas
          <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded font-mono">{campaigns.length}</span>
        </button>
        <button
          onClick={() => setActiveTab('kioscos')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'kioscos' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/25' : 'text-white/40 hover:text-white/70'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
          Asignación por Kiosco
        </button>
      </div>

      {activeTab === 'campaigns' && (
        <>
          {/* ── Estado del loop publicitario ── */}
          <div className={`rounded-xl border p-4 ${
            loopStatus.overExtended
              ? 'bg-red-950/30 border-red-500/30'
              : loopStatus.overTarget
              ? 'bg-amber-950/20 border-amber-500/25'
              : 'bg-white/[0.03] border-white/10'
          }`}>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium mb-0.5">Loop actual</p>
                  <p className="text-white font-mono text-xl">
                    {loopStatus.slots}<span className="text-white/30 text-sm">/{LOOP_TARGET_SLOTS}</span>
                    <span className="text-white/30 text-xs ml-2">slots</span>
                  </p>
                </div>
                <div className="h-10 w-px bg-white/10" />
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium mb-0.5">Duración</p>
                  <p className="text-white font-mono text-xl">
                    {Math.floor(loopStatus.durationSeconds / 60)}:{String(loopStatus.durationSeconds % 60).padStart(2, '0')}
                    <span className="text-white/30 text-xs ml-2">min</span>
                  </p>
                </div>
                <div className="h-10 w-px bg-white/10" />
                <div className="flex items-center gap-2 flex-wrap">
                  {PLAN_TYPES.map(p => {
                    const cap = PLAN_MAX_BRANDS[p];
                    const used = (p === 'PUBLI_PROMO_DIARIO' || p === 'PUBLI_PROMO_SEMANAL')
                      ? (loopStatus.byPlan[p] || 0) + (loopStatus.byPlan['PUBLI_PROMO'] || 0)
                      : (loopStatus.byPlan[p] || 0);
                    const saturated = cap != null && used >= cap;
                    return (
                      <span key={p} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium border ${
                        saturated
                          ? 'bg-red-500/15 text-red-400 border-red-500/30'
                          : `${PLAN_COLORS[p]}`
                      }`}>
                        {PLAN_LABELS[p]} <span className="font-mono">{used}{cap != null ? `/${cap}` : ''}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
              <p className="text-[11px] text-white/40 max-w-xs">
                {loopStatus.overExtended
                  ? `Excediste el escenario ampliado de ${LOOP_EXTENDED_SLOTS} slots. La frecuencia bajará por debajo del estándar.`
                  : loopStatus.overTarget
                  ? `Pasaste el loop base de 3 min. Estás en escenario ampliado (cap. ${LOOP_EXTENDED_SLOTS}).`
                  : `Cada slot dura ${CAMPAIGN_DURATION_SECONDS}s. Loop base = 3 min con 12 slots.`}
              </p>
            </div>
          </div>

          {/* ── Kill-Switch Alert ── */}
          {killSwitchCandidates.length > 0 && (
            <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <svg className="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                    <p className="text-red-400 font-semibold text-sm">{killSwitchCandidates.length} campaña{killSwitchCandidates.length > 1 ? 's' : ''} vencida{killSwitchCandidates.length > 1 ? 's' : ''} activa{killSwitchCandidates.length > 1 ? 's' : ''}</p>
                  </div>
                  <p className="text-red-300/50 text-xs mb-3">Estas campañas pasaron su fecha de fin pero siguen activas. El cron las desactivará en la próxima corrida, o puedes hacerlo manualmente ahora.</p>
                  <div className="space-y-1.5">
                    {killSwitchCandidates.map(c => (
                      <div key={c.id} className="flex items-center bg-red-500/5 rounded-lg px-3 py-1.5">
                        <span className="text-white/70 text-xs font-medium">{c.brand_name}</span>
                        {c.end_date && (
                          <span className="text-red-300/50 text-[10px] ml-2">
                            Venció: {new Date(c.end_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <button
                  onClick={handleApplyKillSwitch}
                  disabled={applyingKillSwitch}
                  className="shrink-0 px-4 py-2 text-sm font-semibold bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {applyingKillSwitch ? 'Desactivando...' : 'Desactivar ahora'}
                </button>
              </div>
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por marca o plan..." className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10" />
          </div>

          {/* Highlight expiring banner */}
          {highlightExpiring && (
            <div className="flex items-center gap-3 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3">
              <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              <p className="text-amber-400 text-sm font-medium">
                Mostrando campañas por vencer &nbsp;·&nbsp;
                <span className="text-red-400 font-normal">Rojo</span> = ≤3 días &nbsp;·&nbsp;
                <span className="text-amber-400 font-normal">Amarillo</span> = ≤7 días
              </p>
            </div>
          )}

          {/* Campaign grid */}
          {campaigns.length === 0 ? (
            <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
              <p className="text-white/30 text-sm">No hay campañas registradas</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {pg.paginated.map((c) => {
                const isVideo = c.media_type === 'video';
                const isExpired = !!c.end_date && new Date(c.end_date) < new Date();
                const planExpired = !!c.stores?.contract_expiry_date && new Date(c.stores.contract_expiry_date) < new Date();
                const isInactive = isExpired || planExpired;
                const isActiveState = c.is_active && !isInactive;

                const statusLabel = planExpired
                  ? 'Plan vencido'
                  : isExpired
                  ? 'Vencida'
                  : (c.is_active ? 'Activo' : 'Pausado');
                const statusClasses = isInactive
                  ? 'bg-white/5 text-white/30'
                  : (c.is_active ? 'bg-orange-500/10 text-orange-400' : 'bg-white/5 text-white/30');
                const dotClasses = isInactive
                  ? 'bg-white/20'
                  : (c.is_active ? 'bg-orange-400' : 'bg-white/20');

                const urgency = getExpiryUrgency(c.end_date);
                const daysLeft = getDaysUntilExpiry(c.end_date);

                let cardClasses = `bg-[#111] border rounded-xl overflow-hidden group transition-all ${isActiveState ? 'border-white/10' : 'border-white/5 opacity-70'}`;
                if (highlightExpiring && urgency === 'critical') {
                  cardClasses = 'bg-red-950/25 border border-red-500/50 ring-1 ring-red-500/20 rounded-xl overflow-hidden group transition-all';
                } else if (highlightExpiring && urgency === 'warning') {
                  cardClasses = 'bg-amber-950/20 border border-amber-400/40 ring-1 ring-amber-400/10 rounded-xl overflow-hidden group transition-all';
                }

                return (
                  <div key={c.id} className={cardClasses}>
                    <div className="h-40 bg-black relative">
                      {isVideo
                        ? <video
                            src={c.media_url}
                            className="w-full h-full object-cover"
                            muted
                            autoPlay
                            loop
                            playsInline
                            onError={(e) => { (e.currentTarget as HTMLVideoElement).style.display = 'none'; }}
                          />
                        : <img
                            src={c.media_url}
                            className="w-full h-full object-cover"
                            alt={c.brand_name}
                            onError={(e) => {
                              const t = e.currentTarget as HTMLImageElement;
                              t.style.display = 'none';
                            }}
                          />}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                      <div className="absolute top-3 right-3 flex flex-col items-end gap-1">
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${PLAN_COLORS[c.plan_type] || 'text-white border-white'}`}>
                          {PLAN_LABELS[c.plan_type] || c.plan_type}
                        </span>
                        {daysLeft !== null && daysLeft >= 0 && daysLeft <= 7 && (
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${urgency === 'critical' ? 'text-red-400 bg-red-500/20 border-red-500/40' : 'text-amber-400 bg-amber-500/15 border-amber-400/30'}`}>
                            {daysLeft === 0 ? 'Vence hoy' : `${daysLeft}d`}
                          </span>
                        )}
                      </div>
                      <div className="absolute bottom-3 left-3">
                        <h3 className="text-white font-semibold">{c.brand_name}</h3>
                        {c.stores?.name && <p className="text-white/50 text-[10px]">Tienda: {c.stores.name}</p>}
                      </div>
                    </div>

                    <div className="p-4 space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-white/40">Duración</span>
                        <span className="text-white font-mono">{c.duration_seconds}s</span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-white/40">Fechas</span>
                        <span className="text-white/70">
                          {new Date(c.start_date).toLocaleDateString()} {c.end_date ? `— ${new Date(c.end_date).toLocaleDateString()}` : '∞'}
                        </span>
                      </div>

                      <div className="pt-3 border-t border-white/5 flex items-center justify-between">
                        <button
                          onClick={() => handleToggleActive(c.id, c.is_active)}
                          className={`text-[10px] flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${statusClasses}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${dotClasses}`} />
                          {statusLabel}
                        </button>

                        <div className="flex gap-1">
                          <button onClick={() => handleEdit(c)} className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                          <button onClick={() => handleDelete(c.id, c.media_url)} className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {pg.totalPages > 1 && (
            <Pagination page={pg.page} totalPages={pg.totalPages} total={pg.total} perPage={pg.perPage} label="campañas" onPageChange={pg.setPage} onPerPageChange={pg.changePerPage} />
          )}
        </>
      )}

      {/* Tab: Kiosco assignment */}
      {activeTab === 'kioscos' && <KioskAssignment />}

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-semibold text-white mb-5">{editingId ? 'Editar Campaña' : 'Nueva Campaña'}</h3>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Marca / Anunciante</label>
                  <input type="text" required value={brandName} onChange={e => setBrandName(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Tienda Vinculada</label>
                  <select value={storeId} onChange={e => setStoreId(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none">
                    <option value="">Ninguna</option>
                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripción Interna</label>
                <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan de pauta</label>
                  <select required value={planType} onChange={e => setPlanType(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none">
                    {PLAN_TYPES.map(p => {
                      const cap = PLAN_MAX_BRANDS[p];
                      const used = (loopStatus.byPlan[p] || 0);
                      const label = PLAN_LABELS[p] || p;
                      const tag = cap != null ? ` — ${used}/${cap}` : '';
                      return <option key={p} value={p}>{label}{tag}</option>;
                    })}
                  </select>
                  {(() => {
                    const cap = PLAN_MAX_BRANDS[planType];
                    if (cap == null) return null;
                    const used = (loopStatus.byPlan[planType] || 0) - (editingId && campaigns.find(c => c.id === editingId)?.plan_type === planType ? 1 : 0);
                    const remaining = cap - used;
                    return (
                      <p className={`text-[10px] mt-1 ${remaining <= 0 ? 'text-red-400' : remaining <= 2 ? 'text-amber-400' : 'text-white/30'}`}>
                        {remaining <= 0
                          ? `Plan saturado (${used}/${cap}) — no podrás guardar`
                          : `Disponibles: ${remaining}/${cap}`}
                      </p>
                    );
                  })()}
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Prioridad (1 = Mayor)</label>
                  <input type="number" min="1" value={priorityLevel} onChange={e => setPriorityLevel(parseInt(e.target.value) || 1)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Grupo Limitación Slot</label>
                <input type="text" value={slotLimitGroup} onChange={e => setSlotLimitGroup(e.target.value)} placeholder="Ej: FOOD_COURT" className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio Campaña</label>
                  <input type="date" required value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin Campaña (Fecha de Corte)</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Media — Imagen o Video (1920×1080 px) {editingId && <span className="normal-case tracking-normal">(dejar vacío para mantener)</span>}
                </label>
                <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={handleFileChange} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:bg-white/10 file:text-white" />
                <p className="text-[10px] text-white/30 mt-1">
                  Formatos: JPG, PNG, WEBP, GIF (máx 5MB) · MP4, WEBM, MOV (máx 50MB).
                  {mediaFile && (
                    <span className={`ml-2 px-1.5 py-0.5 rounded ${mediaType === 'video' ? 'bg-purple-500/15 text-purple-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                      Detectado: {mediaType === 'video' ? 'Video' : 'Imagen'}
                    </span>
                  )}
                </p>
                {mediaPreview && (
                  <div className="mt-2 h-32 bg-black rounded-lg border border-white/5 overflow-hidden flex items-center justify-center">
                    {mediaType === 'video'
                      ? <video src={mediaPreview} className="h-full object-contain" muted autoPlay loop playsInline />
                      : <img src={mediaPreview} className="h-full object-contain" alt="preview" />}
                  </div>
                )}
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={resetForm} className="flex-1 py-2 text-sm bg-white/5 hover:bg-white/10 text-white/50 rounded-lg transition-colors">Cancelar</button>
                <button type="submit" disabled={isSaving} className="flex-1 py-2 text-sm bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border border-orange-500/30 rounded-lg disabled:opacity-50 transition-colors">
                  {isSaving ? 'Guardando...' : 'Guardar Campaña'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CampaniasAdminPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#050505] flex items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-orange-500/20 border-t-orange-500" />
        </div>
      }
    >
      <CampaniasAdminInner />
    </Suspense>
  );
}
