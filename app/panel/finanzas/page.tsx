'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

// ── Types ────────────────────────────────────────────────────────────────────
type Store = { id: string; name: string; plan_type: string | null };

type PlanPayment = {
  id: string;
  store_id: string | null;
  item_name: string;       // plan label: DIAMANTE, ORO…
  period: string | null;   // "Mayo 2026"
  amount_usd: number;
  payment_method: string;
  payment_date: string | null;
  status: string;
  notes: string | null;
  created_at: string;
};

type Expense = {
  id: string;
  category: string;
  description: string | null;
  amount_usd: number;
  expense_date: string;
};

// ── Constants ────────────────────────────────────────────────────────────────
const PLAN_TYPES = ['DIAMANTE', 'ORO', 'IA_PERFORMANCE', 'PROMO_FLASH'];
const PAYMENT_METHODS = ['Bancamiga Bs', 'Bancamiga USD', 'Efectivo', 'Binance', 'Otro'];
const EXPENSE_CATEGORIES = ['Abogada', 'Alcaldía', 'Seguro', 'Mantenimiento', 'Marketing', 'Personal', 'Otro'];

const MORNA_PCT = 36;
const SUNMI_PCT = 36;
const ANAVI_PCT = 16;
const MILLENNIUM_PCT = 12;

// ── Date helpers ─────────────────────────────────────────────────────────────
const iso = (d: Date) => d.toISOString().split('T')[0];
const todayStr = () => iso(new Date());
const firstOfMonth = () => { const d = new Date(); d.setDate(1); return iso(d); };
const firstOfLastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return iso(d); };
const lastOfLastMonth = () => { const d = new Date(); d.setDate(0); return iso(d); };
const threeMonthsAgo = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 3); return iso(d); };
const biMid = () => { const d = new Date(); d.setDate(15); return iso(d); };
const biSecondStart = () => { const d = new Date(); d.setDate(16); return iso(d); };
const lastOfMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); d.setDate(0); return iso(d); };
const shortMonth = () => new Date().toLocaleString('es', { month: 'short' }).replace('.', '');

const fmt = (n: number) => `$${n.toFixed(2)}`;

