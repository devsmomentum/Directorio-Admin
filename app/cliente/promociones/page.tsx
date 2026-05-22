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
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
};

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-300 bg-cyan-500/10',
  ORO: 'text-amber-300 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-300 bg-purple-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-300 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-300 bg-pink-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-300 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-300 bg-blue-500/10',
};

const BASE_COUPON_PLANS = new Set(['DIAMANTE', 'ORO', 'IA_PERFORMANCE']);
const FLASH_PLANS = new Set(['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL']);
const CAMPAIGN_CAPABLE = new Set(['DIAMANTE', 'ORO', 'PUBLI_PROMO_DIARIO', 'PUBLI_PROMO_SEMANAL']);

const FLASH_GALLERY_MAX = 20;
const FLASH_PERIOD_LIMITS: Record<string, { max: number; windowDays: number; label: string }> = {
  FLASH_COUPON_DIARIO: { max: 10, windowDays: 1, label: 'día' },
  FLASH_COUPON_SEMANAL: { max: 30, windowDays: 5, label: 'semana (5 días)' },
};

const CAMPAIGN_DURATION_SECONDS = 15;

type FilterKind = 'all' | 'coupons' | 'campaigns';
type FormKind = null | 'pick' | 'coupon' | 'campaign';

export default function ClientePromocionesPage() {
  const { selectedStore: store } = useClienteStore();
  const [coupons, setCoupons] = useState<any[]>([]);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [flashBrandIds, setFlashBrandIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [filter, setFilter] = useState<FilterKind>('all');

  const [form, setForm] = useState<FormKind>(null);

  // Coupon form state
  const [cEditingId, setCEditingId] = useState<string | null>(null);
  const [cTitle, setCTitle] = useState('');
  const [cIsFlash, setCIsFlash] = useState(false);
  const [cCategory, setCCategory] = useState('');
  const [cDiscount, setCDiscount] = useState<string>('');
  const [cStock, setCStock] = useState<string>('');
  const [cImageFile, setCImageFile] = useState<File | null>(null);
  const [cImageUrl, setCImageUrl] = useState('');
  const [cStartDate, setCStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [cEndDate, setCEndDate] = useState('');

  // Campaign form state
  const [aEditingId, setAEditingId] = useState<string | null>(null);
  const [aBrandName, setABrandName] = useState('');
  const [aDescription, setADescription] = useState('');
  const [aMediaFile, setAMediaFile] = useState<File | null>(null);
  const [aMediaUrl, setAMediaUrl] = useState('');
  const [aMediaType, setAMediaType] = useState<'image' | 'video'>('video');
  const [aStartDate, setAStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [aEndDate, setAEndDate] = useState('');

  const [submitting, setSubmitting] = useState(false);

  // Modal de conflicto: una empresa solo puede tener UNA campaña activa a la vez.
  const [conflict, setConflict] = useState<{ active: any; step: 'choose' | 'queue-dates' } | null>(null);
  const [qStartDate, setQStartDate] = useState('');
  const [qEndDate, setQEndDate] = useState('');

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const planActive = !!store?.plan_type
    && (!store.contract_expiry_date || store.contract_expiry_date >= today);
  const flashActive = !!store?.flash_coupon_plan
    && (!store.flash_coupon_expiry_date || store.flash_coupon_expiry_date >= today);

  const canBaseCoupon = planActive && !!store?.plan_type && BASE_COUPON_PLANS.has(store.plan_type);
  const canFlashCoupon = flashActive;
  const canCampaign = planActive && !!store?.plan_type && CAMPAIGN_CAPABLE.has(store.plan_type);
  const canCreateCoupon = canBaseCoupon || canFlashCoupon;

  const couponPlanType = useMemo(() => {
    if (cIsFlash) return store?.flash_coupon_plan || '';
    return store?.plan_type || '';
  }, [cIsFlash, store]);

  const fetchData = async () => {
    if (!store) { setLoading(false); return; }
    setLoading(true);
    const [mineCoupons, gallery, mineCampaigns] = await Promise.all([
      supabase.from('coupons').select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('coupons').select('store_id, plan_type, amount_available, end_date')
        .in('plan_type', ['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL'])
        .gt('amount_available', 0)
        .gte('end_date', new Date().toISOString()),
      supabase.from('ad_campaigns').select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    setCoupons(mineCoupons.data || []);
    setFlashBrandIds(new Set((gallery.data || []).map((c: any) => c.store_id).filter(Boolean)));
    setCampaigns(mineCampaigns.data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store?.id]);

  const flashIssuedInWindow = (flavor: string): number => {
    const limit = FLASH_PERIOD_LIMITS[flavor];
    if (!limit) return 0;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (limit.windowDays - 1));
    return coupons.filter(c =>
      c.id !== cEditingId &&
      c.plan_type === flavor &&
      new Date(c.start_date) >= start
    ).length;
  };

  const resetCouponForm = () => {
    setCEditingId(null);
    setCTitle(''); setCCategory('');
    setCDiscount(''); setCStock('');
    setCImageFile(null); setCImageUrl('');
    setCStartDate(today); setCEndDate('');
    setCIsFlash(false);
  };
  const resetCampaignForm = () => {
    setAEditingId(null);
    setABrandName(''); setADescription('');
    setAMediaFile(null); setAMediaUrl(''); setAMediaType('video');
    setAStartDate(today); setAEndDate('');
  };
  const closeForm = () => {
    if (submitting) return;
    setForm(null);
    resetCouponForm();
    resetCampaignForm();
  };

  const openCreateCoupon = () => {
    resetCouponForm();
    setCIsFlash(canFlashCoupon && !canBaseCoupon);
    setForm('coupon');
  };
  const openCreateCampaign = () => {
    resetCampaignForm();
    setForm('campaign');
  };

  const openEditCoupon = (c: any) => {
    setCEditingId(c.id);
    setCTitle(c.title || '');
    setCIsFlash(FLASH_PLANS.has(c.plan_type));
    setCCategory(c.category || '');
    setCDiscount(c.price_usd != null ? String(c.price_usd) : '');
    setCStock(c.amount_available != null ? String(c.amount_available) : '');
    setCImageFile(null);
    setCImageUrl(c.image_url || '');
    setCStartDate((c.start_date || today).split('T')[0]);
    setCEndDate((c.end_date || '').split('T')[0]);
    setForm('coupon');
  };
  const openEditCampaign = (c: any) => {
    setAEditingId(c.id);
    setABrandName(c.brand_name || '');
    setADescription(c.description || '');
    setAMediaUrl(c.media_url || '');
    setAMediaType((c.media_type as 'image' | 'video') || 'video');
    setAStartDate(c.start_date || today);
    setAEndDate(c.end_date || '');
    setAMediaFile(null);
    setForm('campaign');
  };

  const handleImage = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 500 * 1024) { alert('La imagen debe pesar menos de 500 KB.'); e.target.value = ''; return; }
    setCImageFile(f);
    setCImageUrl(URL.createObjectURL(f));
  };
  const handleMedia = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) { alert('El archivo debe pesar menos de 30 MB.'); e.target.value = ''; return; }
    setAMediaFile(f);
    setAMediaType(f.type.startsWith('video/') ? 'video' : 'image');
    setAMediaUrl(URL.createObjectURL(f));
  };

  const submitCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    const planType = couponPlanType;
    if (!planType) {
      setFeedback({ type: 'err', msg: cIsFlash ? 'No tienes el addon Flash Coupon activo.' : 'Tu plan no permite cupones.' });
      return;
    }
    if (cIsFlash && !canFlashCoupon) {
      setFeedback({ type: 'err', msg: 'El addon Flash Coupon no está activo.' });
      return;
    }
    if (!cIsFlash && !canBaseCoupon) {
      setFeedback({ type: 'err', msg: 'Tu plan base no permite cupones normales.' });
      return;
    }
    if (!cEndDate) { setFeedback({ type: 'err', msg: 'Indica la fecha de vencimiento.' }); return; }
    const planExpiry = cIsFlash ? store.flash_coupon_expiry_date : store.contract_expiry_date;
    if (planExpiry && cEndDate > planExpiry) {
      setFeedback({
        type: 'err',
        msg: cIsFlash
          ? `El cupón flash no puede vencer después de tu addon (${planExpiry}).`
          : `El cupón no puede vencer después de tu plan (${planExpiry}).`,
      });
      return;
    }
    const discountNum = parseFloat(cDiscount);
    if (!cDiscount || isNaN(discountNum) || discountNum <= 0 || discountNum > 100) {
      setFeedback({ type: 'err', msg: 'Ingresa un descuento entre 1 y 100%.' });
      return;
    }
    const stockNum = parseInt(cStock, 10);
    if (!cStock || isNaN(stockNum) || stockNum <= 0) {
      setFeedback({ type: 'err', msg: 'Ingresa un stock mayor a 0.' });
      return;
    }

    if (cIsFlash) {
      const isNewBrand = !flashBrandIds.has(store.id);
      const editingThis = cEditingId ? coupons.find(c => c.id === cEditingId) : null;
      const editingWasFlash = !!editingThis && FLASH_PLANS.has(editingThis.plan_type);
      if (isNewBrand && !editingWasFlash && flashBrandIds.size >= FLASH_GALLERY_MAX) {
        setFeedback({ type: 'err', msg: `Galería Flash llena (${flashBrandIds.size}/${FLASH_GALLERY_MAX} campañas).` });
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
      let finalImageUrl = cImageUrl;
      if (cImageFile) {
        const ext = cImageFile.name.split('.').pop();
        const path = `coupons/cupon_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('publicidad').upload(path, cImageFile, { upsert: true });
        if (upErr) throw upErr;
        finalImageUrl = supabase.storage.from('publicidad').getPublicUrl(path).data.publicUrl;
      }

      if (cEditingId) {
        const { error } = await supabase.from('coupons')
          .update({
            title: cTitle, plan_type: planType, category: cCategory,
            price_usd: discountNum, amount_available: stockNum,
            image_url: finalImageUrl || null,
            start_date: new Date(cStartDate).toISOString(),
            end_date: new Date(cEndDate).toISOString(),
          })
          .eq('id', cEditingId);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Cupón actualizado.' });
      } else {
        const code = `CUPON-${(store.name || 'STORE').substring(0, 3).toUpperCase()}-${Date.now().toString().slice(7)}`;
        const { error } = await supabase.from('coupons').insert([{
          store_id: store.id,
          title: cTitle, plan_type: planType, category: cCategory,
          price_usd: discountNum, amount_available: stockNum,
          image_url: finalImageUrl || null,
          start_date: new Date(cStartDate).toISOString(),
          end_date: new Date(cEndDate).toISOString(),
          code,
        }]);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Cupón publicado.' });
      }
      closeForm();
      fetchData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Error al guardar.' });
    } finally {
      setSubmitting(false);
    }
  };

  const findActiveCampaign = () =>
    campaigns.find(c =>
      c.id !== aEditingId &&
      c.is_active &&
      (!c.end_date || c.end_date >= today)
    );

  const submitCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    if (!canCampaign) { setFeedback({ type: 'err', msg: 'Tu plan no permite campañas.' }); return; }
    if (!aBrandName.trim()) { setFeedback({ type: 'err', msg: 'Indica el nombre de la campaña.' }); return; }
    if (!aEditingId && !aMediaFile) { setFeedback({ type: 'err', msg: 'Sube el archivo (video o imagen).' }); return; }
    if (store.contract_expiry_date) {
      if (!aEndDate) {
        setFeedback({ type: 'err', msg: 'Indica la fecha de fin de la campaña.' });
        return;
      }
      if (aEndDate > store.contract_expiry_date) {
        setFeedback({ type: 'err', msg: `La campaña no puede pasar de la vigencia de tu plan (${store.contract_expiry_date}).` });
        return;
      }
    }

    // Una empresa solo puede tener una campaña activa a la vez.
    // En creación, si ya hay activa, abrimos el modal de elección.
    if (!aEditingId) {
      const active = findActiveCampaign();
      if (active) {
        setConflict({ active, step: 'choose' });
        return;
      }
    }

    await persistCampaign('normal');
  };

  const persistCampaign = async (
    mode: 'normal' | 'replace' | 'queue',
    activeConflict?: any,
  ) => {
    if (!store) return;
    setSubmitting(true); setFeedback(null);
    try {
      let finalMediaUrl = aMediaUrl;
      let finalMediaType = aMediaType;
      if (aMediaFile) {
        const ext = aMediaFile.name.split('.').pop();
        const path = `campaigns/camp_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('publicidad').upload(path, aMediaFile, { upsert: true });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from('publicidad').getPublicUrl(path);
        finalMediaUrl = data.publicUrl;
        finalMediaType = aMediaFile.type.startsWith('video/') ? 'video' : 'image';
      }

      if (aEditingId) {
        const { error } = await supabase.from('ad_campaigns')
          .update({
            brand_name: aBrandName, description: aDescription,
            media_url: finalMediaUrl, media_type: finalMediaType,
            duration_seconds: CAMPAIGN_DURATION_SECONDS,
            start_date: aStartDate, end_date: aEndDate || null,
          })
          .eq('id', aEditingId);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Campaña actualizada.' });
      } else {
        // Si reemplazamos: desactivar la actual primero.
        if (mode === 'replace' && activeConflict) {
          const { error: deactErr } = await supabase.from('ad_campaigns')
            .update({ is_active: false })
            .eq('id', activeConflict.id);
          if (deactErr) throw deactErr;
        }

        // Si encolamos: la nueva usa el rango elegido por el usuario.
        // Queda inactiva como borrador: el día que toque se activa manualmente
        // desde el listado. Así garantizamos que solo haya una activa a la vez.
        let startDate = aStartDate;
        let endDate: string | null = aEndDate || null;
        let isActiveFlag = true;
        if (mode === 'queue') {
          startDate = qStartDate;
          endDate = qEndDate || null;
          isActiveFlag = false;
        }

        const { error } = await supabase.from('ad_campaigns').insert([{
          brand_name: aBrandName,
          description: aDescription,
          media_url: finalMediaUrl,
          media_type: finalMediaType,
          duration_seconds: CAMPAIGN_DURATION_SECONDS,
          start_date: startDate,
          end_date: endDate,
          plan_type: store.plan_type,
          store_id: store.id,
          is_active: isActiveFlag,
        }]);
        if (error) throw error;

        if (mode === 'replace') {
          setFeedback({ type: 'ok', msg: 'Campaña anterior desactivada. Tu nueva campaña ya está en el loop.' });
        } else if (mode === 'queue') {
          setFeedback({
            type: 'ok',
            msg: `Campaña programada del ${qStartDate} al ${qEndDate || '—'}. Quedó como borrador; actívala desde el listado el ${qStartDate}.`,
          });
        } else {
          setFeedback({ type: 'ok', msg: 'Campaña creada y publicada en el loop.' });
        }
      }
      setConflict(null);
      closeForm();
      fetchData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Error al guardar.' });
    } finally {
      setSubmitting(false);
    }
  };

  const deleteCoupon = async (c: any) => {
    if (!confirm(`Eliminar el cupón "${c.title}"?`)) return;
    const { error } = await supabase.from('coupons').delete().eq('id', c.id);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: 'Cupón eliminado.' });
    fetchData();
  };
  const deleteCampaign = async (c: any) => {
    if (!confirm(`Eliminar la campaña "${c.brand_name}"?`)) return;
    const { error } = await supabase.from('ad_campaigns').delete().eq('id', c.id);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: 'Campaña eliminada.' });
    fetchData();
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver tus promociones.
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

  const noCapability = !canCreateCoupon && !canCampaign;

  const items: Array<{ kind: 'coupon' | 'campaign'; data: any; created: string }> = [
    ...coupons.map(c => ({ kind: 'coupon' as const, data: c, created: c.created_at })),
    ...campaigns.map(c => ({ kind: 'campaign' as const, data: c, created: c.created_at })),
  ].sort((a, b) => (b.created || '').localeCompare(a.created || ''));

  const visible = items.filter(it => {
    if (filter === 'all') return true;
    if (filter === 'coupons') return it.kind === 'coupon';
    return it.kind === 'campaign';
  });

  const flashCount = coupons.filter(c => FLASH_PLANS.has(c.plan_type)
    && c.amount_available > 0
    && (!c.end_date || c.end_date >= new Date().toISOString())).length;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Promociones · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Cupones y Campañas</h2>
          <p className="text-white/50 text-sm mt-2">
            Administra cupones de descuento y campañas publicitarias de tu tienda desde un solo lugar.
          </p>
        </div>
        <button
          onClick={() => setForm('pick')}
          disabled={noCapability}
          className="shrink-0 text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg px-4 py-2.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed self-start"
        >
          + Nueva promoción
        </button>
      </div>

      {noCapability && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2.5">
          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="text-xs text-amber-200/90 leading-relaxed flex-1">
            <p>Tu tienda no tiene un plan activo que permita cupones ni campañas.</p>
            <Link href="/cliente/planes" className="inline-block mt-1 text-amber-300 underline">
              Ver catálogo de planes →
            </Link>
          </div>
        </div>
      )}

      {flashActive && (
        <div className="bg-pink-500/[0.06] border border-pink-500/25 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-pink-200 text-sm font-semibold">
                ⚡ Addon Flash Coupon activo · {PLAN_LABELS[store!.flash_coupon_plan!]}
              </p>
              <p className="text-white/50 text-xs mt-1">
                Galería global: <span className="font-mono text-pink-200">{flashBrandIds.size}/{FLASH_GALLERY_MAX}</span> campañas. Tu campaña {flashBrandIds.has(store!.id) ? 'ya ocupa un slot' : 'no ocupa slot todavía'}.
              </p>
              {store!.flash_coupon_expiry_date && (
                <p className="text-white/50 text-xs mt-0.5">Vence {store!.flash_coupon_expiry_date}.</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-[10px] text-white/40 uppercase">Tus flash activos</p>
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
        <div className={`rounded-lg p-3 text-sm border ${feedback.type === 'ok'
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}>{feedback.msg}</div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {(['all', 'coupons', 'campaigns'] as FilterKind[]).map(k => {
          const active = filter === k;
          const label = k === 'all' ? `Todos (${items.length})`
            : k === 'coupons' ? `Cupones (${coupons.length})`
              : `Campañas (${campaigns.length})`;
          return (
            <button key={k} onClick={() => setFilter(k)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${active
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-100'
                : 'bg-white/[0.03] border-white/10 text-white/60 hover:bg-white/[0.06]'
                }`}>
              {label}
            </button>
          );
        })}
      </div>

      {/* Picker modal */}
      {form === 'pick' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeForm} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">¿Qué quieres crear?</h3>
              <button onClick={closeForm} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={() => { if (canCreateCoupon) openCreateCoupon(); }}
                disabled={!canCreateCoupon}
                className="text-left bg-[#0A0A0A] border border-white/10 hover:border-cyan-500/40 hover:bg-cyan-500/[0.04] disabled:opacity-40 disabled:cursor-not-allowed rounded-xl p-4 transition-colors"
              >
                <div className="text-2xl mb-2">🎟️</div>
                <p className="text-sm font-semibold text-white">Cupón</p>
                <p className="text-[11px] text-white/50 mt-1 leading-snug">
                  Descuento con código que el cliente puede canjear. Soporta Flash si tienes el addon.
                </p>
              </button>
              <button
                onClick={() => { if (canCampaign) openCreateCampaign(); }}
                disabled={!canCampaign}
                className="text-left bg-[#0A0A0A] border border-white/10 hover:border-cyan-500/40 hover:bg-cyan-500/[0.04] disabled:opacity-40 disabled:cursor-not-allowed rounded-xl p-4 transition-colors"
              >
                <div className="text-2xl mb-2">📺</div>
                <p className="text-sm font-semibold text-white">Campaña</p>
                <p className="text-[11px] text-white/50 mt-1 leading-snug">
                  Video o imagen que rota en los kioscos según tu plan.
                </p>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Coupon modal */}
      {form === 'coupon' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeForm} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>🎟️</span>
                {cEditingId ? 'Editar cupón' : 'Nuevo cupón'}
              </h3>
              <button onClick={closeForm} disabled={submitting} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={submitCoupon} className="px-6 py-5 space-y-4">
              {/* Tipo de cupón: segmented control */}
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Tipo de cupón</label>
                <div className="grid grid-cols-2 gap-2 bg-[#0A0A0A] border border-white/10 rounded-lg p-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (!canBaseCoupon) {
                        setFeedback({ type: 'err', msg: 'Tu plan base no permite cupones normales.' });
                        return;
                      }
                      setCIsFlash(false);
                    }}
                    disabled={!canBaseCoupon}
                    aria-pressed={!cIsFlash}
                    className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${!cIsFlash
                      ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-100'
                      : 'border border-transparent text-white/60 hover:bg-white/[0.04]'
                      }`}
                  >
                    Normal
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!canFlashCoupon) {
                        setFeedback({ type: 'err', msg: 'No tienes el addon Flash Coupon activo.' });
                        return;
                      }
                      setCIsFlash(true);
                    }}
                    disabled={!canFlashCoupon}
                    aria-pressed={cIsFlash}
                    className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${cIsFlash
                      ? 'bg-pink-500/20 border border-pink-500/50 text-pink-100'
                      : 'border border-transparent text-white/60 hover:bg-white/[0.04]'
                      }`}
                  >
                    ⚡ Flash
                  </button>
                </div>
                <p className="text-[11px] text-white/50 leading-snug mt-2">
                  {cIsFlash
                    ? `Aparece en la galería pública con captura de datos. Plan: ${PLAN_LABELS[couponPlanType] || couponPlanType || '—'}.`
                    : `Cupón normal asociado a tu plan ${PLAN_LABELS[store!.plan_type!] || store!.plan_type || '—'}. No entra en la galería pública.`}
                </p>
                {cIsFlash && !canFlashCoupon && (
                  <p className="text-[11px] text-amber-300 mt-1">Necesitas el addon Flash Coupon activo.</p>
                )}
                {!cIsFlash && !canBaseCoupon && (
                  <p className="text-[11px] text-amber-300 mt-1">Tu plan base no permite cupones normales.</p>
                )}
              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Título</label>
                <input type="text" required value={cTitle} onChange={(e) => setCTitle(e.target.value)}
                  placeholder="Ej: 2x1 en bebidas"
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descuento (%)</label>
                  <div className="relative">
                    <input type="number" min={1} max={100} step={1} required
                      value={cDiscount}
                      onChange={(e) => setCDiscount(e.target.value)}
                      placeholder="0"
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-3 pr-8 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 text-sm pointer-events-none">%</span>
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Stock disponible</label>
                  <input type="number" min={1} step={1} required
                    value={cStock}
                    onChange={(e) => setCStock(e.target.value)}
                    placeholder="0"
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Categoría (opcional)</label>
                <input type="text" value={cCategory} onChange={(e) => setCCategory(e.target.value)}
                  placeholder="Ej: Café"
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input type="date" required value={cStartDate} min={today}
                    max={cIsFlash ? (store!.flash_coupon_expiry_date || undefined) : (store!.contract_expiry_date || undefined)}
                    onChange={(e) => setCStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vence</label>
                  <input type="date" required value={cEndDate} min={cStartDate || today}
                    max={cIsFlash ? (store!.flash_coupon_expiry_date || undefined) : (store!.contract_expiry_date || undefined)}
                    onChange={(e) => setCEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              {(cIsFlash ? store!.flash_coupon_expiry_date : store!.contract_expiry_date) && (
                <p className="text-[10px] text-white/40 -mt-2">
                  {cIsFlash ? 'Tu addon Flash' : 'Tu plan'} vence el {cIsFlash ? store!.flash_coupon_expiry_date : store!.contract_expiry_date}. El cupón no puede pasar de esa fecha.
                </p>
              )}

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Imagen {cEditingId && <span className="normal-case tracking-normal text-white/30">(vacío = mantener)</span>}
                </label>
                <input type="file" accept="image/*" onChange={handleImage}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-white/10 file:text-white/60" />
                <p className="text-[10px] text-white/20 mt-1">JPG/PNG · Máx 500 KB · Recomendado <span className="text-white/40">1200 × 900 px (4:3)</span>. El kiosco recorta a 4:3 con <code className="text-white/30">cover</code>; mantén el contenido importante centrado.</p>
                {cImageUrl && (
                  <img src={cImageUrl} alt="preview" className="mt-2 w-40 aspect-[4/3] rounded-lg object-cover bg-black" />
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={closeForm} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg">
                  Cancelar
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-50">
                  {submitting ? 'Guardando…' : cEditingId ? 'Guardar cambios' : 'Publicar cupón'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Campaign modal */}
      {form === 'campaign' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeForm} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>📺</span>
                {aEditingId ? 'Editar campaña' : 'Nueva campaña'}
              </h3>
              <button onClick={closeForm} disabled={submitting} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={submitCampaign} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre de la campaña</label>
                <input type="text" required value={aBrandName} onChange={(e) => setABrandName(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripción (opcional)</label>
                <textarea value={aDescription} onChange={(e) => setADescription(e.target.value)}
                  rows={2}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50 resize-none" />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Archivo {aEditingId && <span className="normal-case tracking-normal text-white/30">(vacío = mantener)</span>}
                </label>
                <input type="file" accept="video/*,image/*" onChange={handleMedia}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-white/10 file:text-white/60" />
                <p className="text-[10px] text-white/20 mt-1">Video MP4/WebM o imagen JPG/PNG · Máx 30 MB · Recomendado <span className="text-white/40">1080 × 1920 px (9:16 vertical)</span>. El kiosco lo muestra a pantalla completa con <code className="text-white/30">cover</code>.</p>

                {aMediaUrl && (
                  <div className="mt-3 flex items-start gap-3">
                    {/* Mock del kiosco 9:16 a escala (réplica de home_screen.dart) */}
                    <div className="shrink-0 relative w-[200px] aspect-[9/16] rounded-xl overflow-hidden bg-black border border-white/15 shadow-lg">
                      {/* 1. Media a pantalla completa con cover */}
                      {aMediaType === 'video' ? (
                        <video
                          key={aMediaUrl}
                          src={aMediaUrl}
                          className="absolute inset-0 w-full h-full object-cover bg-black"
                          autoPlay
                          muted
                          loop
                          playsInline
                          controls
                          preload="metadata"
                        />
                      ) : (
                        <img src={aMediaUrl} alt="preview" className="absolute inset-0 w-full h-full object-cover" />
                      )}

                      {/* 2. Gradiente vertical (igual al de home_screen: top transparente → bottom oscuro) */}
                      <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-transparent via-black/30 to-black/85" />

                      {/* 3. Logo Millennium (top-right, ~5% de alto) */}
                      <div className="absolute top-1.5 right-2 px-1.5 py-0.5 bg-black/45 border border-white/20 rounded text-[7px] font-black tracking-widest text-white/80">
                        MM
                      </div>

                      {/* 4. Bloque inferior: badge + marca + descripción + wifi + CTA + footer */}
                      <div className="absolute left-0 right-0 bottom-2 px-2.5 flex flex-col items-start gap-1">
                        <span className="text-[7px] font-bold tracking-widest text-white bg-white/10 border border-white/20 rounded-full px-1.5 py-[1px]">
                          📍 SLOT
                        </span>
                        <p className="text-[11px] font-black text-white leading-tight truncate max-w-full">
                          {aBrandName.trim() || 'Tu marca'}
                        </p>
                        <p className="text-[8px] text-white/75 leading-tight line-clamp-2 max-w-full">
                          {aDescription.trim() || 'Toca para explorar el mall'}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className="text-[6px] font-mono text-white/60 bg-white/10 border border-white/15 rounded px-1 py-[1px]">📶 WIFI</span>
                          <span className="text-[6px] font-mono text-white/60 bg-white/10 border border-white/15 rounded px-1 py-[1px]">QR</span>
                        </div>
                        <button type="button" disabled
                          className="mt-1 w-full bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-[8px] font-black tracking-widest rounded-md py-1 shadow">
                          COMENZAR ▸
                        </button>
                        <span className="text-[6px] text-white/40 tracking-wider mt-0.5">Millennium Mall · Anavi</span>
                      </div>

                      {/* 5. Marca de aspecto */}
                      <span className="absolute top-1.5 left-1.5 text-[8px] font-mono bg-black/65 text-white/75 px-1.5 py-0.5 rounded">9:16</span>
                    </div>

                    <div className="flex-1 space-y-1.5 text-[11px] text-white/50 leading-snug">
                      <p>
                        Vista previa a escala del kiosco vertical (1080 × 1920) en la pantalla <span className="text-white/70">Home</span>, que es donde se reproduce tu campaña.
                      </p>
                      <p>
                        Sobre tu video se renderizan elementos fijos del kiosco:
                      </p>
                      <ul className="list-disc list-inside text-white/45 space-y-0.5 ml-1">
                        <li><span className="text-white/70">Top-right:</span> logo Millennium (~5% alto).</li>
                        <li><span className="text-white/70">Inferior (~40%):</span> gradiente oscuro + badge, nombre de la marca, descripción, info WiFi/QR, botón <span className="text-white/70">COMENZAR</span> y footer.</li>
                      </ul>
                      <p>
                        Mantén logos / texto / personajes en el <span className="text-white/70">tercio superior central</span> para que no compitan con la UI. El kiosco usa <code className="text-white/40">cover</code>: archivos no 9:16 recortan bordes.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <div className="bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2.5 flex items-center gap-2">
                <svg className="w-4 h-4 text-white/40 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <p className="text-xs text-white/60">
                  Duración fija: <span className="text-white font-semibold">{CAMPAIGN_DURATION_SECONDS} segundos</span> por reproducción en el loop.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input type="date" required value={aStartDate} min={today} max={store!.contract_expiry_date || undefined}
                    onChange={(e) => setAStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin</label>
                  <input type="date" value={aEndDate} min={aStartDate || today} max={store!.contract_expiry_date || undefined}
                    onChange={(e) => setAEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              {store!.contract_expiry_date && (
                <p className="text-[10px] text-white/40 -mt-2">
                  Tu plan vence el {store!.contract_expiry_date}. La campaña no puede pasar de esa fecha.
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={closeForm} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg">
                  Cancelar
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-50">
                  {submitting ? 'Guardando…' : aEditingId ? 'Guardar cambios' : 'Publicar campaña'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Conflict modal: solo una campaña activa por empresa */}
      {conflict && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            onClick={() => { if (!submitting) setConflict(null); }}
          />
          <div className="relative bg-[#0E0E0E] border border-amber-500/30 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10">
              <h3 className="text-sm font-semibold text-amber-200 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Ya tienes una campaña activa
              </h3>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-white/70 leading-relaxed">
                Tu tienda <span className="text-white font-semibold">{store.name}</span> solo puede tener una campaña en el loop a la vez.
              </p>
              <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Campaña activa</p>
                <p className="text-sm text-white font-semibold mt-1">{conflict.active.brand_name}</p>
                <p className="text-[11px] text-white/50 mt-0.5">
                  {conflict.active.start_date}
                  {conflict.active.end_date ? ` → ${conflict.active.end_date}` : ' · sin fecha de fin'}
                </p>
              </div>
              {conflict.step === 'choose' && (() => {
                const planExpiry = store.contract_expiry_date || null;
                const minStart = conflict.active.end_date
                  ? (() => {
                      const d = new Date(conflict.active.end_date);
                      d.setUTCDate(d.getUTCDate() + 1);
                      return d.toISOString().split('T')[0];
                    })()
                  : null;
                const planAllowsQueue = !!minStart && (!planExpiry || planExpiry >= minStart);
                const queueDisabledReason = !conflict.active.end_date
                  ? 'La campaña activa no tiene fecha de fin definida.'
                  : !planAllowsQueue
                    ? `Tu plan vence el ${planExpiry} y no deja ventana después de la campaña actual (termina ${conflict.active.end_date}).`
                    : null;
                return (
                  <>
                    <p className="text-xs text-white/50 leading-snug">
                      ¿Qué quieres hacer con tu nueva campaña?
                    </p>

                    <div className="space-y-2">
                      <button
                        type="button"
                        disabled={submitting || !!queueDisabledReason}
                        onClick={() => {
                          setQStartDate(minStart || '');
                          setQEndDate(planExpiry || '');
                          setConflict({ ...conflict, step: 'queue-dates' });
                        }}
                        className="w-full text-left bg-[#0A0A0A] border border-white/10 hover:border-cyan-500/40 hover:bg-cyan-500/[0.05] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg p-3 transition-colors"
                      >
                        <p className="text-sm font-semibold text-cyan-100">
                          Programarla para cuando termine la actual
                        </p>
                        <p className="text-[11px] text-white/50 mt-1 leading-snug">
                          {queueDisabledReason
                            ?? 'Elige el rango de fechas en el siguiente paso. Queda como borrador y se activa desde el listado.'}
                        </p>
                      </button>

                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => persistCampaign('replace', conflict.active)}
                      className="w-full text-left bg-[#0A0A0A] border border-white/10 hover:border-red-500/40 hover:bg-red-500/[0.05] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg p-3 transition-colors"
                    >
                      <p className="text-sm font-semibold text-red-200">
                        Desactivar la actual y publicar la nueva ahora
                      </p>
                      <p className="text-[11px] text-white/50 mt-1 leading-snug">
                        “{conflict.active.brand_name}” se desactivará. Tu nueva campaña entrará al loop de inmediato.
                      </p>
                    </button>
                  </div>

                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setConflict(null)}
                      className="px-4 py-2 text-xs text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg"
                    >
                      Cancelar
                    </button>
                  </div>
                  </>
                );
              })()}

              {conflict.step === 'queue-dates' && (() => {
                const minStart = (() => {
                  const d = new Date(conflict.active.end_date);
                  d.setUTCDate(d.getUTCDate() + 1);
                  return d.toISOString().split('T')[0];
                })();
                const maxEnd = store.contract_expiry_date || undefined;
                // Otras campañas del store cuyo rango también debemos respetar
                // (la activa ya se cubre con minStart; aquí filtramos cualquier
                // borrador/programada futura para que la nueva no se le solape).
                const otherRanges = campaigns
                  .filter(c => c.id !== conflict.active.id && c.start_date)
                  .map(c => ({
                    brand: c.brand_name,
                    start: c.start_date as string,
                    end: (c.end_date as string | null) || null,
                  }));
                const overlapWith = qStartDate && qEndDate
                  ? otherRanges.find(r =>
                      r.start <= qEndDate && (r.end == null || r.end >= qStartDate)
                    )
                  : null;
                const inPlanRange =
                  !!qStartDate &&
                  !!qEndDate &&
                  qStartDate >= minStart &&
                  qEndDate >= qStartDate &&
                  (!maxEnd || qEndDate <= maxEnd);
                const datesValid = inPlanRange && !overlapWith;
                return (
                  <>
                    <p className="text-xs text-white/60 leading-snug">
                      Elige el rango de fechas de la nueva campaña. Debe empezar después de que termine la actual
                      {' '}(<span className="font-mono text-white/80">{conflict.active.end_date}</span>)
                      {maxEnd && <> y caer dentro de tu plan (vence <span className="font-mono text-white/80">{maxEnd}</span>)</>}.
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                        <input
                          type="date"
                          required
                          value={qStartDate}
                          min={minStart}
                          max={maxEnd}
                          onChange={(e) => setQStartDate(e.target.value)}
                          className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin</label>
                        <input
                          type="date"
                          required
                          value={qEndDate}
                          min={qStartDate || minStart}
                          max={maxEnd}
                          onChange={(e) => setQEndDate(e.target.value)}
                          className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-white/40">
                      Ventana disponible: <span className="font-mono text-white/70">{minStart}</span>
                      {maxEnd ? <> → <span className="font-mono text-white/70">{maxEnd}</span></> : ' en adelante'}.
                    </p>
                    {!inPlanRange && (qStartDate || qEndDate) && (
                      <p className="text-[11px] text-amber-300">
                        Revisa el rango: el inicio debe ser igual o posterior a {minStart}
                        {maxEnd ? ` y el fin no puede pasar de ${maxEnd}` : ''}.
                      </p>
                    )}
                    {inPlanRange && overlapWith && (
                      <p className="text-[11px] text-amber-300">
                        Choca con otra campaña tuya
                        {' '}(<span className="text-white/70">{overlapWith.brand}</span>:
                        {' '}<span className="font-mono">{overlapWith.start}</span>
                        {overlapWith.end ? <> → <span className="font-mono">{overlapWith.end}</span></> : ' sin fin'}).
                        Ajusta el rango o elimina esa campaña primero.
                      </p>
                    )}

                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => setConflict({ ...conflict, step: 'choose' })}
                        className="px-4 py-2 text-xs text-white/60 hover:text-white/90 bg-white/5 hover:bg-white/10 rounded-lg"
                      >
                        ← Volver
                      </button>
                      <button
                        type="button"
                        disabled={submitting || !datesValid}
                        onClick={() => persistCampaign('queue', conflict.active)}
                        className="flex-1 px-4 py-2 text-xs font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {submitting ? 'Programando…' : 'Programar campaña'}
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Mixed grid */}
      {visible.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">
            {items.length === 0 ? 'Aún no tienes promociones.' : 'No hay resultados para este filtro.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map(it => it.kind === 'coupon'
            ? <CouponCard key={`c-${it.data.id}`} c={it.data} onEdit={openEditCoupon} onDelete={deleteCoupon} today={today} />
            : <CampaignCard key={`a-${it.data.id}`} c={it.data} onEdit={openEditCampaign} onDelete={deleteCampaign} today={today} />
          )}
        </div>
      )}
    </div>
  );
}

function CouponCard({ c, onEdit, onDelete, today }: { c: any; onEdit: (c: any) => void; onDelete: (c: any) => void; today: string }) {
  const isFlash = FLASH_PLANS.has(c.plan_type);
  const active = c.amount_available > 0 && (!c.end_date || c.end_date >= new Date().toISOString());
  return (
    <div className="bg-[#0F0F0F] border border-white/5 rounded-xl overflow-hidden">
      <div className="aspect-[4/3] bg-black flex items-center justify-center relative">
        {c.image_url ? (
          <img src={c.image_url} alt={c.title} className="w-full h-full object-cover" />
        ) : (
          <span className="text-white/20 text-xs">Sin imagen</span>
        )}
        <span className="absolute top-2 left-2 text-[9px] font-bold tracking-wider bg-black/70 text-white border border-white/20 px-1.5 py-0.5 rounded">
          🎟️ CUPÓN
        </span>
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
        <p className="text-[11px] text-emerald-300 font-mono font-semibold">
          {Number(c.price_usd ?? 0)}% OFF · vence {c.end_date?.split('T')[0] || '—'}
        </p>
        <p className="text-[10px] text-white/30 font-mono break-all">{c.code}</p>
        <div className="flex gap-1.5 pt-2">
          <button onClick={() => onEdit(c)} className="flex-1 text-[11px] text-white/70 bg-white/5 hover:bg-white/10 rounded-md py-1.5">
            Editar
          </button>
          <button onClick={() => onDelete(c)} className="flex-1 text-[11px] text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-md py-1.5">
            Eliminar
          </button>
        </div>
      </div>
    </div>
  );
}

function CampaignCard({ c, onEdit, onDelete, today }: { c: any; onEdit: (c: any) => void; onDelete: (c: any) => void; today: string }) {
  const active = c.is_active && (!c.end_date || c.end_date >= today);
  return (
    <div className="bg-[#0F0F0F] border border-white/5 rounded-xl overflow-hidden">
      <div className="aspect-[9/16] bg-black flex items-center justify-center relative">
        {c.media_type === 'video' && c.media_url ? (
          <video
            key={c.media_url}
            src={c.media_url}
            className="w-full h-full object-cover bg-black"
            muted
            loop
            autoPlay
            playsInline
            controls
            preload="metadata"
          />
        ) : c.media_url ? (
          <img src={c.media_url} alt={c.brand_name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-white/20 text-xs">Sin media</span>
        )}
        <span className="absolute top-2 left-2 text-[9px] font-bold tracking-wider bg-black/70 text-white border border-white/20 px-1.5 py-0.5 rounded">
          📺 CAMPAÑA
        </span>
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
          <button onClick={() => onEdit(c)} className="flex-1 text-[11px] text-white/70 bg-white/5 hover:bg-white/10 rounded-md py-1.5">
            Editar
          </button>
          <button onClick={() => onDelete(c)} className="flex-1 text-[11px] text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-md py-1.5">
            Eliminar
          </button>
        </div>
      </div>
    </div>
  );
}
