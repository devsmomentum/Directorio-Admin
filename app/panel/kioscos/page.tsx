'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';
import { toast } from '../../components/toast';
import { confirmDialog } from '../../components/confirm-dialog';

export default function KioscosCRUD() {
  const [kiosks, setKiosks] = useState<any[]>([]);
  const [malls, setMalls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  // Centro comercial al que pertenece el kiosco: define qué tiendas lista en
  // su directorio/mapa. La app del kiosco filtra `stores` por este mall_id.
  const [mallId, setMallId] = useState('');

  // Mall por defecto para kioscos nuevos: Millennium si existe, si no el primero.
  const defaultMallId = useMemo(
    () => malls.find(m => m.code === 'MILLENNIUM')?.id || malls[0]?.id || '',
    [malls]
  );

  useEffect(() => {
    fetchKiosks();
  }, []);

  const fetchKiosks = async () => {
    setRefreshing(true);
    const [kiosksRes, mallsRes] = await Promise.all([
      supabase.from('kiosks').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('malls').select('id, name, code').order('name', { ascending: true }),
    ]);

    if (kiosksRes.data) setKiosks(kiosksRes.data);
    if (mallsRes.data) setMalls(mallsRes.data);
    setLoading(false);
    setRefreshing(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    if (editingId) {
      const { error } = await supabase
        .from('kiosks')
        .update({ name, location, mall_id: mallId || null })
        .eq('id', editingId);

      if (error) { toast.error('Error al actualizar: ' + error.message); setSubmitting(false); return; }
      toast.success('Kiosco actualizado.');
    } else {
      const { error } = await supabase.from('kiosks').insert([{
        name,
        location,
        mall_id: mallId || null,
        status: 'offline',
        hardware_id: null
      }]);

      if (error) { toast.error('Error al crear: ' + error.message); setSubmitting(false); return; }
      toast.success('Kiosco creado.');
    }

    resetForm();
    fetchKiosks();
    setSubmitting(false);
  };

  const handleEdit = (kiosk: any) => {
    setEditingId(kiosk.id);
    setName(kiosk.name || '');
    setLocation(kiosk.location || '');
    setMallId(kiosk.mall_id || '');
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setLocation('');
    setMallId(defaultMallId);
    setShowForm(false);
  };

  const handleUnbind = async (id: string) => {
    const ok = await confirmDialog({
      title: 'Desvincular hardware',
      message: 'Dejará de registrar analíticas hasta vincular una nueva pantalla.',
      confirmLabel: 'Desvincular',
      tone: 'danger',
    });
    if (!ok) return;
    const { error } = await supabase.from('kiosks').update({ hardware_id: null, status: 'offline' }).eq('id', id);
    if (error) { toast.error('No se pudo desvincular: ' + error.message); return; }
    fetchKiosks();
    toast.success('Hardware desvinculado.');
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: 'Eliminar kiosco',
      message: 'Se perderá su historial asociado. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    const { error } = await supabase.from('kiosks').delete().eq('id', id);
    if (error) { toast.error('No se pudo eliminar: ' + error.message); return; }
    fetchKiosks();
    toast.success('Kiosco eliminado.');
  };

  const handleToggleKioskMode = async (id: string, current: boolean) => {
    await supabase.from('kiosks').update({ kiosk_mode: !current }).eq('id', id);
    setKiosks(prev => prev.map(k => k.id === id ? { ...k, kiosk_mode: !current } : k));
  };

  const handleToggleBinding = async (id: string, current: boolean) => {
    await supabase.from('kiosks').update({ binding_enabled: !current }).eq('id', id);
    setKiosks(prev => prev.map(k => k.id === id ? { ...k, binding_enabled: !current } : k));
  };

  const filtered = useMemo(() => {
    if (!search) return kiosks;
    const q = search.toLowerCase();
    return kiosks.filter(k =>
      (k.name || '').toLowerCase().includes(q) || (k.location || '').toLowerCase().includes(q)
    );
  }, [kiosks, search]);
  const pg = usePagination(filtered);

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
      <div className="flex items-end justify-between">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Directorio</p>
          <h2 className="text-2xl font-bold text-white">Flota de Kioscos</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchKiosks}
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
            Nuevo kiosco
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
          placeholder="Buscar por nombre o ubicacion..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">
                {editingId ? 'Editar kiosco' : 'Registrar nuevo kiosco'}
              </h3>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                  placeholder="Ej: Totem Entrada Norte"
                />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Ubicacion</label>
                <input
                  type="text"
                  required
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                  placeholder="Ej: Nivel C2, frente a Arturo's"
                />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Centro comercial</label>
                <select
                  required
                  value={mallId}
                  onChange={(e) => setMallId(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-colors"
                >
                  <option value="">Seleccionar...</option>
                  {malls.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-white/20 mt-1">El kiosco solo mostrará tiendas de este centro comercial.</p>
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
                  disabled={submitting}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Guardando...' : editingId ? 'Actualizar' : 'Registrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Table */}
      {kiosks.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
          <p className="text-white/30 text-sm">No hay kioscos registrados</p>
          <p className="text-white/15 text-xs mt-1">Haz clic en "Nuevo kiosco" para empezar</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Kiosco</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Ubicacion</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Vinculacion</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Modo kiosco</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Vinculación</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pg.paginated.map((kiosk) => (
                <tr key={kiosk.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3.5">
                    <span className="text-white font-medium text-sm">{kiosk.name || 'Sin nombre'}</span>
                  </td>
                  <td className="px-5 py-3.5 max-w-[150px]">
                    <span className="text-white/40 text-sm block truncate" title={kiosk.location || ''}>{kiosk.location || '—'}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    {kiosk.hardware_id ? (
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        <span className="text-emerald-400 text-xs font-medium">Vinculado</span>
                        <span className="text-white/20 text-[10px] font-mono">{kiosk.hardware_id.substring(0, 8)}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        <span className="text-amber-400/70 text-xs">Esperando hardware</span>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => handleToggleKioskMode(kiosk.id, kiosk.kiosk_mode ?? true)}
                      title={kiosk.kiosk_mode !== false ? 'Desactivar modo kiosco' : 'Activar modo kiosco'}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${kiosk.kiosk_mode !== false ? 'bg-cyan-500/40 border border-cyan-500/50' : 'bg-white/10 border border-white/10'}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${kiosk.kiosk_mode !== false ? 'translate-x-4 bg-cyan-400' : 'translate-x-0.5 bg-white/30'}`} />
                    </button>
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => handleToggleBinding(kiosk.id, kiosk.binding_enabled ?? false)}
                      title={kiosk.binding_enabled ? 'Desactivar vinculación' : 'Activar vinculación'}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${kiosk.binding_enabled ? 'bg-amber-500/40 border border-amber-500/50' : 'bg-white/10 border border-white/10'}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${kiosk.binding_enabled ? 'translate-x-4 bg-amber-400' : 'translate-x-0.5 bg-white/30'}`} />
                    </button>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {kiosk.hardware_id && (
                        <button
                          onClick={() => handleUnbind(kiosk.id)}
                          title="Desvincular hardware"
                          className="p-1.5 rounded-md text-amber-400/60 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                        </button>
                      )}
                      <button
                        onClick={() => handleEdit(kiosk)}
                        title="Editar"
                        className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDelete(kiosk.id)}
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
              label="kioscos"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </div>
      )}
    </div>
  );
}
