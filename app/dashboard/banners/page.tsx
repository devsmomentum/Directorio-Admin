'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

export default function BannersCRUD() {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const [brandName, setBrandName] = useState('');
  const [planType, setPlanType] = useState('ORO');
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState('15');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    setRefreshing(true);
    const { data } = await supabase
      .from('ad_campaigns')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (data) setCampaigns(data);
    setLoading(false);
    setRefreshing(false);
  };

  const resetForm = () => {
    setEditingId(null);
    setBrandName('');
    setPlanType('ORO');
    setFile(null);
    setDuration('15');
    setStartDate('');
    setEndDate('');
    setShowForm(false);
  };

  const handleEdit = (camp: any) => {
    setEditingId(camp.id);
    setBrandName(camp.brand_name || '');
    setPlanType(camp.plan_type || 'ORO');
    setDuration(String(camp.duration_seconds || 15));
    setStartDate(camp.start_date || '');
    setEndDate(camp.end_date || '');
    setFile(null);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!editingId && !file) {
      alert('Selecciona un archivo (imagen o video vertical).');
      return;
    }

    setUploading(true);

    try {
      let mediaUrl: string | undefined;
      let mediaType: string | undefined;

      // Upload file if provided (new campaign or replacing file on edit)
      if (file) {
        const fileExt = file.name.split('.').pop();
        const cleanBrandName = brandName.replace(/\s+/g, '_').toLowerCase();
        const fileName = `${cleanBrandName}_banner.${fileExt}`;
        const filePath = `campaigns/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('publicidad')
          .upload(filePath, file, { upsert: true, cacheControl: '3600' });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('publicidad')
          .getPublicUrl(filePath);

        mediaUrl = publicUrl;
        mediaType = file.type.startsWith('video/') ? 'video' : 'image';
      }

      if (editingId) {
        // Update existing
        const updateData: any = {
          brand_name: brandName,
          plan_type: planType,
          duration_seconds: parseInt(duration),
          start_date: startDate || new Date().toISOString().split('T')[0],
          end_date: endDate || null,
        };
        if (mediaUrl) {
          updateData.media_url = mediaUrl;
          updateData.media_type = mediaType;
        }

        const { error } = await supabase.from('ad_campaigns').update(updateData).eq('id', editingId);
        if (error) throw error;
      } else {
        // Insert new
        const { error } = await supabase.from('ad_campaigns').insert([{
          brand_name: brandName,
          plan_type: planType,
          media_url: mediaUrl,
          media_type: mediaType,
          duration_seconds: parseInt(duration),
          start_date: startDate || new Date().toISOString().split('T')[0],
          end_date: endDate || null,
          is_active: true
        }]);
        if (error) throw error;
      }

      resetForm();
      fetchCampaigns();
    } catch (error: any) {
      alert('Error: ' + error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, mediaUrl: string) => {
    if (confirm('Eliminar esta campana y su archivo de la nube?')) {
      try {
        const pathToRemove = mediaUrl.substring(mediaUrl.indexOf('campaigns/'));
        if (pathToRemove) {
          await supabase.storage.from('publicidad').remove([pathToRemove]);
        }
        await supabase.from('ad_campaigns').delete().eq('id', id);
        fetchCampaigns();
      } catch {
        alert('Error al eliminar. Verifica los permisos del bucket.');
      }
    }
  };

  const handleToggleActive = async (id: string, current: boolean) => {
    const { error } = await supabase.from('ad_campaigns').update({ is_active: !current }).eq('id', id);
    if (error) {
      alert('Error al cambiar estado: ' + error.message);
      return;
    }
    setCampaigns(prev => prev.map(c => c.id === id ? { ...c, is_active: !current } : c));
  };

  const planColors: Record<string, string> = {
    'DIAMANTE': 'text-cyan-400 bg-cyan-500/10',
    'ORO': 'text-amber-400 bg-amber-500/10',
    'SOCIOS': 'text-purple-400 bg-purple-500/10',
    'BONO_FLASH': 'text-pink-400 bg-pink-500/10',
  };

  const planLabels: Record<string, string> = {
    'DIAMANTE': 'Diamante',
    'ORO': 'Oro',
    'SOCIOS': 'Socios',
    'BONO_FLASH': 'Flash',
  };

  const filtered = useMemo(() => {
    if (!search) return campaigns;
    const q = search.toLowerCase();
    return campaigns.filter(c => (c.brand_name || '').toLowerCase().includes(q) || (c.plan_type || '').toLowerCase().includes(q));
  }, [campaigns, search]);
  const pg = usePagination(filtered);

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
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Publicidad</p>
          <h2 className="text-2xl font-bold text-white">Campanas</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchCampaigns}
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
            Nueva campana
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
          placeholder="Buscar por marca o plan..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">
                {editingId ? 'Editar campana' : 'Nueva campana publicitaria'}
              </h3>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Marca / Cliente</label>
                  <input
                    type="text"
                    required
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: KFC"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan</label>
                  <select
                    required
                    value={planType}
                    onChange={(e) => setPlanType(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  >
                    <option value="DIAMANTE">Diamante (90s)</option>
                    <option value="ORO">Oro (3m)</option>
                    <option value="SOCIOS">Socios Fijos</option>
                    <option value="BONO_FLASH">Bono Flash</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Duracion (seg)</label>
                  <input
                    type="number"
                    max="15"
                    required
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Archivo {editingId && <span className="normal-case tracking-normal">(dejar vacio para mantener)</span>}
                  </label>
                  <input
                    type="file"
                    accept="video/mp4,image/png,image/jpeg"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fecha inicio</label>
                  <input
                    type="date"
                    required
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fecha fin (opcional)</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  />
                </div>
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
                  disabled={uploading}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {uploading ? 'Procesando...' : editingId ? 'Guardar cambios' : 'Publicar campana'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Campaigns list */}
      {campaigns.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          <p className="text-white/30 text-sm">No hay campanas activas</p>
          <p className="text-white/15 text-xs mt-1">Crea una nueva campana para empezar</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Campana</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Plan</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Tipo</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Periodo</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Estado</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pg.paginated.map((camp) => (
                <tr key={camp.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-12 bg-[#0A0A0A] rounded-md overflow-hidden shrink-0 border border-white/5">
                        {camp.media_type === 'image' ? (
                          <img src={camp.media_url} alt={camp.brand_name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <svg className="w-3 h-3 text-white/20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                          </div>
                        )}
                      </div>
                      <div>
                        <span className="text-white font-medium text-sm">{camp.brand_name}</span>
                        <span className="block text-white/20 text-[10px] font-mono">{camp.duration_seconds}s</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider ${planColors[camp.plan_type] || 'text-white/40 bg-white/5'}`}>
                      {planLabels[camp.plan_type] || camp.plan_type}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 text-xs capitalize">{camp.media_type === 'video' ? 'Video' : 'Imagen'}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 text-xs font-mono">{camp.start_date}</span>
                    {camp.end_date && (
                      <span className="text-white/20 text-xs font-mono"> — {camp.end_date}</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => handleToggleActive(camp.id, camp.is_active)}
                      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md transition-colors ${
                        camp.is_active
                          ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
                          : 'text-white/30 bg-white/5 hover:bg-white/10'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${camp.is_active ? 'bg-emerald-500' : 'bg-white/20'}`} />
                      {camp.is_active ? 'Activa' : 'Pausada'}
                    </button>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <a
                        href={camp.media_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Ver archivo"
                        className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      </a>
                      <button
                        onClick={() => handleEdit(camp)}
                        title="Editar"
                        className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDelete(camp.id, camp.media_url)}
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
              label="campanas"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </div>
      )}
    </div>
  );
}
