'use client';

import { useEffect, useMemo, useState, ChangeEvent } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
};

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-300 bg-cyan-500/10',
  ORO: 'text-amber-300 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-300 bg-purple-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-300 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-300 bg-blue-500/10',
};

// Planes que admiten campañas (según plans.applies_to = 'campaigns')
const CAMPAIGN_CAPABLE = new Set([
  'DIAMANTE','ORO','PUBLI_PROMO_DIARIO','PUBLI_PROMO_SEMANAL',
]);

export default function ClienteCampanasPage() {
  const { selectedStore: store } = useClienteStore();
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok'|'err'; msg: string } | null>(null);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState('');
  const [description, setDescription] = useState('');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState<'image'|'video'>('video');
  const [durationSeconds, setDurationSeconds] = useState<number>(15);
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchData = async () => {
    if (!store) { setLoading(false); return; }
    setLoading(true);
    const { data } = await supabase
      .from('ad_campaigns')
      .select('*')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false })
      .limit(200);
    setCampaigns(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store?.id]);

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);
  const planActive = !!store?.plan_type
    && (!store.contract_expiry_date || store.contract_expiry_date >= today);
  const canCreate = planActive && CAMPAIGN_CAPABLE.has(store!.plan_type!);

  const blockerReason = useMemo<string | null>(() => {
    if (!store) return 'Selecciona una tienda.';
    if (!store.plan_type) return 'Tu tienda no tiene plan base activo. Adquiere Diamante, Oro o Publi Promo para subir campañas.';
    if (store.contract_expiry_date && store.contract_expiry_date < today)
      return `Tu plan venció el ${store.contract_expiry_date}. Renueva para volver a subir campañas.`;
    if (!CAMPAIGN_CAPABLE.has(store.plan_type))
      return `Tu plan (${PLAN_LABELS[store.plan_type] || store.plan_type}) no incluye campañas publicitarias en el loop.`;
    return null;
  }, [store, today]);

  const resetForm = () => {
    setEditingId(null);
    setBrandName(''); setDescription('');
    setMediaFile(null); setMediaUrl(''); setMediaType('video');
    setDurationSeconds(15);
    setStartDate(today); setEndDate('');
    setShowForm(false);
  };

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) { alert('El archivo debe pesar menos de 30 MB.'); e.target.value = ''; return; }
    setMediaFile(f);
    setMediaType(f.type.startsWith('video/') ? 'video' : 'image');
    setMediaUrl(URL.createObjectURL(f));
  };

  const openEdit = (c: any) => {
    setEditingId(c.id);
    setBrandName(c.brand_name || '');
    setDescription(c.description || '');
    setMediaUrl(c.media_url || '');
    setMediaType((c.media_type as 'image'|'video') || 'video');
    setDurationSeconds(c.duration_seconds ?? 15);
    setStartDate(c.start_date || today);
    setEndDate(c.end_date || '');
    setMediaFile(null);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    if (blockerReason) { setFeedback({ type: 'err', msg: blockerReason }); return; }
    if (!brandName.trim()) { setFeedback({ type: 'err', msg: 'Indica el nombre de la marca.' }); return; }
    if (!editingId && !mediaFile) { setFeedback({ type: 'err', msg: 'Sube el archivo (video o imagen).' }); return; }

    setSubmitting(true); setFeedback(null);
    try {
      let finalMediaUrl = mediaUrl;
      let finalMediaType = mediaType;
      if (mediaFile) {
        const ext = mediaFile.name.split('.').pop();
        const path = `campaigns/camp_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('publicidad').upload(path, mediaFile, { upsert: true });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from('publicidad').getPublicUrl(path);
        finalMediaUrl = data.publicUrl;
        finalMediaType = mediaFile.type.startsWith('video/') ? 'video' : 'image';
      }

      if (editingId) {
        // El guard de campaigns sólo permite editar campos no críticos.
        const { error } = await supabase.from('ad_campaigns')
          .update({
            brand_name: brandName, description,
            media_url: finalMediaUrl, media_type: finalMediaType,
            duration_seconds: durationSeconds,
            start_date: startDate, end_date: endDate || null,
          })
          .eq('id', editingId);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Campaña actualizada.' });
      } else {
        const { error } = await supabase.from('ad_campaigns').insert([{
          brand_name: brandName,
          description,
          media_url: finalMediaUrl,
          media_type: finalMediaType,
          duration_seconds: durationSeconds,
          start_date: startDate,
          end_date: endDate || null,
          plan_type: store.plan_type,
          store_id: store.id,
        }]);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Campaña creada y publicada en el loop.' });
      }
      resetForm();
      fetchData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Error al guardar.' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (c: any) => {
    if (!confirm(`Eliminar la campaña "${c.brand_name}"?`)) return;
    const { error } = await supabase.from('ad_campaigns').delete().eq('id', c.id);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: 'Campaña eliminada.' });
    fetchData();
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver tus campañas.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Loop publicitario · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Mis Campañas</h2>
          <p className="text-white/50 text-sm mt-2">
            Sube y administra el video o imagen que rota en los kioscos según tu plan.
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          disabled={!canCreate}
          className="shrink-0 text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg px-4 py-2.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed self-start"
        >
          + Nueva campaña
        </button>
      </div>

      {blockerReason && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2.5">
          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="text-xs text-amber-200/90 leading-relaxed flex-1">
            <p>{blockerReason}</p>
            <Link href="/cliente/planes" className="inline-block mt-1 text-amber-300 underline">
              Ver catálogo de planes →
            </Link>
          </div>
        </div>
      )}

      {feedback && (
        <div className={`rounded-lg p-3 text-sm border ${
          feedback.type === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>{feedback.msg}</div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => { if (!submitting) resetForm(); }} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                {editingId ? 'Editar campaña' : 'Nueva campaña'}
              </h3>
              <button onClick={resetForm} disabled={submitting} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Marca</label>
                <input type="text" required value={brandName} onChange={(e) => setBrandName(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripción (opcional)</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50 resize-none" />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Archivo {editingId && <span className="normal-case tracking-normal text-white/30">(vacío = mantener)</span>}
                </label>
                <input type="file" accept="video/*,image/*" onChange={handleFile}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-white/10 file:text-white/60" />
                <p className="text-[10px] text-white/20 mt-1">Video MP4/WebM o imagen JPG/PNG · Máx 30 MB · Recomendado 1080×1920 (vertical)</p>
                {mediaUrl && (
                  mediaType === 'video' ? (
                    <video src={mediaUrl} className="mt-2 w-full max-h-48 rounded-lg bg-black" controls />
                  ) : (
                    <img src={mediaUrl} alt="preview" className="mt-2 w-full max-h-48 rounded-lg object-contain bg-black" />
                  )
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Duración (s)</label>
                  <input type="number" min={3} max={60} value={durationSeconds} onChange={(e) => setDurationSeconds(parseInt(e.target.value) || 15)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={resetForm} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg">
                  Cancelar
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-50">
                  {submitting ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Publicar campaña'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {campaigns.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">Aún no tienes campañas.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map(c => {
            const active = c.is_active && (!c.end_date || c.end_date >= today);
            return (
              <div key={c.id} className="bg-[#0F0F0F] border border-white/5 rounded-xl overflow-hidden">
                <div className="aspect-video bg-black flex items-center justify-center">
                  {c.media_type === 'video' && c.media_url ? (
                    <video src={c.media_url} className="w-full h-full object-contain" muted loop />
                  ) : c.media_url ? (
                    <img src={c.media_url} alt={c.brand_name} className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-white/20 text-xs">Sin media</span>
                  )}
                </div>
                <div className="p-4 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-white text-sm font-bold truncate">{c.brand_name}</h4>
                    <span className={`text-[9px] font-semibold px-2 py-0.5 rounded ${active ? 'text-emerald-300 bg-emerald-500/15' : 'text-white/40 bg-white/5'}`}>
                      {active ? 'ACTIVA' : 'INACTIVA'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
                      {PLAN_LABELS[c.plan_type] || c.plan_type}
                    </span>
                    <span className="text-[10px] text-white/30 font-mono">{c.duration_seconds}s</span>
                  </div>
                  <p className="text-[10px] text-white/40 font-mono">
                    {c.start_date}{c.end_date ? ` → ${c.end_date}` : ' · sin fin'}
                  </p>
                  <div className="flex gap-1.5 pt-2">
                    <button onClick={() => openEdit(c)}
                      className="flex-1 text-[11px] text-white/70 bg-white/5 hover:bg-white/10 rounded-md py-1.5">
                      Editar
                    </button>
                    <button onClick={() => handleDelete(c)}
                      className="flex-1 text-[11px] text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-md py-1.5">
                      Eliminar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
