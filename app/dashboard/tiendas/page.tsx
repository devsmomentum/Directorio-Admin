'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

const PLAN_TYPES = ['DIAMANTE', 'ORO', 'IA_PERFORMANCE', 'PROMO_FLASH'] as const;

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10',
  ORO: 'text-amber-400 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10',
  PROMO_FLASH: 'text-pink-400 bg-pink-500/10',
};

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  PROMO_FLASH: 'Promo Flash',
};

// Logos → bucket público 'publicidad'
async function uploadLogo(file: File, path: string): Promise<string> {
  const { error } = await supabase.storage
    .from('publicidad')
    .upload(path, file, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('publicidad').getPublicUrl(path);
  return data.publicUrl;
}

// Documentos legales → bucket privado 'documentos', devuelve solo el path
async function uploadPrivateDoc(file: File, path: string): Promise<string> {
  const { error } = await supabase.storage
    .from('documentos')
    .upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}

// Genera URL firmada de 60s y abre el documento en nueva pestaña
async function openPrivateDoc(path: string) {
  const { data, error } = await supabase.storage
    .from('documentos')
    .createSignedUrl(path, 60);
  if (error || !data) { alert('No se pudo abrir el documento.'); return; }
  window.open(data.signedUrl, '_blank');
}

export default function TiendasCRUD() {
  const [stores, setStores] = useState<any[]>([]);
  const [categoriesList, setCategoriesList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  // Basic info
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [floorLevel, setFloorLevel] = useState('');
  const [localNumber, setLocalNumber] = useState('');
  const [description, setDescription] = useState('');
  const [planType, setPlanType] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState('');

  // CRM fields
  const [rif, setRif] = useState('');
  const [representativeName, setRepresentativeName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');

  // Documents
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [contractUrl, setContractUrl] = useState('');
  const [mercantilFile, setMercantilFile] = useState<File | null>(null);
  const [mercantilUrl, setMercantilUrl] = useState('');
  const [cedulaFile, setCedulaFile] = useState<File | null>(null);
  const [cedulaUrl, setCedulaUrl] = useState('');
  const [contractExpiryDate, setContractExpiryDate] = useState('');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const [catsRes, storesRes] = await Promise.all([
      supabase.from('categories').select('*').order('name', { ascending: true }).limit(200),
      supabase.from('stores').select('*, categories(id, name, icon)').order('created_at', { ascending: false }).limit(500),
    ]);
    if (catsRes.data) setCategoriesList(catsRes.data);
    if (storesRes.data) setStores(storesRes.data);
    setLoading(false);
    setRefreshing(false);
  };

  const validateImage = (file: File): Promise<boolean> =>
    new Promise((resolve) => {
      if (file.size > 500 * 1024) { alert('El logo debe pesar menos de 500 KB.'); resolve(false); return; }
      const img = new Image();
      img.onload = () => {
        if (img.width > 800 || img.height > 800) {
          alert(`Dimensiones excedidas (${img.width}x${img.height}). Maximo: 800x800px.`);
          resolve(false);
        } else { resolve(true); }
      };
      img.src = URL.createObjectURL(file);
    });

  const validateDoc = (file: File): boolean => {
    if (file.size > 10 * 1024 * 1024) { alert('El documento debe pesar menos de 10 MB.'); return false; }
    return true;
  };

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await validateImage(file);
    if (ok) { setLogoFile(file); setLogoPreview(URL.createObjectURL(file)); }
    else e.target.value = '';
  };

  const handleContractChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (validateDoc(file)) setContractFile(file);
    else e.target.value = '';
  };

  const handleMercantilChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (validateDoc(file)) setMercantilFile(file);
    else e.target.value = '';
  };

  const handleCedulaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (validateDoc(file)) setCedulaFile(file);
    else e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      let finalLogoUrl = logoPreview || '';
      let finalContractUrl = contractUrl;
      let finalMercantilUrl = mercantilUrl;
      let finalCedulaUrl = cedulaUrl;

      if (logoFile) {
        const ext = logoFile.name.split('.').pop();
        finalLogoUrl = await uploadLogo(logoFile, `logos/logo_${Date.now()}.${ext}`);
      }
      if (contractFile) {
        const ext = contractFile.name.split('.').pop();
        finalContractUrl = await uploadPrivateDoc(contractFile, `contratos/contrato_${Date.now()}.${ext}`);
      }
      if (mercantilFile) {
        const ext = mercantilFile.name.split('.').pop();
        finalMercantilUrl = await uploadPrivateDoc(mercantilFile, `mercantil/mercantil_${Date.now()}.${ext}`);
      }
      if (cedulaFile) {
        const ext = cedulaFile.name.split('.').pop();
        finalCedulaUrl = await uploadPrivateDoc(cedulaFile, `cedulas/cedula_${Date.now()}.${ext}`);
      }

      const storeData: any = {
        name,
        category_id: categoryId || null,
        floor_level: floorLevel,
        local_number: localNumber,
        description,
        logo_url: finalLogoUrl,
        plan_type: planType || null,
        rif: rif || null,
        representative_name: representativeName || null,
        contact_phone: contactPhone || null,
        contact_email: contactEmail || null,
        contract_url: finalContractUrl || null,
        mercantil_url: finalMercantilUrl || null,
        cedula_url: finalCedulaUrl || null,
        contract_expiry_date: contractExpiryDate || null,
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
    } catch (err: any) {
      alert('Error al guardar: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (store: any) => {
    setEditingId(store.id);
    setName(store.name || '');
    setCategoryId(store.category_id || '');
    setFloorLevel(store.floor_level || '');
    setLocalNumber(store.local_number || '');
    setDescription(store.description || '');
    setPlanType(store.plan_type || '');
    setLogoPreview(store.logo_url || '');
    setLogoFile(null);
    setRif(store.rif || '');
    setRepresentativeName(store.representative_name || '');
    setContactPhone(store.contact_phone || '');
    setContactEmail(store.contact_email || '');
    setContractUrl(store.contract_url || '');
    setContractFile(null);
    setMercantilUrl(store.mercantil_url || '');
    setMercantilFile(null);
    setCedulaUrl(store.cedula_url || '');
    setCedulaFile(null);
    setContractExpiryDate(store.contract_expiry_date || '');
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
    setName(''); setCategoryId(''); setFloorLevel(''); setLocalNumber('');
    setDescription(''); setPlanType(''); setLogoFile(null); setLogoPreview('');
    setRif(''); setRepresentativeName(''); setContactPhone(''); setContactEmail('');
    setContractFile(null); setContractUrl('');
    setMercantilFile(null); setMercantilUrl('');
    setCedulaFile(null); setCedulaUrl('');
    setContractExpiryDate('');
    setShowForm(false);
  };

  const getCategoryName = (store: any): string => store.categories?.name ?? 'Sin categoría';

  const filtered = useMemo(() => {
    let result = stores;
    if (search) {
      const q = search.toLowerCase();
      result = stores.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.floor_level || '').toLowerCase().includes(q) ||
        (s.rif || '').toLowerCase().includes(q) ||
        (s.contact_email || '').toLowerCase().includes(q) ||
        getCategoryName(s).toLowerCase().includes(q)
      );
    }
    const planWeight: Record<string, number> = { PROMO_FLASH: 4, DIAMANTE: 3, ORO: 2, IA_PERFORMANCE: 1 };
    return [...result].sort((a, b) => {
      const diff = (planWeight[b.plan_type] || 0) - (planWeight[a.plan_type] || 0);
      return diff !== 0 ? diff : (a.name || '').localeCompare(b.name || '');
    });
  }, [stores, search]);

  const pg = usePagination(filtered);

  // Check if contract is expiring soon (≤30 days)
  const isExpiringSoon = (dateStr: string | null): boolean => {
    if (!dateStr) return false;
    const diff = (new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return diff <= 30 && diff >= 0;
  };

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
          placeholder="Buscar por nombre, RIF, email, categoria o piso..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">
                {editingId ? 'Editar ficha de tienda' : 'Nueva tienda'}
              </h3>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">

              {/* ── Sección: Info del Local ── */}
              <div className="space-y-4">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Info del Local</p>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre de la tienda</label>
                  <input
                    type="text" required value={name} onChange={(e) => setName(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: Cinex"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Categoria</label>
                  <select
                    required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
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
                      required value={floorLevel} onChange={(e) => setFloorLevel(e.target.value)}
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
                      type="text" required value={localNumber} onChange={(e) => setLocalNumber(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="Ej: L-45"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripcion</label>
                  <textarea
                    required value={description} onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors resize-none"
                    placeholder="Breve descripcion del local..."
                  />
                </div>
              </div>

              {/* ── Sección: Datos del Cliente (CRM) ── */}
              <div className="border-t border-white/5 pt-5 space-y-4">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Datos del Cliente</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">RIF</label>
                    <input
                      type="text" value={rif} onChange={(e) => setRif(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="Ej: J-12345678-9"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Representante Legal</label>
                    <input
                      type="text" value={representativeName} onChange={(e) => setRepresentativeName(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="Nombre completo"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Telefono</label>
                    <input
                      type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="+58 4XX-XXXXXXX"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Email de Contacto</label>
                    <input
                      type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="correo@empresa.com"
                    />
                  </div>
                </div>
              </div>

              {/* ── Sección: Documentación Legal ── */}
              <div className="border-t border-white/5 pt-5 space-y-4">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Documentacion Legal</p>

                {/* Contrato */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Contrato de Cesion de Espacios
                    {editingId && contractUrl && <span className="normal-case tracking-normal text-green-400/70 ml-2">(ya cargado)</span>}
                  </label>
                  <div className="flex items-center gap-3">
                    {contractUrl && !contractFile && (
                      <button
                        type="button"
                        onClick={() => openPrivateDoc(contractUrl)}
                        className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 px-2.5 py-1.5 rounded-md shrink-0 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        Ver doc
                      </button>
                    )}
                    <div className="flex-1">
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        onChange={handleContractChange}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                      />
                      <p className="text-[10px] text-white/20 mt-1">PDF, JPG o PNG — Max 10MB</p>
                    </div>
                  </div>
                </div>

                {/* Registro Mercantil */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Registro Mercantil
                    {editingId && mercantilUrl && <span className="normal-case tracking-normal text-green-400/70 ml-2">(ya cargado)</span>}
                  </label>
                  <div className="flex items-center gap-3">
                    {mercantilUrl && !mercantilFile && (
                      <button
                        type="button"
                        onClick={() => openPrivateDoc(mercantilUrl)}
                        className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 px-2.5 py-1.5 rounded-md shrink-0 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        Ver doc
                      </button>
                    )}
                    <div className="flex-1">
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        onChange={handleMercantilChange}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                      />
                      <p className="text-[10px] text-white/20 mt-1">PDF, JPG o PNG — Max 10MB</p>
                    </div>
                  </div>
                </div>

                {/* Cédula del Representante */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Cédula del Representante Legal
                    {editingId && cedulaUrl && <span className="normal-case tracking-normal text-green-400/70 ml-2">(ya cargada)</span>}
                  </label>
                  <div className="flex items-center gap-3">
                    {cedulaUrl && !cedulaFile && (
                      <button
                        type="button"
                        onClick={() => openPrivateDoc(cedulaUrl)}
                        className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 px-2.5 py-1.5 rounded-md shrink-0 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        Ver doc
                      </button>
                    )}
                    <div className="flex-1">
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        onChange={handleCedulaChange}
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                      />
                      <p className="text-[10px] text-white/20 mt-1">PDF, JPG o PNG — Max 10MB</p>
                    </div>
                  </div>
                </div>

                {/* Vencimiento del contrato */}
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vencimiento del Contrato</label>
                  <input
                    type="date"
                    value={contractExpiryDate}
                    onChange={(e) => setContractExpiryDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                  />
                  {contractExpiryDate && isExpiringSoon(contractExpiryDate) && (
                    <p className="text-[10px] text-amber-400 mt-1">Contrato por vencer en menos de 30 dias</p>
                  )}
                </div>
              </div>

              {/* ── Sección: Plan Publicitario ── */}
              <div className="border-t border-white/5 pt-5">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-3">Plan Publicitario</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button" onClick={() => setPlanType('')}
                    className={`py-2 text-xs font-medium rounded-lg border transition-colors ${!planType
                      ? 'bg-white/10 text-white border-white/20'
                      : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'}`}
                  >
                    Sin plan
                  </button>
                  {PLAN_TYPES.map(pt => (
                    <button
                      key={pt} type="button" onClick={() => setPlanType(pt)}
                      className={`py-2 text-xs font-medium rounded-lg border transition-colors ${planType === pt
                        ? `${PLAN_COLORS[pt]} border-current`
                        : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'}`}
                    >
                      {PLAN_LABELS[pt]}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Sección: Logo ── */}
              <div className="border-t border-white/5 pt-5">
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Logo {editingId && <span className="normal-case tracking-normal">(dejar vacio para mantener)</span>}
                </label>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-[#0A0A0A] rounded-lg border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                    {logoPreview
                      ? <img src={logoPreview} alt="Preview" className="w-full h-full object-cover" />
                      : <span className="text-white/15 text-[9px]">1:1</span>}
                  </div>
                  <div className="flex-1">
                    <input
                      type="file" accept="image/*" onChange={handleLogoChange}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white/10 file:text-white/60"
                    />
                    <p className="text-[10px] text-white/20 mt-1">Max 500KB, rec 400x400px</p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  type="button" onClick={resetForm}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit" disabled={submitting}
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
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Contacto</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Docs</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Plan</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pg.paginated.map((store) => (
                <tr key={store.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-[#0A0A0A] border border-white/5 overflow-hidden shrink-0">
                        {store.logo_url
                          ? <img src={store.logo_url} alt={store.name} className="w-full h-full object-cover" loading="lazy" />
                          : <div className="w-full h-full flex items-center justify-center text-white/10 text-[8px]">N/A</div>}
                      </div>
                      <div className="min-w-0">
                        <span className="text-white font-medium text-sm block truncate">{store.name}</span>
                        {store.rif && (
                          <span className="text-white/30 text-[10px] font-mono block">{store.rif}</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/40 bg-white/5 px-2 py-0.5 rounded-md text-xs">{getCategoryName(store)}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-white/50 text-xs font-mono block truncate">
                      {store.floor_level} — {store.local_number}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 max-w-[160px]">
                    {store.contact_phone || store.contact_email ? (
                      <div className="space-y-0.5">
                        {store.contact_phone && (
                          <span className="text-white/40 text-xs block truncate">{store.contact_phone}</span>
                        )}
                        {store.contact_email && (
                          <span className="text-white/30 text-[10px] block truncate">{store.contact_email}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-white/15 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5">
                      {/* Contrato */}
                      <span
                        title={store.contract_url ? 'Contrato cargado' : 'Sin contrato'}
                        className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${store.contract_url ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/15'}`}
                      >
                        C
                      </span>
                      {/* Mercantil */}
                      <span
                        title={store.mercantil_url ? 'Registro mercantil cargado' : 'Sin registro mercantil'}
                        className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${store.mercantil_url ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/15'}`}
                      >
                        M
                      </span>
                      {/* Cédula */}
                      <span
                        title={store.cedula_url ? 'Cédula cargada' : 'Sin cédula del representante'}
                        className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${store.cedula_url ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/15'}`}
                      >
                        CI
                      </span>
                      {/* Alerta vencimiento */}
                      {isExpiringSoon(store.contract_expiry_date) && (
                        <span title="Contrato por vencer" className="w-5 h-5 rounded flex items-center justify-center bg-amber-500/15 text-amber-400">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    {store.plan_type ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider ${PLAN_COLORS[store.plan_type] || 'text-white/40 bg-white/5'}`}>
                        {PLAN_LABELS[store.plan_type] || store.plan_type}
                      </span>
                    ) : (
                      <span className="text-white/15 text-xs">—</span>
                    )}
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
