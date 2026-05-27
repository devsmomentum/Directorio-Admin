'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';
import {
  PaymentFields,
  PaymentState,
  emptyPaymentState,
  buildPaymentPayload,
} from '../payment-fields';

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'from-cyan-500/20 to-blue-500/10 border-cyan-500/30 text-cyan-300',
  ORO: 'from-amber-500/20 to-orange-500/10 border-amber-500/30 text-amber-300',
  IA_PERFORMANCE: 'from-purple-500/20 to-pink-500/10 border-purple-500/30 text-purple-300',
  PUBLI_PROMO_DIARIO: 'from-blue-500/20 to-cyan-500/10 border-blue-500/30 text-blue-300',
  PUBLI_PROMO_SEMANAL: 'from-blue-500/20 to-cyan-500/10 border-blue-500/30 text-blue-300',
  FLASH_COUPON_DIARIO: 'from-pink-500/20 to-rose-500/10 border-pink-500/30 text-pink-300',
  FLASH_COUPON_SEMANAL: 'from-pink-500/20 to-rose-500/10 border-pink-500/30 text-pink-300',
};

// Helper: el plan_key corresponde a addon Flash Coupon, no a plan base.
const isFlashPlan = (key: string) =>
  key === 'FLASH_COUPON_DIARIO' || key === 'FLASH_COUPON_SEMANAL';

