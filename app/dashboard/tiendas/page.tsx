'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

export default function TiendasCRUD() {
  const [stores, setStores] = useState<any[]>([]);
  const [categoriesList, setCategoriesList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [floor, setFloor] = useState('');
  const [localNumber, setLocalNumber] = useState('');
  const [description, setDescription] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string>('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [catsRes, storesRes] = await Promise.all([
      supabase.from('categories').select('*').order('name', { ascending: true }).limit(200),
      supabase.from('stores').select('*').order('created_at', { ascending: false }).limit(500),
    ]);
    if (catsRes.data) setCategoriesList(catsRes.data);
    if (storesRes.data) setStores(storesRes.data);
    setLoading(false);
    setRefreshing(false);
  };

  const validateImage = (file: File): Promise<boolean> => {
    return new Promise((resolve) => {
      if (file.size > 500 * 1024) {
        alert('El logo debe pesar menos de 500 KB.');
        resolve(false);
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (img.width > 800 || img.height > 800) {
          alert(`Dimensiones excedidas (${img.width}x${img.height}). Maximo: 800x800px.`);
          resolve(false);
        } else {
          resolve(true);
        }
      };
      img.src = URL.createObjectURL(file);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const isValid = await validateImage(file);
      if (isValid) {
        setLogoFile(file);
        setLogoPreview(URL.createObjectURL(file));
      } else {
        e.target.value = '';
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      let finalLogoUrl = logoPreview || '';

      if (logoFile) {
        const fileExt = logoFile.name.split('.').pop();
        const fileName = `logo_${Date.now()}.${fileExt}`;
        const { error: uploadError } = await supabase.storage
          .from('publicidad')
          .upload(`logos/${fileName}`, logoFile, { upsert: true });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage
          .from('publicidad')
          .getPublicUrl(`logos/${fileName}`);
        finalLogoUrl = publicUrlData.publicUrl;
      }

      const selectedCat = categoriesList.find(c => c.id === categoryId);
      const storeData = {
        name,
        category_id: categoryId,
        category: selectedCat?.name || '',
        floor,
        local_number: localNumber,
        description,
        logo_url: finalLogoUrl,
      };

      if (editingId) {
        const { error } = await supabase.from('stores').update(storeData).eq('id', editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('stores').insert([storeData]);
        if (error) throw error;
      }

      resetForm();
      fetchData();
    } catch (error: any) {
      alert('Error al guardar: ' + error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (store: any) => {
    setEditingId(store.id);
    setName(store.name || '');
    if (store.category_id) {
      setCategoryId(store.category_id);
    } else {
      const matchedCat = categoriesList.find(c => c.name === store.category);
      setCategoryId(matchedCat ? matchedCat.id : '');
    }
    setFloor(store.floor || '');
    setLocalNumber(store.local_number || '');
    setDescription(store.description || '');
    setLogoPreview(store.logo_url || '');
    setLogoFile(null);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm('Eliminar esta tienda?')) {
      await supabase.from('stores').delete().eq('id', id);
      fetchData();
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setCategoryId('');
    setFloor('');
    setLocalNumber('');
    setDescription('');
    setLogoFile(null);
    setLogoPreview('');
    setShowForm(false);
  };

  // O(1) map: category id → name. Rebuilt only when categories change.
  const categoryMap = useMemo(
    () => Object.fromEntries(categoriesList.map((c: any) => [c.id, c.name])),
    [categoriesList]
  );

  const getCategoryName = useCallback((store: any) => {
    if (store.category_id) return categoryMap[store.category_id] || store.category || 'Sin categoria';
    return store.category || 'Sin categoria';
  }, [categoryMap]);

  // Recomputed only when stores or search changes — NOT on every form keystroke.
  const filtered = useMemo(() => {
    if (!search) return stores;
    const q = search.toLowerCase();
    return stores.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.floor || '').toLowerCase().includes(q) ||
      getCategoryName(s).toLowerCase().includes(q)
    );
  }, [stores, search, getCategoryName]);

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
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Directorio</p>
          <h2 className="text-2xl font-bold text-white">Tiendas</h2>
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
            Nueva tienda
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
          placeholder="Buscar por nombre, categoria o piso..."
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
                {editingId ? 'Editar tienda' : 'Nueva tienda'}
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
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  placeholder="Ej: Cinex"
                />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Categoria</label>
                <select
                  required
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                >
                  <option value="">Seleccionar...</option>
                  {categoriesList.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Piso</label>
                  <select
                    required
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  >
                    <option value="">Elegir...</option>
                    <option value="C4">Nivel C4</option>
                    <option value="C3">Nivel C3</option>
                    <option value="C2">Nivel C2</option>
                    <option value="C1">Nivel C1</option>
                    <option value="RG">Nivel RG</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Local N</label>
                  <input
                    type="text"
                    required
                    value={localNumber}
                    onChange={(e) => setLocalNumber(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: L-45"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripcion</label>
                <textarea
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors resize-none"
                  placeholder="Breve descripcion del local..."
                />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Logo {editingId && <span className="normal-case tracking-normal">(dejar vacio para mantener)</span>}
                </label>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-[#0A0A0A] rounded-lg border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                    {logoPreview ? (
                      <img src={logoPreview} alt="Preview" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-white/15 text-[9px]">1:1</span>
                    )}
                  </div>
                  <div className="flex-1">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                    />
                    <p className="text-[10px] text-white/20 mt-1">Max 500KB, rec 400x400px</p>
                  </div>
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
                  disabled={submitting}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear tienda'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Table */}
      {stores.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
          <p className="text-white/30 text-sm">No hay tiendas registradas</p>
          <p className="text-white/15 text-xs mt-1">Haz clic en "Nueva tienda" para empezar</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Tienda</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Categoria</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Ubicacion</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pg.paginated.map((store) => (
                <tr key={store.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-[#0A0A0A] border border-white/5 overflow-hidden shrink-0">
                        {store.logo_url ? (
                          <img src={store.logo_url} alt={store.name} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-white/10 text-[8px]">N/A</div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="text-white font-medium text-sm block truncate">{store.name}</span>
                        {store.description && (
                          <span className="text-white/20 text-[10px] block truncate max-w-[200px]">{store.description}</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 bg-white/5 px-2 py-0.5 rounded-md text-xs">{getCategoryName(store)}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/50 text-xs font-mono">{store.floor} - {store.local_number}</span>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleEdit(store)}
                        title="Editar"
                        className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDelete(store.id)}
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
              label="tiendas"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </div>
      )}
    </div>
  );
}
