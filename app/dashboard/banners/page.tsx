'use client';

import { useState, useEffect, useMemo, useRef, ChangeEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

const BANNER_W = 80;
const BANNER_H = 192;
const SCALE = 2;

const UI_POSITIONS = ['top', 'bottom'] as const;

// Plan exclusivo para slots de banner (PDF "PLANES DIRECTORIOS").
const DIAMANTE_PLAN = 'DIAMANTE';

interface Campaign { id: string; brand_name: string; }

interface DiamanteStore {
  id: string;
  name: string;
  logo_url: string | null;
  plan_type: string | null;
}

interface Banner {
  id: string;
  media_url: string;
  media_type: 'image' | 'video';
  ui_position: string;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  campaign_id: string | null;
  store_id: string | null;
  slot_position: number | null;
  ad_campaigns?: { brand_name: string };
  stores?: { id: string; name: string; logo_url: string | null; plan_type: string | null };
}

function KioskPreview({ src, type, inactive = false, scale = SCALE }: {
  src: string; type: 'image' | 'video'; inactive?: boolean; scale?: number;
}) {
  const [errored, setErrored] = useState(false);
  const w = BANNER_W * scale;
  const h = BANNER_H * scale;

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <div
        className="relative border border-white/15 rounded-sm overflow-hidden bg-[#0a0a0a] shadow-lg shadow-black/60"
        style={{ width: w, height: h }}
      >
        {inactive && (
          <div className="absolute inset-0 bg-black/55 z-10 flex items-center justify-center pointer-events-none">
            <span className="text-white/50 text-[9px] font-bold tracking-widest rotate-[-45deg] select-none">PAUSADO</span>
          </div>
        )}
        {errored || !src ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1">
            <svg className="w-5 h-5 text-white/10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            <span className="text-white/15 text-[7px]">sin media</span>
          </div>
        ) : type === 'video' ? (
          <video src={src} className="w-full h-full object-cover" muted autoPlay loop playsInline onError={() => setErrored(true)} />
        ) : (
          <img src={src} className="w-full h-full object-cover" alt="banner" onError={() => setErrored(true)} />
        )}
      </div>
      <span className="text-[8px] text-white/20 font-mono">{BANNER_W}×{BANNER_H}px</span>
    </div>
  );
}

