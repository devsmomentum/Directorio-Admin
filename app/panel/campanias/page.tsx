'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { Suspense, useState, useEffect, useMemo, ChangeEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';
import { removePublicidadFile } from '../../../lib/storage';
import { PLAN_LABELS, PLAN_BADGE_BORDERED as PLAN_COLORS } from '../../../lib/plans';
import { validateKioskVideo } from '../../../lib/videoValidation';
import Pagination, { usePagination } from '../../components/Pagination';
import { toast } from '../../components/toast';
import { confirmDialog } from '../../components/confirm-dialog';
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

// Fallback si la BD no responde; sobrescrito en fetchData con plans.max_brands.
const PLAN_MAX_BRANDS_FALLBACK: Record<string, number | null> = {
  DIAMANTE: 2,
  ORO: 30,
};

// Frecuencia objetivo del loop por plan (cada cuántos segundos aparece la marca)
const PLAN_FREQUENCY_SECONDS: Record<string, number> = {
  DIAMANTE: 180,
  ORO: 180,
  PUBLI_PROMO_DIARIO: 180,
  PUBLI_PROMO_SEMANAL: 180,
};

// Duración por defecto (fallback) cuando un plan no define video_seconds.
// La duración real de cada campaña vive en ad_campaigns.duration_seconds y el
// loop se calcula sumando esas duraciones (no asumiendo 15s fijos).
const CAMPAIGN_DURATION_SECONDS = 15;

interface Store { id: string; name: string; contract_expiry_date: string | null; plan_type: string | null; }

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
  admin_managed: boolean;
  stores?: { name: string; contract_expiry_date: string | null };
}

type Tab = 'campaigns' | 'kioscos' | 'loop';

