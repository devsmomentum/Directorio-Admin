'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';

const PLAN_OPTIONS = [
  { key: 'DIAMANTE', label: 'Diamante' },
  { key: 'ORO', label: 'Oro' },
  { key: 'IA_PERFORMANCE', label: 'IA Performance' },
  { key: 'PUBLI_PROMO_DIARIO', label: 'Publi Promo · Diario' },
  { key: 'PUBLI_PROMO_SEMANAL', label: 'Publi Promo · Semanal' },
  { key: 'FLASH_COUPON_DIARIO', label: 'Flash Coupon · Diario' },
  { key: 'FLASH_COUPON_SEMANAL', label: 'Flash Coupon · Semanal' },
];

const PAYMENT_METHODS = [
  { key: 'bancamiga_bs', label: 'Bancamiga · Bolívares' },
  { key: 'bancamiga_usd', label: 'Bancamiga · Dólares' },
  { key: 'binance', label: 'Binance' },
  { key: 'efectivo', label: 'Efectivo' },
  { key: 'otro', label: 'Otro' },
];

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
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('');
  const [plan, setPlan] = useState('');
  const [method, setMethod] = useState('bancamiga_bs');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const months = useMemo(monthOptions, []);

  const fetchData = async () => {
    if (!store) { setLoading(false); return; }
    setLoading(true);
    const { data } = await supabase.from('transactions')
      .select('*')
      .eq('transaction_type', 'plan_payment')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false })
      .limit(200);
    setTransactions(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [store]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    setSubmitting(true);
    setFeedback(null);

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setFeedback({ type: 'err', msg: 'Monto inválido.' });
      setSubmitting(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    const itemName = `Pago plan ${plan} · ${store.name} · ${period}`;
    const { error } = await supabase.from('transactions').insert([{
      transaction_type: 'plan_payment',
      item_name: itemName,
      amount_usd: amountNum,
      payment_method: method,
      status: 'pending',
      user_email: user?.email ?? null,
      store_id: store.id,
      period,
      notes: notes || null,
      payment_date: new Date().toISOString().split('T')[0],
    }]);

    setSubmitting(false);
    if (error) {
      setFeedback({ type: 'err', msg: 'No se pudo registrar el pago: ' + error.message });
    } else {
      setFeedback({ type: 'ok', msg: 'Pago registrado. La administración validará tu reporte y actualizará el estado.' });
      setAmount(''); setPeriod(''); setPlan(''); setMethod('bancamiga_bs'); setNotes('');
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
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Cobranzas · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Mis Pagos</h2>
          <p className="text-white/50 text-sm mt-2">
            Registra los pagos que reportas a <span className="text-emerald-300 font-medium">anavidirectorios@gmail.com</span>.
            Aquí podrás ver el historial y el estado de cada uno.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg px-4 py-2.5 hover:opacity-90 transition-opacity"
        >
          + Registrar nuevo pago
        </button>
      </div>

      <div className="bg-gradient-to-br from-amber-500/10 via-orange-500/5 to-transparent border border-amber-500/20 rounded-xl p-5">
        <p className="text-amber-300 text-sm font-bold uppercase tracking-wider mb-2">
          📧 Centro de Pagos · ANAVI Directorios
        </p>
        <p className="text-white/70 text-xs leading-relaxed">
          Recuerda enviar el comprobante a{' '}
          <span className="font-mono text-amber-300">anavidirectorios@gmail.com</span> con el asunto{' '}
          <span className="font-mono text-amber-300">CC MILLENNIUM + {store.name.toUpperCase()} + {store.local_number || ''}</span>.
          Indica monto, mes y plan. <Link href="/cliente/tutorial" className="underline text-amber-200 hover:text-amber-100">Ver instrucciones completas →</Link>
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

      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-3">
          Historial ({transactions.length})
        </p>
        {transactions.length === 0 ? (
          <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
            <p className="text-white/30 text-sm">Aún no has registrado pagos para esta tienda.</p>
            <p className="text-white/15 text-xs mt-1">Haz clic en "Registrar nuevo pago" cuando hayas enviado tu comprobante.</p>
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
                    <td className="px-4 py-3 text-white/80 font-mono text-xs">${Number(t.amount_usd).toFixed(2)}</td>
                    <td className="px-4 py-3 text-white/50 text-xs">
                      {PAYMENT_METHODS.find(m => m.key === t.payment_method)?.label || t.payment_method || '—'}
                    </td>
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
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowForm(false)} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-lg shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-semibold text-white">Registrar pago</h3>
                <p className="text-[11px] text-white/40 mt-0.5">Tienda: {store.name}</p>
              </div>
              <button onClick={() => setShowForm(false)} className="text-white/30 hover:text-white/60">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Monto (USD)</label>
                <input
                  type="number" step="0.01" min="0" required
                  value={amount} onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                  placeholder="120.00"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Mes correspondiente</label>
                  <select
                    required value={period} onChange={(e) => setPeriod(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                  >
                    <option value="">Seleccionar...</option>
                    {months.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Plan contratado</label>
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
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Método de pago</label>
                <select
                  required value={method} onChange={(e) => setMethod(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                >
                  {PAYMENT_METHODS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Referencia / Notas (opcional)
                </label>
                <textarea
                  value={notes} onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 resize-none"
                  placeholder="Nro de referencia bancaria, hora del depósito, etc."
                />
              </div>

              <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 text-[11px] text-amber-200/80">
                Recuerda enviar el comprobante por correo a <span className="font-mono">anavidirectorios@gmail.com</span> con el asunto correcto.
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button" onClick={() => setShowForm(false)}
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
