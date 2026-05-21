'use client';

import { useEffect, useMemo, useState, ChangeEvent } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  FLASH_COUPON_DIARIO: 'Flash Coupon · Diario',
  FLASH_COUPON_SEMANAL: 'Flash Coupon · Semanal',
};

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-300 bg-cyan-500/10',
  ORO: 'text-amber-300 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-300 bg-purple-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-300 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-300 bg-pink-500/10',
};

// Planes base que permiten cupones (según applies_to)
const BASE_COUPON_PLANS = new Set(['DIAMANTE','ORO','IA_PERFORMANCE']);
const FLASH_PLANS = new Set(['FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL']);

// Tope galería flash (20 marcas activas simultáneas)
const FLASH_GALLERY_MAX = 20;
// Cupos por período según flavor
const FLASH_PERIOD_LIMITS: Record<string, { max: number; windowDays: number; label: string }> = {
  FLASH_COUPON_DIARIO:  { max: 10, windowDays: 1, label: 'día' },
  FLASH_COUPON_SEMANAL: { max: 30, windowDays: 5, label: 'semana (5 días)' },
};

export default function ClienteCuponesPage() {
  const { selectedStore: store } = useClienteStore();
  const [myCoupons, setMyCoupons] = useState<any[]>([]);
  const [flashBrandIds, setFlashBrandIds] = useState<Set<string>>(new Set()); // marcas globales en galería
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok'|'err'; msg: string } | null>(null);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [planType, setPlanType] = useState<string>('');
  const [category, setCategory] = useState('');
  const [priceUsd, setPriceUsd] = useState<number>(0);
  const [amount, setAmount] = useState<number>(0);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const planActive = !!store?.plan_type
    && (!store.contract_expiry_date || store.contract_expiry_date >= today);
  const flashActive = !!store?.flash_coupon_plan
    && (!store.flash_coupon_expiry_date || store.flash_coupon_expiry_date >= today);

  const allowedPlanTypes = useMemo<string[]>(() => {
    if (!store) return [];
    const out: string[] = [];
    if (planActive && BASE_COUPON_PLANS.has(store.plan_type!)) out.push(store.plan_type!);
    if (flashActive && store.flash_coupon_plan) out.push(store.flash_coupon_plan);
    return out;
  }, [store, planActive, flashActive]);

  const blockerReason = useMemo<string | null>(() => {
    if (!store) return 'Selecciona una tienda.';
    if (allowedPlanTypes.length === 0) {
      if (store.plan_type && !BASE_COUPON_PLANS.has(store.plan_type)) {
        return `Tu plan (${PLAN_LABELS[store.plan_type] || store.plan_type}) no incluye cupones. Adquiere el addon Flash Coupon o cambia a un plan con cupones.`;
      }
      return 'Tu tienda no tiene plan que permita subir cupones. Adquiere un plan base (Diamante/Oro/IA Performance) o el addon Flash Coupon.';
    }
    return null;
  }, [store, allowedPlanTypes]);

  const fetchData = async () => {
    if (!store) { setLoading(false); return; }
    setLoading(true);
    const [mineRes, galleryRes] = await Promise.all([
      supabase.from('coupons').select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(200),
      // Global: cuántas marcas distintas tienen flash activo (para mostrar cap restante).
      supabase.from('coupons').select('store_id, plan_type, amount_available, end_date')
        .in('plan_type', ['FLASH_COUPON_DIARIO','FLASH_COUPON_SEMANAL'])
        .gt('amount_available', 0)
        .gte('end_date', new Date().toISOString()),
    ]);
    setMyCoupons(mineRes.data || []);
    setFlashBrandIds(new Set((galleryRes.data || []).map((c: any) => c.store_id).filter(Boolean)));
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store?.id]);

  // Cupones flash por período de la propia tienda (cupos diarios/semanales)
  const flashIssuedInWindow = (flavor: string): number => {
    const limit = FLASH_PERIOD_LIMITS[flavor];
    if (!limit) return 0;
    const start = new Date(); start.setHours(0,0,0,0);
    start.setDate(start.getDate() - (limit.windowDays - 1));
    return myCoupons.filter(c =>
      c.id !== editingId &&
      c.plan_type === flavor &&
      new Date(c.start_date) >= start
    ).length;
  };

  const resetForm = () => {
    setEditingId(null);
    setTitle(''); setPlanType(allowedPlanTypes[0] || '');
    setCategory(''); setPriceUsd(0); setAmount(0);
    setImageFile(null); setImageUrl('');
    setStartDate(today); setEndDate('');
    setShowForm(false);
  };

  const openCreate = () => {
    resetForm();
    setPlanType(allowedPlanTypes[0] || '');
    setShowForm(true);
  };

  const openEdit = (c: any) => {
    setEditingId(c.id);
    setTitle(c.title || '');
    setPlanType(c.plan_type || allowedPlanTypes[0] || '');
    setCategory(c.category || '');
    setPriceUsd(Number(c.price_usd ?? 0));
    setAmount(Number(c.amount_available ?? 0));
    setImageFile(null);
    setImageUrl(c.image_url || '');
    setStartDate((c.start_date || today).split('T')[0]);
    setEndDate((c.end_date || '').split('T')[0]);
    setShowForm(true);
  };

  const handleImage = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 500 * 1024) { alert('La imagen debe pesar menos de 500 KB.'); e.target.value=''; return; }
    setImageFile(f);
    setImageUrl(URL.createObjectURL(f));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    if (blockerReason) { setFeedback({ type: 'err', msg: blockerReason }); return; }
    if (!planType) { setFeedback({ type: 'err', msg: 'Selecciona el plan del cupón.' }); return; }
    if (!allowedPlanTypes.includes(planType)) { setFeedback({ type: 'err', msg: 'Plan no autorizado para tu tienda.' }); return; }
    if (!endDate) { setFeedback({ type: 'err', msg: 'Indica la fecha de vencimiento.' }); return; }

    // Validaciones flash extra
    if (FLASH_PLANS.has(planType)) {
      const isNewBrand = !flashBrandIds.has(store.id);
      const editingThis = editingId ? myCoupons.find(c => c.id === editingId) : null;
      const editingWasFlash = !!editingThis && FLASH_PLANS.has(editingThis.plan_type);
      if (isNewBrand && !editingWasFlash && flashBrandIds.size >= FLASH_GALLERY_MAX) {
        setFeedback({ type: 'err', msg: `Galería Flash llena (${flashBrandIds.size}/${FLASH_GALLERY_MAX} marcas).` });
        return;
      }
      const limit = FLASH_PERIOD_LIMITS[planType];
      if (limit) {
        const issued = flashIssuedInWindow(planType);
        if (issued >= limit.max) {
          setFeedback({ type: 'err', msg: `Ya lanzaste ${issued}/${limit.max} cupones flash en este ${limit.label}.` });
          return;
        }
      }
    }

    setSubmitting(true); setFeedback(null);
    try {
      let finalImageUrl = imageUrl;
      if (imageFile) {
        const ext = imageFile.name.split('.').pop();
        const path = `coupons/cupon_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('publicidad').upload(path, imageFile, { upsert: true });
        if (upErr) throw upErr;
        finalImageUrl = supabase.storage.from('publicidad').getPublicUrl(path).data.publicUrl;
      }

      if (editingId) {
        const { error } = await supabase.from('coupons')
          .update({
            title, plan_type: planType, category,
            price_usd: priceUsd, amount_available: amount,
            image_url: finalImageUrl || null,
            start_date: new Date(startDate).toISOString(),
            end_date: new Date(endDate).toISOString(),
          })
          .eq('id', editingId);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Cupón actualizado.' });
      } else {
        const code = `CUPON-${(store.name || 'STORE').substring(0,3).toUpperCase()}-${Date.now().toString().slice(7)}`;
        const { error } = await supabase.from('coupons').insert([{
          store_id: store.id,
          title, plan_type: planType, category,
          price_usd: priceUsd, amount_available: amount,
          image_url: finalImageUrl || null,
          start_date: new Date(startDate).toISOString(),
          end_date: new Date(endDate).toISOString(),
          code,
        }]);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Cupón publicado.' });
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
    if (!confirm(`Eliminar el cupón "${c.title}"?`)) return;
    const { error } = await supabase.from('coupons').delete().eq('id', c.id);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: 'Cupón eliminado.' });
    fetchData();
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver tus cupones.
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

  const flashCount = myCoupons.filter(c => FLASH_PLANS.has(c.plan_type)
    && c.amount_available > 0
    && (!c.end_date || c.end_date >= new Date().toISOString())).length;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Promociones · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Mis Cupones</h2>
          <p className="text-white/50 text-sm mt-2">
            Sube cupones de tu tienda. Los marcados como <span className="text-pink-300 font-semibold">⚡ FLASH</span> entran en la galería de cupones con captura de datos.
          </p>
        </div>
        <button
          onClick={openCreate}
          disabled={allowedPlanTypes.length === 0}
          className="shrink-0 text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg px-4 py-2.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed self-start"
        >
          + Nuevo cupón
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
              Ver catálogo / addon Flash Coupon →
            </Link>
          </div>
        </div>
      )}

      {/* Estado addon flash */}
      {flashActive && (
        <div className="bg-pink-500/[0.06] border border-pink-500/25 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-pink-200 text-sm font-semibold">
                Addon Flash Coupon activo · {PLAN_LABELS[store!.flash_coupon_plan!]}
              </p>
              <p className="text-white/50 text-xs mt-1">
                Galería global: <span className="font-mono text-pink-200">{flashBrandIds.size}/{FLASH_GALLERY_MAX}</span> marcas. Tu marca {flashBrandIds.has(store!.id) ? 'ya ocupa un slot' : 'no ocupa slot todavía'}.
              </p>
              {store!.flash_coupon_expiry_date && (
                <p className="text-white/50 text-xs mt-0.5">Vence {store!.flash_coupon_expiry_date}.</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-[10px] text-white/40 uppercase">Tus cupones flash activos</p>
              <p className="text-pink-300 font-mono text-xl font-bold">{flashCount}</p>
              {FLASH_PERIOD_LIMITS[store!.flash_coupon_plan!] && (() => {
                const lim = FLASH_PERIOD_LIMITS[store!.flash_coupon_plan!];
                const issued = flashIssuedInWindow(store!.flash_coupon_plan!);
                return (
                  <p className="text-[10px] text-white/40">
                    {issued}/{lim.max} por {lim.label}
                  </p>
                );
              })()}
            </div>
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
                {editingId ? 'Editar cupón' : 'Nuevo cupón'}
              </h3>
              <button onClick={resetForm} disabled={submitting} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Título</label>
                <input type="text" required value={title} onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan del cupón</label>
                  <select required value={planType} onChange={(e) => setPlanType(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50">
                    <option value="">Seleccionar…</option>
                    {allowedPlanTypes.map(p => (
                      <option key={p} value={p}>
                        {FLASH_PLANS.has(p) ? '⚡ ' : ''}{PLAN_LABELS[p] || p}{FLASH_PLANS.has(p) ? ' (flash)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Categoría</label>
                  <input type="text" value={category} onChange={(e) => setCategory(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                    placeholder="Ej: Café" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Precio (USD)</label>
                  <input type="number" min={0} step={0.01} value={priceUsd}
                    onChange={(e) => setPriceUsd(parseFloat(e.target.value) || 0)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Stock disponible</label>
                  <input type="number" min={0} value={amount}
                    onChange={(e) => setAmount(parseInt(e.target.value) || 0)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vence</label>
                  <input type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Imagen {editingId && <span className="normal-case tracking-normal text-white/30">(vacío = mantener)</span>}
                </label>
                <input type="file" accept="image/*" onChange={handleImage}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-white/10 file:text-white/60" />
                <p className="text-[10px] text-white/20 mt-1">JPG/PNG · Máx 500 KB · Recomendado 800×800</p>
                {imageUrl && (
                  <img src={imageUrl} alt="preview" className="mt-2 w-32 h-32 rounded-lg object-contain bg-black" />
                )}
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={resetForm} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg">
                  Cancelar
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-50">
                  {submitting ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Publicar cupón'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {myCoupons.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">Aún no tienes cupones.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {myCoupons.map(c => {
            const isFlash = FLASH_PLANS.has(c.plan_type);
            const active = c.amount_available > 0
              && (!c.end_date || c.end_date >= new Date().toISOString());
            return (
              <div key={c.id} className="bg-[#0F0F0F] border border-white/5 rounded-xl overflow-hidden">
                <div className="aspect-square bg-black flex items-center justify-center">
                  {c.image_url ? (
                    <img src={c.image_url} alt={c.title} className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-white/20 text-xs">Sin imagen</span>
                  )}
                </div>
                <div className="p-4 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-white text-sm font-bold truncate">{c.title}</h4>
                    {isFlash && (
                      <span className="text-[9px] font-bold tracking-wider bg-pink-500/20 text-pink-300 border border-pink-500/40 px-1.5 py-0.5 rounded shrink-0">
                        ⚡ FLASH
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
                      {PLAN_LABELS[c.plan_type] || c.plan_type}
                    </span>
                    <span className={`text-[10px] font-mono ${active ? 'text-emerald-300' : 'text-white/30'}`}>
                      {active ? `${c.amount_available} disp.` : 'AGOTADO/VENCIDO'}
                    </span>
                  </div>
                  <p className="text-[10px] text-white/40 font-mono">
                    ${Number(c.price_usd ?? 0).toFixed(2)} USD · vence {c.end_date?.split('T')[0] || '—'}
                  </p>
                  <p className="text-[10px] text-white/30 font-mono break-all">{c.code}</p>
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
