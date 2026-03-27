'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase'; // Ajusta la ruta a tu cliente de Supabase

export default function CategoriasCRUD() {
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Estados del formulario
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('category');

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('categories')
      .select('*')
      .order('name', { ascending: true });
    
    if (data) setCategories(data);
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const categoryData = { name, icon };

    try {
      if (editingId) {
        const { error } = await supabase.from('categories').update(categoryData).eq('id', editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('categories').insert([categoryData]);
        if (error) throw error;
      }

      resetForm();
      fetchCategories();
    } catch (error: any) {
      alert('Error al guardar: ' + error.message);
      setLoading(false);
    }
  };

  const handleEdit = (cat: any) => {
    setEditingId(cat.id);
    setName(cat.name);
    setIcon(cat.icon);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (id: string) => {
    if (confirm('¿Eliminar esta categoría? Las tiendas asociadas podrían quedar sin categoría.')) {
      setLoading(true);
      try {
        const { error } = await supabase.from('categories').delete().eq('id', id);
        if (error) throw error;
        fetchCategories();
      } catch (error: any) {
        alert('Error al eliminar: ' + error.message);
        setLoading(false);
      }
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setIcon('category');
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white">Gestión de Categorías</h2>
        <p className="text-white/50 mt-2">Define las categorías que aparecerán en el Kiosco y asócialas a iconos.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* FORMULARIO */}
        <div className="lg:col-span-1 bg-[#111111] border border-white/10 rounded-2xl p-6 h-fit">
          <div className="flex justify-between items-center mb-6 border-b border-white/10 pb-4">
            <h3 className="text-xl font-bold text-white">
              {editingId ? 'Editar Categoría' : 'Nueva Categoría'}
            </h3>
            {editingId && (
              <button onClick={resetForm} className="text-xs text-white/50 hover:text-white transition-colors">
                Cancelar edición
              </button>
            )}
          </div>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Nombre de Categoría</label>
              <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" 
                placeholder="Ej: Zapaterías" />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Nombre del Icono (Material Icon)</label>
              <input type="text" required value={icon} onChange={(e) => setIcon(e.target.value)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" 
                placeholder="Ej: shopping_bag" />
              <p className="text-[10px] text-white/30 mt-2 italic flex items-center">
                <span className="material-icons text-[12px] mr-1">info</span>
                Usa nombres de fonts.google.com/icons
              </p>
            </div>

            {/* Vista previa del icono */}
            <div className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10">
              <span className="text-sm text-white/50">Vista previa:</span>
              <span className="material-icons text-pink-500 text-2xl">{icon}</span>
            </div>

            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-pink-600 to-purple-600 text-white font-bold rounded-xl px-4 py-3 hover:opacity-90 transition-opacity mt-4 shadow-[0_0_15px_rgba(236,72,153,0.3)]">
              {loading ? 'Procesando...' : editingId ? 'Actualizar Categoría' : 'Guardar Categoría'}
            </button>
          </form>
        </div>

        {/* LISTA DE CATEGORÍAS */}
        <div className="lg:col-span-2 bg-[#111111] border border-white/10 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-white/70">
              <thead className="text-xs text-white/50 uppercase bg-white/5 border-b border-white/10">
                <tr>
                  <th className="px-6 py-4">Icono</th>
                  <th className="px-6 py-4">Categoría</th>
                  <th className="px-6 py-4 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {categories.length === 0 && !loading && (
                  <tr>
                    <td colSpan={3} className="px-6 py-8 text-center text-white/50">
                      No hay categorías registradas aún.
                    </td>
                  </tr>
                )}
                {categories.map((cat) => (
                  <tr key={cat.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4">
                      <div className="w-10 h-10 bg-white/5 rounded-lg flex items-center justify-center border border-white/10">
                        <span className="material-icons text-pink-500">{cat.icon}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-medium text-white text-base">{cat.name}</td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <button onClick={() => handleEdit(cat)} className="text-blue-400 hover:text-blue-300 text-xs bg-blue-500/10 px-3 py-1 rounded-lg transition-colors">
                        Editar
                      </button>
                      <button onClick={() => handleDelete(cat.id)} className="text-red-500 hover:text-red-400 text-xs bg-red-500/10 px-3 py-1 rounded-lg transition-colors">
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}