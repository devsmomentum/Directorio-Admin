"use client";

import { useState, useEffect, ChangeEvent } from "react";
import { supabase } from "../../../lib/supabase";

interface Store {
  id: string;
  name: string;
}

interface Coupon {
  id: string;
  title: string;
  store_id: string;
  stores: { name: string };
  image_url: string;
  code: string;
  amount_available: number;
  price_usd: number;
}

export default function CuponsAdminPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  
  // Form states
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [couponTitle, setCouponTitle] = useState("");
  const [amountAvailable, setAmountAvailable] = useState<number>(0);
  const [priceUsd, setPriceUsd] = useState<number>(0);
  const [imageFile, setImageFile] = useState<File | null>(null);
  
  // CRUD states
  const [isSaving, setIsSaving] = useState(false);
  const [editingCouponId, setEditingCouponId] = useState<string | null>(null);

  useEffect(() => {
    fetchStores();
    fetchCoupons();
  }, []);

  const fetchStores = async () => {
    const { data } = await supabase.from("stores").select("id, name").order("name");
    if (data) setStores(data);
  };

  const fetchCoupons = async () => {
    const { data } = await supabase
      .from("coupons")
      .select("*, stores(name)")
      .order("created_at", { ascending: false });
    if (data) setCoupons(data as Coupon[]);
  };

  const handleImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setImageFile(e.target.files[0]);
    }
  };

  const resetForm = () => {
    setSelectedStoreId("");
    setCouponTitle("");
    setAmountAvailable(0);
    setPriceUsd(0);
    setImageFile(null);
    setEditingCouponId(null);
  };

  const handleEditClick = (coupon: Coupon) => {
    setEditingCouponId(coupon.id);
    setSelectedStoreId(coupon.store_id);
    setCouponTitle(coupon.title);
    setAmountAvailable(coupon.amount_available);
    setPriceUsd(coupon.price_usd);
    setImageFile(null); // No cargamos la imagen vieja en el input file
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Subir al formulario
  };

  const handleDeleteClick = async (id: string) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este combo? Esta acción no se puede deshacer.")) return;
    
    try {
      const { error } = await supabase.from('coupons').delete().eq('id', id);
      if (error) throw error;
      alert("Combo eliminado correctamente.");
      fetchCoupons();
    } catch (error: any) {
      alert("Error eliminando: " + error.message);
    }
  };

  const handleSaveCoupon = async () => {
    if (!selectedStoreId || !couponTitle || amountAvailable <= 0 || priceUsd <= 0) {
      alert("Por favor completa todos los campos (Tienda, Título, Precio y Cantidad).");
      return;
    }

    if (!editingCouponId && !imageFile) {
      alert("Debes subir una imagen para crear un combo nuevo.");
      return;
    }

    setIsSaving(true);
    try {
      let publicUrl = undefined;

      // Si subió una imagen nueva (tanto al crear como al editar)
      if (imageFile) {
        const fileExt = imageFile.name.split('.').pop();
        const fileName = `${Date.now()}.${fileExt}`;
        const filePath = `coupon_images/${fileName}`;

        const { error: uploadError } = await supabase.storage.from('coupons').upload(filePath, imageFile);
        if (uploadError) throw uploadError;

        const { data } = supabase.storage.from('coupons').getPublicUrl(filePath);
        publicUrl = data.publicUrl;
      }

      if (editingCouponId) {
        // ACTUALIZAR (UPDATE)
        const updateData: any = {
          store_id: selectedStoreId,
          title: couponTitle,
          amount_available: amountAvailable,
          price_usd: priceUsd
        };
        // Solo actualizamos la imagen si subió una nueva
        if (publicUrl) updateData.image_url = publicUrl;

        const { error } = await supabase.from('coupons').update(updateData).eq('id', editingCouponId);
        if (error) throw error;
        alert("¡Combo actualizado exitosamente!");

      } else {
        // CREAR NUEVO (INSERT)
        const storeName = stores.find(s => s.id === selectedStoreId)?.name || "TIENDA";
        const uniqueCode = `CUPON-${storeName.substring(0,3).toUpperCase()}-${Date.now().toString().substring(7)}`;

        const { error } = await supabase.from('coupons').insert({
          store_id: selectedStoreId,
          title: couponTitle,
          image_url: publicUrl,
          code: uniqueCode,
          amount_available: amountAvailable,
          price_usd: priceUsd
        });
        if (error) throw error;
        alert("¡Combo creado exitosamente!");
      }

      resetForm();
      fetchCoupons();

    } catch (error: any) {
      alert("Error guardando el combo: " + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-6 bg-black min-h-screen text-white">
      <div className="mb-8">
        <h1 className="text-2xl font-bold italic tracking-tighter">OFERTAS Y COMBOS</h1>
        <p className="text-white/40 text-sm">Crea, edita y elimina el catálogo de ventas del Kiosco.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
        {/* Formulario de Creación/Edición */}
        <div className="bg-[#111] p-8 rounded-3xl border border-white/10 space-y-5 h-fit transition-all">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-black italic tracking-tight text-cyan-400">
              {editingCouponId ? "EDITAR COMBO" : "NUEVA OFERTA"}
            </h2>
            {editingCouponId && (
              <button onClick={resetForm} className="text-xs text-white/40 hover:text-white underline">
                Cancelar
              </button>
            )}
          </div>
          
          <div>
            <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Vincular Tienda</label>
            <select className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-cyan-500"
              value={selectedStoreId} onChange={e => setSelectedStoreId(e.target.value)}>
              <option value="">-- Seleccionar tienda --</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Título del Combo</label>
            <input type="text" value={couponTitle} onChange={e => setCouponTitle(e.target.value)} placeholder="Ej: 20% Desc. en Café"
              className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-cyan-500"/>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Precio ($)</label>
              <input 
                type="number" step="0.01" value={priceUsd === 0 ? "" : priceUsd} 
                onChange={e => setPriceUsd(parseFloat(e.target.value) || 0)} placeholder="Ej: 5.50"
                className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Stock</label>
              <input 
                type="number" value={amountAvailable === 0 ? "" : amountAvailable} 
                onChange={e => setAmountAvailable(parseInt(e.target.value) || 0)} placeholder="Ej: 100"
                className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Imagen Promocional {editingCouponId && "(Opcional)"}</label>
            <input type="file" accept="image/*" onChange={handleImageChange}
              className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none"/>
            {editingCouponId && !imageFile && <p className="text-[10px] text-white/30 mt-1">Deja vacío para mantener la imagen actual.</p>}
          </div>

          <button onClick={handleSaveCoupon} disabled={isSaving}
            className={`w-full py-4 rounded-xl font-bold mt-6 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors ${editingCouponId ? 'bg-pink-600 hover:bg-pink-500' : 'bg-cyan-600 hover:bg-cyan-500'}`}>
            {isSaving ? "Guardando..." : (editingCouponId ? "ACTUALIZAR COMBO" : "PUBLICAR OFERTA")}
          </button>
        </div>

        {/* Tabla de Cupones */}
        <div className="md:col-span-3 bg-[#111] rounded-3xl border border-white/10 overflow-hidden">
          <div className="p-6 border-b border-white/5">
            <h3 className="font-bold uppercase text-xs tracking-widest text-white/40">Catálogo Activo</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left bg-black text-white/40 uppercase text-[10px]">
              <tr>
                <th className="p-5 font-normal">Tienda</th>
                <th className="p-5 font-normal">Título</th>
                <th className="p-5 font-normal">Imagen</th>
                <th className="p-5 font-normal">Precio</th>
                <th className="p-5 font-normal">Stock</th>
                <th className="p-5 font-normal text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {coupons.map(coupon => (
                <tr key={coupon.id} className="hover:bg-white/2">
                  <td className="p-5 font-bold">{coupon.stores.name}</td>
                  <td className="p-5">{coupon.title}</td>
                  <td className="p-5">
                    <img src={coupon.image_url} alt="Cupón" className="w-12 h-12 rounded object-cover border border-white/10"/>
                  </td>
                  <td className="p-5 text-green-400 font-bold">${coupon.price_usd?.toFixed(2) || "0.00"}</td>
                  <td className="p-5 font-black text-cyan-400">{coupon.amount_available}</td>
                  <td className="p-5 text-right">
                    <button onClick={() => handleEditClick(coupon)} className="text-cyan-400 hover:text-white mr-4 transition-colors">
                      <span className="material-icons text-sm">edit</span>
                    </button>
                    <button onClick={() => handleDeleteClick(coupon.id)} className="text-red-500 hover:text-white transition-colors">
                      <span className="material-icons text-sm">delete</span>
                    </button>
                  </td>
                </tr>
              ))}
              {coupons.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-white/30">No hay ofertas registradas.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}