'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';
import {
  PaymentFields,
  PaymentState,
  emptyPaymentState,
  buildPaymentPayload,
  methodLabel,
} from '../payment-fields';

const PLAN_OPTIONS = [
  { key: 'DIAMANTE', label: 'Diamante' },
  { key: 'ORO', label: 'Oro' },
  { key: 'IA_PERFORMANCE', label: 'IA Performance' },
  { key: 'PUBLI_PROMO_DIARIO', label: 'Publi Promo · Diario' },
  { key: 'PUBLI_PROMO_SEMANAL', label: 'Publi Promo · Semanal' },
  { key: 'FLASH_COUPON_DIARIO', label: 'Flash Coupon · Diario' },
  { key: 'FLASH_COUPON_SEMANAL', label: 'Flash Coupon · Semanal' },
];

const PLAN_LABELS: Record<string, string> = Object.fromEntries(
  PLAN_OPTIONS.map(p => [p.key, p.label])
);

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10',
  ORO: 'text-amber-400 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-400 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-400 bg-blue-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-400 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-400 bg-pink-500/10',
};

function monthOptions(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = -3; i < 10; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    out.push(`${d.toLocaleString('es-VE', { month: 'long' })} ${d.getFullYear()}`);
  }
  return out.map(m => m.charAt(0).toUpperCase() + m.slice(1));
}

