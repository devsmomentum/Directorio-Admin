'use client';

import { useState, useEffect, ChangeEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

interface Store { id: string; name: string; }
interface Coupon {
  id: string;
  title: string;
  store_id: string;
  stores: { name: string };
  image_url: string;
  code: string;
  amount_available: number;
  price_usd: number;
}

export default function CuponsAdminPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [storeSearch, setStoreSearch] = useState('');
  const [storeDropdownOpen, setStoreDropdownOpen] = useState(false);

  const [editingCouponId, setEditingCouponId] = useState<string | null>(null);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [couponTitle, setCouponTitle] = useState('');
  const [amountAvailable, setAmountAvailable] = useState<number>(0);
  const [priceUsd, setPriceUsd] = useState<number>(0);
  const [imageFile, setImageFile] = useState<File | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [storesRes, couponsRes] = await Promise.all([
      supabase.from('stores').select('id, name').order('name'),
      supabase.from('coupons').select('*, stores(name)').order('created_at', { ascending: false }),
    ]);
    if (storesRes.data) setStores(storesRes.data);
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
    setShowForm(false);
  };

  const selectStore = (store: Store) => {
    setSelectedStoreId(store.id);
    setStoreSearch(store.name);
    setStoreDropdownOpen(false);
  };

  const filteredStores = stores.filter(s =>
    !storeSearch || s.name.toLowerCase().includes(storeSearch.toLowerCase())
  );

  const handleEditClick = (coupon: Coupon) => {
    setEditingCouponId(coupon.id);
    setSelectedStoreId(coupon.store_id);
    setStoreSearch(coupon.stores?.name || '');
    setCouponTitle(coupon.title);
    setAmountAvailable(coupon.amount_available);
    setPriceUsd(coupon.price_usd);
    setImageFile(null);
    setShowForm(true);
  };

  const handleDeleteClick = async (id: string) => {
    if (!confirm('Eliminar este combo? Esta accion no se puede deshacer.')) return;
    await supabase.from('coupons').delete().eq('id', id);
    fetchData();
  };

  const handleSaveCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStoreId || !couponTitle || amountAvailable <= 0 || priceUsd <= 0) {
      alert('Completa todos los campos.');
      return;
    }
    if (!editingCouponId && !imageFile) {
      alert('Sube una imagen para el combo nuevo.');
      return;
    }

    setIsSaving(true);
    try {
      let publicUrl: string | undefined;
      if (imageFile) {
        const fileExt = imageFile.name.split('.').pop();
        const filePath = `coupon_images/${Date.now()}.${fileExt}`;
        const { error: uploadError } = await supabase.storage.from('coupons').upload(filePath, imageFile);
        if (uploadError) throw uploadError;
        publicUrl = supabase.storage.from('coupons').getPublicUrl(filePath).data.publicUrl;
      }

      if (editingCouponId) {
        const updateData: any = { store_id: selectedStoreId, title: couponTitle, amount_available: amountAvailable, price_usd: priceUsd };
        if (publicUrl) updateData.image_url = publicUrl;
        const { error } = await supabase.from('coupons').update(updateData).eq('id', editingCouponId);
        if (error) throw error;
      } else {
        const storeName = stores.find(s => s.id === selectedStoreId)?.name || 'TIENDA';
        const code = `CUPON-${storeName.substring(0, 3).toUpperCase()}-${Date.now().toString().substring(7)}`;
        const { error } = await supabase.from('coupons').insert({ store_id: selectedStoreId, title: couponTitle, image_url: publicUrl, code, amount_available: amountAvailable, price_usd: priceUsd });
        if (error) throw error;
      }

      resetForm();
      fetchData();
    } catch (error: any) {
      alert('Error: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const filtered = coupons.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.title.toLowerCase().includes(q) || c.stores?.name?.toLowerCase().includes(q);
  });
  const pg = usePagination(filtered);

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
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Catalogo</p>
          <h2 className="text-2xl font-bold text-white">Cupones y Combos</h2>
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
            Nuevo combo
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por titulo o tienda..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">
                {editingCouponId ? 'Editar combo' : 'Nuevo combo'}
              </h3>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSaveCoupon} className="space-y-4">
              <div className="relative">
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Tienda</label>
                <div className="relative">
                  <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input
                    type="text"
                    value={storeSearch}
                    onChange={e => {
                      setStoreSearch(e.target.value);
                      setStoreDropdownOpen(true);
                      if (!e.target.value) setSelectedStoreId('');
                    }}
                    onFocus={() => setStoreDropdownOpen(true)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-9 pr-8 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                    placeholder="Buscar tienda..."
                  />
                  {selectedStoreId && (
                    <button
                      type="button"
                      onClick={() => { setSelectedStoreId(''); setStoreSearch(''); }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
                {storeDropdownOpen && !selectedStoreId && (
                  <div className="absolute z-10 mt-1 w-full bg-[#0A0A0A] border border-white/10 rounded-lg shadow-xl max-h-40 overflow-y-auto">
                    {filteredStores.length === 0 ? (
                      <div className="px-3 py-2.5 text-xs text-white/20">Sin resultados</div>
                    ) : (
                      filteredStores.map(s => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => selectStore(s)}
                          className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 transition-colors"
                        >
                          {s.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
                <input type="hidden" required value={selectedStoreId} />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Titulo</label>
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
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Precio ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={priceUsd === 0 ? '' : priceUsd}
                    onChange={e => setPriceUsd(parseFloat(e.target.value) || 0)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                    placeholder="5.50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Stock</label>
                  <input
                    type="number"
                    required
                    value={amountAvailable === 0 ? '' : amountAvailable}
                    onChange={e => setAmountAvailable(parseInt(e.target.value) || 0)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                    placeholder="100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Imagen {editingCouponId && <span className="normal-case tracking-normal">(dejar vacio para mantener)</span>}
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files?.[0]) setImageFile(e.target.files[0]); }}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                />
              </div>
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
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Tienda</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Precio</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Stock</th>
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
                          <img src={coupon.image_url} alt={coupon.title} className="w-full h-full object-cover" />
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
                    <span className="text-white/40 text-xs">{coupon.stores?.name || '—'}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-emerald-400 text-sm font-medium">${coupon.price_usd?.toFixed(2) || '0.00'}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-sm font-medium ${coupon.amount_available <= 5 ? 'text-amber-400' : 'text-white/60'}`}>
                      {coupon.amount_available}
                    </span>
                    {coupon.amount_available <= 5 && coupon.amount_available > 0 && (
                      <span className="text-amber-400/50 text-[10px] ml-1.5">bajo</span>
                    )}
                    {coupon.amount_available === 0 && (
                      <span className="text-red-400/50 text-[10px] ml-1.5">agotado</span>
                    )}
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
                        onClick={() => handleDeleteClick(coupon.id)}
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