function CampaniasAdminInner() {
  const searchParams = useSearchParams();
  const highlightExpiring = searchParams.get('highlight') === 'expiring';

  const [activeTab, setActiveTab] = useState<Tab>('campaigns');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [plans, setPlans] = useState<{ plan_key: string; video_seconds: number | null; max_brands: number | null; loop_eligible: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [storeFilter, setStoreFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused' | 'expired'>('all');
  const [isSaving, setIsSaving] = useState(false);

  // Tamaño del loop en slots: suma de plans.max_brands donde loop_eligible = true.
  // Configurable desde /panel/configuracion → Slots por plan.
  const [loopMaxSlots, setLoopMaxSlots] = useState<number>(32);

  // Kill-switch state
  const [killSwitchCandidates, setKillSwitchCandidates] = useState<Campaign[]>([]);
  const [applyingKillSwitch, setApplyingKillSwitch] = useState(false);

  // Reactivación de campañas vencidas (flujo admin: pide nueva fecha de fin)
  const [reactivateTarget, setReactivateTarget] = useState<Campaign | null>(null);
  const [reactivateEnd, setReactivateEnd] = useState<string>('');
  const [savingReactivate, setSavingReactivate] = useState(false);

  // Form Fields
  const [editingId, setEditingId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState('');
  const [planType, setPlanType] = useState<string>('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState<string>('');
  const [storeId, setStoreId] = useState<string>('');
  const [priorityLevel, setPriorityLevel] = useState<number>(1);
  const [slotLimitGroup, setSlotLimitGroup] = useState<string>('');
  const [durationSeconds, setDurationSeconds] = useState<number>(CAMPAIGN_DURATION_SECONDS);
  const [isActive, setIsActive] = useState<boolean>(true);
  const [adminManaged, setAdminManaged] = useState<boolean>(true);

  // Duración "general" definida en el plan (plans.video_seconds). Sirve como
  // valor por defecto al elegir un plan; la campaña puede sobreescribirla.
  const planVideoSeconds = (key: string): number => {
    const p = plans.find(pl => pl.plan_key === key);
    return p && p.video_seconds != null && p.video_seconds > 0 ? p.video_seconds : CAMPAIGN_DURATION_SECONDS;
  };

  // File handling
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState('');
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [campRes, storesRes, plansRes] = await Promise.all([
      supabase.from('ad_campaigns').select('*, stores(name, contract_expiry_date)').order('created_at', { ascending: false }).limit(200),
      supabase.from('stores').select('id, name, contract_expiry_date, plan_type').order('name').limit(500),
      supabase.from('plans').select('plan_key, video_seconds, max_brands, loop_eligible').limit(200),
    ]);
    if (plansRes.data) {
      const plansData = plansRes.data as { plan_key: string; video_seconds: number | null; max_brands: number | null; loop_eligible: boolean }[];
      setPlans(plansData);
      // Tamaño del loop = suma de max_brands de planes con loop_eligible = true.
      const computed = plansData
        .filter(p => p.loop_eligible && p.max_brands != null)
        .reduce((s, p) => s + (p.max_brands ?? 0), 0);
      if (computed > 0) setLoopMaxSlots(computed);
    }
    if (campRes.data) {
      const data = campRes.data as Campaign[];
      setCampaigns(data);
      // Campañas activas que deberían estar apagadas: vencidas o con plan-tienda vencido
      const today = new Date().toISOString().split('T')[0];
      const overdue = data.filter(c => {
        if (!c.is_active) return false;
        const expiredEnd = c.end_date && c.end_date < today;
        const expiredPlan = !c.admin_managed && c.stores?.contract_expiry_date && c.stores.contract_expiry_date < today;
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
    const loopEligibleKeys = new Set(plans.filter(p => p.loop_eligible).map(p => p.plan_key));
    const live = campaigns.filter(c =>
      c.is_active &&
      loopEligibleKeys.has(c.plan_type) &&
      (!c.end_date || c.end_date >= today) &&
      (!c.stores?.contract_expiry_date || c.stores.contract_expiry_date >= today || c.admin_managed)
    );
    const byPlan = live.reduce<Record<string, number>>((acc, c) => {
      acc[c.plan_type] = (acc[c.plan_type] || 0) + 1;
      return acc;
    }, {});
    const slots = live.length;
    // Duración real del loop = suma de la duración de cada campaña viva.
    const durationSeconds = live.reduce(
      (sum, c) => sum + (c.duration_seconds || CAMPAIGN_DURATION_SECONDS),
      0
    );
    // El cap es en slots: 1 campaña activa = 1 slot, sin importar duración del video.
    const pct = loopMaxSlots > 0 ? slots / loopMaxSlots : 0;
    return {
      slots,
      durationSeconds,   // informativo (suma de segundos de todas las campañas vivas)
      byPlan,
      pct,
      overTarget: pct >= 0.75,
      overExtended: pct >= 1,
    };
  }, [campaigns, loopMaxSlots, plans]);

  const resetForm = () => {
    setEditingId(null);
    setBrandName(''); setPlanType(''); setDescription('');
    setStartDate(new Date().toISOString().split('T')[0]);
    setEndDate(''); setStoreId(''); setPriorityLevel(1);
    setSlotLimitGroup(''); setDurationSeconds(planVideoSeconds('ORO')); setIsActive(true); setAdminManaged(true);
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
        (c.plan_type || '').toLowerCase().includes(q) ||
        (c.stores?.name || '').toLowerCase().includes(q)
      );
    }
    if (storeFilter) {
      result = result.filter(c => c.store_id === storeFilter);
    }
    if (statusFilter !== 'all') {
      result = result.filter(c => {
        const isExpired = !!c.end_date && new Date(c.end_date) < new Date();
        const planExpired = !c.admin_managed && !!c.stores?.contract_expiry_date && new Date(c.stores.contract_expiry_date) < new Date();
        const inactive = isExpired || planExpired;
        if (statusFilter === 'expired') return inactive;
        if (statusFilter === 'active') return c.is_active && !inactive;
        if (statusFilter === 'paused') return !c.is_active && !inactive;
        return true;
      });
    }
    if (highlightExpiring) {
      result = [...result].sort((a, b) => urgencyRank(a) - urgencyRank(b));
    }
    return result;
  }, [campaigns, search, storeFilter, statusFilter, highlightExpiring]);

  const pg = usePagination(filtered);

  const handleEdit = (c: Campaign) => {
    setEditingId(c.id);
    setBrandName(c.brand_name);
    setPlanType(stores.find(s => s.id === c.store_id)?.plan_type || '');
    setDescription(c.description || '');
    setStartDate(c.start_date || '');
    setEndDate(c.end_date || '');
    setStoreId(c.store_id || '');
    setPriorityLevel(c.priority_level || 1);
    setSlotLimitGroup(c.slot_limit_group || '');
    setDurationSeconds(c.duration_seconds || CAMPAIGN_DURATION_SECONDS);
    setIsActive(c.is_active);
    setAdminManaged(!!c.admin_managed);
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
        toast.error('Formato no soportado. Sube una imagen (JPG/PNG/WEBP) o un video (MP4/WEBM).');
        e.target.value = '';
        return;
      }

      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const allowedImageExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
      const allowedVideoExt = ['mp4', 'webm', 'mov', 'm4v'];
      if (isImage && !allowedImageExt.includes(ext)) {
        toast.error(`Extensión "${ext}" no permitida para imagen. Usa: ${allowedImageExt.join(', ')}.`);
        e.target.value = '';
        return;
      }
      if (isVideo && !allowedVideoExt.includes(ext)) {
        toast.error(`Extensión "${ext}" no permitida para video. Usa: ${allowedVideoExt.join(', ')}.`);
        e.target.value = '';
        return;
      }

      const maxSize = isVideo ? 200 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > maxSize) {
        toast.error(`El archivo excede el límite (${isVideo ? '200MB para video' : '5MB para imagen'}).`);
        e.target.value = '';
        return;
      }
      // Compatibilidad con el decoder del kiosco K2 (rechaza 4K / HEVC / Level alto).
      if (isVideo) {
        const check = await validateKioskVideo(file);
        if (!check.ok) { toast.error(check.message || 'El video no es válido.'); e.target.value = ''; return; }
      }
      setMediaFile(file);
      setMediaType(isVideo ? 'video' : 'image');
      setMediaPreview(URL.createObjectURL(file));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId && !mediaFile) { toast.error('Debes subir un archivo multimedia.'); return; }

    // Tope de end_date por el plan de la tienda (si está vigente): igual que el portal cliente.
    const today = new Date().toISOString().split('T')[0];
    const selStore = stores.find(s => s.id === storeId);
    const planExpiry = selStore?.contract_expiry_date ?? null;
    if (storeId && planExpiry && planExpiry >= today) {
      if (!endDate) { toast.error('Indica la fecha de fin: esta tienda tiene un plan vigente.'); return; }
      if (endDate > planExpiry) {
        toast.error(`La campaña no puede pasar de la vigencia del plan de la tienda (${planExpiry}).`);
        return;
      }
    }

    // Máximo 1 campaña activa por tienda (igual que el portal cliente).
    if (isActive && storeId) {
      const activeInStore = campaigns.filter(c =>
        c.id !== editingId && c.store_id === storeId && c.is_active &&
        (!c.end_date || c.end_date >= today)
      ).length;
      if (activeInStore >= 1) {
        toast.error('Esta tienda ya tiene una campaña activa. Pausa la actual antes de activar otra.');
        return;
      }
    }

    setIsSaving(true);
    const wasEditing = !!editingId;

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
        plan_type: planType || null,
        media_url: finalUrl,
        media_type: mediaType,
        duration_seconds: durationSeconds || CAMPAIGN_DURATION_SECONDS,
        start_date: startDate ? new Date(startDate).toISOString().split('T')[0] : null,
        end_date: endDate ? new Date(endDate).toISOString().split('T')[0] : null,
        is_active: isActive,
        description: description,
        priority_level: priorityLevel,
        slot_limit_group: slotLimitGroup || null,
        target_frequency_seconds: PLAN_FREQUENCY_SECONDS[planType] || null,
        store_id: storeId || null,
        admin_managed: adminManaged,
      };

      let campId: string | null = editingId;
      if (editingId) {
        const { error } = await supabase.from('ad_campaigns').update(payload).eq('id', editingId);
        if (error) throw error;
        await logAdminAction({
          action_type: 'EDITAR',
          entity_type: 'campaña',
          entity_id: editingId,
          entity_name: payload.brand_name,
          details: payload
        });
        if (mediaFile && previousMediaUrl && previousMediaUrl !== finalUrl) {
          await removePublicidadFile(previousMediaUrl);
        }
      } else {
        const { data: inserted, error } = await supabase.from('ad_campaigns').insert([payload]).select('id').single();
        if (error) throw error;
        campId = inserted?.id ?? null;
        if (campId) {
          await logAdminAction({
            action_type: 'CREAR',
            entity_type: 'campaña',
            entity_id: campId,
            entity_name: payload.brand_name,
            details: payload
          });
        }
      }

      resetForm();
      fetchData();
      toast.success(wasEditing ? 'Campaña actualizada.' : 'Campaña creada.');
    } catch (err: any) {
      toast.error('Error: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string, url: string) => {
    const ok = await confirmDialog({
      title: 'Eliminar campaña',
      message: 'La campaña se eliminará permanentemente. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const camp = campaigns.find(c => c.id === id);
      const campName = camp ? camp.brand_name : 'Desconocida';
      const { error } = await supabase.from('ad_campaigns').delete().eq('id', id);
      if (error) throw error;
      await logAdminAction({
        action_type: 'ELIMINAR',
        entity_type: 'campaña',
        entity_id: id,
        entity_name: campName,
        details: { brand_name: campName }
      });
      await removePublicidadFile(url);
      fetchData();
      toast.success('Campaña eliminada.');
    } catch (err: any) {
      toast.error('Error: ' + err.message);
    }
  };

  const handleToggleActive = async (id: string, current: boolean) => {
    const camp = campaigns.find(c => c.id === id);
    const campName = camp ? camp.brand_name : 'Desconocida';

    if (current) {
      const ok = await confirmDialog({
        title: 'Pausar campaña',
        message: `¿Deseas pausar la campaña "${campName}"? Dejará de sonar en el loop de pantallas.`,
        confirmLabel: 'Pausar',
        tone: 'danger',
      });
      if (!ok) return;
    }

    // Máximo 1 activa por tienda al activar.
    if (!current) {
      const camp = campaigns.find(c => c.id === id);
      if (camp?.store_id) {
        const today = new Date().toISOString().split('T')[0];
        const hasOtherActive = campaigns.some(c =>
          c.id !== id && c.store_id === camp.store_id && c.is_active &&
          (!c.end_date || c.end_date >= today)
        );
        if (hasOtherActive) {
          toast.error('Esta tienda ya tiene una campaña activa. Pausa la actual antes de activar otra.');
          return;
        }
      }
    }

    // Pedimos el row de vuelta: así detectamos tanto un error explícito como
    // el caso en que la BD no actualizó ninguna fila (RLS/permiso) sin lanzar.
    const updatePayload: Record<string, unknown> = { is_active: !current };

    // Reactivación: si la campaña vuelve a activarse y su start_date quedó en el
    // pasado, la adelantamos a hoy para que los reportes y el loop reflejen la
    // fecha real de arranque de este nuevo ciclo.
    if (!current && camp?.start_date) {
      const today = new Date().toISOString().split('T')[0];
      if (camp.start_date < today) updatePayload.start_date = today;
    }

    const { data: updated, error } = await supabase
      .from('ad_campaigns')
      .update(updatePayload)
      .eq('id', id)
      .select('id, is_active, start_date')
      .single();
    if (error) { toast.error('Error: ' + error.message); return; }
    if (!updated || updated.is_active !== !current) {
      toast.error('No se pudo cambiar el estado de la campaña (permisos o regla de la base de datos). Vuelve a intentar.');
      fetchData();
      return;
    }
    await logAdminAction({
      action_type: !current ? 'ACTIVAR' : 'DESACTIVAR',
      entity_type: 'campaña',
      entity_id: id,
      entity_name: campName,
      details: updatePayload
    });
    setCampaigns(prev => prev.map(c =>
      c.id === id
        ? { ...c, is_active: !current, start_date: (updated.start_date as string) ?? c.start_date }
        : c
    ));
    toast.success(current ? 'Campaña pausada.' : 'Campaña reactivada.');
  };

  const openReactivate = (c: Campaign) => {
    setReactivateTarget(c);
    setReactivateEnd('');
  };

  const confirmReactivate = async () => {
    const c = reactivateTarget;
    if (!c) return;
    const today = new Date().toISOString().split('T')[0];
    if (!reactivateEnd) { toast.error('Indica la nueva fecha de fin de la campaña.'); return; }
    if (reactivateEnd < today) { toast.error('La fecha de fin debe ser hoy o futura.'); return; }

    // Máximo 1 activa por tienda.
    if (c.store_id) {
      const hasOtherActive = campaigns.some(other =>
        other.id !== c.id && other.store_id === c.store_id && other.is_active &&
        (!other.end_date || other.end_date >= today)
      );
      if (hasOtherActive) {
        toast.error('Esta tienda ya tiene una campaña activa. Pausa la actual antes de reactivar otra.');
        return;
      }
    }

    setSavingReactivate(true);
    // Reactivar como gestionada por admin: queda exenta del plan vencido y
    // suena hasta la nueva fecha de fin. Si el inicio quedó en el pasado, se
    // adelanta a hoy para reflejar el nuevo ciclo.
    const payload: Record<string, unknown> = {
      is_active: true,
      end_date: reactivateEnd,
      admin_managed: true,
    };
    if (c.start_date && c.start_date < today) payload.start_date = today;

    const { data: updated, error } = await supabase
      .from('ad_campaigns')
      .update(payload)
      .eq('id', c.id)
      .select('id, is_active, end_date')
      .single();
    setSavingReactivate(false);

    if (error) { toast.error('Error: ' + error.message); return; }
    if (!updated || !updated.is_active) {
      toast.error('No se pudo reactivar la campaña. Verifica que la tienda no tenga ya una campaña activa.');
      fetchData(); setReactivateTarget(null); return;
    }
    await logAdminAction({
      action_type: 'ACTIVAR',
      entity_type: 'campaña',
      entity_id: c.id,
      entity_name: c.brand_name,
      details: { is_active: true, end_date: reactivateEnd, admin_managed: true, reason: 'Reactivación admin' },
    });
    setReactivateTarget(null);
    fetchData();
    toast.success('Campaña reactivada.');
  };

  const handleApplyKillSwitch = async () => {
    if (!killSwitchCandidates.length) return;
    const names = killSwitchCandidates.map(c => `• ${c.brand_name}`).join('\n');
    const ok = await confirmDialog({
      title: `Desactivar ${killSwitchCandidates.length} campaña(s) vencida(s)`,
      message: `${names}\n\nSe quitarán del loop de pantallas.`,
      confirmLabel: 'Desactivar',
      tone: 'danger',
    });
    if (!ok) return;

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
      toast.success('Campañas vencidas desactivadas.');
    } catch (err: any) {
      toast.error('Error: ' + err.message);
    } finally {
      setApplyingKillSwitch(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <PageSpinner />
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
        <button
          onClick={() => setActiveTab('loop')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'loop' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/25' : 'text-white/40 hover:text-white/70'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          Loop Activo
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${loopStatus.overExtended ? 'bg-red-500/20 text-red-400' : loopStatus.overTarget ? 'bg-amber-500/20 text-amber-400' : 'bg-white/10'}`}>
            {loopStatus.slots}/{loopMaxSlots}
          </span>
        </button>
      </div>

      {activeTab === 'campaigns' && (
        <>
          {/* ── Estado del loop publicitario ── */}
          <div className={`rounded-xl border p-4 space-y-3 ${
            loopStatus.overExtended
              ? 'bg-red-950/30 border-red-500/30'
              : loopStatus.overTarget
              ? 'bg-amber-950/20 border-amber-500/25'
              : 'bg-white/[0.03] border-white/10'
          }`}>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium mb-0.5">Slots ocupados</p>
                  <p className="text-white font-mono text-xl">
                    {loopStatus.slots}
                    <span className="text-white/30 text-sm">/{loopMaxSlots}</span>
                    <span className="text-white/30 text-xs ml-2">slots</span>
                  </p>
                </div>
                <div className="h-10 w-px bg-white/10" />
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium mb-0.5">Duración estimada</p>
                  <p className="text-white/60 font-mono text-base">
                    {Math.floor(loopStatus.durationSeconds / 60)}:{String(loopStatus.durationSeconds % 60).padStart(2, '0')}
                    <span className="text-white/30 text-xs ml-1">min</span>
                  </p>
                  <p className="text-white/25 text-[10px] font-mono">{loopStatus.durationSeconds}s · {loopStatus.slots > 0 ? Math.round(loopStatus.durationSeconds / loopStatus.slots) : 0}s/slot prom.</p>
                </div>
                <div className="h-10 w-px bg-white/10" />
                <div className="flex items-center gap-2 flex-wrap">
                  {plans.filter(p => p.loop_eligible).map(p => {
                    const cap = p.max_brands ?? PLAN_MAX_BRANDS_FALLBACK[p.plan_key] ?? null;
                    const used = loopStatus.byPlan[p.plan_key] || 0;
                    const saturated = cap != null && used >= cap;
                    return (
                      <span key={p.plan_key} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium border ${
                        saturated
                          ? 'bg-red-500/15 text-red-400 border-red-500/30'
                          : `${PLAN_COLORS[p.plan_key] || 'text-white/40 bg-white/5 border-white/10'}`
                      }`}>
                        {PLAN_LABELS[p.plan_key] || p.plan_key} <span className="font-mono">{used}{cap != null ? `/${cap}` : ''}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="text-[11px] text-white/40 max-w-xs space-y-1">
                <p>
                  {loopStatus.overExtended
                    ? 'El loop supera su duración máxima. Los aliados no pueden activar nuevas campañas.'
                    : loopStatus.overTarget
                    ? 'El loop está al 75 % o más. Considera pausar campañas o ampliar el máximo.'
                    : 'La duración máxima determina si los aliados pueden activar campañas.'}
                </p>
                <Link href="/panel/configuracion" className="inline-flex items-center gap-1 text-orange-400/70 hover:text-orange-400 transition-colors">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  Cambiar máximo en Configuración
                </Link>
              </div>
            </div>
            {/* Barra de progreso */}
            <div className="relative h-2 bg-white/5 rounded-full overflow-hidden">
              <div
                className={`absolute left-0 top-0 h-full rounded-full transition-all ${
                  loopStatus.overExtended ? 'bg-red-500' : loopStatus.overTarget ? 'bg-amber-500' : 'bg-orange-500'
                }`}
                style={{ width: `${Math.min(loopStatus.pct * 100, 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-white/30 text-right font-mono">
              {loopStatus.slots} / {loopMaxSlots} slots · {Math.round(loopStatus.pct * 100)}%
            </p>
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

          {/* Search + filtros */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por título, plan o tienda..." className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10" />
            </div>
            <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)} className="bg-[#111] border border-white/5 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-white/10 sm:w-52">
              <option value="">Todas las tiendas</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)} className="bg-[#111] border border-white/5 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-white/10 sm:w-40">
              <option value="all">Todos los estados</option>
              <option value="active">Activas</option>
              <option value="paused">Pausadas</option>
              <option value="expired">Vencidas</option>
            </select>
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
                const planExpired = !c.admin_managed && !!c.stores?.contract_expiry_date && new Date(c.stores.contract_expiry_date) < new Date();
                const isInactive = isExpired || planExpired;
                const isActiveState = c.is_active && !isInactive;

                // Badge de plan: heredado de la tienda. Vencido → "Plan vencido";
                // sin plan (campaña admin sin plan / plan_type null) → "Sin plan".
                const storePlanExpired = !!c.stores?.contract_expiry_date && new Date(c.stores.contract_expiry_date) < new Date();
                const planBadgeLabel = c.plan_type == null
                  ? 'Sin plan'
                  : storePlanExpired ? 'Plan vencido' : (PLAN_LABELS[c.plan_type] || c.plan_type);
                const planBadgeClass = c.plan_type == null
                  ? 'text-white/40 border-white/15'
                  : storePlanExpired ? 'text-red-400 border-red-500/40 bg-red-500/10' : (PLAN_COLORS[c.plan_type] || 'text-white border-white');

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
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${planBadgeClass}`}>
                          {planBadgeLabel}
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
                        {isInactive ? (
                          <button
                            onClick={() => openReactivate(c)}
                            className="text-[10px] flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                            Reactivar ({statusLabel})
                          </button>
                        ) : (
                          <button
                            onClick={() => handleToggleActive(c.id, c.is_active)}
                            className={`text-[10px] flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${statusClasses}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${dotClasses}`} />
                            {statusLabel}
                          </button>
                        )}

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

      {/* Tab: Loop Activo */}
      {activeTab === 'loop' && (() => {
        const today = new Date().toISOString().split('T')[0];
        const loopEligibleKeys = new Set(plans.filter(p => p.loop_eligible).map(p => p.plan_key));
        const live = campaigns.filter(c =>
          c.is_active &&
          loopEligibleKeys.has(c.plan_type) &&
          (!c.end_date || c.end_date >= today) &&
          (!c.stores?.contract_expiry_date || c.stores.contract_expiry_date >= today || c.admin_managed)
        ).sort((a, b) => (a.priority_level || 99) - (b.priority_level || 99));

        const totalDuration = live.reduce((s, c) => s + (c.duration_seconds || CAMPAIGN_DURATION_SECONDS), 0);
        const slotsUsed = live.length;
        const freeSlots = Math.max(0, loopMaxSlots - slotsUsed);

        return (
          <div className="space-y-5">
            {/* Timeline */}
            <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium">Slots del loop</p>
                <span className="text-[10px] text-white/40 font-mono">{slotsUsed}/{loopMaxSlots} slots · {totalDuration}s totales</span>
              </div>
              {live.length === 0 ? (
                <p className="text-white/30 text-sm text-center py-4">No hay campañas activas en el loop</p>
              ) : (
                <div className="flex h-8 rounded-lg overflow-hidden gap-px">
                  {live.map(c => {
                    const widthPct = loopMaxSlots > 0 ? (1 / loopMaxSlots) * 100 : 0;
                    const color = PLAN_COLORS[c.plan_type]?.split(' ')[0]?.replace('text-', 'bg-') || 'bg-white/20';
                    return (
                      <div
                        key={c.id}
                        className={`relative group ${color} opacity-70 hover:opacity-100 transition-opacity flex items-center justify-center min-w-[4px]`}
                        style={{ width: `${widthPct}%` }}
                        title={`${c.brand_name} · ${c.duration_seconds || CAMPAIGN_DURATION_SECONDS}s`}
                      >
                        {widthPct > 6 && (
                          <span className="text-[9px] text-white font-medium truncate px-1">{c.brand_name}</span>
                        )}
                      </div>
                    );
                  })}
                  {freeSlots > 0 && Array.from({ length: freeSlots }).map((_, i) => (
                    <div
                      key={`free-${i}`}
                      className="bg-white/5 border border-dashed border-white/10 flex items-center justify-center"
                      style={{ width: `${(1 / loopMaxSlots) * 100}%` }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Lista de campañas en el loop */}
            {live.length === 0 ? (
              <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
                <p className="text-white/30 text-sm">El loop está vacío</p>
                <p className="text-white/15 text-xs mt-1">Activa campañas desde la pestaña "Campañas"</p>
              </div>
            ) : (
              <div className="space-y-2">
                {live.map((c, idx) => {
                  const dur = c.duration_seconds || CAMPAIGN_DURATION_SECONDS;
                  const widthPct = loopMaxSlots > 0 ? (1 / loopMaxSlots) * 100 : 0;
                  const isVideo = c.media_type === 'video';
                  return (
                    <div key={c.id} className="bg-[#111] border border-white/8 rounded-xl p-4 flex items-center gap-4">
                      {/* Posición */}
                      <span className="text-white/20 font-mono text-xs w-5 shrink-0 text-right">{idx + 1}</span>
                      {/* Thumbnail */}
                      <div className="w-16 h-10 bg-black rounded-md overflow-hidden shrink-0 border border-white/5">
                        {isVideo
                          ? <video src={c.media_url} className="w-full h-full object-cover" muted playsInline />
                          : <img src={c.media_url} className="w-full h-full object-cover" alt={c.brand_name} />
                        }
                      </div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-white text-sm font-medium truncate">{c.brand_name}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${PLAN_COLORS[c.plan_type] || 'text-white/40 border-white/15'}`}>
                            {PLAN_LABELS[c.plan_type] || c.plan_type}
                          </span>
                          {c.admin_managed && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">Admin</span>
                          )}
                        </div>
                        {c.stores?.name && <p className="text-white/40 text-xs mt-0.5">{c.stores.name}</p>}
                        {/* Mini barra de duración */}
                        <div className="mt-2 flex items-center gap-2">
                          <div className="flex-1 max-w-32 h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-orange-500/60 rounded-full" style={{ width: `${widthPct}%` }} />
                          </div>
                          <span className="text-white/40 text-[10px] font-mono">{dur}s</span>
                        </div>
                      </div>
                      {/* Fechas */}
                      <div className="shrink-0 text-right hidden sm:block">
                        <p className="text-white/30 text-[10px]">{new Date(c.start_date).toLocaleDateString()}</p>
                        {c.end_date && <p className="text-white/30 text-[10px]">→ {new Date(c.end_date).toLocaleDateString()}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Resumen de capacidad */}
            <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 grid grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider">Slots ocupados</p>
                <p className="text-white font-mono text-lg mt-0.5">{slotsUsed}<span className="text-white/30 text-sm">/{loopMaxSlots}</span></p>
              </div>
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider">Slots libres</p>
                <p className={`font-mono text-lg mt-0.5 ${freeSlots <= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {freeSlots}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider">Duración total</p>
                <p className="text-white/60 font-mono text-base mt-0.5">{totalDuration}s</p>
                <p className="text-white/25 text-[10px] font-mono">{Math.floor(totalDuration/60)}m {totalDuration%60}s</p>
              </div>
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider">Prom. por slot</p>
                <p className="text-white/60 font-mono text-base mt-0.5">
                  {slotsUsed > 0 ? Math.round(totalDuration / slotsUsed) : 0}s
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-semibold text-white mb-5">{editingId ? 'Editar Campaña' : 'Nueva Campaña'}</h3>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Título de la publicidad</label>
                  <input type="text" required value={brandName} onChange={e => setBrandName(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Tienda Vinculada</label>
                  <select value={storeId} onChange={e => {
                    const val = e.target.value; setStoreId(val);
                    const p = stores.find(s => s.id === val)?.plan_type || '';
                    setPlanType(p); setDurationSeconds(planVideoSeconds(p));
                  }} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none">
                    <option value="">Ninguna</option>
                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripción Interna</label>
                <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Duración del video (seg)</label>
                <input
                  type="number" min="1" max="120"
                  value={durationSeconds}
                  onChange={e => setDurationSeconds(parseInt(e.target.value) || CAMPAIGN_DURATION_SECONDS)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio Campaña</label>
                  <input type="date" required value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin Campaña (Fecha de Corte)</label>
                  <input type="date" required min={startDate || undefined}
                    max={(() => {
                      const exp = stores.find(s => s.id === storeId)?.contract_expiry_date;
                      const t = new Date().toISOString().split('T')[0];
                      return exp && exp >= t ? exp : undefined;   // sin plan vigente → sin tope
                    })()}
                    value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Media — Imagen o Video (1920×1080 px) {editingId && <span className="normal-case tracking-normal">(dejar vacío para mantener)</span>}
                </label>
                <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={handleFileChange} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:bg-white/10 file:text-white" />
                <p className="text-[10px] text-white/30 mt-1">
                  Formatos: JPG, PNG, WEBP, GIF (máx 5MB) · MP4, WEBM, MOV (máx 200MB).
                  {mediaFile && (
                    <span className={`ml-2 px-1.5 py-0.5 rounded ${mediaType === 'video' ? 'bg-purple-500/15 text-purple-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                      Detectado: {mediaType === 'video' ? 'Video' : 'Imagen'}
                    </span>
                  )}
                </p>
                {mediaPreview && (
                  <div className="mt-2 h-32 bg-black rounded-lg border border-white/5 overflow-hidden flex items-center justify-center">
                    {mediaType === 'video'
                      ? <video src={mediaPreview} className="h-full object-contain" autoPlay loop playsInline controls />
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

      {/* Modal: reactivar campaña vencida (flujo admin) */}
      {reactivateTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setReactivateTarget(null)} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-sm font-semibold text-white mb-1">Reactivar campaña</h3>
            <p className="text-xs text-white/50 mb-4">
              «{reactivateTarget.brand_name}» — {reactivateTarget.stores?.name || 'sin tienda'}
            </p>
            {(() => {
              const t = new Date().toISOString().split('T')[0];
              const planExp = !!reactivateTarget.stores?.contract_expiry_date && reactivateTarget.stores.contract_expiry_date < t;
              const camExp = !!reactivateTarget.end_date && reactivateTarget.end_date < t;
              const msg = planExp
                ? '⚠ El plan de esta tienda está vencido. Al reactivarla, la campaña sonará en el loop exenta del plan (gestionada por admin) hasta la fecha de fin que indiques.'
                : camExp
                ? '⚠ Esta campaña está vencida. Indica una nueva fecha de fin para que vuelva al loop.'
                : null;
              return msg ? (
                <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 mb-4">{msg}</p>
              ) : null;
            })()}
            <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nueva fecha de fin</label>
            <input
              type="date"
              required
              min={new Date().toISOString().split('T')[0]}
              max={(() => {
                const exp = reactivateTarget.stores?.contract_expiry_date;
                const t = new Date().toISOString().split('T')[0];
                return exp && exp >= t ? exp : undefined;   // plan vigente → tope; vencido → sin tope
              })()}
              value={reactivateEnd}
              onChange={e => setReactivateEnd(e.target.value)}
              className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none"
            />
            <div className="flex gap-2 pt-4">
              <button type="button" onClick={() => setReactivateTarget(null)} className="flex-1 py-2 text-sm bg-white/5 hover:bg-white/10 text-white/50 rounded-lg transition-colors">Cancelar</button>
              <button type="button" disabled={savingReactivate} onClick={confirmReactivate} className="flex-1 py-2 text-sm bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 rounded-lg disabled:opacity-50 transition-colors">
                {savingReactivate ? 'Reactivando...' : 'Reactivar'}
              </button>
            </div>
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
          <PageSpinner />
        </div>
      }
    >
      <CampaniasAdminInner />
    </Suspense>
  );
}