export default function ClientePagosPage() {
  const { selectedStore: store } = useClienteStore();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const [period, setPeriod] = useState('');
  const [plan, setPlan] = useState('');
  const [months, setMonths] = useState(1);
  const [payment, setPayment] = useState<PaymentState>(emptyPaymentState());
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const monthsCatalog = useMemo(monthOptions, []);
  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const fetchData = async () => {
    if (!store) { setLoading(false); return; }
    setLoading(true);
    const [txRes, reqRes] = await Promise.all([
      supabase.from('transactions')
        .select('*')
        .eq('transaction_type', 'plan_payment')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('plan_requests')
        .select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false }),
    ]);
    setTransactions(txRes.data || []);
    setRequests(reqRes.data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [store]);

  const openForm = () => {
    setPeriod(''); setPlan(''); setMonths(1);
    setPayment(emptyPaymentState()); setNotes('');
    setFormErr(null); setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    setFormErr(null);

    const built = buildPaymentPayload(payment);
    if (built.error || !built.payload) {
      setFormErr(built.error || 'Datos de pago incompletos.');
      return;
    }
    const p = built.payload;
    const amountUsd = p.amountUsd ?? 0;
    if (amountUsd <= 0 && (p.amountBs ?? 0) <= 0) {
      setFormErr('Indica el monto pagado.');
      return;
    }

    setSubmitting(true);
    const { data: { user } } = await supabase.auth.getUser();
    const itemName = `Pago plan ${plan} · ${store.name} · ${period} · ${months} ciclo(s)`;
    const notesParts = [
      p.reference ? `Ref: ${p.reference}` : null,
      p.bank ? `Banco/Plataforma: ${p.bank}` : null,
      p.amountBs != null ? `Bs ${p.amountBs.toLocaleString('es-VE')}` : null,
      p.bcvRate != null ? `BCV ${p.bcvRate}` : null,
      `Ciclos: ${months}`,
      notes,
    ].filter(Boolean).join(' · ');

    const { error } = await supabase.from('transactions').insert([{
      transaction_type: 'plan_payment',
      item_name: itemName,
      amount_usd: amountUsd,
      amount_bs: p.amountBs,
      exchange_rate: p.bcvRate,
      payment_method: p.method,
      status: 'pending',
      user_email: user?.email ?? null,
      store_id: store.id,
      period,
      notes: notesParts || null,
      payment_date: new Date().toISOString().split('T')[0],
    }]);

    setSubmitting(false);
    if (error) {
      setFormErr('No se pudo registrar el pago: ' + error.message);
    } else {
      setFeedback({ type: 'ok', msg: 'Pago registrado. La administración validará tu reporte.' });
      setShowForm(false);
      fetchData();
    }
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver y registrar pagos.
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
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Cobranzas · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Mis Pagos</h2>
          <p className="text-white/50 text-sm mt-2">
            Solicitudes de plan (pago inicial) y pagos de renovación. Reporta en transferencia Bs,
            transferencia USD o efectivo.
          </p>
        </div>
        <button
          onClick={openForm}
          className="text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg px-4 py-2.5 hover:opacity-90 transition-opacity"
        >
          + Registrar pago / renovación
        </button>
      </div>

      <div className="bg-gradient-to-br from-amber-500/10 via-orange-500/5 to-transparent border border-amber-500/20 rounded-xl p-5">
        <p className="text-amber-300 text-sm font-bold uppercase tracking-wider mb-2">
          📧 Centro de Pagos · ANAVI Directorios
        </p>
        <p className="text-white/70 text-xs leading-relaxed">
          Para pagos en bolívares, recuerda que la tasa debe ser la <strong>BCV del día</strong>.
          Para constancia adicional, envía el comprobante a{' '}
          <span className="font-mono text-amber-300">anavidirectorios@gmail.com</span> con el asunto{' '}
          <span className="font-mono text-amber-300">CC MILLENNIUM + {store.name.toUpperCase()} + {store.local_number || ''}</span>.{' '}
          <Link href="/cliente/tutorial" className="underline text-amber-200 hover:text-amber-100">
            Ver instrucciones completas →
          </Link>
        </p>
      </div>

      {feedback && (
        <div className={`rounded-lg p-3 text-sm border ${
          feedback.type === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {feedback.msg}
        </div>
      )}

      {/* ──────────── Solicitudes (cuentas virtuales) ──────────── */}
      <div>
        <div className="flex items-end justify-between mb-3">
          <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
            Solicitudes de plan ({requests.length})
          </p>
          <Link href="/cliente/planes" className="text-[11px] text-cyan-300 hover:text-cyan-200">
            Solicitar plan →
          </Link>
        </div>

        {requests.length === 0 ? (
          <div className="bg-[#111] border border-white/5 rounded-xl p-8 text-center">
            <p className="text-white/30 text-sm">
              Aún no has solicitado ningún plan.{' '}
              <Link href="/cliente/planes" className="text-cyan-300 hover:underline">
                Mira el catálogo
              </Link>{' '}
              para comenzar.
            </p>
          </div>
        ) : (
          <div className="bg-[#111] border border-white/5 rounded-xl overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                  <th className="px-3 py-2.5 font-medium">Plan</th>
                  <th className="px-3 py-2.5 font-medium">Estado</th>
                  <th className="px-3 py-2.5 font-medium">Método</th>
                  <th className="px-3 py-2.5 font-medium text-right">USD</th>
                  <th className="px-3 py-2.5 font-medium text-right">Bs</th>
                  <th className="px-3 py-2.5 font-medium">Banco</th>
                  <th className="px-3 py-2.5 font-medium">Ref</th>
                  <th className="px-3 py-2.5 font-medium">Activa</th>
                  <th className="px-3 py-2.5 font-medium">Vence</th>
                  <th className="px-3 py-2.5 font-medium">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => {
                  const planLabel = PLAN_LABELS[r.plan_key] || r.plan_key;
                  const planClr = PLAN_COLORS[r.plan_key] || 'text-white/40 bg-white/5';
                  const statusUi =
                    r.status === 'approved' ? { txt: 'APROBADA', cls: 'text-emerald-400 bg-emerald-500/10' }
                    : r.status === 'rejected' ? { txt: 'RECHAZADA', cls: 'text-red-400 bg-red-500/10' }
                    : { txt: 'REVISIÓN', cls: 'text-amber-400 bg-amber-500/10' };
                  const expired = r.expires_at && r.expires_at < today;
                  return (
                    <tr key={r.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${planClr}`}>
                          {planLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${statusUi.cls}`}>
                          {statusUi.txt}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-white/60">{methodLabel(r.payment_method)}</td>
                      <td className="px-3 py-2 text-white/80 font-mono text-right">
                        {r.amount_usd != null ? `$${Number(r.amount_usd).toFixed(2)}` : '·'}
                      </td>
                      <td className="px-3 py-2 text-white/60 font-mono text-right">
                        {r.amount_bs != null ? Number(r.amount_bs).toLocaleString('es-VE') : '·'}
                      </td>
                      <td className="px-3 py-2 text-white/60">{r.payment_bank || '·'}</td>
                      <td className="px-3 py-2 text-white/60 font-mono">
                        {r.payment_reference
                          ? (r.payment_reference.length > 12
                              ? `…${r.payment_reference.slice(-8)}`
                              : r.payment_reference)
                          : '·'}
                      </td>
                      <td className="px-3 py-2 text-white/50 font-mono">{r.effective_date || '·'}</td>
                      <td className={`px-3 py-2 font-mono ${
                        expired ? 'text-red-400 font-semibold'
                        : r.expires_at ? 'text-amber-300 font-semibold'
                        : 'text-white/30'
                      }`}>
                        {r.expires_at || '·'}
                      </td>
                      <td className="px-3 py-2 text-white/40">
                        {new Date(r.created_at).toLocaleDateString('es-VE')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ──────────── Historial de pagos ──────────── */}
      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-3">
          Historial de pagos ({transactions.length})
        </p>
        {transactions.length === 0 ? (
          <div className="bg-[#111] border border-white/5 rounded-xl p-8 text-center">
            <p className="text-white/30 text-sm">Aún no has registrado pagos de renovación.</p>
            <p className="text-white/15 text-xs mt-1">Cuando renueves tu plan, repórtalo aquí.</p>
          </div>
        ) : (
          <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                  <th className="px-4 py-3 font-medium">Concepto</th>
                  <th className="px-4 py-3 font-medium">Mes</th>
                  <th className="px-4 py-3 font-medium">Monto</th>
                  <th className="px-4 py-3 font-medium">Método</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Reportado</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(t => (
                  <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-white/80 text-xs">{t.item_name}</td>
                    <td className="px-4 py-3 text-white/50 text-xs">{t.period || '—'}</td>
                    <td className="px-4 py-3 text-white/80 font-mono text-xs">
                      ${Number(t.amount_usd).toFixed(2)}
                      {t.amount_bs != null && (
                        <span className="text-white/30 block text-[10px]">
                          Bs {Number(t.amount_bs).toLocaleString('es-VE')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-white/50 text-xs">{methodLabel(t.payment_method)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                        t.status === 'completed' || t.status === 'paid' ? 'text-emerald-400 bg-emerald-500/10'
                        : t.status === 'rejected' ? 'text-red-400 bg-red-500/10'
                        : 'text-amber-400 bg-amber-500/10'
                      }`}>
                        {(t.status || 'pending').toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/40 text-xs">
                      {new Date(t.created_at).toLocaleDateString('es-VE')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !submitting && setShowForm(false)} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-semibold text-white">Registrar pago / renovación</h3>
                <p className="text-[11px] text-white/40 mt-0.5">Tienda: {store.name}</p>
              </div>
              <button
                onClick={() => !submitting && setShowForm(false)}
                className="text-white/30 hover:text-white/60"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Mes correspondiente</label>
                  <select
                    required value={period} onChange={(e) => setPeriod(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                  >
                    <option value="">Seleccionar...</option>
                    {monthsCatalog.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan</label>
                  <select
                    required value={plan} onChange={(e) => setPlan(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                  >
                    <option value="">Seleccionar...</option>
                    {PLAN_OPTIONS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Ciclos / meses a pagar
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button" onClick={() => setMonths(m => Math.max(1, m - 1))}
                    className="w-9 h-9 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 font-bold"
                  >−</button>
                  <input
                    type="number" min="1" step="1" value={months}
                    onChange={(e) => setMonths(Math.max(1, parseInt(e.target.value) || 1))}
                    className="flex-1 bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white text-center focus:outline-none focus:border-cyan-500/50"
                  />
                  <button
                    type="button" onClick={() => setMonths(m => m + 1)} disabled={months >= 12}
                    className="w-9 h-9 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 font-bold"
                  >+</button>
                </div>
              </div>

              <PaymentFields value={payment} onChange={setPayment} />

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Notas (opcional)
                </label>
                <textarea
                  value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 resize-none"
                  placeholder="Hora del depósito, observaciones, etc."
                />
              </div>

              {formErr && (
                <div className="rounded-lg p-3 text-xs border bg-red-500/10 border-red-500/30 text-red-300">
                  {formErr}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button" onClick={() => setShowForm(false)} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit" disabled={submitting}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 border border-cyan-500/30 rounded-lg disabled:opacity-50"
                >
                  {submitting ? 'Registrando...' : 'Registrar pago'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
