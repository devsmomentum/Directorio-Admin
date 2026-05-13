'use client';

import { useState, useEffect, useMemo, ChangeEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

// Match real schema coupons.plan_type options
const PLAN_TYPES = ['DIAMANTE', 'ORO', 'IA_PERFORMANCE', 'PUBLI_PROMO'] as const;

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE:       'text-cyan-400 bg-cyan-500/10',
  ORO:            'text-amber-400 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10',
  PUBLI_PROMO:    'text-blue-400 bg-blue-500/10',
};

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE:       'Diamante',
  ORO:            'Oro',
  IA_PERFORMANCE: 'IA Performance',
  PUBLI_PROMO:    'Publi Promo',
};

interface Store { id: string; name: string; }
interface Campaign { id: string; brand_name: string; }

interface Coupon {
  id: string;
  title: string;
  store_id: string;
  stores: { name: string };
  image_url: string;
  code: string;
  amount_available: number;
  price_usd: number;
  plan_type: string;
  category: string;
  start_date: string;
  end_date: string;
  campaign_id: string;
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
  const [priceUsd, setPriceUsd] = useState<number>(0);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>('');
  
  // New Schema fields
  const [planType, setPlanType] = useState<string>('IA_PERFORMANCE');
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
      supabase.from('stores').select('id, name').order('name').limit(500),
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
    setPriceUsd(0);
    setImageFile(null);
    setImagePreview('');
    setPlanType('IA_PERFORMANCE');
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
    setPriceUsd(coupon.price_usd || 0);
    setImagePreview(coupon.image_url || '');
    setImageFile(null);
    setPlanType(coupon.plan_type || 'IA_PERFORMANCE');
    setCategory(coupon.category || '');
    setStartDate(coupon.start_date ? coupon.start_date.split('T')[0] : new Date().toISOString().split('T')[0]);
    setEndDate(coupon.end_date ? coupon.end_date.split('T')[0] : '');
    setCampaignId(coupon.campaign_id || '');
    setShowForm(true);
  };

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
    if (!selectedStoreId && !campaignId) { alert('Debes seleccionar una tienda o una campaña.'); return; }
    if (!endDate) { alert('La fecha de vencimiento es requerida por el esquema.'); return; }
    setIsSaving(true);

    try {
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
        price_usd: priceUsd,
        plan_type: planType,
        category: category,
        start_date: new Date(startDate).toISOString(),
        end_date: new Date(endDate).toISOString(),
      };
      
      if (publicUrl) couponData.image_url = publicUrl;

      if (editingCouponId) {
        const { error } = await supabase.from('coupons').update(couponData).eq('id', editingCouponId);
        if (error) throw error;
      } else {
        const storeName = stores.find(s => s.id === selectedStoreId)?.name || 'GENERICO';
        couponData.code = `CUPON-${storeName.substring(0, 3).toUpperCase()}-${Date.now().toString().substring(7)}`;
        const { error } = await supabase.from('coupons').insert([couponData]);
        if (error) throw error;
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
    const { error } = await supabase.from('coupons').delete().eq('id', id);
    if (error) alert(error.message);
    else fetchData();
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
      <div className="flex items-end justify-between">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Publicidad y Promociones</p>
          <h2 className="text-2xl font-bold text-white">Gestión de Cupones</h2>
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
            className="flex items-center gap-2 text-sm font-medium bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded-lg px-4 py-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
            Nuevo Combo
          </button>
        </div>
      </div>

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
                    onClick={() => setStoreDropdownOpen(!storeDropdownOpen)}
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
                        <div
                          className="px-3 py-2 text-sm text-white/40 hover:bg-white/5 cursor-pointer"
                          onClick={() => { setSelectedStoreId(''); setStoreSearch(''); setStoreDropdownOpen(false); }}
                        >
                          Ninguna (Solo campaña)
                        </div>
                        {filteredStores.map(store => (
                          <div
                            key={store.id}
                            className="px-3 py-2 text-sm text-white hover:bg-white/5 cursor-pointer truncate"
                            onClick={() => {
                              setSelectedStoreId(store.id);
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
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan de Visibilidad</label>
                  <select
                    value={planType}
                    onChange={e => setPlanType(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                  >
                    {PLAN_TYPES.map(pt => (
                      <option key={pt} value={pt}>{PLAN_LABELS[pt] || pt}</option>
                    ))}
                  </select>
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

      {/* Table */}
      {coupons.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
          <p className="text-white/30 text-sm">No hay combos registrados</p>
          <p className="text-white/15 text-xs mt-1">Haz clic en "Nuevo combo" para empezar</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Combo</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Tienda / Categoría</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Plan</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Vigencia</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Precio / Stock</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pg.paginated.map((coupon) => (
                <tr key={coupon.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-md bg-[#0A0A0A] border border-white/5 overflow-hidden shrink-0">
                        {coupon.image_url ? (
                          <img src={coupon.image_url} alt={coupon.title} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-white/10 text-[8px]">N/A</div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="text-white font-medium text-sm block truncate">{coupon.title}</span>
                        <span className="text-white/20 text-[10px] font-mono">{coupon.code}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 text-xs block">{coupon.stores?.name || 'GENERICO'}</span>
                    {coupon.category && <span className="text-white/20 text-[10px] block mt-0.5">{coupon.category}</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider ${PLAN_COLORS[coupon.plan_type] || 'text-white/40 bg-white/5'}`}>
                      {PLAN_LABELS[coupon.plan_type] || coupon.plan_type}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 text-xs block">{new Date(coupon.start_date).toLocaleDateString()}</span>
                    <span className="text-white/20 text-[10px] block mt-0.5">al {new Date(coupon.end_date).toLocaleDateString()}</span>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <span className="text-emerald-400 text-sm font-medium block">${coupon.price_usd?.toFixed(2) || '0.00'}</span>
                    <div className="mt-0.5">
                      <span className={`text-xs font-medium ${coupon.amount_available <= 5 ? 'text-amber-400' : 'text-white/60'}`}>
                        {coupon.amount_available} disp.
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
              label="combos"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </div>
      )}
    </div>
  );
}