// ── Page ─────────────────────────────────────────────────────────────────────
export default function FinanzasPage() {
  const [activeTab, setActiveTab] = useState<'distribucion' | 'ingresos' | 'gastos' | 'reporte'>('distribucion');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [stores, setStores] = useState<Store[]>([]);
  const [payments, setPayments] = useState<PlanPayment[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);

  const [dateStart, setDateStart] = useState(firstOfMonth());
  const [dateEnd, setDateEnd] = useState(todayStr());

  // Payment modal
  const [payModal, setPayModal] = useState(false);
  const [editingPay, setEditingPay] = useState<PlanPayment | null>(null);
  const [payForm, setPayForm] = useState({
    store_id: '', item_name: PLAN_TYPES[0], period: '', amount_usd: '',
    payment_method: PAYMENT_METHODS[0], payment_date: todayStr(), status: 'completed', notes: '',
  });
  const [payError, setPayError] = useState('');
  const [deletingPayId, setDeletingPayId] = useState<string | null>(null);

  // Expense modal
  const [expModal, setExpModal] = useState(false);
  const [editingExp, setEditingExp] = useState<Expense | null>(null);
  const [expForm, setExpForm] = useState({ category: EXPENSE_CATEGORIES[0], description: '', amount_usd: '', expense_date: todayStr() });
  const [expError, setExpError] = useState('');
  const [deletingExpId, setDeletingExpId] = useState<string | null>(null);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    const [{ data: storeData }, { data: payData }, { data: expData }] = await Promise.all([
      supabase.from('stores').select('id, name, plan_type').order('name'),
      supabase
        .from('transactions')
        .select('id, store_id, item_name, period, amount_usd, payment_method, payment_date, status, notes, created_at')
        .eq('transaction_type', 'plan_payment')
        .order('payment_date', { ascending: false })
        .limit(500),
      supabase.from('operational_expenses').select('*').order('expense_date', { ascending: false }).limit(500),
    ]);
    setStores((storeData as Store[]) || []);
    setPayments((payData as PlanPayment[]) || []);
    setExpenses((expData as Expense[]) || []);
    setLoading(false);
  };

  // ── Period filter ────────────────────────────────────────────────────────────
  const periodPayments = useMemo(() =>
    payments.filter(p => {
      const d = p.payment_date || p.created_at.split('T')[0];
      return d >= dateStart && d <= dateEnd;
    }),
    [payments, dateStart, dateEnd]
  );

  const periodExpenses = useMemo(() =>
    expenses.filter(e => e.expense_date >= dateStart && e.expense_date <= dateEnd),
    [expenses, dateStart, dateEnd]
  );

  // ── Revenue distribution ──────────────────────────────────────────────────
  const dist = useMemo(() => {
    const gross = periodPayments
      .filter(p => p.status === 'completed')
      .reduce((s, p) => s + Number(p.amount_usd), 0);
    const pending = periodPayments
      .filter(p => p.status !== 'completed')
      .reduce((s, p) => s + Number(p.amount_usd), 0);
    const totalExpenses = periodExpenses.reduce((s, e) => s + Number(e.amount_usd), 0);
    const distributable = gross - totalExpenses;
    const morna = distributable * (MORNA_PCT / 100);
    const sunmi = distributable * (SUNMI_PCT / 100);
    const anavi = distributable * (ANAVI_PCT / 100);
    const millennium = distributable * (MILLENNIUM_PCT / 100);
    return { gross, pending, totalExpenses, distributable, morna, sunmi, anavi, millennium };
  }, [periodPayments, periodExpenses]);

  // ── Store helpers ──────────────────────────────────────────────────────────
  const storeById = useMemo(() => new Map(stores.map(s => [s.id, s])), [stores]);
  const storeName = (id: string | null) => (id ? storeById.get(id)?.name || '—' : '—');

  // ── Payment CRUD ───────────────────────────────────────────────────────────
  const openNewPayment = () => {
    setEditingPay(null);
    setPayForm({ store_id: stores[0]?.id || '', item_name: PLAN_TYPES[0], period: '', amount_usd: '', payment_method: PAYMENT_METHODS[0], payment_date: todayStr(), status: 'completed', notes: '' });
    setPayError('');
    setPayModal(true);
  };

  const openEditPayment = (p: PlanPayment) => {
    setEditingPay(p);
    setPayForm({ store_id: p.store_id || '', item_name: p.item_name, period: p.period || '', amount_usd: String(p.amount_usd), payment_method: p.payment_method, payment_date: p.payment_date || todayStr(), status: p.status, notes: p.notes || '' });
    setPayError('');
    setPayModal(true);
  };

  const handleSavePayment = async () => {
    const amount = parseFloat(payForm.amount_usd);
    if (!payForm.store_id) return setPayError('Selecciona una tienda.');
    if (isNaN(amount) || amount <= 0) return setPayError('Monto inválido.');
    if (!payForm.payment_date) return setPayError('La fecha de pago es requerida.');
    setSaving(true);
    const payload = {
      transaction_type: 'plan_payment',
      store_id: payForm.store_id,
      item_name: payForm.item_name,
      period: payForm.period || null,
      amount_usd: amount,
      payment_method: payForm.payment_method,
      payment_date: payForm.payment_date,
      status: payForm.status,
      notes: payForm.notes || null,
    };
    let error;
    if (editingPay) {
      ({ error } = await supabase.from('transactions').update(payload).eq('id', editingPay.id));
    } else {
      ({ error } = await supabase.from('transactions').insert(payload));
    }
    setSaving(false);
    if (error) return setPayError(error.message);
    setPayModal(false);
    fetchData();
  };

  const handleDeletePayment = async (id: string) => {
    setDeletingPayId(id);
    await supabase.from('transactions').delete().eq('id', id);
    setDeletingPayId(null);
    fetchData();
  };

  // ── Expense CRUD ───────────────────────────────────────────────────────────
  const openNewExpense = () => {
    setEditingExp(null);
    setExpForm({ category: EXPENSE_CATEGORIES[0], description: '', amount_usd: '', expense_date: todayStr() });
    setExpError('');
    setExpModal(true);
  };

  const openEditExpense = (e: Expense) => {
    setEditingExp(e);
    setExpForm({ category: e.category, description: e.description || '', amount_usd: String(e.amount_usd), expense_date: e.expense_date });
    setExpError('');
    setExpModal(true);
  };

  const handleSaveExpense = async () => {
    const amount = parseFloat(expForm.amount_usd);
    if (isNaN(amount) || amount <= 0) return setExpError('Monto inválido.');
    if (!expForm.expense_date) return setExpError('La fecha es requerida.');
    setSaving(true);
    const payload = { category: expForm.category, description: expForm.description || null, amount_usd: amount, expense_date: expForm.expense_date };
    let error;
    if (editingExp) {
      ({ error } = await supabase.from('operational_expenses').update(payload).eq('id', editingExp.id));
    } else {
      ({ error } = await supabase.from('operational_expenses').insert(payload));
    }
    setSaving(false);
    if (error) return setExpError(error.message);
    setExpModal(false);
    fetchData();
  };

  const handleDeleteExpense = async (id: string) => {
    setDeletingExpId(id);
    await supabase.from('operational_expenses').delete().eq('id', id);
    setDeletingExpId(null);
    fetchData();
  };

  // ── CSV export ─────────────────────────────────────────────────────────────
  const exportCSV = (headers: string[], rows: string[][], filename: string) => {
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleExportReport = () => {
    const rows: string[][] = [
      ['Ingresos cobrados (pagos completados)', '', fmt(dist.gross)],
      ['Pagos pendientes (no incluidos)', '', fmt(dist.pending)],
      ['− Gastos operativos registrados', fmt(dist.totalExpenses), ''],
      ['Ganancia distribuible', '', fmt(dist.distributable)],
      [`− ${MORNA_PCT}% Morna`, fmt(dist.morna), ''],
      [`− ${SUNMI_PCT}% Sunmi`, fmt(dist.sunmi), ''],
      [`− ${ANAVI_PCT}% Anavi (gestión)`, fmt(dist.anavi), ''],
      [`− ${MILLENNIUM_PCT}% Millennium`, fmt(dist.millennium), ''],
      ['', '', ''],
      ['INGRESOS DETALLADOS', '', '', '', ''],
      ['Tienda', 'Plan', 'Período', 'Monto', 'Método', 'Fecha', 'Estado', 'Notas'],
      ...periodPayments.map(p => [
        `"${storeName(p.store_id)}"`, p.item_name, `"${p.period || ''}"`,
        fmt(Number(p.amount_usd)), p.payment_method, p.payment_date || '', p.status, `"${p.notes || ''}"`,
      ]),
      ['', '', '', '', ''],
      ['GASTOS DETALLADOS', '', '', '', ''],
      ['Categoría', 'Descripción', 'Monto', 'Fecha'],
      ...periodExpenses.map(e => [`"${e.category}"`, `"${e.description || ''}"`, fmt(Number(e.amount_usd)), e.expense_date]),
    ];
    exportCSV(['Concepto', 'Débito', 'Saldo'], rows, `Reporte_${dateStart}_al_${dateEnd}.csv`);
  };

  // ── Period presets ─────────────────────────────────────────────────────────
  const presets = [
    { label: 'Este mes', s: firstOfMonth(), e: todayStr() },
    { label: 'Mes anterior', s: firstOfLastMonth(), e: lastOfLastMonth() },
    { label: `1-15 ${shortMonth()}`, s: firstOfMonth(), e: biMid() },
    { label: `16-fin ${shortMonth()}`, s: biSecondStart(), e: lastOfMonth() },
    { label: 'Últimos 3 meses', s: threeMonthsAgo(), e: todayStr() },
  ];

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
      <div>
        <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Administración</p>
        <h2 className="text-2xl font-bold text-white">Finanzas</h2>
      </div>

      {/* Period selector */}
      <div className="bg-[#111] border border-white/5 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <span className="text-xs text-white/30 uppercase tracking-wider shrink-0">Período:</span>
        <div className="flex items-center gap-2">
          <input type="date" value={dateStart} onChange={e => setDateStart(e.target.value)}
            className="text-xs bg-[#0a0a0a] border border-white/10 text-white/70 rounded-lg px-3 py-2 focus:outline-none focus:border-pink-500" />
          <span className="text-white/20 text-xs">→</span>
          <input type="date" value={dateEnd} onChange={e => setDateEnd(e.target.value)}
            className="text-xs bg-[#0a0a0a] border border-white/10 text-white/70 rounded-lg px-3 py-2 focus:outline-none focus:border-pink-500" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {presets.map(p => (
            <button key={p.label} onClick={() => { setDateStart(p.s); setDateEnd(p.e); }}
              className={`text-[10px] px-2.5 py-1.5 rounded-md transition-colors ${
                dateStart === p.s && dateEnd === p.e
                  ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30'
                  : 'bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/50'
              }`}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-[#111] rounded-lg p-1 border border-white/5 w-fit">
        {([
          { id: 'distribucion', label: 'Distribución' },
          { id: 'ingresos', label: 'Ingresos' },
          { id: 'gastos', label: 'Gastos' },
          { id: 'reporte', label: 'Reporte' },
        ] as const).map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-all ${
              activeTab === tab.id ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/50'
            }`}>{tab.label}</button>
        ))}
      </div>

      {/* ===== DISTRIBUCIÓN ===== */}
      {activeTab === 'distribucion' && (
        <div className="space-y-4">
          {/* Porcentajes (fijos) */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Porcentajes de distribución (sobre ganancia neta)</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Morna', pct: MORNA_PCT, color: 'text-pink-400' },
                { label: 'Sunmi', pct: SUNMI_PCT, color: 'text-cyan-400' },
                { label: 'Anavi (gestión)', pct: ANAVI_PCT, color: 'text-purple-400' },
                { label: 'Millennium', pct: MILLENNIUM_PCT, color: 'text-yellow-400' },
              ].map(({ label, pct, color }) => (
                <div key={label} className="bg-white/5 rounded-lg p-3">
                  <p className="text-[10px] text-white/30 mb-1.5">{label}</p>
                  <p className={`text-lg font-bold ${color}`}>{pct}%</p>
                </div>
              ))}
            </div>
          </div>

          {/* Waterfall */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Distribución del período</h3>
            <div className="space-y-0.5">
              <WRow label="Ingresos cobrados" sub={`${periodPayments.filter(p => p.status === 'completed').length} pagos completados`} amount={dist.gross} color="text-white" isTotal />
              {dist.pending > 0 && <WRow label="Pagos pendientes (excluidos)" amount={dist.pending} color="text-white/20" indent />}
              <WRow label={`− Gastos operativos (${periodExpenses.length} registros)`} amount={-dist.totalExpenses} color="text-red-400" indent />
              <WRow label="Ganancia distribuible" amount={dist.distributable} color={dist.distributable >= 0 ? 'text-emerald-400' : 'text-red-400'} isTotal borderTop />
              <WRow label={`− ${MORNA_PCT}% Morna`} amount={-dist.morna} color="text-pink-400" indent />
              <WRow label={`− ${SUNMI_PCT}% Sunmi`} amount={-dist.sunmi} color="text-cyan-400" indent />
              <WRow label={`− ${ANAVI_PCT}% Anavi (gestión)`} amount={-dist.anavi} color="text-purple-400" indent />
              <WRow label={`− ${MILLENNIUM_PCT}% Millennium`} amount={-dist.millennium} color="text-yellow-400" indent />
            </div>
          </div>

          {/* Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Para Morna (36%)', value: fmt(dist.morna), color: 'text-pink-400' },
              { label: 'Para Sunmi (36%)', value: fmt(dist.sunmi), color: 'text-cyan-400' },
              { label: 'Para Anavi (16%)', value: fmt(dist.anavi), color: 'text-purple-400' },
              { label: 'Para Millennium (12%)', value: fmt(dist.millennium), color: 'text-yellow-400' },
            ].map(s => (
              <div key={s.label} className="bg-[#111] border border-white/5 rounded-xl p-4">
                <p className="text-[10px] text-white/25 uppercase tracking-wider mb-1">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== INGRESOS ===== */}
      {activeTab === 'ingresos' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-white/30 text-xs">
              {periodPayments.length} pagos en el período ·{' '}
              <span className="text-emerald-400 font-semibold">{fmt(dist.gross)}</span> cobrado ·{' '}
              <span className="text-yellow-400 font-semibold">{fmt(dist.pending)}</span> pendiente
            </p>
            <button onClick={openNewPayment}
              className="flex items-center gap-2 text-sm bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 rounded-lg px-4 py-2 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              Registrar pago
            </button>
          </div>

          <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
            {payments.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-white/20 text-sm">No hay pagos registrados.</p>
                <button onClick={openNewPayment} className="mt-3 text-xs text-pink-400/70 hover:text-pink-300 transition-colors">+ Registrar primer pago</button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/5">
                      {['Fecha', 'Tienda', 'Plan', 'Período', 'Monto', 'Método', 'Estado', ''].map(h => (
                        <th key={h} className={`text-[11px] text-white/25 uppercase tracking-wider font-medium px-5 py-3 ${h === 'Monto' ? 'text-right' : 'text-left'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {payments.map(p => {
                      const inPeriod = (p.payment_date || p.created_at.split('T')[0]) >= dateStart &&
                                       (p.payment_date || p.created_at.split('T')[0]) <= dateEnd;
                      return (
                        <tr key={p.id} className={`hover:bg-white/3 transition-colors ${!inPeriod ? 'opacity-35' : ''}`}>
                          <td className="px-5 py-3 text-xs font-mono text-white/40">{p.payment_date || p.created_at.split('T')[0]}</td>
                          <td className="px-5 py-3 text-xs text-white/70 font-medium">{storeName(p.store_id)}</td>
                          <td className="px-5 py-3">
                            <span className="text-[11px] text-white/50 bg-white/5 px-2 py-0.5 rounded font-mono">{p.item_name}</span>
                          </td>
                          <td className="px-5 py-3 text-xs text-white/40">{p.period || '—'}</td>
                          <td className="px-5 py-3 text-right text-sm font-semibold text-emerald-400">{fmt(Number(p.amount_usd))}</td>
                          <td className="px-5 py-3 text-xs text-white/40">{p.payment_method}</td>
                          <td className="px-5 py-3">
                            <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                              p.status === 'completed' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-yellow-500/15 text-yellow-300'
                            }`}>
                              {p.status === 'completed' ? 'Pagado' : 'Pendiente'}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <button onClick={() => openEditPayment(p)} className="text-white/20 hover:text-white/60 transition-colors">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                              </button>
                              <button onClick={() => handleDeletePayment(p.id)} disabled={deletingPayId === p.id} className="text-white/20 hover:text-red-400 transition-colors disabled:opacity-30">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="text-[10px] text-white/15 text-right">Filas atenuadas = fuera del período seleccionado</p>
        </div>
      )}

      {/* ===== GASTOS ===== */}
      {activeTab === 'gastos' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-white/30 text-xs">{periodExpenses.length} gastos en el período · Total: <span className="text-red-400 font-semibold">{fmt(dist.totalExpenses)}</span></p>
            <button onClick={openNewExpense} className="flex items-center gap-2 text-sm bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 rounded-lg px-4 py-2 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              Nuevo gasto
            </button>
          </div>
          <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
            {expenses.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-white/20 text-sm">No hay gastos registrados.</p>
                <button onClick={openNewExpense} className="mt-3 text-xs text-pink-400/70 hover:text-pink-300 transition-colors">+ Agregar primer gasto</button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/5">
                      {['Fecha', 'Categoría', 'Descripción', 'Monto', ''].map(h => (
                        <th key={h} className={`text-[11px] text-white/25 uppercase tracking-wider font-medium px-5 py-3 ${h === 'Monto' ? 'text-right' : 'text-left'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {expenses.map(e => {
                      const inPeriod = e.expense_date >= dateStart && e.expense_date <= dateEnd;
                      return (
                        <tr key={e.id} className={`hover:bg-white/3 transition-colors ${!inPeriod ? 'opacity-35' : ''}`}>
                          <td className="px-5 py-3 text-xs font-mono text-white/40">{e.expense_date}</td>
                          <td className="px-5 py-3"><span className="text-xs text-white/60 bg-white/5 px-2 py-0.5 rounded">{e.category}</span></td>
                          <td className="px-5 py-3 text-xs text-white/40 max-w-xs truncate">{e.description || '—'}</td>
                          <td className="px-5 py-3 text-right text-sm font-semibold text-red-400">{fmt(Number(e.amount_usd))}</td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <button onClick={() => openEditExpense(e)} className="text-white/20 hover:text-white/60 transition-colors">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                              </button>
                              <button onClick={() => handleDeleteExpense(e.id)} disabled={deletingExpId === e.id} className="text-white/20 hover:text-red-400 transition-colors disabled:opacity-30">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== REPORTE ===== */}
      {activeTab === 'reporte' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-white/30 text-xs">Período: <span className="font-mono text-white/50">{dateStart}</span> → <span className="font-mono text-white/50">{dateEnd}</span></p>
            <button onClick={handleExportReport} className="flex items-center gap-2 text-xs text-emerald-400/70 hover:text-emerald-300 bg-emerald-500/5 hover:bg-emerald-500/10 rounded-lg px-4 py-2 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Exportar CSV
            </button>
          </div>

          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Resumen financiero</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left text-[11px] text-white/25 uppercase tracking-wider font-medium py-2 pr-6">Concepto</th>
                  <th className="text-right text-[11px] text-white/25 uppercase tracking-wider font-medium py-2">Monto (USD)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {[
                  { label: 'Ingresos cobrados', value: dist.gross, color: 'text-white', bold: false },
                  { label: 'Pagos pendientes (excluidos del cálculo)', value: dist.pending, color: 'text-yellow-400', bold: false },
                  { label: '− Gastos operativos registrados', value: -dist.totalExpenses, color: 'text-red-400', bold: false },
                  { label: 'Ganancia distribuible', value: dist.distributable, color: dist.distributable >= 0 ? 'text-emerald-400' : 'text-red-400', bold: true },
                  { label: `− ${MORNA_PCT}% Morna`, value: -dist.morna, color: 'text-pink-400', bold: false },
                  { label: `− ${SUNMI_PCT}% Sunmi`, value: -dist.sunmi, color: 'text-cyan-400', bold: false },
                  { label: `− ${ANAVI_PCT}% Anavi (gestión)`, value: -dist.anavi, color: 'text-purple-400', bold: false },
                  { label: `− ${MILLENNIUM_PCT}% Millennium`, value: -dist.millennium, color: 'text-yellow-400', bold: false },
                ].map((row, i) => (
                  <tr key={i} className={row.bold ? 'bg-white/3' : ''}>
                    <td className={`py-2.5 pr-6 text-xs ${row.bold ? 'font-semibold text-white/60' : 'text-white/40'}`}>{row.label}</td>
                    <td className={`py-2.5 text-right font-mono ${row.bold ? 'text-sm font-bold' : 'text-sm font-medium'} ${row.color}`}>
                      {row.value >= 0 ? '+' : ''}{fmt(row.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Ingresos por tienda */}
          {periodPayments.length > 0 && (
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Ingresos por tienda (período)</h3>
              {(() => {
                const byStore: Record<string, number> = {};
                periodPayments.filter(p => p.status === 'completed').forEach(p => {
                  const name = storeName(p.store_id);
                  byStore[name] = (byStore[name] || 0) + Number(p.amount_usd);
                });
                const sorted = Object.entries(byStore).sort((a, b) => b[1] - a[1]);
                const max = sorted[0]?.[1] || 1;
                return (
                  <div className="space-y-3">
                    {sorted.map(([name, amount]) => (
                      <div key={name}>
                        <div className="flex justify-between text-xs mb-1.5">
                          <span className="text-white/60">{name}</span>
                          <span className="text-emerald-400 font-semibold">{fmt(amount)}</span>
                        </div>
                        <div className="w-full bg-white/5 rounded-full h-1">
                          <div className="h-1 rounded-full bg-emerald-500/50 transition-all duration-700" style={{ width: `${(amount / max) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* ===== PAYMENT MODAL ===== */}
      {payModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-6 border-b border-white/5">
              <h3 className="text-white font-semibold">{editingPay ? 'Editar pago' : 'Registrar pago de plan'}</h3>
              <button onClick={() => setPayModal(false)} className="text-white/30 hover:text-white/70 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              {/* Store */}
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">Tienda / Cliente</label>
                <select value={payForm.store_id} onChange={e => {
                  const store = storeById.get(e.target.value);
                  setPayForm(f => ({ ...f, store_id: e.target.value, item_name: store?.plan_type || f.item_name }));
                }} className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500">
                  <option value="">Selecciona una tienda...</option>
                  {stores.map(s => <option key={s.id} value={s.id}>{s.name} {s.plan_type ? `· ${s.plan_type}` : ''}</option>)}
                </select>
              </div>
              {/* Plan + Period */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Plan</label>
                  <select value={payForm.item_name} onChange={e => setPayForm(f => ({ ...f, item_name: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500">
                    {PLAN_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Período</label>
                  <input type="text" placeholder="Mayo 2026" value={payForm.period}
                    onChange={e => setPayForm(f => ({ ...f, period: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white placeholder-white/20 rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500" />
                </div>
              </div>
              {/* Amount + Method */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Monto (USD)</label>
                  <input type="number" step="0.01" min="0" placeholder="0.00" value={payForm.amount_usd}
                    onChange={e => setPayForm(f => ({ ...f, amount_usd: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white placeholder-white/20 rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Método de pago</label>
                  <select value={payForm.payment_method} onChange={e => setPayForm(f => ({ ...f, payment_method: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500">
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              {/* Date + Status */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Fecha de pago</label>
                  <input type="date" value={payForm.payment_date}
                    onChange={e => setPayForm(f => ({ ...f, payment_date: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Estado</label>
                  <select value={payForm.status} onChange={e => setPayForm(f => ({ ...f, status: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500">
                    <option value="completed">Pagado</option>
                    <option value="pending">Pendiente</option>
                  </select>
                </div>
              </div>
              {/* Notes */}
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">Notas / Nro. de referencia (opcional)</label>
                <input type="text" placeholder="Ej: Ref. 0045872" value={payForm.notes}
                  onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white placeholder-white/20 rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500" />
              </div>
              {payError && <p className="text-xs text-red-400">{payError}</p>}
            </div>
            <div className="flex gap-3 p-6 pt-0">
              <button onClick={handleSavePayment} disabled={saving}
                className="flex-1 bg-gradient-to-r from-pink-600 to-orange-500 text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
                {saving ? 'Guardando...' : editingPay ? 'Guardar cambios' : 'Registrar pago'}
              </button>
              <button onClick={() => setPayModal(false)} className="px-4 text-white/40 hover:text-white/70 text-sm transition-colors">Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== EXPENSE MODAL ===== */}
      {expModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-6 border-b border-white/5">
              <h3 className="text-white font-semibold">{editingExp ? 'Editar gasto' : 'Nuevo gasto'}</h3>
              <button onClick={() => setExpModal(false)} className="text-white/30 hover:text-white/70 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">Categoría</label>
                <select value={expForm.category} onChange={e => setExpForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500">
                  {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">Descripción (opcional)</label>
                <input type="text" placeholder="Ej: Honorarios enero 2026" value={expForm.description}
                  onChange={e => setExpForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white placeholder-white/20 rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Monto (USD)</label>
                  <input type="number" step="0.01" min="0" placeholder="0.00" value={expForm.amount_usd}
                    onChange={e => setExpForm(f => ({ ...f, amount_usd: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white placeholder-white/20 rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1.5 block">Fecha</label>
                  <input type="date" value={expForm.expense_date}
                    onChange={e => setExpForm(f => ({ ...f, expense_date: e.target.value }))}
                    className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white rounded-lg px-3 py-2.5 focus:outline-none focus:border-pink-500" />
                </div>
              </div>
              {expError && <p className="text-xs text-red-400">{expError}</p>}
            </div>
            <div className="flex gap-3 p-6 pt-0">
              <button onClick={handleSaveExpense} disabled={saving}
                className="flex-1 bg-gradient-to-r from-pink-600 to-orange-500 text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
                {saving ? 'Guardando...' : editingExp ? 'Guardar cambios' : 'Agregar gasto'}
              </button>
              <button onClick={() => setExpModal(false)} className="px-4 text-white/40 hover:text-white/70 text-sm transition-colors">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Waterfall row ─────────────────────────────────────────────────────────────
function WRow({ label, sub, amount, color, indent, isTotal, borderTop, large }: {
  label: string; sub?: string; amount: number; color: string;
  indent?: boolean; isTotal?: boolean; borderTop?: boolean; large?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between py-2.5 px-3 rounded-lg ${
      borderTop ? 'border-t border-white/10 mt-1' : ''
    } ${isTotal ? 'bg-white/3' : ''}`}>
      <div className={indent ? 'pl-4' : ''}>
        <p className={`text-xs ${isTotal ? 'font-semibold text-white/60' : 'text-white/35'}`}>{label}</p>
        {sub && <p className="text-[10px] text-white/20 mt-0.5">{sub}</p>}
      </div>
      <span className={`font-mono font-semibold tabular-nums ${large ? 'text-lg' : 'text-sm'} ${color}`}>
        {amount >= 0 ? '+' : ''}${Math.abs(amount).toFixed(2)}
      </span>
    </div>
  );
}
