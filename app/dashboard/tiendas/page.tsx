'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

export default function TiendasCRUD() {
  const [stores, setStores] = useState<any[]>([]);
  const [categoriesList, setCategoriesList] = useState<any[]>([]); // 🚀 NUEVO: Estado para categorías
  const [loading, setLoading] = useState(true);

  // Estados del formulario
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(''); // 🚀 NUEVO: Ahora guardamos el ID
  const [floor, setFloor] = useState('');
  const [localNumber, setLocalNumber] = useState('');
  const [description, setDescription] = useState('');
  
  // Estados para el Logo
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string>('');

  useEffect(() => {
    fetchData();
  }, []);

  // 🚀 NUEVO: Cargamos tiendas y categorías al mismo tiempo
  const fetchData = async () => {
    setLoading(true);
    
    // Traer categorías
    const { data: catsData } = await supabase
      .from('categories')
      .select('*')
      .order('name', { ascending: true });
    if (catsData) setCategoriesList(catsData);

    // Traer tiendas
    const { data: storesData } = await supabase
      .from('stores')
      .select('*')
      .order('created_at', { ascending: false });
    if (storesData) setStores(storesData);
    
    setLoading(false);
  };

  const validateImage = (file: File): Promise<boolean> => {
    return new Promise((resolve) => {
      if (file.size > 500 * 1024) {
        alert('❌ El logo es muy pesado. Debe pesar menos de 500 KB.');
        resolve(false);
        return;
      }

      const img = new Image();
      img.onload = () => {
        if (img.width > 800 || img.height > 800) {
          alert(`❌ Dimensiones excedidas (${img.width}x${img.height}). Máximo permitido: 800x800 píxeles. Recomendado: Cuadrado 400x400.`);
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
    setLoading(true);

    try {
      let finalLogoUrl = logoPreview || 'https://via.placeholder.com/150';

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

      // 🚀 NUEVO: Encontramos el nombre de la categoría para guardarlo como respaldo
      const selectedCat = categoriesList.find(c => c.id === categoryId);

      const storeData = {
        name,
        category_id: categoryId,           // Guardamos el UUID (La forma correcta ahora)
        category: selectedCat?.name || '', // Mantenemos el string viejo por retrocompatibilidad temporal
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
      setLoading(false);
    }
  };

  const handleEdit = (store: any) => {
    setEditingId(store.id);
    setName(store.name || '');
    // 🚀 NUEVO: Cargamos el ID de la categoría (o buscamos por nombre si es muy vieja)
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
    window.scrollTo({ top: 0, behavior: 'smooth' }); 
  };

  const handleDelete = async (id: string) => {
    if (confirm('¿Estás seguro de eliminar esta tienda?')) {
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
  };

  // Función auxiliar para mostrar el nombre de la categoría en la tabla
  const getCategoryName = (store: any) => {
    if (store.category_id) {
      const cat = categoriesList.find(c => c.id === store.category_id);
      return cat ? cat.name : store.category;
    }
    return store.category || 'Sin categoría';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white">Directorio de Tiendas</h2>
        <p className="text-white/50 mt-2">Gestiona los locales, sus logos y ubicaciones en el mall.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* FORMULARIO */}
        <div className="lg:col-span-1 bg-[#111111] border border-white/10 rounded-2xl p-6 h-fit">
          <div className="flex justify-between items-center mb-6 border-b border-white/10 pb-4">
            <h3 className="text-xl font-bold text-white">
              {editingId ? 'Editar Tienda' : 'Nueva Tienda'}
            </h3>
            {editingId && (
              <button onClick={resetForm} className="text-xs text-white/50 hover:text-white transition-colors">
                Cancelar edición
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Nombre</label>
              <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" 
                placeholder="Ej: Cinex" />
            </div>
            
            {/* 🚀 SELECTOR DINÁMICO DE CATEGORÍAS */}
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Categoría</label>
              <select required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500">
                <option value="">Selecciona una categoría...</option>
                {categoriesList.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1">Piso</label>
                <select required value={floor} onChange={(e) => setFloor(e.target.value)}
                  className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500">
                  <option value="">Elegir...</option>
                  <option value="C4">Nivel C4</option> {/* 🚀 NUEVO */}
                  <option value="C3">Nivel C3</option> {/* 🚀 NUEVO */}
                  <option value="C2">Nivel C2</option>
                  <option value="C1">Nivel C1</option>
                  <option value="RG">Nivel RG</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1">Local N°</label>
                <input type="text" required value={localNumber} onChange={(e) => setLocalNumber(e.target.value)}
                  className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" 
                  placeholder="Ej: L-45" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Descripción Breve</label>
              <textarea required value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" 
                placeholder="Ej: Salas de cine 3D y 4DX..." />
            </div>

            <div className="border border-white/10 bg-[#1A1A1A] p-4 rounded-xl">
              <label className="block text-sm font-medium text-white/70 mb-2">Logo de la Tienda</label>
              <div className="flex items-center space-x-4">
                <div className="w-16 h-16 bg-black rounded-lg border border-white/10 overflow-hidden flex-shrink-0">
                  {logoPreview ? (
                    <img src={logoPreview} alt="Preview" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/20">
                      <span className="text-[10px]">1:1</span>
                    </div>
                  )}
                </div>
                <div className="flex-1">
                  <input type="file" accept="image/*" onChange={handleFileChange}
                    className="block w-full text-xs text-white/50 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-pink-500/10 file:text-pink-500 hover:file:bg-pink-500/20 transition-colors"
                  />
                  <p className="text-[10px] text-white/30 mt-1">Máx: 500KB. Rec: 400x400px</p>
                </div>
              </div>
            </div>
            
            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-[#FF007A] to-[#FF5900] text-white font-bold rounded-xl px-4 py-3 hover:opacity-90 transition-opacity mt-4 shadow-[0_0_15px_rgba(255,0,122,0.2)]">
              {loading ? 'Procesando...' : editingId ? 'Actualizar Tienda' : 'Guardar Nueva Tienda'}
            </button>
          </form>
        </div>

        {/* LISTA DE TIENDAS */}
        <div className="lg:col-span-2">
          <div className="bg-[#111111] border border-white/10 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-white/70">
                <thead className="text-xs text-white/50 uppercase bg-white/5 border-b border-white/10">
                  <tr>
                    <th className="px-6 py-4">Tienda</th>
                    <th className="px-6 py-4">Categoría</th>
                    <th className="px-6 py-4">Ubicación</th>
                    <th className="px-6 py-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {stores.length === 0 && !loading && (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-white/50">
                        No hay tiendas registradas aún.
                      </td>
                    </tr>
                  )}
                  {stores.map((store) => (
                    <tr key={store.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center space-x-3">
                          <img src={store.logo_url} alt={store.name} className="w-8 h-8 rounded-full bg-black object-cover" />
                          <span className="font-medium text-white">{store.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {/* 🚀 NUEVO: Mostramos el nombre de la categoría usando nuestra función auxiliar */}
                        <span className="bg-white/10 px-3 py-1 rounded-full text-xs">
                          {getCategoryName(store)}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-mono text-pink-400">
                        {store.floor} - {store.local_number}
                      </td>
                      <td className="px-6 py-4 text-right space-x-2">
                        <button 
                          onClick={() => handleEdit(store)}
                          className="text-blue-400 hover:text-blue-300 bg-blue-500/10 px-3 py-1 rounded-lg transition-colors">
                          Editar
                        </button>
                        <button 
                          onClick={() => handleDelete(store.id)}
                          className="text-red-500 hover:text-red-400 bg-red-500/10 px-3 py-1 rounded-lg transition-colors">
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
    </div>
  );
}