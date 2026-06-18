'use client';

import { useState, useEffect, useMemo, ChangeEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';
import { removePublicidadFile } from '../../../lib/storage';
import Pagination, { usePagination } from '../../components/Pagination';
import { PLAN_LABELS, PLAN_BADGE as PLAN_COLORS } from '../../../lib/plans';

// Solo se emiten cupones bajo el plan Cupones Flash (diario o semanal).
// Los planes base ya no admiten cupones — ver migración 018.

// Tope duro de marcas activas en la galería (PDF: 20 marcas máx)
const FLASH_COUPON_MAX_BRANDS = 20;
const FLASH_COUPON_PLANS = new Set(['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL']);

// Cupones máximos que una marca puede lanzar dentro de su período Flash Coupon
// PDF: "entre 5 y 10 cupones diarios, y 30 semanales, según formato"
const FLASH_COUPON_BRAND_LIMITS: Record<string, { max: number; windowDays: number; label: string }> = {
  FLASH_COUPON_DIARIO:  { max: 10, windowDays: 1, label: 'día' },
  FLASH_COUPON_SEMANAL: { max: 30, windowDays: 5, label: 'semana (5 días)' },
};

interface Store {
  id: string;
  name: string;
  plan_type: string | null;
  flash_coupon_plan: string | null;
  flash_coupon_expiry_date: string | null;
}
interface Campaign { id: string; brand_name: string; }

interface Coupon {
  id: string;
  title: string;
  store_id: string;
  stores: { name: string };
  image_url: string;
  code: string;
  amount_available: number;
  discount_percent: number;
  plan_type: string;
  category: string;
  start_date: string;
  end_date: string;
  campaign_id: string;
  is_active: boolean;
  last_shown_at: string | null;
}

export default function CuponsAdminPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Combobox state
  const [storeSearch, setStoreSearch] = useState('');
  const [storeDropdownOpen, setStoreDropdownOpen] = useState(false);

  // Form Fields
  const [editingCouponId, setEditingCouponId] = useState<string | null>(null);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [couponTitle, setCouponTitle] = useState('');
  const [amountAvailable, setAmountAvailable] = useState<number>(0);
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>('');

  // New Schema fields
  const [planType, setPlanType] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState<string>('');
  const [campaignId, setCampaignId] = useState<string>('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [storesRes, campaignsRes, couponsRes] = await Promise.all([
      supabase
        .from('stores')
        .select('id, name, plan_type, flash_coupon_plan, flash_coupon_expiry_date')
        .order('name')
        .limit(500),
      supabase.from('ad_campaigns').select('id, brand_name').order('brand_name').limit(200),
      supabase.from('coupons').select('*, stores(name)').order('created_at', { ascending: false }).limit(500),
    ]);
    if (storesRes.data) setStores(storesRes.data);
    if (campaignsRes.data) setCampaigns(campaignsRes.data);
    if (couponsRes.data) setCoupons(couponsRes.data as Coupon[]);
    setLoading(false);
    setRefreshing(false);
  };

  const resetForm = () => {
    setEditingCouponId(null);
    setSelectedStoreId('');
    setStoreSearch('');
    setStoreDropdownOpen(false);
    setCouponTitle('');
    setAmountAvailable(0);
    setDiscountPercent(0);
    setImageFile(null);
    setImagePreview('');
    setPlanType('');
    setCategory('');
    setStartDate(new Date().toISOString().split('T')[0]);
    setEndDate('');
    setCampaignId('');
    setShowForm(false);
  };

  const filteredStores = useMemo(() => {
    if (!storeSearch) return stores;
    return stores.filter(s => s.name.toLowerCase().includes(storeSearch.toLowerCase()));
  }, [stores, storeSearch]);

  // Marcas únicas activas con plan Flash Coupon (cap de 20 según PDF)
  const flashCouponBrands = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const stamps = today;
    const activeFlash = coupons.filter(c =>
      FLASH_COUPON_PLANS.has(c.plan_type) &&
      c.amount_available > 0 &&
      (!c.end_date || c.end_date.split('T')[0] >= stamps)
    );
    return new Set(activeFlash.map(c => c.store_id).filter(Boolean));
  }, [coupons]);

  const filteredCoupons = useMemo(() => {
    if (!search) return coupons;
    const q = search.toLowerCase();
    return coupons.filter(c =>
      c.title.toLowerCase().includes(q) ||
      c.code?.toLowerCase().includes(q) ||
      (c.stores?.name || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q)
    );
  }, [coupons, search]);

  const pg = usePagination(filteredCoupons);

  const handleEditClick = (coupon: Coupon) => {
    setEditingCouponId(coupon.id);
    setSelectedStoreId(coupon.store_id || '');
    setStoreSearch(coupon.stores?.name || '');
    setCouponTitle(coupon.title || '');
    setAmountAvailable(coupon.amount_available || 0);
    setDiscountPercent(coupon.discount_percent || 0);
    setImagePreview(coupon.image_url || '');
    setImageFile(null);
    // El plan_type del cupón se respeta tal cual (sea base o addon flash).
    setPlanType(coupon.plan_type || '');
    setCategory(coupon.category || '');
    setStartDate(coupon.start_date ? coupon.start_date.split('T')[0] : new Date().toISOString().split('T')[0]);
    setEndDate(coupon.end_date ? coupon.end_date.split('T')[0] : '');
    setCampaignId(coupon.campaign_id || '');
    setShowForm(true);
  };

  // Solo emitimos cupones bajo el plan Cupones Flash vigente de la tienda.
  const selectedStore = useMemo(
    () => stores.find(s => s.id === selectedStoreId) || null,
    [stores, selectedStoreId]
  );

  const flashAddonActive = useMemo(() => {
    if (!selectedStore?.flash_coupon_plan) return false;
    const exp = selectedStore.flash_coupon_expiry_date;
    if (!exp) return true;
    return exp >= new Date().toISOString().split('T')[0];
  }, [selectedStore]);

  const planOptionsForStore = useMemo<string[]>(() => {
    if (!selectedStore || !flashAddonActive || !selectedStore.flash_coupon_plan) return [];
    return [selectedStore.flash_coupon_plan];
  }, [selectedStore, flashAddonActive]);

  const validateImage = (file: File): Promise<boolean> => {
    return new Promise((resolve) => {
      if (file.size > 500 * 1024) { alert('La imagen debe pesar menos de 500 KB.'); resolve(false); return; }
      const img = new Image();
      img.onload = () => {
        if (img.width > 800 || img.height > 800) { alert(`Dimensiones excedidas (${img.width}x${img.height}). Máximo: 800x800px.`); resolve(false); }
        else { resolve(true); }
      };
      img.src = URL.createObjectURL(file);
    });
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const isValid = await validateImage(file);
      if (isValid) {
        setImageFile(file);
        setImagePreview(URL.createObjectURL(file));
      } else {
        e.target.value = '';
      }
    }
  };

  const handleSaveCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStoreId) { alert('Debes seleccionar una tienda.'); return; }
    if (!endDate) { alert('La fecha de vencimiento es requerida por el esquema.'); return; }
    if (!planType) { alert('Debes seleccionar el plan del cupón.'); return; }

    // Solo se aceptan cupones bajo el plan Cupones Flash vigente de la tienda.
    if (!FLASH_COUPON_PLANS.has(planType) || !planOptionsForStore.includes(planType)) {
      alert(
        `La tienda seleccionada no tiene un plan Cupones Flash activo. ` +
        `Actívalo en /panel/tiendas antes de emitir cupones.`
      );
      return;
    }

    // Cap de 20 marcas en galería
    const isNewBrand = !flashCouponBrands.has(selectedStoreId);
    if (isNewBrand && !editingCouponId && flashCouponBrands.size >= FLASH_COUPON_MAX_BRANDS) {
      alert(
        `Límite alcanzado: ${flashCouponBrands.size}/${FLASH_COUPON_MAX_BRANDS} marcas activas en la galería.\n\n` +
        `Para añadir esta marca, libera un slot dejando que un cupón existente se agote o venza.`
      );
      return;
    }

    // Cap de cupones por marca dentro del período del plan (10/día, 30/semana)
    const brandLimit = FLASH_COUPON_BRAND_LIMITS[planType];
    if (brandLimit) {
      const windowStart = new Date();
      windowStart.setHours(0, 0, 0, 0);
      windowStart.setDate(windowStart.getDate() - (brandLimit.windowDays - 1));

      const issuedInWindow = coupons.filter(c =>
        c.id !== editingCouponId &&
        c.store_id === selectedStoreId &&
        c.plan_type === planType &&
        new Date(c.start_date) >= windowStart
      ).length;

      if (issuedInWindow >= brandLimit.max) {
        const storeName = stores.find(s => s.id === selectedStoreId)?.name || 'esta marca';
        alert(
          `Límite alcanzado: ${storeName} ya lanzó ${issuedInWindow}/${brandLimit.max} cupones ` +
          `en ${PLAN_LABELS[planType]} durante el período (${brandLimit.label}).\n\n` +
          `Espera al próximo período para emitir más cupones.`
        );
        return;
      }
    }

    setIsSaving(true);

    try {
      const previousImageUrl = editingCouponId
        ? coupons.find(c => c.id === editingCouponId)?.image_url ?? null
        : null;

      let publicUrl = imagePreview || null;
      if (imageFile) {
        const fileExt = imageFile.name.split('.').pop();
        const fileName = `coupon_${Date.now()}.${fileExt}`;
        const { error: uploadError } = await supabase.storage.from('publicidad').upload(`coupons/${fileName}`, imageFile, { upsert: true });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage.from('publicidad').getPublicUrl(`coupons/${fileName}`);
        publicUrl = publicUrlData.publicUrl;
      }

      const couponData: any = {
        store_id: selectedStoreId || null,
        campaign_id: campaignId || null,
        title: couponTitle,
        amount_available: amountAvailable,
        discount_percent: discountPercent,
        plan_type: planType,
        category: category,
        start_date: new Date(startDate).toISOString(),
        end_date: new Date(endDate).toISOString(),
      };

      if (publicUrl) couponData.image_url = publicUrl;

      let couponId: string | null = editingCouponId;
      if (editingCouponId) {
        const { error } = await supabase.from('coupons').update(couponData).eq('id', editingCouponId);
        if (error) throw error;
        await logAdminAction({
          action_type: 'EDITAR',
          entity_type: 'cupón',
          entity_id: editingCouponId,
          entity_name: couponData.title,
          details: couponData
        });
        if (imageFile && previousImageUrl && previousImageUrl !== publicUrl) {
          await removePublicidadFile(previousImageUrl);
        }
      } else {
        const storeName = stores.find(s => s.id === selectedStoreId)?.name || 'GENERICO';
        couponData.code = `CUPON-${storeName.substring(0, 3).toUpperCase()}-${Date.now().toString().substring(7)}`;
        const { data: inserted, error } = await supabase.from('coupons').insert([couponData]).select('id').single();
        if (error) throw error;
        couponId = inserted?.id ?? null;
        if (couponId) {
          await logAdminAction({
            action_type: 'CREAR',
            entity_type: 'cupón',
            entity_id: couponId,
            entity_name: couponData.title,
            details: couponData
          });
        }
      }

      resetForm();
      fetchData();
    } catch (err: any) {
      alert(`Error al guardar: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminar este cupón permanentemente?')) return;
    const coupon = coupons.find(c => c.id === id);
    const { error } = await supabase.from('coupons').delete().eq('id', id);
    if (error) { alert(error.message); return; }
    await logAdminAction({
      action_type: 'ELIMINAR',
      entity_type: 'cupón',
      entity_id: id,
      entity_name: coupon?.title || coupon?.code || 'Desconocido',
      details: { title: coupon?.title, code: coupon?.code }
    });
    await removePublicidadFile(coupon?.image_url);
    fetchData();
  };

  const handleToggleActive = async (coupon: Coupon) => {
    // Solo permitimos reactivar si la tienda sigue con plan Cupones Flash vigente.
    if (!coupon.is_active) {
      const store = stores.find(s => s.id === coupon.store_id);
      const today = new Date().toISOString().split('T')[0];
      const flashOk = !!store?.flash_coupon_plan
        && (!store.flash_coupon_expiry_date || store.flash_coupon_expiry_date >= today);
      if (!flashOk) {
        alert('No se puede reactivar: la tienda no tiene plan Cupones Flash vigente. Renueva el plan primero.');
        return;
      }
      if (coupon.end_date && coupon.end_date < new Date().toISOString()) {
        alert('No se puede reactivar: el cupón ya venció (end_date pasada). Edita la fecha primero.');
        return;
      }
      if (coupon.amount_available <= 0) {
        alert('No se puede reactivar: el cupón está sin stock. Edita el stock primero.');
        return;
      }
    }
    const { error } = await supabase
      .from('coupons')
      .update({ is_active: !coupon.is_active })
      .eq('id', coupon.id);
    if (error) alert(error.message);
    else {
      await logAdminAction({
        action_type: !coupon.is_active ? 'ACTIVAR' : 'DESACTIVAR',
        entity_type: 'cupón',
        entity_id: coupon.id,
        entity_name: coupon.title || coupon.code,
        details: { is_active: !coupon.is_active }
      });
      fetchData();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-y-3">
        <div className="min-w-0">
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Publicidad y Promociones</p>
          <h2 className="text-2xl font-bold text-white">Gestión de Cupones</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
            className="flex items-center gap-2 text-sm font-medium bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded-lg px-4 py-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
            Nuevo Combo
          </button>
        </div>
      </div>

      {/* Indicador galería Flash Coupon */}
      {flashCouponBrands.size > 0 && (
        <div className={`flex items-center justify-between flex-wrap gap-3 rounded-xl border px-4 py-3 ${
          flashCouponBrands.size >= FLASH_COUPON_MAX_BRANDS
            ? 'bg-red-950/25 border-red-500/30'
            : flashCouponBrands.size >= FLASH_COUPON_MAX_BRANDS - 3
            ? 'bg-amber-950/20 border-amber-500/25'
            : 'bg-white/[0.03] border-white/10'
        }`}>
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-pink-400" />
            <div>
              <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium">Galería Cupones Flash</p>
              <p className="text-white font-mono text-sm">
                {flashCouponBrands.size}<span className="text-white/30">/{FLASH_COUPON_MAX_BRANDS}</span>
                <span className="text-white/30 text-xs ml-2">marcas activas · rotación 1 cupón por tienda</span>
              </p>
            </div>
          </div>
          <p className="text-[11px] text-white/40 max-w-sm text-right">
            {flashCouponBrands.size >= FLASH_COUPON_MAX_BRANDS
              ? 'Galería llena. No se aceptan más marcas hasta liberar slots.'
              : `Quedan ${FLASH_COUPON_MAX_BRANDS - flashCouponBrands.size} cupos para nuevas marcas.`}
          </p>
        </div>
      )}

      {/* Search Bar */}
      <div className="relative">
        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por titulo, codigo o tienda..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Modal Form */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">
                {editingCouponId ? 'Editar Combo/Cupón' : 'Nuevo Combo/Cupón'}
              </h3>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSaveCoupon} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {/* Store Combobox */}
                <div className="relative">
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Tienda asignada</label>
                  <div
                    className="flex items-center justify-between w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm cursor-pointer"
                    onClick={() => { if (!storeDropdownOpen) setStoreSearch(''); setStoreDropdownOpen(!storeDropdownOpen); }}
                  >
                    <span className="text-white truncate">
                      {selectedStoreId ? stores.find(s => s.id === selectedStoreId)?.name : 'Seleccionar tienda...'}
                    </span>
                    <svg className={`w-4 h-4 text-white/30 transition-transform ${storeDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </div>
                  {storeDropdownOpen && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-[#1A1A1A] border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
                      <div className="p-2 border-b border-white/5">
                        <input
                          type="text"
                          value={storeSearch}
                          onChange={e => setStoreSearch(e.target.value)}
                          placeholder="Buscar tienda..."
                          className="w-full bg-[#0A0A0A] border border-white/5 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none"
                        />
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {filteredStores.map(store => (
                          <div
                            key={store.id}
                            className="px-3 py-2 text-sm text-white hover:bg-white/5 cursor-pointer truncate"
                            onClick={() => {
                              setSelectedStoreId(store.id);
                              // Solo se emiten cupones bajo el plan Cupones Flash. Si
                              // la tienda lo tiene activo lo preseleccionamos; si no,
                              // queda vacío y el selector muestra el aviso.
                              const today = new Date().toISOString().split('T')[0];
                              const flashActive = !!store.flash_coupon_plan
                                && (!store.flash_coupon_expiry_date || store.flash_coupon_expiry_date >= today);
                              setPlanType(flashActive && store.flash_coupon_plan ? store.flash_coupon_plan : '');
                              setStoreSearch(store.name);
                              setStoreDropdownOpen(false);
                            }}
                          >
                            {store.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan del Cupón</label>
                  {planOptionsForStore.length > 0 ? (
                    <select
                      required
                      value={planType}
                      onChange={e => setPlanType(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                    >
                      <option value="">Seleccionar...</option>
                      {planOptionsForStore.map(opt => (
                        <option key={opt} value={opt}>
                          ⚡ {PLAN_LABELS[opt] || opt}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="w-full bg-[#0A0A0A] border border-white/5 rounded-lg px-3 py-2.5 text-sm flex items-center min-h-[42px] cursor-default select-none">
                      <span className="text-white/20 text-xs">
                        {selectedStoreId
                          ? 'Esta tienda no tiene el plan Cupones Flash activo.'
                          : 'Selecciona una tienda'}
                      </span>
                    </div>
                  )}
                  {selectedStore?.flash_coupon_plan && !flashAddonActive && (
                    <p className="text-[10px] text-amber-400 mt-1">
                      Plan Cupones Flash vencido el {selectedStore.flash_coupon_expiry_date}. Debe renovarse para emitir cupones.
                    </p>
                  )}
                  {/* Aviso de cupos restantes para Flash Coupon */}
                  {selectedStoreId && FLASH_COUPON_PLANS.has(planType) && (() => {
                    const limit = FLASH_COUPON_BRAND_LIMITS[planType];
                    if (!limit) return null;
                    const windowStart = new Date();
                    windowStart.setHours(0, 0, 0, 0);
                    windowStart.setDate(windowStart.getDate() - (limit.windowDays - 1));
                    const issued = coupons.filter(c =>
                      c.id !== editingCouponId &&
                      c.store_id === selectedStoreId &&
                      c.plan_type === planType &&
                      new Date(c.start_date) >= windowStart
                    ).length;
                    const remaining = limit.max - issued;
                    return (
                      <p className={`text-[10px] mt-1 ${remaining <= 0 ? 'text-red-400' : remaining <= 2 ? 'text-amber-400' : 'text-white/40'}`}>
                        Lanzados por {limit.label}: <span className="font-mono">{issued}/{limit.max}</span>
                        {remaining > 0 ? ` · quedan ${remaining}` : ' · sin cupos'}
                      </p>
                    );
                  })()}
                </div>

              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Título del Cupón / Oferta</label>
                <input
                  type="text"
                  required
                  value={couponTitle}
                  onChange={e => setCouponTitle(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                  placeholder="Ej: 20% Desc. en Cafe"
                />
              </div>



              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fecha Inicio</label>
                  <input
                    type="date"
                    required
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fecha Fin</label>
                  <input
                    type="date"
                    required
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Stock Disponible</label>
                  <input
                    type="number"
                    required
                    value={amountAvailable === 0 ? '' : amountAvailable}
                    onChange={e => setAmountAvailable(parseInt(e.target.value) || 0)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                    placeholder="100"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Imagen {editingCouponId && <span className="normal-case tracking-normal">(dejar vacío para mantener)</span>}
                  </label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                  />
                </div>
              </div>

              {imagePreview && (
                <div className="flex justify-center">
                  <div className="w-32 h-32 rounded-xl bg-[#0A0A0A] border border-white/10 overflow-hidden">
                    <img src={imagePreview} alt="Preview" className="w-full h-full object-contain" />
                  </div>
                </div>
              )}



              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={resetForm}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {isSaving ? 'Guardando...' : editingCouponId ? 'Guardar cambios' : 'Publicar combo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Card grid */}
      {coupons.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
          <p className="text-white/30 text-sm">No hay combos registrados</p>
          <p className="text-white/15 text-xs mt-1">Haz clic en "Nuevo combo" para empezar</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {pg.paginated.map((coupon) => {
              const isExpired = !!coupon.end_date && new Date(coupon.end_date) < new Date();
              const outOfStock = coupon.amount_available <= 0;
              const isInactive = !coupon.is_active || isExpired || outOfStock;

              const statusLabel = isExpired ? 'Vencido' : outOfStock ? 'Sin stock' : coupon.is_active ? 'Activo' : 'Inactivo';
              const statusClasses = isInactive
                ? 'bg-white/5 text-white/30'
                : 'bg-cyan-500/10 text-cyan-400';
              const dotClasses = isInactive ? 'bg-white/20' : 'bg-cyan-400';

              return (
                <div key={coupon.id} className={`bg-[#111] border rounded-xl overflow-hidden transition-all ${isInactive ? 'border-white/5 opacity-70' : 'border-white/10'}`}>
                  {/* Image */}
                  <div className="h-40 bg-black relative">
                    {coupon.image_url ? (
                      <img
                        src={coupon.image_url}
                        alt={coupon.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <svg className="w-10 h-10 text-white/10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    {/* Plan badge */}
                    <div className="absolute top-3 right-3 flex flex-col items-end gap-1">
                      {FLASH_COUPON_PLANS.has(coupon.plan_type) && (
                        <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-pink-500/20 text-pink-300 border border-pink-500/40">
                          ⚡ FLASH
                        </span>
                      )}
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${PLAN_COLORS[coupon.plan_type] || 'text-white/40 bg-white/5'}`}>
                        {PLAN_LABELS[coupon.plan_type] || coupon.plan_type}
                      </span>
                    </div>
                    {/* Title overlay */}
                    <div className="absolute bottom-3 left-3 right-3">
                      <h3 className="text-white font-semibold text-sm truncate">{coupon.title}</h3>
                      {coupon.stores?.name && <p className="text-white/50 text-[10px]">Tienda: {coupon.stores.name}</p>}
                    </div>
                  </div>

                  {/* Body */}
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/40">Código</span>
                      <span className="text-white/60 font-mono text-[10px]">{coupon.code}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/40">Stock</span>
                      <span className={`font-medium ${outOfStock ? 'text-red-400' : coupon.amount_available <= 5 ? 'text-amber-400' : 'text-white/70'}`}>
                        {coupon.amount_available} disp.
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/40">Descuento</span>
                      <span className="text-cyan-400 font-medium">{coupon.discount_percent ?? 0}% OFF</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/40">Vigencia</span>
                      <span className="text-white/60 text-[10px]">
                        {new Date(coupon.start_date).toLocaleDateString()} — {new Date(coupon.end_date).toLocaleDateString()}
                      </span>
                    </div>
                    {coupon.last_shown_at && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-white/40">Última rotación</span>
                        <span className="text-white/30 text-[10px] font-mono">{new Date(coupon.last_shown_at).toLocaleDateString()}</span>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="pt-3 border-t border-white/5 flex items-center justify-between">
                      <button
                        onClick={() => handleToggleActive(coupon)}
                        className={`text-[10px] flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${statusClasses}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${dotClasses}`} />
                        {statusLabel}
                      </button>
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleEditClick(coupon)}
                          title="Editar"
                          className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        </button>
                        <button
                          onClick={() => handleDelete(coupon.id)}
                          title="Eliminar"
                          className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {pg.totalPages > 1 && (
            <Pagination
              page={pg.page}
              totalPages={pg.totalPages}
              total={pg.total}
              perPage={pg.perPage}
              label="combos"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </>
      )}
    </div>
  );
}
