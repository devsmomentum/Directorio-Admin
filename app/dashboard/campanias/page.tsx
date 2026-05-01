'use client';

import { useState, useEffect, useMemo, ChangeEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

const PLAN_TYPES = ['DIAMANTE', 'ORO', 'SOCIOS', 'BONO_FLASH'] as const;

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  ORO: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  SOCIOS: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  BONO_FLASH: 'text-pink-400 bg-pink-500/10 border-pink-500/30',
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
  stores?: { name: string };
}

export default function CampaniasAdminPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Form Fields
  const [editingId, setEditingId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState('');
  const [planType, setPlanType] = useState<string>('ORO');
  const [description, setDescription] = useState('');
  const [durationSecs, setDurationSecs] = useState<number>(15);
  const [startDate, setStartDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState<string>('');
  const [storeId, setStoreId] = useState<string>('');
  const [priorityLevel, setPriorityLevel] = useState<number>(1);
  const [slotLimitGroup, setSlotLimitGroup] = useState<string>('');
  const [targetFrequency, setTargetFrequency] = useState<number | ''>('');
  const [isActive, setIsActive] = useState<boolean>(true);

  // File handling
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState('');
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [campRes, storesRes] = await Promise.all([
      supabase.from('ad_campaigns').select('*, stores(name)').order('created_at', { ascending: false }).limit(200),
      supabase.from('stores').select('id, name').order('name').limit(500)
    ]);
    if (campRes.data) setCampaigns(campRes.data as Campaign[]);
    if (storesRes.data) setStores(storesRes.data);
    setLoading(false);
    setRefreshing(false);
  };

  const resetForm = () => {
    setEditingId(null);
    setBrandName('');
    setPlanType('ORO');
    setDescription('');
    setDurationSecs(15);
    setStartDate(new Date().toISOString().split('T')[0]);
    setEndDate('');
    setStoreId('');
    setPriorityLevel(1);
    setSlotLimitGroup('');
    setTargetFrequency('');
    setIsActive(true);
    setMediaFile(null);
    setMediaPreview('');
    setMediaType('image');
    setShowForm(false);
  };

  const filtered = useMemo(() => {
    if (!search) return campaigns;
    const q = search.toLowerCase();
    return campaigns.filter(c => 
      c.brand_name.toLowerCase().includes(q) || 
      c.plan_type.toLowerCase().includes(q) ||
      (c.stores?.name || '').toLowerCase().includes(q)
    );
  }, [campaigns, search]);

  const pg = usePagination(filtered);

  const handleEdit = (c: Campaign) => {
    setEditingId(c.id);
    setBrandName(c.brand_name);
    setPlanType(c.plan_type);
    setDescription(c.description || '');
    setDurationSecs(c.duration_seconds || 15);
    setStartDate(c.start_date || '');
    setEndDate(c.end_date || '');
    setStoreId(c.store_id || '');
    setPriorityLevel(c.priority_level || 1);
    setSlotLimitGroup(c.slot_limit_group || '');
    setTargetFrequency(c.target_frequency_seconds || '');
    setIsActive(c.is_active);
    setMediaPreview(c.media_url);
    setMediaType(c.media_type as 'image'|'video');
    setMediaFile(null);
    setShowForm(true);
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const isVideo = file.type.startsWith('video/');
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
    setIsSaving(true);

    try {
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
        duration_seconds: durationSecs,
        start_date: startDate ? new Date(startDate).toISOString().split('T')[0] : null,
        end_date: endDate ? new Date(endDate).toISOString().split('T')[0] : null,
        is_active: isActive,
        description: description,
        priority_level: priorityLevel,
        slot_limit_group: slotLimitGroup || null,
        target_frequency_seconds: targetFrequency === '' ? null : Number(targetFrequency),
        store_id: storeId || null
      };

      if (editingId) {
        const { error } = await supabase.from('ad_campaigns').update(payload).eq('id', editingId);
        if (error) throw error;
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
      const match = url.match(/campaigns\/(.+)$/);
      if (match && match[1]) {
        await supabase.storage.from('publicidad').remove([`campaigns/${match[1]}`]);
      }
      const { error } = await supabase.from('ad_campaigns').delete().eq('id', id);
      if (error) throw error;
      fetchData();
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  const handleToggleActive = async (id: string, current: boolean) => {
    const { error } = await supabase.from('ad_campaigns').update({ is_active: !current }).eq('id', id);
    if (!error) {
      setCampaigns(prev => prev.map(c => c.id === id ? { ...c, is_active: !current } : c));
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
      <div className="flex items-end justify-between">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Publicidad</p>
          <h2 className="text-2xl font-bold text-white">Campañas Publicitarias</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} disabled={refreshing} className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2">
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button onClick={() => { resetForm(); setShowForm(true); }} className="flex items-center gap-2 text-sm font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20 hover:bg-orange-500/20 rounded-lg px-4 py-2">
            Nueva Campaña
          </button>
        </div>
      </div>

      <div className="relative">
        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por marca o plan..." className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10" />
      </div>

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

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan de pauta</label>
                  <select required value={planType} onChange={e => setPlanType(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none">
                    {PLAN_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Prioridad (1 = Mayor)</label>
                  <input type="number" min="1" value={priorityLevel} onChange={e => setPriorityLevel(parseInt(e.target.value) || 1)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Duración (seg)</label>
                  <input type="number" required min="1" max="60" value={durationSecs} onChange={e => setDurationSecs(parseInt(e.target.value) || 15)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Frecuencia Obj. (seg)</label>
                  <input type="number" min="1" value={targetFrequency} onChange={e => setTargetFrequency(e.target.value)} placeholder="Ej: 180" className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Grupo Limitación Slot</label>
                  <input type="text" value={slotLimitGroup} onChange={e => setSlotLimitGroup(e.target.value)} placeholder="Ej: FOOD_COURT" className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio Campaña</label>
                  <input type="date" required value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin Campaña</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500/50 outline-none" />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Media {editingId && <span className="normal-case tracking-normal">(dejar vacio para mantener)</span>}
                </label>
                <input type="file" accept="image/*,video/*" onChange={handleFileChange} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:bg-white/10 file:text-white" />
                {mediaPreview && (
                  <div className="mt-2 h-32 bg-black rounded-lg border border-white/5 overflow-hidden flex items-center justify-center">
                    {mediaType === 'video' ? <video src={mediaPreview} className="h-full object-contain" muted autoPlay loop /> : <img src={mediaPreview} className="h-full object-contain" />}
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <button type="button" onClick={resetForm} className="flex-1 py-2 text-sm bg-white/5 hover:bg-white/10 text-white/50 rounded-lg">Cancelar</button>
                <button type="submit" disabled={isSaving} className="flex-1 py-2 text-sm bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border border-orange-500/30 rounded-lg disabled:opacity-50">
                  {isSaving ? 'Guardando...' : 'Guardar Campaña'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {campaigns.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">No hay campañas registradas</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {pg.paginated.map((c) => {
            const isVideo = c.media_type === 'video';
            const isActiveState = c.is_active && (!c.end_date || new Date(c.end_date) >= new Date());
            
            return (
              <div key={c.id} className={`bg-[#111] border rounded-xl overflow-hidden group transition-all ${isActiveState ? 'border-white/10' : 'border-white/5 opacity-70'}`}>
                <div className="h-40 bg-black relative">
                  {isVideo ? <video src={c.media_url} className="w-full h-full object-cover" muted autoPlay loop /> : <img src={c.media_url} className="w-full h-full object-cover" />}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                  <div className="absolute top-3 right-3">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${PLAN_COLORS[c.plan_type] || 'text-white border-white'}`}>
                      {c.plan_type}
                    </span>
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
                      {new Date(c.start_date).toLocaleDateString()} {c.end_date ? `- ${new Date(c.end_date).toLocaleDateString()}` : '∞'}
                    </span>
                  </div>

                  <div className="pt-3 border-t border-white/5 flex items-center justify-between">
                    <button onClick={() => handleToggleActive(c.id, c.is_active)} className={`text-[10px] flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${c.is_active ? 'bg-orange-500/10 text-orange-400' : 'bg-white/5 text-white/30'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${c.is_active ? 'bg-orange-400' : 'bg-white/20'}`} />
                      {c.is_active ? 'Activo' : 'Pausado'}
                    </button>
                    
                    <div className="flex gap-1">
                      <button onClick={() => handleEdit(c)} className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button onClick={() => handleDelete(c.id, c.media_url)} className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10">
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
    </div>
  );
}
