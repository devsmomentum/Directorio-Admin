'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

export default function BannersCRUD() {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  // Estados del formulario
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
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (data) setCampaigns(data);
    setLoading(false);
  };

  const handleAddCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      alert('Por favor selecciona un archivo (Imagen o Video vertical).');
      return;
    }
    
    setUploading(true);

    try {
      // 1. Nombre estandarizado para sobreescribir basura (Upsert)
      const fileExt = file.name.split('.').pop();
      // Nombre limpio: ej. "mcdonalds_banner.mp4"
      const cleanBrandName = brandName.replace(/\s+/g, '_').toLowerCase();
      const fileName = `${cleanBrandName}_banner.${fileExt}`;
      const filePath = `campaigns/${fileName}`;

      // 2. Subimos a Supabase con la magia de "upsert: true" (Si existe, lo chanca)
      const { error: uploadError } = await supabase.storage
        .from('publicidad')
        .upload(filePath, file, { 
          upsert: true, 
          cacheControl: '3600' 
        });

      if (uploadError) throw uploadError;

      // 3. Obtener el Link Público
      const { data: { publicUrl } } = supabase.storage
        .from('publicidad')
        .getPublicUrl(filePath);

      // 4. Guardar en la Base de Datos
      const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
      
      const { error: dbError } = await supabase.from('ad_campaigns').insert([{
        brand_name: brandName,
        plan_type: planType,
        media_url: publicUrl,
        media_type: mediaType,
        duration_seconds: parseInt(duration),
        start_date: startDate || new Date().toISOString().split('T')[0],
        end_date: endDate || null,
        is_active: true
      }]);

      if (dbError) throw dbError;

      // Limpiar y recargar
      setBrandName('');
      setPlanType('ORO');
      setFile(null);
      setDuration('15');
      setStartDate('');
      setEndDate('');
      fetchCampaigns();

    } catch (error: any) {
      alert('Error al subir campaña: ' + error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, mediaUrl: string) => {
    if (confirm('¿Eliminar esta campaña y borrar su archivo de la nube?')) {
      try {
        // 1. Extraemos la ruta exacta del archivo desde el URL público
        // Buscamos todo lo que está después de "campaigns/"
        const pathToRemove = mediaUrl.substring(mediaUrl.indexOf('campaigns/'));
        
        // 2. Borramos el archivo físico del bucket para no pagar basura
        if (pathToRemove) {
          await supabase.storage.from('publicidad').remove([pathToRemove]);
        }

        // 3. Borramos el registro de la base de datos
        await supabase.from('ad_campaigns').delete().eq('id', id);
        
        fetchCampaigns();
      } catch (error) {
        alert('Error al eliminar: Verifica los permisos del bucket.');
      }
    }
  };

  const planColors: Record<string, string> = {
    'DIAMANTE': 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
    'ORO': 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
    'SOCIOS': 'text-purple-400 bg-purple-400/10 border-purple-400/20',
    'BONO_FLASH': 'text-pink-400 bg-pink-400/10 border-pink-400/20',
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white">Ad-Server Morna</h2>
        <p className="text-white/50 mt-2">Gestiona la publicidad. Si creas una campaña con la misma marca, el archivo viejo se reemplazará automáticamente.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* FORMULARIO */}
        <div className="xl:col-span-1 bg-[#111111] border border-white/10 rounded-2xl p-6 h-fit">
          <h3 className="text-xl font-bold text-white mb-6 border-b border-white/10 pb-4">Nueva Campaña</h3>
          <form onSubmit={handleAddCampaign} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Marca / Cliente</label>
              <input type="text" required value={brandName} onChange={(e) => setBrandName(e.target.value)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" placeholder="Ej: KFC" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1">Plan</label>
                <select required value={planType} onChange={(e) => setPlanType(e.target.value)}
                  className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500">
                  <option value="DIAMANTE">Diamante (90s)</option>
                  <option value="ORO">Oro (3m)</option>
                  <option value="SOCIOS">Socios Fijos</option>
                  <option value="BONO_FLASH">Bono Flash</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1">Duración (Seg)</label>
                <input type="number" max="15" required value={duration} onChange={(e) => setDuration(e.target.value)}
                  className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-white/70 mb-1">Archivo (Video/Imagen vertical)</label>
              <input type="file" accept="video/mp4,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white/70 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-pink-500/10 file:text-pink-500 hover:file:bg-pink-500/20 cursor-pointer" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1">Inicio</label>
                <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1">Fin (Opcional)</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-pink-500" />
              </div>
            </div>
            
            <button type="submit" disabled={uploading}
              className="w-full bg-gradient-to-r from-[#FF007A] to-[#FF5900] text-white font-bold rounded-xl px-4 py-3 hover:opacity-90 disabled:opacity-50 mt-4 shadow-[0_0_15px_rgba(255,0,122,0.2)]">
              {uploading ? 'Procesando...' : 'Publicar Campaña'}
            </button>
          </form>
        </div>

        {/* LISTA DE CAMPAÑAS */}
        <div className="xl:col-span-2">
          <div className="bg-[#111111] border border-white/10 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-white/70">
                <thead className="text-xs text-white/50 uppercase bg-white/5 border-b border-white/10">
                  <tr>
                    <th className="px-6 py-4">Campaña</th>
                    <th className="px-6 py-4">Plan / Tipo</th>
                    <th className="px-6 py-4">Fechas</th>
                    <th className="px-6 py-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.length === 0 && !loading && (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-white/50">No hay campañas activas.</td>
                    </tr>
                  )}
                  {campaigns.map((camp) => (
                    <tr key={camp.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="px-6 py-4">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-16 bg-[#1A1A1A] rounded overflow-hidden flex-shrink-0 border border-white/10">
                            {camp.media_type === 'image' ? (
                              <img src={camp.media_url} alt={camp.brand_name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[10px] bg-pink-500/20 text-pink-500 font-bold">MP4</div>
                            )}
                          </div>
                          <span className="font-bold text-white">{camp.brand_name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-bold border tracking-wider ${planColors[camp.plan_type]}`}>
                          {camp.plan_type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-[11px] font-mono">
                        <div className="text-green-400">IN: {camp.start_date}</div>
                        {camp.end_date && <div className="text-red-400">OUT: {camp.end_date}</div>}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button onClick={() => handleDelete(camp.id, camp.media_url)}
                          className="text-red-500 hover:text-red-400 bg-red-500/10 px-3 py-1 rounded-lg font-medium transition-colors">
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