export default function BannersAdminPage() {
  const [banners, setBanners] = useState<Banner[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [diamanteStores, setDiamanteStores] = useState<DiamanteStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState('');
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');
  const [uiPosition, setUiPosition] = useState('home_hero');
  const [slotPosition, setSlotPosition] = useState(1);
  const [isActive, setIsActive] = useState(true);
  const [campaignId, setCampaignId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [storeSearch, setStoreSearch] = useState('');
  const [storeDropdownOpen, setStoreDropdownOpen] = useState(false);
  const storeBoxRef = useRef<HTMLDivElement | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => { fetchData(); }, []);

  // Cerrar el combobox al clickear fuera del contenedor.
  useEffect(() => {
    if (!storeDropdownOpen) return;
    const handler = (ev: MouseEvent) => {
      if (storeBoxRef.current && !storeBoxRef.current.contains(ev.target as Node)) {
        setStoreDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [storeDropdownOpen]);

  const filteredDiamanteStores = useMemo(() => {
    if (!storeSearch) return diamanteStores;
    const q = storeSearch.toLowerCase();
    return diamanteStores.filter(s => s.name.toLowerCase().includes(q));
  }, [diamanteStores, storeSearch]);

  const selectedStore = useMemo(
    () => diamanteStores.find(s => s.id === storeId) || null,
    [diamanteStores, storeId]
  );

  // Si la tienda vinculada perdió el plan DIAMANTE, el SELECT en fetchData no
  // la traerá; recurrimos al `stores` embebido del banner que estamos editando
  // para que el formulario muestre el nombre real en vez de un id huérfano.
  const editingStoreFallback = useMemo(() => {
    if (!editingId) return null;
    if (selectedStore) return null;
    const b = banners.find(x => x.id === editingId);
    return b?.stores || null;
  }, [editingId, selectedStore, banners]);

  const fetchData = async () => {
    setRefreshing(true);
    const [bannersRes, campsRes, storesRes] = await Promise.all([
      supabase
        .from('banners')
        .select('*, ad_campaigns(brand_name), stores(id, name, logo_url, plan_type)')
        .order('ui_position')
        .order('slot_position', { ascending: true }),
      supabase.from('ad_campaigns').select('id, brand_name').order('brand_name'),
      // Solo tiendas DIAMANTE pueden tener banner (regla del PDF "PLANES DIRECTORIOS").
      supabase
        .from('stores')
        .select('id, name, logo_url, plan_type')
        .eq('plan_type', DIAMANTE_PLAN)
        .order('name'),
    ]);

    if (bannersRes.error) {
      console.error("Error fetching banners:", bannersRes.error);
      alert("Error al cargar banners: " + bannersRes.error.message);
    } else if (bannersRes.data) {
      setBanners(bannersRes.data as Banner[]);
    }

    if (campsRes.error) {
      console.error("Error fetching campaigns:", campsRes.error);
    } else if (campsRes.data) {
      setCampaigns(campsRes.data);
    }

    if (storesRes.error) {
      console.error("Error fetching DIAMANTE stores:", storesRes.error);
    } else if (storesRes.data) {
      setDiamanteStores(storesRes.data as DiamanteStore[]);
    }

    setLoading(false);
    setRefreshing(false);
  };

  const resetForm = () => {
    setEditingId(null); setMediaFile(null); setMediaPreview('');
    setMediaType('image'); setUiPosition('home_hero'); setSlotPosition(1);
    setIsActive(true); setCampaignId(''); setStartDate(''); setEndDate('');
    setStoreId(''); setStoreSearch(''); setStoreDropdownOpen(false);
    setShowForm(false);
  };

  const pg = usePagination(banners);

  const handleEdit = (b: Banner) => {
    setEditingId(b.id); setMediaPreview(b.media_url); setMediaType(b.media_type);
    setUiPosition(b.ui_position); setSlotPosition(b.slot_position || 1);
    setIsActive(b.is_active); setCampaignId(b.campaign_id || '');
    setStoreId(b.store_id || '');
    setStoreSearch(b.stores?.name || '');
    setStoreDropdownOpen(false);
    setStartDate(b.start_date ? b.start_date.split('T')[0] : '');
    setEndDate(b.end_date ? b.end_date.split('T')[0] : '');
    setShowForm(true);
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    if (file.size > (isVideo ? 15 : 2) * 1024 * 1024) {
      alert(`Máximo ${isVideo ? '15 MB (video)' : '2 MB (imagen)'}.`);
      e.target.value = ''; return;
    }
    setMediaFile(file);
    setMediaType(isVideo ? 'video' : 'image');
    setMediaPreview(URL.createObjectURL(file));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId && !mediaFile) { alert('Sube un archivo multimedia.'); return; }

    // Tienda DIAMANTE es obligatoria — el slot del banner solo se vende dentro
    // de ese plan. Validamos en cliente para feedback inmediato; el trigger
    // `enforce_banner_diamante` lo refuerza en BD.
    if (!storeId) {
      alert('Vincula una tienda con plan DIAMANTE antes de guardar el banner.');
      return;
    }
    const storeStillDiamante = diamanteStores.some(s => s.id === storeId);
    if (!storeStillDiamante) {
      alert('La tienda seleccionada ya no tiene plan DIAMANTE. Elige otra tienda DIAMANTE activa.');
      return;
    }

    setIsSaving(true);
    try {
      let finalUrl = mediaPreview;
      if (mediaFile) {
        const ext = mediaFile.name.split('.').pop();
        const fileName = `banner_${uiPosition}_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage.from('publicidad').upload(`banners/${fileName}`, mediaFile, { upsert: true });
        if (upErr) throw upErr;
        const { data: pubData } = supabase.storage.from('publicidad').getPublicUrl(`banners/${fileName}`);
        finalUrl = pubData.publicUrl;
      }
      const payload: any = {
        ui_position: uiPosition, slot_position: slotPosition,
        media_url: finalUrl, media_type: mediaType, is_active: isActive,
        store_id: storeId,
        campaign_id: campaignId || null,
        start_date: startDate ? new Date(startDate).toISOString() : null,
        end_date: endDate ? new Date(endDate).toISOString() : null,
      };
      if (editingId) {
        const { error } = await supabase.from('banners').update(payload).eq('id', editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('banners').insert([payload]);
        if (error) throw error;
      }
      resetForm(); fetchData();
    } catch (err: any) { alert(`Error: ${err.message}`); }
    finally { setIsSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminar este banner?')) return;
    const { error } = await supabase.from('banners').delete().eq('id', id);
    if (error) alert(error.message); else fetchData();
  };

  const handleToggle = async (id: string, current: boolean) => {
    const { error } = await supabase.from('banners').update({ is_active: !current }).eq('id', id);
    if (error) { alert(error.message); return; }
    setBanners(prev => prev.map(b => b.id === id ? { ...b, is_active: !current } : b));
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Interfaz</p>
          <h2 className="text-2xl font-bold text-white">Gestión de Banners UI</h2>
          <p className="text-white/25 text-xs mt-1">Vista previa real del kiosco: {BANNER_W} × {BANNER_H} px</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} disabled={refreshing}
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50">
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            disabled={diamanteStores.length === 0}
            title={diamanteStores.length === 0 ? 'No hay tiendas DIAMANTE: asigna el plan DIAMANTE a una tienda antes de crear banners' : undefined}
            className="flex items-center gap-2 text-sm font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 rounded-lg px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-emerald-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
            Nuevo Banner
          </button>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-sm font-semibold text-white">{editingId ? 'Editar Banner' : 'Nuevo Banner'}</h3>
                <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="flex gap-6 items-start">
                <form onSubmit={handleSave} className="flex-1 space-y-3 min-w-0">
                  {/* Tienda DIAMANTE — obligatoria */}
                  <div className="relative" ref={storeBoxRef}>
                    <label className="flex items-center justify-between text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                      <span>Tienda DIAMANTE <span className="text-cyan-400 normal-case tracking-normal">*</span></span>
                      <span className="text-[10px] text-white/25 normal-case tracking-normal">
                        {diamanteStores.length} disponibles
                      </span>
                    </label>
                    {diamanteStores.length === 0 && !editingStoreFallback ? (
                      <div className="bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2.5 text-xs text-red-300">
                        No hay tiendas con plan DIAMANTE. Asigna el plan a una tienda
                        antes de crear un banner (Directorio → Tiendas → editar → plan DIAMANTE).
                      </div>
                    ) : (
                      <>
                        <div
                          role="combobox"
                          aria-expanded={storeDropdownOpen}
                          aria-haspopup="listbox"
                          tabIndex={0}
                          onClick={() => { if (!storeDropdownOpen) setStoreSearch(''); setStoreDropdownOpen(!storeDropdownOpen); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStoreDropdownOpen(o => !o); } }}
                          className={`flex items-center justify-between w-full bg-[#0A0A0A] border rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors ${
                            storeId ? 'border-emerald-500/30' : 'border-white/10 hover:border-white/20'
                          }`}
                        >
                          <span className={`truncate ${selectedStore || editingStoreFallback ? 'text-white' : 'text-white/40'}`}>
                            {selectedStore?.name
                              || (editingStoreFallback
                                ? `${editingStoreFallback.name} (ya no es DIAMANTE)`
                                : 'Seleccionar tienda DIAMANTE...')}
                          </span>
                          <svg className={`w-4 h-4 text-white/30 transition-transform shrink-0 ${storeDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </div>
                        {storeDropdownOpen && (
                          <div className="absolute top-full left-0 right-0 mt-1 bg-[#1A1A1A] border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
                            <div className="p-2 border-b border-white/5">
                              <input
                                type="text"
                                autoFocus
                                value={storeSearch}
                                onChange={e => setStoreSearch(e.target.value)}
                                placeholder="Buscar tienda DIAMANTE..."
                                className="w-full bg-[#0A0A0A] border border-white/5 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none"
                              />
                            </div>
                            <div className="max-h-48 overflow-y-auto" role="listbox">
                              {filteredDiamanteStores.length === 0 ? (
                                <div className="px-3 py-3 text-xs text-white/30 text-center">Sin coincidencias</div>
                              ) : filteredDiamanteStores.map(s => (
                                <button
                                  type="button"
                                  key={s.id}
                                  role="option"
                                  aria-selected={s.id === storeId}
                                  onClick={() => {
                                    setStoreId(s.id);
                                    setStoreSearch(s.name);
                                    setStoreDropdownOpen(false);
                                  }}
                                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-white/5 transition-colors ${
                                    s.id === storeId ? 'bg-emerald-500/10 text-emerald-300' : 'text-white'
                                  }`}
                                >
                                  {s.logo_url ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={s.logo_url} alt="" className="w-5 h-5 rounded object-cover bg-[#0A0A0A] shrink-0" onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                                  ) : (
                                    <span className="w-5 h-5 rounded bg-cyan-500/15 text-cyan-300 text-[9px] font-semibold flex items-center justify-center shrink-0">
                                      {(s.name[0] || '?').toUpperCase()}
                                    </span>
                                  )}
                                  <span className="truncate">{s.name}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <p className="text-[10px] text-white/25 mt-1">Sólo tiendas con plan DIAMANTE pueden tener banner activo.</p>
                      </>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Posición UI</label>
                      <select value={uiPosition} onChange={e => setUiPosition(e.target.value)}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50">
                        {UI_POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Desde</label>
                      <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50" />
                    </div>
                    <div>
                      <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Hasta</label>
                      <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2.5">
                    <div>
                      <p className="text-[11px] text-white/40 uppercase tracking-wider">Estado</p>
                      <p className="text-[10px] text-white/20 mt-0.5">{isActive ? 'Se mostrará al guardar' : 'Quedará pausado'}</p>
                    </div>
                    <button type="button" onClick={() => setIsActive(!isActive)}
                      className={`relative w-10 h-5 rounded-full transition-colors ${isActive ? 'bg-emerald-500/60' : 'bg-white/10'}`}>
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                      Multimedia {editingId && <span className="normal-case tracking-normal text-white/20">(vacío = mantener)</span>}
                    </label>
                    <input type="file" accept="image/*,video/*" onChange={handleFileChange}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:bg-white/10 file:text-white/70 file:text-xs" />
                    <p className="text-[10px] text-white/20 mt-1">Imagen máx 2 MB · Video máx 15 MB</p>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button type="button" onClick={resetForm}
                      className="flex-1 py-2 text-sm bg-white/5 hover:bg-white/10 text-white/50 rounded-lg transition-colors">
                      Cancelar
                    </button>
                    <button type="submit" disabled={isSaving || !storeId}
                      title={!storeId ? 'Vincula una tienda DIAMANTE para habilitar el guardado' : undefined}
                      className="flex-1 py-2 text-sm bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      {isSaving ? 'Guardando...' : !storeId ? 'Falta tienda DIAMANTE' : 'Guardar banner'}
                    </button>
                  </div>
                </form>

                {/* Live preview */}
                <div className="flex flex-col items-center gap-2 shrink-0">
                  <p className="text-[9px] text-white/30 uppercase tracking-widest font-medium">Vista kiosco</p>
                  {mediaPreview ? (
                    <KioskPreview src={mediaPreview} type={mediaType} inactive={!isActive} scale={SCALE} />
                  ) : (
                    <div className="flex flex-col items-center gap-1">
                      <div className="border border-dashed border-white/10 rounded-sm bg-white/[0.02] flex items-center justify-center"
                        style={{ width: BANNER_W * SCALE, height: BANNER_H * SCALE }}>
                        <span className="text-white/15 text-[9px] text-center px-2 leading-relaxed">Selecciona<br />un archivo</span>
                      </div>
                      <span className="text-[8px] text-white/20 font-mono">{BANNER_W}×{BANNER_H}px</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {banners.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="text-white/30 text-sm">No hay banners registrados</p>
          <p className="text-white/15 text-xs mt-1">Haz clic en "Nuevo Banner" para empezar</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <div className="divide-y divide-white/[0.04]">
            {pg.paginated.map(b => (
              <div
                key={b.id}
                className={`flex items-center gap-5 px-5 py-4 hover:bg-white/[0.02] transition-colors ${!b.is_active ? 'opacity-55' : ''}`}
              >
                {/* Kiosk preview at 1× */}
                <KioskPreview src={b.media_url} type={b.media_type} inactive={!b.is_active} scale={1} />

                {/* Metadata */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-medium">
                      {b.ui_position}
                    </span>
                    <span className="text-white/30 text-[10px] font-mono">Slot {b.slot_position ?? '—'}</span>
                    <span className={`text-[10px] ${b.media_type === 'video' ? 'text-blue-400' : 'text-white/30'}`}>
                      {b.media_type === 'video' ? '▶ Video' : '🖼 Imagen'}
                    </span>
                  </div>
                  {b.stores ? (
                    <div className="flex items-center gap-2 mb-1">
                      {b.stores.logo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={b.stores.logo_url} alt="" className="w-5 h-5 rounded object-cover bg-[#0A0A0A] border border-white/5 shrink-0" onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      ) : (
                        <span className="w-5 h-5 rounded bg-cyan-500/15 text-cyan-300 text-[9px] font-semibold flex items-center justify-center shrink-0">
                          {(b.stores.name[0] || '?').toUpperCase()}
                        </span>
                      )}
                      <span className="text-white/70 text-xs truncate">{b.stores.name}</span>
                      {b.stores.plan_type === DIAMANTE_PLAN ? (
                        <span className="text-cyan-400 bg-cyan-500/10 text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded">DIAMANTE</span>
                      ) : (
                        <span className="text-amber-400 bg-amber-500/10 text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded" title="La tienda ya no es DIAMANTE — el banner sigue vivo pero no es editable sin reasignar a otra tienda DIAMANTE.">
                          plan caducó
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-amber-400 text-xs mb-1">⚠ Banner sin tienda vinculada</p>
                  )}
                  {b.ad_campaigns?.brand_name && (
                    <p className="text-white/40 text-[10px] mb-1">Campaña: {b.ad_campaigns.brand_name}</p>
                  )}
                  {(b.start_date || b.end_date) && (
                    <p className="text-white/25 text-[10px] font-mono">
                      {b.start_date ? new Date(b.start_date).toLocaleDateString('es-VE') : '∞'}
                      {' → '}
                      {b.end_date ? new Date(b.end_date).toLocaleDateString('es-VE') : '∞'}
                    </p>
                  )}
                  <p className="text-white/15 text-[10px] font-mono truncate mt-1 max-w-xs">{b.media_url}</p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleToggle(b.id, b.is_active)}
                    className={`flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                      b.is_active
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-amber-500/10 hover:text-amber-400 hover:border-amber-500/20'
                        : 'bg-white/5 text-white/30 border-white/10 hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/20'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${b.is_active ? 'bg-emerald-400' : 'bg-white/20'}`} />
                    {b.is_active ? 'Activo' : 'Pausado'}
                  </button>
                  <button onClick={() => handleEdit(b)} title="Editar"
                    className="p-2 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                  </button>
                  <button onClick={() => handleDelete(b.id)} title="Eliminar"
                    className="p-2 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
          {pg.totalPages > 1 && (
            <Pagination page={pg.page} totalPages={pg.totalPages} total={pg.total}
              perPage={pg.perPage} label="banners" onPageChange={pg.setPage} onPerPageChange={pg.changePerPage} />
          )}
        </div>
      )}
    </div>
  );
}
