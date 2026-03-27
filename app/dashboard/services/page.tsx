"use client";

import { useState, useEffect, ChangeEvent } from "react";
import { supabase } from "../../../lib/supabase";

interface Service {
  id: string;
  title: string;
  provider: string;
  description: string;
  image_url: string;
  is_active: boolean;
}

export default function ServicesAdminPage() {
  const [services, setServices] = useState<Service[]>([]);
  
  // Form states
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState("");
  const [description, setDescription] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  
  // CRUD states
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    fetchServices();
  }, []);

  const fetchServices = async () => {
    const { data } = await supabase.from("services").select("*").order("created_at", { ascending: false });
    if (data) setServices(data as Service[]);
  };

  const resetForm = () => {
    setTitle(""); setProvider(""); setDescription("");
    setImageFile(null); setEditingId(null);
  };

  const handleEditClick = (srv: Service) => {
    setEditingId(srv.id);
    setTitle(srv.title);
    setProvider(srv.provider);
    setDescription(srv.description);
    setImageFile(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteClick = async (id: string) => {
    if (!window.confirm("¿Seguro que deseas eliminar este servicio?")) return;
    try {
      await supabase.from('services').delete().eq('id', id);
      fetchServices();
    } catch (error: any) {
      alert("Error: " + error.message);
    }
  };

  const toggleStatus = async (id: string, currentStatus: boolean) => {
    await supabase.from('services').update({ is_active: !currentStatus }).eq('id', id);
    fetchServices();
  };

  const handleSave = async () => {
    if (!title || !provider || !description) {
      alert("Completa todos los campos de texto.");
      return;
    }
    if (!editingId && !imageFile) {
      alert("Sube un logo para el nuevo servicio.");
      return;
    }

    setIsSaving(true);
    try {
      let publicUrl = undefined;

      if (imageFile) {
        const fileExt = imageFile.name.split('.').pop();
        const fileName = `${Date.now()}.${fileExt}`;
        const filePath = `logos/${fileName}`;
        const { error: uploadError } = await supabase.storage.from('services_logos').upload(filePath, imageFile);
        if (uploadError) throw uploadError;
        const { data } = supabase.storage.from('services_logos').getPublicUrl(filePath);
        publicUrl = data.publicUrl;
      }

      if (editingId) {
        const updateData: any = { title, provider, description };
        if (publicUrl) updateData.image_url = publicUrl;
        await supabase.from('services').update(updateData).eq('id', editingId);
      } else {
        await supabase.from('services').insert({ title, provider, description, image_url: publicUrl });
      }

      alert(editingId ? "¡Servicio actualizado!" : "¡Servicio creado!");
      resetForm();
      fetchServices();
    } catch (error: any) {
      alert("Error: " + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-6 bg-black min-h-screen text-white">
      <div className="mb-8">
        <h1 className="text-2xl font-bold italic tracking-tighter">PAGO DE SERVICIOS</h1>
        <p className="text-white/40 text-sm">Administra los servicios disponibles en el Kiosco.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
        <div className="bg-[#111] p-8 rounded-3xl border border-white/10 space-y-5 h-fit">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-black italic tracking-tight text-cyan-400">
              {editingId ? "EDITAR SERVICIO" : "NUEVO SERVICIO"}
            </h2>
            {editingId && <button onClick={resetForm} className="text-xs text-white/40 underline">Cancelar</button>}
          </div>
          
          <div>
            <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Proveedor (Ej: CANTV)</label>
            <input type="text" value={provider} onChange={e => setProvider(e.target.value)} className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-cyan-500"/>
          </div>
          <div>
            <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Título Público</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Ej: Pago de Telefonía Fija" className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-cyan-500"/>
          </div>
          <div>
            <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Descripción Breve</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-cyan-500 resize-none"/>
          </div>
          <div>
            <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Logo del Servicio {editingId && "(Opcional)"}</label>
            <input type="file" accept="image/*" onChange={e => setImageFile(e.target.files?.[0] || null)} className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none"/>
          </div>

          <button onClick={handleSave} disabled={isSaving} className={`w-full py-4 rounded-xl font-bold mt-6 flex items-center justify-center ${editingId ? 'bg-pink-600' : 'bg-cyan-600'}`}>
            {isSaving ? "Guardando..." : (editingId ? "ACTUALIZAR" : "CREAR SERVICIO")}
          </button>
        </div>

        <div className="md:col-span-3 bg-[#111] rounded-3xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-left bg-black text-white/40 uppercase text-[10px]">
              <tr>
                <th className="p-5">Logo</th><th className="p-5">Servicio</th>
                <th className="p-5">Estado</th><th className="p-5 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {services.map(srv => (
                <tr key={srv.id} className={`hover:bg-white/5 ${!srv.is_active && 'opacity-50'}`}>
                  <td className="p-5"><img src={srv.image_url} alt="logo" className="w-12 h-12 rounded-xl object-cover bg-white"/></td>
                  <td className="p-5">
                    <p className="font-bold text-cyan-400">{srv.provider}</p>
                    <p className="text-white font-bold text-lg">{srv.title}</p>
                    <p className="text-white/40 text-xs mt-1">{srv.description}</p>
                  </td>
                  <td className="p-5">
                    <button onClick={() => toggleStatus(srv.id, srv.is_active)} className={`px-3 py-1 rounded text-xs font-bold ${srv.is_active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                      {srv.is_active ? 'ACTIVO' : 'OCULTO'}
                    </button>
                  </td>
                  <td className="p-5 text-right">
                    <button onClick={() => handleEditClick(srv)} className="text-cyan-400 mr-4"><span className="material-icons text-sm">edit</span></button>
                    <button onClick={() => handleDeleteClick(srv.id)} className="text-red-500"><span className="material-icons text-sm">delete</span></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}