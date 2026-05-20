'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
  FLASH_COUPON_DIARIO: 'Flash Coupon · Diario',
  FLASH_COUPON_SEMANAL: 'Flash Coupon · Semanal',
};

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10',
  ORO: 'text-amber-400 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-400 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-400 bg-blue-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-400 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-400 bg-pink-500/10',
};

const METHOD_LABEL: Record<string, string> = {
  transfer_bs: 'Transferencia Bs',
  transfer_usd: 'Transferencia USD',
  cash_usd: 'Efectivo USD',
  cash_bs: 'Efectivo Bs',
  bancamiga_bs: 'Bancamiga · Bs',
  bancamiga_usd: 'Bancamiga · USD',
  binance: 'Binance',
  efectivo: 'Efectivo',
  otro: 'Otro',
};

type Tab = 'requests' | 'payments';
type StatusFilter = 'pending' | 'resolved' | 'all';

type StoreLite = { id: string; name: string; local_number: string | null };

export default function SolicitudesPanelPage() {
  const [tab, setTab] = useState<Tab>('requests');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [requests, setRequests] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [storesById, setStoresById] = useState<Record<string, StoreLite>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // Modal state
  const [detail, setDetail] = useState<{ kind: Tab; row: any } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchData = async () => {
    setRefreshing(true);
    const [reqRes, payRes, storeRes] = await Promise.all([
      supabase.from('plan_requests').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('transactions')
        .select('*')
        .eq('transaction_type', 'plan_payment')
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('stores').select('id, name, local_number'),
    ]);
    setRequests(reqRes.data || []);
    setPayments(payRes.data || []);
    const map: Record<string, StoreLite> = {};
    for (const s of (storeRes.data || [])) map[s.id] = s as StoreLite;
    setStoresById(map);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => { fetchData(); }, []);

  const filteredRequests = useMemo(() => {
    if (statusFilter === 'all') return requests;
    if (statusFilter === 'pending') return requests.filter(r => r.status === 'pending');
    return requests.filter(r => r.status !== 'pending');
  }, [requests, statusFilter]);

  const filteredPayments = useMemo(() => {
    if (statusFilter === 'all') return payments;
    if (statusFilter === 'pending') {
      return payments.filter(p => (p.status ?? 'pending') === 'pending');
    }
    return payments.filter(p => (p.status ?? 'pending') !== 'pending');
  }, [payments, statusFilter]);

  const pendingReqCount = useMemo(() => requests.filter(r => r.status === 'pending').length, [requests]);
  const pendingPayCount = useMemo(
    () => payments.filter(p => (p.status ?? 'pending') === 'pending').length,
    [payments]
  );

  const approveRequest = async (row: any) => {
    setBusy(true); setFeedback(null);
    const { error } = await supabase.rpc('admin_approve_plan_request', { p_request_id: row.id });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: `Solicitud aprobada y plan activado.` });
    setDetail(null);
    fetchData();
  };
  const rejectRequest = async (row: any) => {
    setBusy(true); setFeedback(null);
    const { error } = await supabase.rpc('admin_reject_plan_request', {
      p_request_id: row.id, p_reason: rejectReason || null,
    });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: 'Solicitud rechazada.' });
    setDetail(null); setRejectReason('');
    fetchData();
  };

  const approvePayment = async (row: any) => {
    setBusy(true); setFeedback(null);
    const { error } = await supabase.rpc('admin_approve_plan_payment', { p_transaction_id: row.id });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: 'Pago aprobado y vencimiento extendido.' });
    setDetail(null);
    fetchData();
  };
  const rejectPayment = async (row: any) => {
    setBusy(true); setFeedback(null);
    const { error } = await supabase.rpc('admin_reject_plan_payment', {
      p_transaction_id: row.id, p_reason: rejectReason || null,
    });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    setFeedback({ type: 'ok', msg: 'Pago rechazado.' });
    setDetail(null); setRejectReason('');
    fetchData();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-[#FF007A] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Cobranzas</p>
          <h2 className="text-2xl font-bold text-white">Solicitudes & Pagos</h2>
          <p className="text-white/50 text-sm mt-2">
            Valida solicitudes de plan y pagos de renovación. Al aprobar se actualiza el contrato
            de la tienda y se registra el ingreso en finanzas.
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={refreshing}
          className="shrink-0 text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 rounded-lg px-4 py-2 disabled:opacity-50 self-start sm:self-auto"
        >
          {refreshing ? 'Actualizando…' : '↻ Refrescar'}
        </button>
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

      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex bg-white/[0.03] border border-white/10 rounded-lg p-1">
          <button
            onClick={() => setTab('requests')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === 'requests'
                ? 'bg-[#FF007A]/20 text-[#FF99CC]'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            Solicitudes de plan
            {pendingReqCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-amber-500/20 text-amber-300 rounded text-[10px] font-bold">
                {pendingReqCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('payments')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === 'payments'
                ? 'bg-[#FF007A]/20 text-[#FF99CC]'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            Renovaciones
            {pendingPayCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-amber-500/20 text-amber-300 rounded text-[10px] font-bold">
                {pendingPayCount}
              </span>
            )}
          </button>
        </div>

        <div className="flex bg-white/[0.03] border border-white/10 rounded-lg p-1">
          {(['pending','resolved','all'] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                statusFilter === s
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {s === 'pending' ? 'Pendientes' : s === 'resolved' ? 'Resueltas' : 'Todas'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'requests' ? (
        filteredRequests.length === 0 ? (
          <EmptyState text="Sin solicitudes" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredRequests.map(r => (
              <SolicitudCard
                key={r.id}
                kind="requests"
                row={r}
                store={storesById[r.store_id]}
                onOpen={() => { setRejectReason(''); setDetail({ kind: 'requests', row: r }); }}
              />
            ))}
          </div>
        )
      ) : (
        filteredPayments.length === 0 ? (
          <EmptyState text="Sin pagos" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredPayments.map(p => (
              <SolicitudCard
                key={p.id}
                kind="payments"
                row={p}
                store={storesById[p.store_id]}
                onOpen={() => { setRejectReason(''); setDetail({ kind: 'payments', row: p }); }}
              />
            ))}
          </div>
        )
      )}

      {detail && (
        <DetailModal
          detail={detail}
          storesById={storesById}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          busy={busy}
          onClose={() => { if (!busy) { setDetail(null); setRejectReason(''); } }}
          onApprove={() => detail.kind === 'requests' ? approveRequest(detail.row) : approvePayment(detail.row)}
          onReject={() => detail.kind === 'requests' ? rejectRequest(detail.row) : rejectPayment(detail.row)}
        />
      )}
    </div>
  );
}

function DetailModal({
  detail, storesById, rejectReason, setRejectReason, busy,
  onClose, onApprove, onReject,
}: {
  detail: { kind: Tab; row: any };
  storesById: Record<string, StoreLite>;
  rejectReason: string;
  setRejectReason: (s: string) => void;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { kind, row } = detail;
  const store = storesById[row.store_id];
  const isPending = kind === 'requests'
    ? row.status === 'pending'
    : (row.status ?? 'pending') === 'pending';
  const title = kind === 'requests' ? 'Solicitud de plan' : 'Pago de renovación';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-5 border-b border-white/10 flex items-start justify-between">
          <div>
            <p className="text-[11px] text-white/40 uppercase tracking-widest mb-1">{title}</p>
            <h3 className="text-xl font-bold text-white">{store?.name || '—'}</h3>
            <p className="text-[11px] text-white/40 font-mono mt-1">#{(row.id || '').slice(0, 8)}</p>
          </div>
          <button onClick={onClose} disabled={busy} className="text-white/40 hover:text-white/80 disabled:opacity-30">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 text-sm">
          <DetailRow label="Plan">
            {kind === 'requests' ? (
              <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${PLAN_COLORS[row.plan_key] || 'text-white/40 bg-white/5'}`}>
                {PLAN_LABELS[row.plan_key] || row.plan_key}
              </span>
            ) : (
              <span className="text-white/80">{row.item_name}</span>
            )}
          </DetailRow>
          <DetailRow label="Estado">
            <span className="uppercase font-semibold text-[11px]">
              {kind === 'requests' ? row.status : (row.status ?? 'pending')}
            </span>
          </DetailRow>
          <DetailRow label="Método">{METHOD_LABEL[row.payment_method] || row.payment_method || '—'}</DetailRow>
          <DetailRow label="Monto USD">
            <span className="text-emerald-300 font-mono">
              ${Number(row.amount_usd ?? 0).toFixed(2)}
            </span>
          </DetailRow>
          {row.amount_bs != null && (
            <DetailRow label="Monto Bs">
              <span className="font-mono">Bs {Number(row.amount_bs).toLocaleString('es-VE')}</span>
            </DetailRow>
          )}
          {(row.bcv_rate ?? row.exchange_rate) != null && (
            <DetailRow label="Tasa BCV">
              <span className="font-mono">{Number(row.bcv_rate ?? row.exchange_rate).toFixed(2)}</span>
            </DetailRow>
          )}
          {row.payment_bank && <DetailRow label="Banco / plataforma">{row.payment_bank}</DetailRow>}
          {row.payment_reference && (
            <DetailRow label="Referencia">
              <span className="font-mono break-all">{row.payment_reference}</span>
            </DetailRow>
          )}
          {kind === 'requests' && (
            <>
              <DetailRow label="Ciclos">{row.months_requested || '—'}</DetailRow>
              <DetailRow label="Fecha efectiva">
                <span className="font-mono">{row.effective_date || '—'}</span>
              </DetailRow>
              {row.expires_at && (
                <DetailRow label="Vencerá">
                  <span className="font-mono text-amber-300">{row.expires_at}</span>
                </DetailRow>
              )}
            </>
          )}
          {kind === 'payments' && (
            <>
              <DetailRow label="Ciclos">{row.months_paid || '—'}</DetailRow>
              <DetailRow label="Período">{row.period || '—'}</DetailRow>
              {row.payment_date && (
                <DetailRow label="Fecha pago"><span className="font-mono">{row.payment_date}</span></DetailRow>
              )}
            </>
          )}
          {row.notes && (
            <DetailRow label="Notas">
              <pre className="whitespace-pre-wrap text-[11px] text-white/60 font-sans">{row.notes}</pre>
            </DetailRow>
          )}

          {isPending && (
            <div className="border-t border-white/10 pt-4 space-y-3">
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Motivo de rechazo (opcional)
                </label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={2}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50 resize-none"
                  placeholder="Ej: referencia no encontrada en estado de cuenta"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={onReject} disabled={busy}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 rounded-lg disabled:opacity-50"
                >
                  {busy ? 'Procesando…' : 'Rechazar'}
                </button>
                <button
                  onClick={onApprove} disabled={busy}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 rounded-lg disabled:opacity-50"
                >
                  {busy ? 'Procesando…' : 'Aprobar y registrar ingreso'}
                </button>
              </div>
              <p className="text-[10px] text-white/30">
                Al aprobar, se valida el cupo del plan, se actualiza el contrato de la tienda y se
                registra la transacción como ingreso en finanzas. La operación es atómica: si dos
                admins aprueban simultáneamente, solo una pasa.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-[11px] text-white/40 uppercase tracking-wider shrink-0 pt-0.5">{label}</span>
      <div className="text-right text-white/80 text-sm">{children}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="bg-[#111] border border-white/5 rounded-xl p-10 text-center">
      <p className="text-white/30 text-sm">{text}</p>
    </div>
  );
}

function SolicitudCard({
  kind, row, store, onOpen,
}: {
  kind: Tab;
  row: any;
  store?: StoreLite;
  onOpen: () => void;
}) {
  const isRequest = kind === 'requests';
  const planKey = isRequest ? row.plan_key : null;
  const planChip = isRequest
    ? (PLAN_LABELS[row.plan_key] || row.plan_key)
    : (row.item_name || 'Renovación');
  const planClr = isRequest
    ? (PLAN_COLORS[row.plan_key] || 'text-white/40 bg-white/5')
    : 'text-white/70 bg-white/5';

  const st = isRequest ? row.status : (row.status ?? 'pending');
  const sUi = isRequest
    ? (st === 'approved'  ? { txt: 'APROBADA',  cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' }
      : st === 'rejected' ? { txt: 'RECHAZADA', cls: 'text-red-400 bg-red-500/10 border-red-500/20' }
      : { txt: 'REVISIÓN', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' })
    : (st === 'completed' ? { txt: 'COMPLETADO', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' }
      : st === 'rejected' ? { txt: 'RECHAZADO',  cls: 'text-red-400 bg-red-500/10 border-red-500/20' }
      : { txt: 'REVISIÓN', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' });

  const isPending = st === 'pending';

  return (
    <button
      onClick={onOpen}
      className={`w-full text-left bg-[#0F0F0F] border rounded-xl p-4 transition-all hover:bg-white/[0.04] hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 ${
        isPending ? 'border-amber-500/20' : 'border-white/5'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{store?.name || '—'}</p>
          {store?.local_number && (
            <p className="text-[10px] text-white/40 font-mono mt-0.5">Local {store.local_number}</p>
          )}
        </div>
        <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border ${sUi.cls}`}>
          {sUi.txt}
        </span>
      </div>

      {/* Plan chip */}
      <div className="mb-3">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${planClr} ${!isRequest ? 'whitespace-normal break-words' : ''}`}>
          {planChip}
        </span>
        {planKey && (
          <span className="ml-1.5 text-[9px] text-white/30 font-mono uppercase">{planKey}</span>
        )}
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-2 gap-2 mb-3 text-[11px]">
        <div>
          <p className="text-white/30 text-[9px] uppercase tracking-wider">Monto USD</p>
          <p className="text-emerald-300 font-mono font-semibold">
            ${Number(row.amount_usd ?? 0).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-white/30 text-[9px] uppercase tracking-wider">Método</p>
          <p className="text-white/80 truncate">{METHOD_LABEL[row.payment_method] || row.payment_method || '—'}</p>
        </div>
        {row.amount_bs != null && (
          <div>
            <p className="text-white/30 text-[9px] uppercase tracking-wider">Monto Bs</p>
            <p className="text-white/80 font-mono">{Number(row.amount_bs).toLocaleString('es-VE')}</p>
          </div>
        )}
        {isRequest ? (
          <div>
            <p className="text-white/30 text-[9px] uppercase tracking-wider">Ciclos</p>
            <p className="text-white/80 font-mono">{row.months_requested || '—'}</p>
          </div>
        ) : (
          <div>
            <p className="text-white/30 text-[9px] uppercase tracking-wider">Período</p>
            <p className="text-white/80 truncate">{row.period || '—'}</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] text-white/40 border-t border-white/5 pt-2.5">
        <span>{new Date(row.created_at).toLocaleDateString('es-VE')}</span>
        <span className="text-cyan-300 font-medium">
          {isPending ? 'Validar →' : 'Ver detalle →'}
        </span>
      </div>
    </button>
  );
}
