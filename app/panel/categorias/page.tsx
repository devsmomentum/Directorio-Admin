'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';
import { toast } from '../../components/toast';
import { confirmDialog } from '../../components/confirm-dialog';
import { logAdminAction } from '../../../lib/audit';

export default function CategoriasCRUD() {
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('category');

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    setRefreshing(true);
    const { data } = await supabase
      .from('categories')
      .select('*')
      .order('name', { ascending: true });

    if (data) setCategories(data);
    setLoading(false);
    setRefreshing(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const categoryData = { name, icon };
      if (editingId) {
        const { error } = await supabase.from('categories').update(categoryData).eq('id', editingId);
        if (error) throw error;
        await logAdminAction({ action_type: 'EDITAR', entity_type: 'categoría', entity_id: editingId, entity_name: name });
      } else {
        const { data: inserted, error } = await supabase.from('categories').insert([categoryData]).select('id').single();
        if (error) throw error;
        await logAdminAction({ action_type: 'CREAR', entity_type: 'categoría', entity_id: inserted?.id, entity_name: name });
      }
      resetForm();
      fetchCategories();
      toast.success(editingId ? 'Categoría actualizada.' : 'Categoría creada.');
    } catch (error: any) {
      toast.error('Error al guardar: ' + error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (cat: any) => {
    setEditingId(cat.id);
    setName(cat.name);
    setIcon(cat.icon);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: 'Eliminar categoría',
      message: 'Las tiendas asociadas podrían quedar sin categoría.',
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    const { error } = await supabase.from('categories').delete().eq('id', id);
    if (error) { toast.error('No se pudo eliminar: ' + error.message); return; }
    await logAdminAction({ action_type: 'ELIMINAR', entity_type: 'categoría', entity_id: id, entity_name: categories.find(c => c.id === id)?.name });
    fetchCategories();
    toast.success('Categoría eliminada.');
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setIcon('category');
    setShowForm(false);
  };

  const filtered = categories.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) || (c.icon || '').toLowerCase().includes(q);
  });
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
          <h2 className="text-2xl font-bold text-white">Categorias</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchCategories}
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
            Nueva categoria
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
          placeholder="Buscar por nombre o icono..."
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
                {editingId ? 'Editar categoria' : 'Nueva categoria'}
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
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                  placeholder="Ej: Zapaterias"
                />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Icono (Material Icon)</label>
                <input
                  type="text"
                  required
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                  placeholder="Ej: shopping_bag"
                />
                <p className="text-[10px] text-white/20 mt-1.5">Nombres de fonts.google.com/icons</p>
              </div>
              <div className="flex items-center gap-3 p-3 bg-white/5 rounded-lg border border-white/5">
                <span className="text-[11px] text-white/30">Vista previa:</span>
                <span className="material-icons text-purple-400 text-xl">{icon}</span>
                <span className="text-white/50 text-sm">{name || 'Categoria'}</span>
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
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 border border-purple-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear categoria'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Table */}
      {categories.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" /></svg>
          <p className="text-white/30 text-sm">No hay categorias registradas</p>
          <p className="text-white/15 text-xs mt-1">Haz clic en "Nueva categoria" para empezar</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Icono</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Categoria</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Nombre del icono</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pg.paginated.map((cat) => (
                <tr key={cat.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3.5">
                    <div className="w-8 h-8 bg-white/5 rounded-md flex items-center justify-center border border-white/5">
                      <span className="material-icons text-purple-400 text-base">{cat.icon}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white font-medium text-sm">{cat.name}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/30 text-xs font-mono">{cat.icon}</span>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleEdit(cat)}
                        title="Editar"
                        className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDelete(cat.id)}
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
              label="categorias"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </div>
      )}
    </div>
  );
}
