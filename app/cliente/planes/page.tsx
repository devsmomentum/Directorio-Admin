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

  const [pendingTxCount, setPendingTxCount] = useState(0);
  const [nextFreeByPlan, setNextFreeByPlan] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!store) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [plansRes, reqRes, storesRes, txRes] = await Promise.all([
        supabase.from('plans').select('*').eq('is_active', true).order('display_order', { ascending: true }),
        supabase.from('plan_requests').select('plan_key, status, effective_date').eq('store_id', store.id),
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
        .eq('status', 'pending');
      if (cancelled) return;
      const m: Record<string, number> = {};
      for (const r of (data || [])) m[r.plan_key] = (m[r.plan_key] || 0) + 1;
      setPendingByPlanGlobal(m);
    })();
    return () => { cancelled = true; };
  }, [store, requests.length]);

  const hasPendingRequest = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    return requests.some(r => r.status === 'pending')
      || requests.some(r => r.status === 'approved' && r.effective_date && r.effective_date > today)
      || pendingTxCount > 0;
  }, [requests, pendingTxCount]);

  // Fecha en que entrará en vigor un cambio (si aplica).
  const effectiveDate = useMemo<string | null>(() => {
    if (!store?.plan_type) return null; // sin plan → activa hoy
    const exp = store.contract_expiry_date;
    if (!exp) return null; // bloqueado: admin debe configurar vencimiento
    const today = new Date().toISOString().split('T')[0];
    if (exp < today) return today;
    const d = new Date(exp + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }, [store]);

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

      {store.plan_type && (
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <p className="text-emerald-300 text-sm font-semibold">
            Plan actual de {store.name}: <span className="font-bold">{store.plan_type}</span>
          </p>
          <p className="text-white/50 text-xs mt-1">
            Si quieres cambiar o renovar, solicita el plan deseado y reporta el pago correspondiente.
          </p>
        </div>
      )}

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
            const isCurrent = store.plan_type === p.plan_key;
            const isChange  = !!store.plan_type && !isCurrent;
            const noExpiry  = isChange && !store.contract_expiry_date;
            const avail = planAvailability(p);
            const disabled = isCurrent || hasPendingRequest || avail.full || noExpiry;
            return (
              <div key={p.id} className={`bg-gradient-to-br ${colors} border rounded-2xl p-5 flex flex-col`}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-bold text-white">{p.name}</h3>
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
                    isCurrent
                      ? 'bg-emerald-500/10 text-emerald-400 cursor-default'
                      : hasPendingRequest
                      ? 'bg-amber-500/10 text-amber-400 cursor-default'
                      : avail.full
                      ? 'bg-red-500/10 text-red-400 cursor-not-allowed'
                      : noExpiry
                      ? 'bg-white/5 text-white/40 cursor-not-allowed'
                      : isChange
                      ? 'bg-blue-500/15 text-blue-200 hover:bg-blue-500/25 border border-blue-500/30'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  } disabled:opacity-60`}
                >
                  {isCurrent
                    ? 'Plan actual'
                    : hasPendingRequest
                    ? 'Solicitud pendiente'
                    : avail.full
                    ? 'Sin cupo'
                    : noExpiry
                    ? 'Sin fecha de venc.'
                    : isChange
                    ? 'Solicitar cambio'
                    : 'Solicitar plan'}
                </button>
                {isChange && !disabled && effectiveDate && (
                  <p className="text-[10px] text-white/40 mt-1.5 text-center">
                    Cambio activo el <span className="text-blue-300 font-mono">{effectiveDate}</span>
                  </p>
                )}
                {noExpiry && (
                  <p className="text-[10px] text-amber-300/80 mt-1.5 text-center">
                    Tu plan actual no tiene fecha de venc. — contacta a la admin.
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
                <div>
                  <p className="text-[11px] text-white/60 uppercase tracking-widest mb-1">
                    {store.plan_type ? `Cambiar de ${store.plan_type} a` : 'Solicitar plan'}
                  </p>
                  <h3 className="text-2xl font-bold text-white">{widgetPlan.name}</h3>
                  <p className="text-[11px] text-white/50 font-mono mt-1">{widgetPlan.plan_key}</p>
                  {store.plan_type && effectiveDate && (
                    <p className="text-[11px] text-white/70 mt-2">
                      Tu plan actual vence el{' '}
                      <span className="font-mono text-amber-200">{store.contract_expiry_date || '—'}</span>.
                      El cambio se activará el{' '}
                      <span className="font-mono text-cyan-200">{effectiveDate}</span>.
                    </p>
                  )}
                </div>
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