export default function ClientePlanesPage() {
  const { selectedStore: store } = useClienteStore();
  const [plans, setPlans] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [storeCounts, setStoreCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const [widgetPlan, setWidgetPlan] = useState<any | null>(null);
  const [months, setMonths] = useState(1);
  const [payment, setPayment] = useState<PaymentState>(emptyPaymentState());
  const [submitting, setSubmitting] = useState(false);
  const [widgetErr, setWidgetErr] = useState<string | null>(null);

  // Widget de abono a una solicitud existente con saldo pendiente
  const [abonoRequest, setAbonoRequest] = useState<any | null>(null);
  const [abonoPayment, setAbonoPayment] = useState<PaymentState>(emptyPaymentState());
  const [abonoSubmitting, setAbonoSubmitting] = useState(false);
  const [abonoErr, setAbonoErr] = useState<string | null>(null);

  const [pendingTxCount, setPendingTxCount] = useState(0);
  const [nextFreeByPlan, setNextFreeByPlan] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!store) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [plansRes, reqRes, storesRes, txRes] = await Promise.all([
        supabase.from('plans').select('*').eq('is_active', true).order('display_order', { ascending: true }),
        supabase.from('plan_requests')
          .select('id, plan_key, status, effective_date, total_amount_usd, paid_amount_usd, months_requested, created_at')
          .eq('store_id', store.id)
          .order('created_at', { ascending: false }),
        supabase.from('stores').select('plan_type, contract_expiry_date'),
        supabase.from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('store_id', store.id)
          .eq('transaction_type', 'plan_payment')
          .eq('status', 'pending'),
      ]);
      if (cancelled) return;
      setPlans(plansRes.data || []);
      setRequests(reqRes.data || []);
      setPendingTxCount(txRes.count ?? 0);

      const counts: Record<string, number> = {};
      const nextFreeByPlan: Record<string, string> = {};
      const todayIso = new Date().toISOString().split('T')[0];
      for (const s of (storesRes.data || [])) {
        if (!s.plan_type) continue;
        counts[s.plan_type] = (counts[s.plan_type] || 0) + 1;
        // Próximo vencimiento por plan (solo expiry futura)
        if (s.contract_expiry_date && s.contract_expiry_date >= todayIso) {
          const prev = nextFreeByPlan[s.plan_type];
          if (!prev || s.contract_expiry_date < prev) {
            nextFreeByPlan[s.plan_type] = s.contract_expiry_date;
          }
        }
      }
      setStoreCounts(counts);
      setNextFreeByPlan(nextFreeByPlan);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [store]);

  const [pendingByPlanGlobal, setPendingByPlanGlobal] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('plan_requests')
        .select('plan_key')
        .in('status', ['pending','partial']);
      if (cancelled) return;
      const m: Record<string, number> = {};
      for (const r of (data || [])) m[r.plan_key] = (m[r.plan_key] || 0) + 1;
      setPendingByPlanGlobal(m);
    })();
    return () => { cancelled = true; };
  }, [store, requests.length]);

  // Hay pendientes en este track (base/flash). El addon Flash Coupon vive en
  // paralelo al plan base: una solicitud pendiente de Oro NO debe bloquear que
  // el cliente solicite también un addon Flash Coupon (y viceversa).
  const hasPendingFor = (planKey: string): boolean => {
    const today = new Date().toISOString().split('T')[0];
    const wantFlash = isFlashPlan(planKey);
    if (requests.some(r =>
      isFlashPlan(r.plan_key) === wantFlash
      && (r.status === 'pending' || r.status === 'partial'
          || (r.status === 'approved' && r.effective_date && r.effective_date > today)))) {
      return true;
    }
    return false;
  };

  // Solicitudes con saldo abierto (para mostrar banner de abono)
  const openRequests = useMemo(
    () => requests.filter((r: any) => r.status === 'pending' || r.status === 'partial'),
    [requests]
  );

  // Fecha efectiva de la nueva activación, en función del track.
  const effectiveDateFor = (planKey: string): string | null => {
    if (!store) return null;
    const flash = isFlashPlan(planKey);
    const currentKey = flash ? store.flash_coupon_plan : store.plan_type;
    const currentExp = flash ? store.flash_coupon_expiry_date : store.contract_expiry_date;
    if (!currentKey) return null;
    if (!currentExp) return null; // bloqueado: admin debe configurar vencimiento
    const today = new Date().toISOString().split('T')[0];
    if (currentExp < today) return today;
    const d = new Date(currentExp + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  };

  const planAvailability = (p: any): { used: number; total: number | null; full: boolean } => {
    if (p.max_brands == null) return { used: 0, total: null, full: false };
    const used = (storeCounts[p.plan_key] || 0) + (pendingByPlanGlobal[p.plan_key] || 0);
    return { used, total: p.max_brands, full: used >= p.max_brands };
  };

  const openWidget = (plan: any) => {
    setWidgetPlan(plan);
    setMonths(1);
    setPayment(emptyPaymentState());
    setWidgetErr(null);
  };
  const closeWidget = () => {
    if (submitting) return;
    setWidgetPlan(null);
  };

  const totalUsd = useMemo(() => {
    if (!widgetPlan?.price_usd) return 0;
    return Number(widgetPlan.price_usd) * months;
  }, [widgetPlan, months]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store || !widgetPlan) return;
    setWidgetErr(null);

    const built = buildPaymentPayload(payment, totalUsd);
    if (built.error || !built.payload) {
      setWidgetErr(built.error || 'Datos de pago incompletos.');
      return;
    }
    const p = built.payload;
    const reported = Number(p.amountUsd ?? totalUsd);
    if (reported > totalUsd + 0.005) {
      setWidgetErr(`El monto reportado (${reported.toFixed(2)} USD) supera el costo total del plan (${totalUsd.toFixed(2)} USD).`);
      return;
    }

    setSubmitting(true);
    const { data, error } = await supabase.rpc('request_plan_atomic', {
      p_store_id:          store.id,
      p_plan_key:          widgetPlan.plan_key,
      p_months:            months,
      p_payment_method:    p.method,
      p_payment_reference: p.reference,
      p_payment_bank:      p.bank,
      p_amount_bs:         p.amountBs,
      p_amount_usd:        p.amountUsd ?? totalUsd,
      p_bcv_rate:          p.bcvRate,
      p_notes:             `Solicitud ${widgetPlan.name} · ${store.name} · ${months} ciclo(s)`,
    });
    setSubmitting(false);

    if (error) {
      setWidgetErr(error.message);
      return;
    }

    setFeedback({
      type: 'ok',
      msg: `Solicitud enviada para ${widgetPlan.name}. La administración validará tu pago y activará el plan. Mira el detalle en "Mis Pagos".`,
    });
    if (data) setRequests(r => [data as any, ...r]);
    setWidgetPlan(null);
  };

  const handleAbonoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!abonoRequest) return;
    setAbonoErr(null);
    const built = buildPaymentPayload(abonoPayment);
    if (built.error || !built.payload) {
      setAbonoErr(built.error || 'Datos de pago incompletos.');
      return;
    }
    const p = built.payload;
    const outstanding = Math.max(
      Number(abonoRequest.total_amount_usd ?? 0) - Number(abonoRequest.paid_amount_usd ?? 0),
      0,
    );
    const reported = Number(p.amountUsd ?? 0);
    if (reported <= 0) {
      setAbonoErr('Indica el monto en USD.');
      return;
    }
    if (reported > outstanding + 0.005) {
      setAbonoErr(`El abono (${reported.toFixed(2)} USD) supera el saldo pendiente (${outstanding.toFixed(2)} USD).`);
      return;
    }
    setAbonoSubmitting(true);
    const { error } = await supabase.rpc('report_additional_payment_atomic', {
      p_request_id:        abonoRequest.id,
      p_payment_method:    p.method,
      p_payment_reference: p.reference,
      p_payment_bank:      p.bank,
      p_amount_bs:         p.amountBs,
      p_amount_usd:        p.amountUsd ?? 0,
      p_bcv_rate:          p.bcvRate,
      p_notes:             `Abono a solicitud ${abonoRequest.plan_key}`,
    });
    setAbonoSubmitting(false);
    if (error) { setAbonoErr(error.message); return; }
    setFeedback({ type: 'ok', msg: 'Abono reportado. Será verificado por la administración.' });
    setAbonoRequest(null);
    setAbonoPayment(emptyPaymentState());
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver y solicitar planes.
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
      <div>
        <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
          Catálogo · {store.name}
        </p>
        <h2 className="text-2xl font-bold text-white">Planes Publicitarios</h2>
        <p className="text-white/50 text-sm mt-2">
          Elige el plan y reporta tu pago (transferencia Bs/USD o efectivo). La administración
          validará tu pago y activará el plan. El detalle de cada solicitud y pago vive en{' '}
          <a href="/cliente/pagos" className="text-cyan-300 underline hover:text-cyan-200">Mis Pagos</a>.
        </p>
      </div>

      {(store.plan_type || store.flash_coupon_plan) && (
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 space-y-1">
          {store.plan_type && (
            <p className="text-emerald-300 text-sm font-semibold">
              Plan base de {store.name}: <span className="font-bold">{store.plan_type}</span>
              {store.contract_expiry_date && (
                <span className="text-white/50 text-xs font-normal"> · vence {store.contract_expiry_date}</span>
              )}
            </p>
          )}
          {store.flash_coupon_plan && (
            <p className="text-pink-300 text-sm font-semibold">
              Plan Cupones Flash: <span className="font-bold">{store.flash_coupon_plan}</span>
              {store.flash_coupon_expiry_date && (
                <span className="text-white/50 text-xs font-normal"> · vence {store.flash_coupon_expiry_date}</span>
              )}
            </p>
          )}
          <p className="text-white/50 text-xs">
            Para cambiar o renovar, solicita el plan/addon deseado y reporta el pago correspondiente.
          </p>
        </div>
      )}

      {openRequests.length > 0 && (
        <div className="space-y-2">
          {openRequests.map((r: any) => {
            const total = Number(r.total_amount_usd ?? 0);
            const paid  = Number(r.paid_amount_usd ?? 0);
            const outstanding = Math.max(total - paid, 0);
            return (
              <div key={r.id} className="bg-amber-500/[0.06] border border-amber-500/25 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-amber-200 text-sm font-semibold">
                      Solicitud en curso · {r.plan_key}
                      <span className="ml-2 text-[10px] font-mono uppercase bg-amber-500/15 text-amber-300 px-1.5 py-0.5 rounded">
                        {r.status === 'partial' ? 'PARCIAL' : 'EN REVISIÓN'}
                      </span>
                    </p>
                    <p className="text-white/60 text-xs mt-1">
                      Pagado <span className="font-mono text-emerald-300">${paid.toFixed(2)}</span> de{' '}
                      <span className="font-mono text-white">${total.toFixed(2)}</span> · saldo{' '}
                      <span className="font-mono text-amber-300 font-bold">${outstanding.toFixed(2)}</span>
                    </p>
                    <p className="text-white/40 text-[11px] mt-0.5">
                      El plan se activa cuando el saldo llegue a $0.00.
                    </p>
                  </div>
                  {outstanding > 0 && (
                    <button
                      onClick={() => { setAbonoRequest(r); setAbonoPayment(emptyPaymentState()); setAbonoErr(null); }}
                      className="shrink-0 text-sm font-semibold bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-100 rounded-lg px-4 py-2"
                    >
                      Reportar abono
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {abonoRequest && (() => {
        const total = Number(abonoRequest.total_amount_usd ?? 0);
        const paid  = Number(abonoRequest.paid_amount_usd ?? 0);
        const outstanding = Math.max(total - paid, 0);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => { if (!abonoSubmitting) setAbonoRequest(null); }} />
            <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
              <div className="bg-gradient-to-br from-amber-500/15 to-orange-500/5 px-6 py-5 border-b border-white/10">
                <p className="text-[11px] text-white/60 uppercase tracking-widest mb-1">
                  Abono a solicitud
                </p>
                <h3 className="text-xl font-bold text-white">{abonoRequest.plan_key}</h3>
                <div className="grid grid-cols-3 gap-3 mt-4 text-center">
                  <div className="bg-white/[0.04] rounded-lg p-2">
                    <p className="text-[9px] text-white/40 uppercase">Total</p>
                    <p className="text-white font-mono text-sm font-bold">${total.toFixed(2)}</p>
                  </div>
                  <div className="bg-white/[0.04] rounded-lg p-2">
                    <p className="text-[9px] text-white/40 uppercase">Pagado</p>
                    <p className="text-emerald-300 font-mono text-sm font-bold">${paid.toFixed(2)}</p>
                  </div>
                  <div className="bg-amber-500/10 rounded-lg p-2">
                    <p className="text-[9px] text-amber-300/70 uppercase">Saldo</p>
                    <p className="text-amber-300 font-mono text-sm font-bold">${outstanding.toFixed(2)}</p>
                  </div>
                </div>
              </div>
              <form onSubmit={handleAbonoSubmit} className="px-6 py-5 space-y-4">
                <PaymentFields value={abonoPayment} onChange={setAbonoPayment} />
                {abonoErr && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg p-2.5 text-xs">
                    {abonoErr}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button" onClick={() => setAbonoRequest(null)} disabled={abonoSubmitting}
                    className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit" disabled={abonoSubmitting}
                    className="flex-1 px-4 py-2.5 text-sm font-semibold bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-100 rounded-lg disabled:opacity-50"
                  >
                    {abonoSubmitting ? 'Enviando…' : 'Reportar abono'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {feedback && (
        <div className={`rounded-lg p-3 text-sm border ${
          feedback.type === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {feedback.msg}
        </div>
      )}

      {plans.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">No hay planes disponibles en este momento.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map(p => {
            const colors = PLAN_COLORS[p.plan_key] || 'from-white/5 to-white/0 border-white/10 text-white/70';
            const flash = isFlashPlan(p.plan_key);
            const currentKey = flash ? store.flash_coupon_plan : store.plan_type;
            const currentExp = flash ? store.flash_coupon_expiry_date : store.contract_expiry_date;
            const today = new Date().toISOString().split('T')[0];
            const isCurrent = currentKey === p.plan_key && (!currentExp || currentExp >= today);
            const isChange  = !!currentKey && !isCurrent;
            const noExpiry  = (isChange || isCurrent) && !currentExp;
            const pendingThisTrack = hasPendingFor(p.plan_key);
            const avail = planAvailability(p);
            // El cliente ya tiene un slot en este plan, así que la disponibilidad
            // global no debe bloquear su renovación.
            const disabled = pendingThisTrack || (!isCurrent && avail.full) || noExpiry;
            const effDate = effectiveDateFor(p.plan_key);
            return (
              <div key={p.id} className={`bg-gradient-to-br ${colors} border rounded-2xl p-5 flex flex-col`}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-bold text-white">{p.name}</h3>
                      {flash && (
                        <span className="text-[9px] font-bold tracking-wider bg-pink-500/20 text-pink-200 border border-pink-500/40 px-1.5 py-0.5 rounded-md">
                          ADDON
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-white/50 font-mono uppercase tracking-wider mt-0.5">
                      {p.plan_key}
                    </p>
                  </div>
                  {isCurrent && (
                    <span className="text-[10px] text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md font-semibold">
                      ACTUAL
                    </span>
                  )}
                </div>
                {flash && (
                  <p className="text-[10px] text-pink-200/80 bg-pink-500/5 border border-pink-500/15 rounded-md px-2 py-1.5 mb-3">
                    Se contrata sobre tu plan base. No reemplaza Diamante / Oro / IA Performance / Publi Promo.
                  </p>
                )}

                {p.description && (
                  <p className="text-white/60 text-xs mb-4 leading-relaxed">{p.description}</p>
                )}

                <div className="space-y-1.5 mb-4">
                  {p.price_usd != null && (
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-black text-white">${Number(p.price_usd).toLocaleString('en-US')}</span>
                      <span className="text-white/40 text-xs">USD / {p.duration_days}d</span>
                    </div>
                  )}
                  <p className="text-white/40 text-xs">
                    {p.duration_days} días · {p.video_seconds}s video · prioridad {p.priority_level}
                  </p>
                  {avail.total != null && (
                    <p className={`text-[11px] font-medium ${avail.full ? 'text-red-300' : 'text-white/60'}`}>
                      Disponibilidad: {avail.used} / {avail.total} ocupados
                      {avail.full && ' · sin cupo'}
                    </p>
                  )}
                  {avail.full && nextFreeByPlan[p.plan_key] && (() => {
                    const exp = new Date(nextFreeByPlan[p.plan_key] + 'T00:00:00');
                    exp.setDate(exp.getDate() + 1);
                    const nextFree = exp.toISOString().split('T')[0];
                    return (
                      <div className="bg-amber-500/5 border border-amber-500/20 rounded-md p-2 mt-1">
                        <p className="text-[10px] text-amber-200 leading-snug">
                          <span className="font-semibold">Próximo slot estimado: </span>
                          <span className="font-mono">{nextFree}</span>
                        </p>
                        <p className="text-[9px] text-white/40 mt-0.5 leading-snug">
                          Aplica solo si la tienda que ocupa ese slot no renueva su contrato a tiempo.
                        </p>
                      </div>
                    );
                  })()}
                </div>

                {p.features?.length > 0 && (
                  <ul className="space-y-1.5 mb-5 flex-1">
                    {p.features.map((f: string, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-white/70">
                        <svg className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  onClick={() => openWidget(p)}
                  disabled={disabled}
                  className={`w-full text-sm font-semibold rounded-lg px-4 py-2.5 transition-colors ${
                    pendingThisTrack
                      ? 'bg-amber-500/10 text-amber-400 cursor-default'
                      : noExpiry
                      ? 'bg-white/5 text-white/40 cursor-not-allowed'
                      : isCurrent
                      ? 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 border border-emerald-500/30'
                      : avail.full
                      ? 'bg-red-500/10 text-red-400 cursor-not-allowed'
                      : isChange
                      ? 'bg-blue-500/15 text-blue-200 hover:bg-blue-500/25 border border-blue-500/30'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  } disabled:opacity-60`}
                >
                  {pendingThisTrack
                    ? 'Solicitud pendiente'
                    : noExpiry
                    ? 'Sin fecha de venc.'
                    : isCurrent
                    ? (flash ? 'Renovar addon' : 'Renovar plan')
                    : avail.full
                    ? 'Sin cupo'
                    : isChange
                    ? (flash ? 'Cambiar addon' : 'Solicitar cambio')
                    : (flash ? 'Adquirir addon' : 'Solicitar plan')}
                </button>
                {(isChange || isCurrent) && !disabled && effDate && (
                  <p className="text-[10px] text-white/40 mt-1.5 text-center">
                    {isCurrent ? 'Renovación activa el ' : 'Activo el '}
                    <span className={`font-mono ${isCurrent ? 'text-emerald-300' : 'text-blue-300'}`}>{effDate}</span>
                  </p>
                )}
                {noExpiry && (
                  <p className="text-[10px] text-amber-300/80 mt-1.5 text-center">
                    {flash
                      ? 'Tu addon actual no tiene fecha de venc. — contacta a la admin.'
                      : 'Tu plan actual no tiene fecha de venc. — contacta a la admin.'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {widgetPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeWidget} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className={`bg-gradient-to-br ${PLAN_COLORS[widgetPlan.plan_key] || 'from-white/5 to-white/0'} px-6 py-5 border-b border-white/10`}>
              <div className="flex items-start justify-between">
                {(() => {
                  const flashW = isFlashPlan(widgetPlan.plan_key);
                  const currentKey = flashW ? store.flash_coupon_plan : store.plan_type;
                  const currentExp = flashW ? store.flash_coupon_expiry_date : store.contract_expiry_date;
                  const effW = effectiveDateFor(widgetPlan.plan_key);
                  const isRenewal = currentKey === widgetPlan.plan_key;
                  return (
                <div>
                  <p className="text-[11px] text-white/60 uppercase tracking-widest mb-1">
                    {isRenewal
                      ? (flashW ? 'Renovar addon' : 'Renovar plan')
                      : flashW
                      ? (currentKey ? `Cambiar addon (${currentKey} → nuevo)` : 'Adquirir addon Flash Coupon')
                      : (currentKey ? `Cambiar de ${currentKey} a` : 'Solicitar plan')}
                  </p>
                  <h3 className="text-2xl font-bold text-white">{widgetPlan.name}</h3>
                  <p className="text-[11px] text-white/50 font-mono mt-1">{widgetPlan.plan_key}</p>
                  {currentKey && effW && (
                    <p className="text-[11px] text-white/70 mt-2">
                      Tu {flashW ? 'addon' : 'plan'} actual vence el{' '}
                      <span className="font-mono text-amber-200">{currentExp || '—'}</span>.
                      {isRenewal ? ' La renovación se activará el ' : ' El cambio se activará el '}
                      <span className="font-mono text-cyan-200">{effW}</span>.
                    </p>
                  )}
                </div>
                  );
                })()}
                <button
                  onClick={closeWidget} disabled={submitting}
                  className="text-white/40 hover:text-white/80 disabled:opacity-30"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="px-6 py-5 space-y-5">
              {widgetPlan.description && (
                <p className="text-white/60 text-xs leading-relaxed">{widgetPlan.description}</p>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Precio</p>
                  <p className="text-white text-base font-bold">
                    ${Number(widgetPlan.price_usd).toLocaleString('en-US')}
                    <span className="text-white/40 text-[10px] font-normal"> USD</span>
                  </p>
                  <p className="text-[10px] text-white/40 mt-0.5">cada {widgetPlan.duration_days} días</p>
                </div>
                <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Disponibilidad</p>
                  {(() => {
                    const a = planAvailability(widgetPlan);
                    if (a.total == null) {
                      return <p className="text-emerald-300 text-base font-bold">Ilimitado</p>;
                    }
                    return (
                      <p className={`text-base font-bold ${a.full ? 'text-red-300' : 'text-white'}`}>
                        {a.used}<span className="text-white/40 text-xs font-normal">/{a.total}</span>
                      </p>
                    );
                  })()}
                  <p className="text-[10px] text-white/40 mt-0.5">marcas ocupando slot</p>
                </div>
                <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Total a pagar</p>
                  <p className="text-cyan-300 text-base font-bold">
                    ${totalUsd.toFixed(2)}
                    <span className="text-white/40 text-[10px] font-normal"> USD</span>
                  </p>
                  <p className="text-[10px] text-white/40 mt-0.5">{months} ciclo(s)</p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Cantidad de ciclos a pagar
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setMonths(m => Math.max(1, m - 1))}
                      className="w-9 h-9 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 font-bold"
                    >−</button>
                    <input
                      type="number" min="1" step="1"
                      value={months}
                      onChange={(e) => setMonths(Math.max(1, parseInt(e.target.value) || 1))}
                      className="flex-1 bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white text-center focus:outline-none focus:border-cyan-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => setMonths(m => m + 1)}
                      disabled={months >= 12}
                      className="w-9 h-9 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 font-bold"
                    >+</button>
                    <span className="text-[11px] text-white/40 ml-2">
                      ×{widgetPlan.duration_days}d = {widgetPlan.duration_days * months} días
                    </span>
                  </div>
                </div>

                <PaymentFields value={payment} onChange={setPayment} expectedUsd={totalUsd} />

                {widgetErr && (
                  <div className="rounded-lg p-3 text-xs border bg-red-500/10 border-red-500/30 text-red-300">
                    {widgetErr}
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    type="button" onClick={closeWidget} disabled={submitting}
                    className="flex-1 px-4 py-2.5 text-sm text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit" disabled={submitting}
                    className="flex-1 px-5 py-2.5 text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                  >
                    {submitting ? 'Enviando...' : 'Enviar solicitud'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
