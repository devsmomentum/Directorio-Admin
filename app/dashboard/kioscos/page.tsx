'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

export default function KioscosCRUD() {
  const [kiosks, setKiosks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Estados del formulario
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');

  useEffect(() => {
    fetchKiosks();
  }, []);

  const fetchKiosks = async () => {
    const { data, error } = await supabase
      .from('kiosks')
      .select('*')
      .order('created_at', { ascending: false });

    if (data) setKiosks(data);
    setLoading(false);
  };

  // 🚀 FUNCIÓN UNIFICADA: CREAR O ACTUALIZAR
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    if (editingId) {
      // ACTUALIZAR KIOSCO EXISTENTE
      const { error } = await supabase
        .from('kiosks')
        .update({ name, location })
        .eq('id', editingId);

      if (!error) {
        resetForm();
        fetchKiosks();
      } else {
        alert('Error al actualizar el kiosco: ' + error.message);
      }
    } else {
      // CREAR KIOSCO NUEVO
      const { error } = await supabase.from('kiosks').insert([{
        name,
        location,
        status: 'offline', // Nace apagado hasta que el APK lo reclame
        hardware_id: null  // Nace sin hardware asignado
      }]);

      if (!error) {
        resetForm();
        fetchKiosks();
      } else {
        alert('Error al crear el kiosco: ' + error.message);
      }
    }
    setLoading(false);
  };

  // 🚀 PREPARAR EL FORMULARIO PARA EDITAR
  const handleEdit = (kiosk: any) => {
    setEditingId(kiosk.id);
    setName(kiosk.name || '');
    setLocation(kiosk.location || '');
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Sube la pantalla suavemente
  };

  // 🚀 LIMPIAR EL FORMULARIO
  const resetForm = () => {
    setEditingId(null);
    setName('');
    setLocation('');
  };

  // 🚀 FUNCIÓN MDM: Permite liberar un perfil si la tablet física se daña
  const handleUnbind = async (id: string) => {
    if (confirm('¿Estás seguro de desvincular el hardware de este kiosco? Dejará de registrar analíticas hasta que se vincule una nueva pantalla.')) {
      await supabase.from('kiosks').update({ hardware_id: null, status: 'offline' }).eq('id', id);
      fetchKiosks();
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('¿Eliminar este perfil de kiosco por completo? Perderás su historial asociado.')) {
      await supabase.from('kiosks').delete().eq('id', id);
      fetchKiosks();
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white">Flota de Kioscos</h2>
        <p className="text-white/50 mt-2">Gestiona las ubicaciones y emparejamientos de tus pantallas Sunmi.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* FORMULARIO PARA CREAR / EDITAR PERFIL */}
        <div className="lg:col-span-1 bg-[#111111] border border-white/10 rounded-2xl p-6 h-fit">
          <div className="flex justify-between items-center mb-6 border-b border-white/10 pb-4">
            <h3 className="text-xl font-bold text-white">
              {editingId ? 'Editar Kiosco' : 'Nuevo Kiosco'}
            </h3>
            {editingId && (
              <button onClick={resetForm} className="text-xs text-white/50 hover:text-white transition-colors">
                Cancelar edición
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Identificador (Nombre)</label>
              <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-cyan-500" 
                placeholder="Ej: Totem Entrada Norte" />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Ubicación Física</label>
              <input type="text" required value={location} onChange={(e) => setLocation(e.target.value)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-cyan-500" 
                placeholder="Ej: Nivel C2, frente a Arturo's" />
            </div>
            
            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold rounded-xl px-4 py-3 hover:opacity-90 transition-opacity mt-4 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
              {loading ? 'Procesando...' : editingId ? 'Actualizar Kiosco' : 'Registrar Kiosco'}
            </button>
          </form>
        </div>

        {/* LISTA DE KIOSCOS Y ESTADO DE VINCULACIÓN */}
        <div className="lg:col-span-2">
          <div className="bg-[#111111] border border-white/10 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-white/70">
                <thead className="text-xs text-white/50 uppercase bg-white/5 border-b border-white/10">
                  <tr>
                    <th className="px-6 py-4">Kiosco</th>
                    <th className="px-6 py-4">Estado / Vinculación</th>
                    <th className="px-6 py-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {kiosks.length === 0 && !loading && (
                    <tr>
                      <td colSpan={3} className="px-6 py-8 text-center text-white/50">
                        No hay kioscos registrados. Crea uno para empezar.
                      </td>
                    </tr>
                  )}
                  {kiosks.map((kiosk) => (
                    <tr key={kiosk.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-medium text-white text-base">{kiosk.name}</div>
                        <div className="text-xs text-white/40 mt-1 flex items-center">
                          <span className="material-icons text-[14px] mr-1">📍</span> {kiosk.location}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {kiosk.hardware_id ? (
                          <div className="flex flex-col space-y-1">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-[10px] font-bold bg-green-500/10 text-green-400 w-fit border border-green-500/20">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5 animate-pulse"></span>
                              VINCULADO
                            </span>
                            <span className="text-[10px] font-mono text-white/30">ID: {kiosk.hardware_id.substring(0,8)}...</span>
                          </div>
                        ) : (
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-[10px] font-bold bg-orange-500/10 text-orange-400 w-fit border border-orange-500/20">
                            ESPERANDO HARDWARE
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right space-x-2 whitespace-nowrap">
                        {kiosk.hardware_id && (
                          <button 
                            onClick={() => handleUnbind(kiosk.id)}
                            className="text-orange-400 hover:text-orange-300 bg-orange-500/10 px-3 py-1 rounded-lg transition-colors text-xs mr-2">
                            Desvincular
                          </button>
                        )}
                        <button 
                          onClick={() => handleEdit(kiosk)}
                          className="text-blue-400 hover:text-blue-300 bg-blue-500/10 px-3 py-1 rounded-lg transition-colors text-xs">
                          Editar
                        </button>
                        <button 
                          onClick={() => handleDelete(kiosk.id)}
                          className="text-red-500 hover:text-red-400 bg-red-500/10 px-3 py-1 rounded-lg transition-colors text-xs ml-2">
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