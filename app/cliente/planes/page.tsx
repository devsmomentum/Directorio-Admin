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
import { AbonoModal, AbonoRequest } from '../abono-modal';

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
  const [abonoRequest, setAbonoRequest] = useState<AbonoRequest | null>(null);

  const [pendingTxCount, setPendingTxCount] = useState(0);

  // ── Lista de espera ─────────────────────────────────────────────────────────
  const [waitlistPlan, setWaitlistPlan] = useState<any | null>(null);
  const [userEmail, setUserEmail] = useState('');
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistSuccess, setWaitlistSuccess] = useState(false);
  const [waitlistErr, setWaitlistErr] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? '');
    });
  }, []);

  // Intervalos anonimizados de ocupación, devueltos por plan_capacity_intervals().
  // SECURITY DEFINER en backend → vemos info de TODAS las tiendas (no solo la nuestra),
  // necesario para replicar el sweep-line del backend y evitar UI "disponible" cuando la BD rechaza.
  type CapacityInterval = { plan_key: string; start_d: string; end_d: string; source: string };
  const [capacityIntervals, setCapacityIntervals] = useState<CapacityInterval[]>([]);

  const fetchCapacity = async () => {
    const { data } = await supabase.rpc('plan_capacity_intervals');
    setCapacityIntervals((data as CapacityInterval[]) || []);
  };

  useEffect(() => {
    if (!store) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [plansRes, reqRes, capRes, txRes] = await Promise.all([
        supabase.from('plans').select('*').eq('is_active', true).order('display_order', { ascending: true }),
        supabase.from('plan_requests')
          .select('id, plan_key, status, effective_date, total_amount_usd, paid_amount_usd, months_requested, created_at')
          .eq('store_id', store.id)
          .order('created_at', { ascending: false }),
        supabase.rpc('plan_capacity_intervals'),
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
      setCapacityIntervals((capRes.data as CapacityInterval[]) || []);

      // Conteo "actual" para mostrar "X / Y ocupados": cualquier intervalo cuyo
      // start_d <= hoy y end_d >= hoy (stores activos + approved en vigor).
      const today = new Date().toISOString().split('T')[0];
      const counts: Record<string, number> = {};
      for (const iv of ((capRes.data as CapacityInterval[]) || [])) {
        if (iv.source === 'pending' || iv.source === 'partial') continue;
        if (iv.start_d <= today && iv.end_d >= today) {
          counts[iv.plan_key] = (counts[iv.plan_key] || 0) + 1;
        }
      }
      setStoreCounts(counts);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [store]);

  // Refrescar capacidad tras crear/aprobar solicitudes (cambia requests.length).
  useEffect(() => {
    if (!store) return;
    fetchCapacity();
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

  // Replica plan_max_overlap_in_window del backend usando los intervalos
  // anonimizados que devuelve la RPC plan_capacity_intervals.
  const computeMaxOverlapInWindow = (
    planKey: string,
    windowStart: string,
    windowEnd: string,
  ): number => {
    const clipped: Array<[string, string]> = [];
    for (const iv of capacityIntervals) {
      if (iv.plan_key !== planKey) continue;
      // Para 'store', el backend ancla el intervalo al inicio de la ventana
      // (el start_d que viene de la RPC es CURRENT_DATE, así que normalizamos).
      const rawStart = iv.source === 'store'
        ? (windowStart > iv.start_d ? windowStart : iv.start_d)
        : iv.start_d;
      const s = rawStart > windowStart ? rawStart : windowStart;
      const e = iv.end_d < windowEnd ? iv.end_d : windowEnd;
      if (s <= windowEnd && e >= windowStart && s <= e) {
        clipped.push([s, e]);
      }
    }
    if (clipped.length === 0) return 0;

    // Sweep-line: +1 al inicio, -1 al día siguiente del fin.
    const evts: Array<[string, number]> = [];
    for (const [s, e] of clipped) {
      evts.push([s, 1]);
      const nxt = new Date(e + 'T00:00:00');
      nxt.setDate(nxt.getDate() + 1);
      evts.push([nxt.toISOString().split('T')[0], -1]);
    }
    evts.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : b[1] - a[1]);
    let count = 0, max = 0;
    for (const [, delta] of evts) {
      count += delta;
      if (count > max) max = count;
    }
    return max;
  };

  // Primera fecha >= fromDate donde una ventana de `windowDays` días tiene cupo.
  const nearestSlotAfter = (
    planKey: string,
    maxBrands: number,
    fromDate: string,
    windowDays: number,
  ): string | null => {
    const candidates = new Set<string>();
    candidates.add(fromDate);
    // Candidatos = días siguientes al fin de cada intervalo del plan
    for (const iv of capacityIntervals) {
      if (iv.plan_key !== planKey) continue;
      if (iv.end_d < fromDate) continue;
      const d = new Date(iv.end_d + 'T00:00:00'); d.setDate(d.getDate() + 1);
      candidates.add(d.toISOString().split('T')[0]);
    }
    const sorted = [...candidates].sort();
    for (const date of sorted) {
      if (date < fromDate) continue;
      const d = new Date(date + 'T00:00:00');
      d.setDate(d.getDate() + windowDays - 1);
      const winEnd = d.toISOString().split('T')[0];
      if (computeMaxOverlapInWindow(planKey, date, winEnd) < maxBrands) return date;
    }
    return null;
  };

  const planAvailability = (p: any): { used: number; total: number | null; full: boolean } => {
    if (p.max_brands == null) return { used: 0, total: null, full: false };
    const pendingCount = capacityIntervals.filter(
      iv => iv.plan_key === p.plan_key && (iv.source === 'pending' || iv.source === 'partial')
    ).length;
    const used = (storeCounts[p.plan_key] || 0) + pendingCount;
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

  const openWaitlist = (plan: any) => {
    setWaitlistPlan(plan);
    setWaitlistSuccess(false);
    setWaitlistErr(null);
  };

  const closeWaitlist = () => {
    if (waitlistLoading) return;
    setWaitlistPlan(null);
  };

  const handleJoinWaitlist = async () => {
    if (!waitlistPlan || !userEmail) return;
    setWaitlistLoading(true);
    setWaitlistErr(null);
    const { data, error } = await supabase.rpc('join_plan_waitlist', {
      p_plan_key: waitlistPlan.plan_key,
      p_email: userEmail,
    });
    setWaitlistLoading(false);
    if (error) {
      setWaitlistErr('No se pudo registrar. Intenta de nuevo.');
      return;
    }
    const result = data as any;
    if (result?.error === 'PLAN_HAS_SLOTS') {
      setWaitlistErr('¡El plan ya tiene cupos disponibles! Puedes solicitarlo directamente.');
      return;
    }
    setWaitlistSuccess(true);
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
                      onClick={() => setAbonoRequest({
                        id: r.id,
                        plan_key: r.plan_key,
                        total_amount_usd: r.total_amount_usd,
                        paid_amount_usd: r.paid_amount_usd,
                      })}
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

      <AbonoModal
        request={abonoRequest}
        onClose={() => setAbonoRequest(null)}
        onSuccess={async (msg) => {
          setFeedback({ type: 'ok', msg });
          const { data } = await supabase.from('plan_requests')
            .select('id, plan_key, status, effective_date, total_amount_usd, paid_amount_usd, months_requested, created_at')
            .eq('store_id', store!.id)
            .order('created_at', { ascending: false });
          setRequests(data || []);
        }}
      />


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
            const isRenewal = currentKey === p.plan_key;
            const isExpiredRenewal = isRenewal && !isCurrent;
            const isChange  = !!currentKey && !isRenewal;
            const noExpiry  = (isChange || isCurrent) && !currentExp;
            const pendingThisTrack = hasPendingFor(p.plan_key);
            const avail = planAvailability(p);
            const effDate = effectiveDateFor(p.plan_key);

            // Ventana de activación: effDate … effDate + 1 ciclo - 1
            const winEnd = (effDate && p.duration_days) ? (() => {
              const d = new Date(effDate + 'T00:00:00');
              d.setDate(d.getDate() + p.duration_days - 1);
              return d.toISOString().split('T')[0];
            })() : null;

            // Ocupación máxima proyectada en la ventana de 1 ciclo, usando el mismo
            // sweep-line que el backend (stores + approved future + pending).
            const futureOccupancy = ((isChange || isExpiredRenewal) && effDate && winEnd && avail.total != null)
              ? computeMaxOverlapInWindow(p.plan_key, effDate, winEnd)
              : null;
            const futureAvailFull = futureOccupancy != null
              ? futureOccupancy >= (avail.total as number)
              : avail.full;
            const nearestSlot = (futureAvailFull && avail.total != null && effDate && p.duration_days)
              ? nearestSlotAfter(p.plan_key, avail.total, effDate, p.duration_days)
              : null;

            // El cliente ya tiene un slot en este plan, así que la disponibilidad
            // global no debe bloquear su renovación.
            const disabled = pendingThisTrack || (!isCurrent && futureAvailFull) || noExpiry;
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
                      Cupo actual: {avail.used} / {avail.total} ocupados
                    </p>
                  )}
                </div>

                {/* ── Bloque de activación + disponibilidad proyectada ── */}
                {(isChange || isExpiredRenewal) && effDate && (
                  <div className={`rounded-xl border p-3 mb-4 ${
                    futureAvailFull
                      ? 'bg-red-500/8 border-red-500/30'
                      : avail.full
                      ? 'bg-emerald-500/8 border-emerald-500/30'
                      : 'bg-blue-500/8 border-blue-500/20'
                  }`}>
                    {/* Línea de tiempo: vence → se activa */}
                    <div className="flex items-start gap-2 mb-2.5">
                      <div className="flex flex-col items-center mt-1 shrink-0">
                        <span className={`w-2 h-2 rounded-full ${futureAvailFull ? 'bg-red-400' : 'bg-emerald-400'}`} />
                        <span className="w-px flex-1 min-h-[16px] bg-white/10 mt-0.5" />
                        <span className={`w-2 h-2 rounded-full ${futureAvailFull ? 'bg-red-400/40' : 'bg-blue-400'}`} />
                      </div>
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div>
                          <p className="text-[9px] text-white/30 uppercase tracking-widest">
                            Tu {isFlashPlan(p.plan_key) ? 'addon' : 'plan'} actual vence
                          </p>
                          <p className="text-white/80 text-xs font-mono font-semibold">
                            {(isFlashPlan(p.plan_key) ? store.flash_coupon_expiry_date : store.contract_expiry_date) || '—'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] text-white/30 uppercase tracking-widest">
                            {p.name} se activaría
                          </p>
                          <p className={`text-sm font-bold font-mono ${futureAvailFull ? 'text-red-300' : 'text-blue-300'}`}>
                            {effDate}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Badge de disponibilidad en la fecha de activación */}
                    {avail.total != null && (
                      futureAvailFull ? (
                        <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-2.5">
                          <div className="flex items-center gap-1.5 mb-1">
                            <svg className="w-3.5 h-3.5 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            <p className="text-red-300 text-[11px] font-bold">Sin cupo para tu fecha de activación</p>
                          </div>
                          <p className="text-white/50 text-[10px] leading-snug">
                            En el período {effDate}–{winEnd}, el máximo simultáneo proyectado es {futureOccupancy}/{avail.total}.
                          </p>
                          {nearestSlot && (
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <svg className="w-3 h-3 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              </svg>
                              <p className="text-amber-300 text-[10px]">
                                Próximo slot estimado:{' '}
                                <span className="font-mono font-semibold">{nearestSlot}</span>
                              </p>
                            </div>
                          )}
                          {!nearestSlot && (
                            <p className="text-white/30 text-[10px] mt-1">Sin slot estimado disponible.</p>
                          )}
                        </div>
                      ) : avail.full ? (
                        <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-lg p-2.5">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            <p className="text-emerald-300 text-[11px] font-bold">Cupo disponible para tu fecha</p>
                          </div>
                          <p className="text-white/50 text-[10px]">
                            Aunque está lleno ahora, un slot se libera antes del {effDate}.
                          </p>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <p className="text-emerald-300 text-[11px] font-medium">
                            Cupo disponible el {effDate}
                            <span className="text-white/40 font-normal"> (máx {futureOccupancy}/{avail.total} en el período)</span>
                          </p>
                        </div>
                      )
                    )}
                  </div>
                )}

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
                      : futureAvailFull
                      ? 'bg-red-500/10 text-red-400 cursor-not-allowed'
                      : isExpiredRenewal
                      ? 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 border border-emerald-500/30'
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
                    : futureAvailFull
                    ? 'Sin cupo para tu fecha'
                    : isExpiredRenewal
                    ? (flash ? 'Renovar addon' : 'Renovar plan')
                    : isChange
                    ? (flash ? 'Cambiar addon' : 'Solicitar cambio')
                    : (flash ? 'Adquirir addon' : 'Solicitar plan')}
                </button>
                {(isCurrent || isExpiredRenewal) && !disabled && effDate && (
                  <p className="text-[10px] text-white/40 mt-1.5 text-center">
                    Renovación activa el{' '}
                    <span className="font-mono text-emerald-300">{effDate}</span>
                  </p>
                )}
                {noExpiry && (
                  <p className="text-[10px] text-amber-300/80 mt-1.5 text-center">
                    {flash
                      ? 'Tu addon actual no tiene fecha de venc. — contacta a la admin.'
                      : 'Tu plan actual no tiene fecha de venc. — contacta a la admin.'}
                  </p>
                )}

                {/* ── Botón de lista de espera ─────────────────────────── */}
                {futureAvailFull && !isCurrent && !pendingThisTrack && (
                  <button
                    onClick={() => openWaitlist(p)}
                    className="w-full mt-2 text-xs font-medium rounded-lg px-4 py-2 bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/25 text-amber-300 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                    Notificarme por correo cuando se libere un cupo
                  </button>
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
              {(() => {
                const flashW = isFlashPlan(widgetPlan.plan_key);
                const currentKey = flashW ? store.flash_coupon_plan : store.plan_type;
                const currentExp = flashW ? store.flash_coupon_expiry_date : store.contract_expiry_date;
                const effW = effectiveDateFor(widgetPlan.plan_key);
                const today = new Date().toISOString().split('T')[0];
                const isCurrent = currentKey === widgetPlan.plan_key && (!currentExp || currentExp >= today);
                const isRenewal = currentKey === widgetPlan.plan_key;
                const isExpiredRenewal = isRenewal && !isCurrent;
                const isChange = !!currentKey && !isRenewal;

                const wAvail = planAvailability(widgetPlan);
                // Ventana exacta del usuario: months ciclos
                const wWinEnd = (effW && widgetPlan.duration_days) ? (() => {
                  const d = new Date(effW + 'T00:00:00');
                  d.setDate(d.getDate() + months * widgetPlan.duration_days - 1);
                  return d.toISOString().split('T')[0];
                })() : null;
                const wFutureOcc = ((isChange || isExpiredRenewal) && effW && wWinEnd && wAvail.total != null)
                  ? computeMaxOverlapInWindow(widgetPlan.plan_key, effW, wWinEnd)
                  : null;
                const wFutureFull = wFutureOcc != null
                  ? wFutureOcc >= (wAvail.total as number)
                  : wAvail.full;
                const wNearestSlot = (wFutureFull && wAvail.total != null && effW && widgetPlan.duration_days)
                  ? nearestSlotAfter(widgetPlan.plan_key, wAvail.total, effW, widgetPlan.duration_days)
                  : null;

                return (
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-white/60 uppercase tracking-widest mb-1">
                        {isRenewal
                          ? (flashW ? 'Renovar addon' : 'Renovar plan')
                          : flashW
                          ? (currentKey ? 'Cambiar addon' : 'Adquirir addon Flash Coupon')
                          : (currentKey ? 'Cambiar de plan' : 'Solicitar plan')}
                      </p>
                      <h3 className="text-2xl font-bold text-white">{widgetPlan.name}</h3>
                      <p className="text-[11px] text-white/50 font-mono mt-0.5">{widgetPlan.plan_key}</p>

                      {/* Bloque de fechas prominente — solo cuando hay un plan activo */}
                      {currentKey && effW && (
                        <div className="mt-4 space-y-3">
                          {/* Línea de tiempo */}
                          <div className="flex items-stretch gap-3">
                            <div className="flex flex-col items-center shrink-0 pt-1">
                              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-amber-400/30" />
                              <span className="w-px flex-1 min-h-[20px] bg-white/15 my-1" />
                              <span className={`w-2.5 h-2.5 rounded-full ring-2 ${
                                wFutureFull
                                  ? 'bg-red-400 ring-red-400/30'
                                  : 'bg-blue-400 ring-blue-400/30'
                              }`} />
                            </div>
                            <div className="space-y-3 flex-1 min-w-0">
                              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                                <p className="text-[9px] text-amber-300/70 uppercase tracking-widest mb-0.5">
                                  Tu {flashW ? 'addon' : 'plan'} actual vence
                                </p>
                                <p className="text-amber-200 text-lg font-bold font-mono leading-none">
                                  {currentExp || '—'}
                                </p>
                                <p className="text-white/40 text-[10px] mt-0.5">{currentKey}</p>
                              </div>
                              <div className={`border rounded-lg px-3 py-2 ${
                                wFutureFull
                                  ? 'bg-red-500/10 border-red-500/25'
                                  : 'bg-blue-500/10 border-blue-500/20'
                              }`}>
                                <p className={`text-[9px] uppercase tracking-widest mb-0.5 ${
                                  wFutureFull ? 'text-red-300/70' : 'text-blue-300/70'
                                }`}>
                                  {isRenewal ? 'Renovación activa el' : `${widgetPlan.name} se activa el`}
                                </p>
                                <p className={`text-lg font-bold font-mono leading-none ${
                                  wFutureFull ? 'text-red-200' : 'text-blue-200'
                                }`}>
                                  {effW}
                                </p>
                              </div>
                            </div>
                          </div>

                          {/* Badge de disponibilidad en la fecha de activación */}
                          {wAvail.total != null && (!isRenewal || isExpiredRenewal) && (
                            wFutureFull ? (
                              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
                                <div className="flex items-start gap-2">
                                  <svg className="w-4 h-4 text-red-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                  </svg>
                                  <div>
                                    <p className="text-red-200 text-xs font-bold">Sin cupo disponible para esa fecha</p>
                                    <p className="text-white/50 text-[10px] mt-0.5">
                                      En el período {effW}–{wWinEnd}, el máximo simultáneo es {wFutureOcc}/{wAvail.total}.
                                      Tu solicitud podría quedar en cola hasta que se libere cupo.
                                    </p>
                                    {wNearestSlot && (
                                      <p className="text-amber-300 text-[10px] mt-1 font-medium">
                                        Próximo slot estimado:{' '}
                                        <span className="font-mono font-bold">{wNearestSlot}</span>
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : wAvail.full ? (
                              <div className="bg-emerald-500/8 border border-emerald-500/25 rounded-xl p-3 flex items-start gap-2">
                                <svg className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <div>
                                  <p className="text-emerald-300 text-xs font-bold">Cupo disponible para tu fecha de activación</p>
                                  <p className="text-white/50 text-[10px] mt-0.5">
                                    Aunque el plan está lleno ahora, un slot se liberará antes del {effW}.
                                  </p>
                                </div>
                              </div>
                            ) : (
                              <div className="bg-emerald-500/8 border border-emerald-500/20 rounded-xl p-3 flex items-center gap-2">
                                <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <p className="text-emerald-300 text-xs font-semibold">
                                  Cupo disponible el {effW}
                                  <span className="text-white/40 font-normal ml-1">
                                    ({wFutureOcc}/{wAvail.total} ocupados)
                                  </span>
                                </p>
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={closeWidget} disabled={submitting}
                      className="text-white/40 hover:text-white/80 disabled:opacity-30 shrink-0 mt-1"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })()}
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

      {/* ── Modal: lista de espera ───────────────────────────────────────────── */}
      {waitlistPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeWaitlist} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">

            {/* Header */}
            <div className={`bg-gradient-to-br ${PLAN_COLORS[waitlistPlan.plan_key] || 'from-white/5 to-white/0'} border-b border-white/10 px-6 py-5`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <svg className="w-4 h-4 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                    <p className="text-[11px] text-white/50 uppercase tracking-widest">Lista de espera</p>
                  </div>
                  <h3 className="text-xl font-bold text-white">{waitlistPlan.name}</h3>
                  <p className="text-[11px] text-white/40 font-mono mt-0.5">
                    {(() => {
                      const a = planAvailability(waitlistPlan);
                      return a.total != null ? `${a.used} / ${a.total} cupos ocupados` : '';
                    })()}
                  </p>
                </div>
                <button onClick={closeWaitlist} disabled={waitlistLoading} className="text-white/40 hover:text-white/80 disabled:opacity-30 mt-1 shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="px-6 py-5">
              {waitlistSuccess ? (
                /* Estado de éxito */
                <div className="text-center py-4 space-y-4">
                  <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto">
                    <svg className="w-7 h-7 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-white font-bold text-lg">¡Listo!</p>
                    <p className="text-white/60 text-sm mt-1.5 leading-relaxed">
                      Te avisaremos a{' '}
                      <span className="text-cyan-300 font-mono">{userEmail}</span>{' '}
                      en cuanto se libere un cupo en{' '}
                      <span className="font-semibold text-white">{waitlistPlan.name}</span>.
                      Date prisa cuando llegue el correo — ¡los cupos se van rápido!
                    </p>
                  </div>
                  <button
                    onClick={closeWaitlist}
                    className="w-full px-4 py-2.5 text-sm font-semibold bg-white/10 hover:bg-white/15 text-white rounded-lg transition-colors"
                  >
                    Cerrar
                  </button>
                </div>
              ) : (
                /* Confirmación */
                <div className="space-y-5">
                  <p className="text-white/60 text-sm leading-relaxed">
                    Cuando se libere un cupo en este plan recibirás un correo automático.
                    <span className="text-amber-300 font-medium"> ¡Date prisa</span> cuando llegue — los cupos se agotan rápido.
                  </p>

                  <div className="bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
                    <svg className="w-4 h-4 text-white/30 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    <div className="min-w-0">
                      <p className="text-[10px] text-white/30 uppercase tracking-wider mb-0.5">Notificación a</p>
                      <p className="text-white text-sm font-mono truncate">{userEmail || '—'}</p>
                    </div>
                  </div>

                  {waitlistErr && (
                    <div className="rounded-lg p-3 text-xs border bg-red-500/10 border-red-500/30 text-red-300">
                      {waitlistErr}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="button" onClick={closeWaitlist} disabled={waitlistLoading}
                      className="flex-1 px-4 py-2.5 text-sm text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg disabled:opacity-50 transition-colors"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleJoinWaitlist}
                      disabled={waitlistLoading || !userEmail}
                      className="flex-1 px-5 py-2.5 text-sm font-semibold bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-100 rounded-lg disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                    >
                      {waitlistLoading ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                      ) : 'Notificarme'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
