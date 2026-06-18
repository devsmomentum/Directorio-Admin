'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';
import K2BannerPreview from '../../components/K2BannerPreview';
import K2CampaignPreview from '../../components/K2CampaignPreview';

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

type Tab = 'payments' | 'campaigns' | 'coupons' | 'banners';
type StatusFilter = 'pending' | 'resolved' | 'all';

type StoreLite = { id: string; name: string; local_number: string | null };

export default function SolicitudesPanelPage() {
  const [activeTab, setActiveTab] = useState<Tab>('payments');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [requests, setRequests] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [banners, setBanners] = useState<any[]>([]);
  const [storesById, setStoresById] = useState<Record<string, StoreLite>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // Modal state
  const [detail, setDetail] = useState<{ kind: Tab; row: any } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [approvalPosition, setApprovalPosition] = useState<string>('top');
  const [approvalSlot, setApprovalSlot] = useState<string>('1');

  const fetchData = async () => {
    setRefreshing(true);
    const [reqRes, payRes, campRes, coupRes, storeRes, bannerRes] = await Promise.all([
      supabase.from('plan_requests').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('transactions')
        .select('*')
        .eq('transaction_type', 'plan_payment')
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('ad_campaigns')
        .select('*')
        .in('approval_status', ['pending', 'approved', 'rejected'])
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('coupons')
        .select('*')
        .in('approval_status', ['pending', 'approved', 'rejected'])
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('stores').select('id, name, local_number'),
      supabase.from('banners')
        .select('*')
        .in('approval_status', ['pending', 'approved', 'rejected'])
        .order('created_at', { ascending: false })
        .limit(500),
    ]);
    setRequests(reqRes.data || []);
    setPayments(payRes.data || []);
    setCampaigns(campRes.data || []);
    setCoupons(coupRes.data || []);
    setBanners(bannerRes.data || []);
    const map: Record<string, StoreLite> = {};
    for (const s of (storeRes.data || [])) map[s.id] = s as StoreLite;
    setStoresById(map);
    setLoading(false);
    setRefreshing(false);
  };

  // Mapa de solicitudes por id, para enriquecer los pagos en la lista/modal.
  const requestById = useMemo(() => {
    const m: Record<string, any> = {};
    for (const r of requests) m[r.id] = r;
    return m;
  }, [requests]);

  useEffect(() => { fetchData(); }, []);

  const filteredPayments = useMemo(() => {
    if (statusFilter === 'all') return payments;
    if (statusFilter === 'pending') {
      return payments.filter(p => (p.status ?? 'pending') === 'pending');
    }
    return payments.filter(p => (p.status ?? 'pending') !== 'pending');
  }, [payments, statusFilter]);

  const filteredCampaigns = useMemo(() => {
    if (statusFilter === 'all') return campaigns;
    if (statusFilter === 'pending') {
      return campaigns.filter(c => c.approval_status === 'pending');
    }
    return campaigns.filter(c => c.approval_status !== 'pending');
  }, [campaigns, statusFilter]);

  const filteredCoupons = useMemo(() => {
    if (statusFilter === 'all') return coupons;
    if (statusFilter === 'pending') {
      return coupons.filter(c => c.approval_status === 'pending');
    }
    return coupons.filter(c => c.approval_status !== 'pending');
  }, [coupons, statusFilter]);

  const filteredBanners = useMemo(() => {
    if (statusFilter === 'all') return banners;
    if (statusFilter === 'pending') {
      return banners.filter(b => b.approval_status === 'pending');
    }
    return banners.filter(b => b.approval_status !== 'pending');
  }, [banners, statusFilter]);

  const pendingPayCount = useMemo(
    () => payments.filter(p => (p.status ?? 'pending') === 'pending').length,
    [payments]
  );
  const pendingCampaignCount = useMemo(
    () => campaigns.filter(c => c.approval_status === 'pending').length,
    [campaigns]
  );
  const pendingCouponCount = useMemo(
    () => coupons.filter(c => c.approval_status === 'pending').length,
    [coupons]
  );
  const pendingBannerCount = useMemo(
    () => banners.filter(b => b.approval_status === 'pending').length,
    [banners]
  );

  const approvePayment = async (row: any) => {
    setBusy(true); setFeedback(null);
    const { error } = await supabase.rpc('admin_approve_plan_payment', { p_transaction_id: row.id });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'APROBAR',
      entity_type: 'pago',
      entity_id: row.id,
      entity_name: row.item_name || 'Pago de Plan',
      details: { amount_usd: row.amount_usd, transaction_type: row.transaction_type }
    });
    setFeedback({ type: 'ok', msg: 'Pago aprobado y vencimiento extendido.' });
    setDetail(null);
    fetchData();
  };
  const rejectPayment = async (row: any) => {
    setBusy(true); setFeedback(null);
    const reasonForLog = rejectReason || null;
    const { error } = await supabase.rpc('admin_reject_plan_payment', {
      p_transaction_id: row.id, p_reason: reasonForLog,
    });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'RECHAZAR',
      entity_type: 'pago',
      entity_id: row.id,
      entity_name: row.item_name || 'Pago de Plan',
      details: { amount_usd: row.amount_usd, reason: reasonForLog }
    });
    setFeedback({ type: 'ok', msg: 'Pago rechazado.' });
    setDetail(null); setRejectReason('');
    fetchData();
  };

  const approveCampaign = async (row: any) => {
    setBusy(true); setFeedback(null);
    const { error } = await supabase.rpc('admin_approve_campaign', { p_campaign_id: row.id });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'APROBAR',
      entity_type: 'campaña',
      entity_id: row.id,
      entity_name: row.brand_name,
      details: { plan_type: row.plan_type }
    });
    setFeedback({ type: 'ok', msg: 'Campaña aprobada. Ya aparece en el loop del K2.' });
    setDetail(null);
    fetchData();
  };
  const rejectCampaign = async (row: any) => {
    setBusy(true); setFeedback(null);
    const reasonForLog = rejectReason || null;
    const { error } = await supabase.rpc('admin_reject_campaign', {
      p_campaign_id: row.id, p_reason: reasonForLog,
    });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'RECHAZAR',
      entity_type: 'campaña',
      entity_id: row.id,
      entity_name: row.brand_name,
      details: { plan_type: row.plan_type, reason: reasonForLog }
    });
    setFeedback({ type: 'ok', msg: 'Campaña rechazada.' });
    setDetail(null); setRejectReason('');
    fetchData();
  };

  const approveCoupon = async (row: any) => {
    setBusy(true); setFeedback(null);
    const { error } = await supabase.rpc('admin_approve_coupon', { p_coupon_id: row.id });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'APROBAR',
      entity_type: 'cupón',
      entity_id: row.id,
      entity_name: row.title || row.code,
      details: { plan_type: row.plan_type }
    });
    setFeedback({ type: 'ok', msg: 'Cupón aprobado. Ya aparece en la galería del K2.' });
    setDetail(null);
    fetchData();
  };
  const rejectCoupon = async (row: any) => {
    setBusy(true); setFeedback(null);
    const reasonForLog = rejectReason || null;
    const { error } = await supabase.rpc('admin_reject_coupon', {
      p_coupon_id: row.id, p_reason: reasonForLog,
    });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'RECHAZAR',
      entity_type: 'cupón',
      entity_id: row.id,
      entity_name: row.title || row.code,
      details: { plan_type: row.plan_type, reason: reasonForLog }
    });
    setFeedback({ type: 'ok', msg: 'Cupón rechazado.' });
    setDetail(null); setRejectReason('');
    fetchData();
  };

  const approveBanner = async (row: any) => {
    if (approvalPosition !== 'top' && approvalPosition !== 'bottom') {
      setFeedback({ type: 'err', msg: 'Debes seleccionar "top" o "bottom" — son las únicas posiciones que el K2 renderiza.' });
      return;
    }
    setBusy(true); setFeedback(null);
    // Asignar posición y slot antes de aprobar (el RPC no los toca)
    const { error: updErr } = await supabase.from('banners')
      .update({ ui_position: approvalPosition, slot_position: Number(approvalSlot) || null })
      .eq('id', row.id);
    if (updErr) { setBusy(false); setFeedback({ type: 'err', msg: updErr.message }); return; }
    const { error } = await supabase.rpc('admin_approve_banner', { p_banner_id: row.id });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'APROBAR',
      entity_type: 'banner',
      entity_id: row.id,
      entity_name: `Banner ${approvalPosition} (Slot ${approvalSlot})`,
      details: { store_id: row.store_id, ui_position: approvalPosition, slot_position: Number(approvalSlot) }
    });
    setFeedback({ type: 'ok', msg: `Banner aprobado en posición "${approvalPosition}" slot ${approvalSlot}. Aparecerá en el K2 en los próximos 3 minutos.` });
    setDetail(null);
    fetchData();
  };

  const rejectBanner = async (row: any) => {
    setBusy(true); setFeedback(null);
    const reasonForLog = rejectReason || null;
    const { error } = await supabase.rpc('admin_reject_banner', {
      p_banner_id: row.id, p_reason: reasonForLog,
    });
    setBusy(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({
      action_type: 'RECHAZAR',
      entity_type: 'banner',
      entity_id: row.id,
      entity_name: `Banner ${row.ui_position} (Slot ${row.slot_position})`,
      details: { store_id: row.store_id, reason: reasonForLog }
    });
    setFeedback({ type: 'ok', msg: 'Banner rechazado.' });
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

  const tabs: Array<{ key: Tab; label: string; pending: number; cls: string }> = [
    { key: 'payments',  label: 'Pagos',     pending: pendingPayCount,      cls: 'bg-[#FF007A]/20 text-[#FF99CC]' },
    { key: 'campaigns', label: 'Campañas',  pending: pendingCampaignCount, cls: 'bg-orange-500/20 text-orange-300' },
    { key: 'coupons',   label: 'Cupones',   pending: pendingCouponCount,   cls: 'bg-cyan-500/20 text-cyan-300' },
    { key: 'banners',   label: 'Banners',   pending: pendingBannerCount,   cls: 'bg-emerald-500/20 text-emerald-300' },
  ];

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Cobranzas & Revisión</p>
          <h2 className="text-2xl font-bold text-white">Solicitudes & Aprobaciones</h2>
          <p className="text-white/50 text-sm mt-2">
            Valida pagos de planes y revisa el contenido publicitario (campañas/cupones) que
            las tiendas suben antes de publicarse en el K2.
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
        <div className="flex bg-white/[0.03] border border-white/10 rounded-lg p-1 gap-1">
          {tabs.map(t => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                  active ? t.cls : 'text-white/40 hover:text-white/70'
                }`}
              >
                {t.label}
                {t.pending > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-amber-500/20 text-amber-300 rounded text-[10px] font-bold">
                    {t.pending}
                  </span>
                )}
              </button>
            );
          })}
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

      {activeTab === 'payments' && (
        filteredPayments.length === 0 ? (
          <EmptyState text="Sin pagos" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredPayments.map(p => (
              <PaymentCard
                key={p.id}
                row={p}
                store={storesById[p.store_id]}
                requestById={requestById}
                onOpen={() => { setRejectReason(''); setDetail({ kind: 'payments', row: p }); }}
              />
            ))}
          </div>
        )
      )}

      {activeTab === 'campaigns' && (
        filteredCampaigns.length === 0 ? (
          <EmptyState text="Sin campañas en revisión" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredCampaigns.map(c => (
              <CampaignCard
                key={c.id}
                row={c}
                store={storesById[c.store_id]}
                onOpen={() => { setRejectReason(''); setDetail({ kind: 'campaigns', row: c }); }}
              />
            ))}
          </div>
        )
      )}

      {activeTab === 'coupons' && (
        filteredCoupons.length === 0 ? (
          <EmptyState text="Sin cupones en revisión" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredCoupons.map(c => (
              <CouponCard
                key={c.id}
                row={c}
                store={storesById[c.store_id]}
                onOpen={() => { setRejectReason(''); setDetail({ kind: 'coupons', row: c }); }}
              />
            ))}
          </div>
        )
      )}

      {activeTab === 'banners' && (
        filteredBanners.length === 0 ? (
          <EmptyState text="Sin banners en revisión" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredBanners.map(b => (
              <BannerCard
                key={b.id}
                row={b}
                store={storesById[b.store_id]}
                onOpen={() => { setRejectReason(''); setApprovalPosition(b.ui_position || 'top'); setApprovalSlot(String(b.slot_position || 1)); setDetail({ kind: 'banners', row: b }); }}
              />
            ))}
          </div>
        )
      )}

      {detail && detail.kind === 'payments' && (
        <PaymentDetailModal
          row={detail.row}
          storesById={storesById}
          requestById={requestById}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          busy={busy}
          onClose={() => { if (!busy) { setDetail(null); setRejectReason(''); } }}
          onApprove={() => approvePayment(detail.row)}
          onReject={() => rejectPayment(detail.row)}
        />
      )}

      {detail && detail.kind === 'campaigns' && (
        <CampaignDetailModal
          row={detail.row}
          store={storesById[detail.row.store_id]}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          busy={busy}
          onClose={() => { if (!busy) { setDetail(null); setRejectReason(''); } }}
          onApprove={() => approveCampaign(detail.row)}
          onReject={() => rejectCampaign(detail.row)}
        />
      )}

      {detail && detail.kind === 'coupons' && (
        <CouponDetailModal
          row={detail.row}
          store={storesById[detail.row.store_id]}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          busy={busy}
          onClose={() => { if (!busy) { setDetail(null); setRejectReason(''); } }}
          onApprove={() => approveCoupon(detail.row)}
          onReject={() => rejectCoupon(detail.row)}
        />
      )}

      {detail && detail.kind === 'banners' && (
        <BannerDetailModal
          row={detail.row}
          store={storesById[detail.row.store_id]}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          approvalPosition={approvalPosition}
          setApprovalPosition={setApprovalPosition}
          approvalSlot={approvalSlot}
          setApprovalSlot={setApprovalSlot}
          busy={busy}
          onClose={() => { if (!busy) { setDetail(null); setRejectReason(''); } }}
          onApprove={() => approveBanner(detail.row)}
          onReject={() => rejectBanner(detail.row)}
        />
      )}
    </div>
  );
}

// ───── Payment card / modal (sin cambios funcionales) ─────────────────────────

function PaymentDetailModal({
  row, storesById, requestById, rejectReason, setRejectReason, busy,
  onClose, onApprove, onReject,
}: {
  row: any;
  storesById: Record<string, StoreLite>;
  requestById: Record<string, any>;
  rejectReason: string;
  setRejectReason: (s: string) => void;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const store = storesById[row.store_id];
  const isPaymentPending = (row.status ?? 'pending') === 'pending';
  const linked = row.plan_request_id ? requestById[row.plan_request_id] : null;
  const total = Number(linked?.total_amount_usd ?? 0);
  const paid  = Number(linked?.paid_amount_usd ?? 0);
  const outstanding = Math.max(total - paid, 0);

  return (
    <ModalShell title="Pago" subtitle={store?.name || '—'} idHint={row.id} busy={busy} onClose={onClose}>
      <div className="px-6 py-5 space-y-4 text-sm">
        <DetailRow label="Concepto">
          <span className="text-white/80">{row.item_name}</span>
        </DetailRow>
        {linked?.plan_key && (
          <DetailRow label="Plan">
            <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${PLAN_COLORS[linked.plan_key] || 'text-white/40 bg-white/5'}`}>
              {PLAN_LABELS[linked.plan_key] || linked.plan_key}
            </span>
          </DetailRow>
        )}
        <DetailRow label="Estado">
          <span className="uppercase font-semibold text-[11px]">{row.status ?? 'pending'}</span>
        </DetailRow>
        <DetailRow label="Método">{METHOD_LABEL[row.payment_method] || row.payment_method || '—'}</DetailRow>
        <DetailRow label="Monto USD">
          <span className="text-emerald-300 font-mono">${Number(row.amount_usd ?? 0).toFixed(2)}</span>
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
        <DetailRow label="Ciclos">{row.months_paid || linked?.months_requested || '—'}</DetailRow>
        <DetailRow label="Período">{row.period || '—'}</DetailRow>
        {row.payment_date && (
          <DetailRow label="Fecha pago"><span className="font-mono">{row.payment_date}</span></DetailRow>
        )}

        {linked && total > 0 && (
          <div className="border-t border-white/10 pt-3 space-y-1.5">
            <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium">
              Estado de cuenta de la solicitud
            </p>
            <DetailRow label="Costo total">
              <span className="text-white font-mono">${total.toFixed(2)}</span>
            </DetailRow>
            <DetailRow label="Pagado (aprobado)">
              <span className="text-emerald-300 font-mono">${paid.toFixed(2)}</span>
            </DetailRow>
            <DetailRow label="Saldo pendiente">
              <span className={`font-mono font-bold ${outstanding > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
                ${outstanding.toFixed(2)}
              </span>
            </DetailRow>
          </div>
        )}

        {isPaymentPending && (
          <ApproveRejectFooter
            rejectReason={rejectReason}
            setRejectReason={setRejectReason}
            busy={busy}
            approveLabel="Aprobar pago"
            rejectLabel="Rechazar pago"
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
      </div>
    </ModalShell>
  );
}

function PaymentCard({
  row, store, requestById, onOpen,
}: {
  row: any;
  store?: StoreLite;
  requestById?: Record<string, any>;
  onOpen: () => void;
}) {
  const linked = row.plan_request_id ? requestById?.[row.plan_request_id] : null;
  const planKey = linked?.plan_key || null;
  const planChip = planKey
    ? (PLAN_LABELS[planKey] || planKey)
    : (row.item_name || 'Renovación');
  const planClr = planKey
    ? (PLAN_COLORS[planKey] || 'text-white/40 bg-white/5')
    : 'text-white/70 bg-white/5';

  const st = row.status ?? 'pending';
  const sUi = st === 'completed' ? { txt: 'COMPLETADO', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' }
    : st === 'rejected' ? { txt: 'RECHAZADO',  cls: 'text-red-400 bg-red-500/10 border-red-500/20' }
    : { txt: 'REVISIÓN', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' };

  const isPending = st === 'pending';
  const total = Number(linked?.total_amount_usd ?? 0);
  const paid  = Number(linked?.paid_amount_usd ?? 0);
  const outstanding = Math.max(total - paid, 0);

  return (
    <button
      onClick={onOpen}
      className={`w-full text-left bg-[#0F0F0F] border rounded-xl p-4 transition-all hover:bg-white/[0.04] hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 ${
        isPending ? 'border-amber-500/20' : 'border-white/5'
      }`}
    >
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

      <div className="mb-3">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold whitespace-normal break-words ${planClr}`}>
          {planChip}
        </span>
        {planKey && (
          <span className="ml-1.5 text-[9px] text-white/30 font-mono uppercase">{planKey}</span>
        )}
      </div>

      {total > 0 && (
        <div className="mb-3 bg-white/[0.03] border border-white/5 rounded-lg p-2 grid grid-cols-3 gap-1 text-[10px]">
          <div>
            <p className="text-white/30 uppercase tracking-wider text-[9px]">Total</p>
            <p className="text-white font-mono">${total.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-white/30 uppercase tracking-wider text-[9px]">Pagado</p>
            <p className="text-emerald-300 font-mono">${paid.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-white/30 uppercase tracking-wider text-[9px]">Saldo</p>
            <p className={`font-mono font-bold ${outstanding > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
              ${outstanding.toFixed(2)}
            </p>
          </div>
        </div>
      )}

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
        <div>
          <p className="text-white/30 text-[9px] uppercase tracking-wider">Período</p>
          <p className="text-white/80 truncate">{row.period || '—'}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-[10px] text-white/40 border-t border-white/5 pt-2.5">
        <span>{new Date(row.created_at).toLocaleDateString('es-VE')}</span>
        <span className="text-cyan-300 font-medium">
          {isPending ? 'Validar →' : 'Ver detalle →'}
        </span>
      </div>
    </button>
  );
}

// ───── Campaign card / modal ─────────────────────────────────────────────────

function approvalChip(status: string) {
  if (status === 'approved') return { txt: 'APROBADA', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
  if (status === 'rejected') return { txt: 'RECHAZADA', cls: 'text-red-400 bg-red-500/10 border-red-500/20' };
  return { txt: 'REVISIÓN', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' };
}

function CampaignCard({
  row, store, onOpen,
}: { row: any; store?: StoreLite; onOpen: () => void }) {
  const status = row.approval_status || 'pending';
  const ui = approvalChip(status);
  const isPending = status === 'pending';
  const planLabel = PLAN_LABELS[row.plan_type] || row.plan_type;
  const planClr = PLAN_COLORS[row.plan_type] || 'text-white/40 bg-white/5';
  const isVideo = row.media_type === 'video';

  return (
    <button
      onClick={onOpen}
      className={`w-full text-left bg-[#0F0F0F] border rounded-xl overflow-hidden transition-all hover:bg-white/[0.04] hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-orange-500/40 ${
        isPending ? 'border-amber-500/20' : 'border-white/5'
      }`}
    >
      <div className="h-36 bg-black relative">
        {isVideo
          ? <video src={row.media_url} className="w-full h-full object-cover" muted autoPlay loop playsInline />
          : <img src={row.media_url} className="w-full h-full object-cover" alt={row.brand_name} />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
        <span className={`absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5 rounded border ${ui.cls}`}>
          {ui.txt}
        </span>
        <div className="absolute bottom-2 left-2 right-2">
          <p className="text-white font-semibold truncate">{row.brand_name}</p>
          <p className="text-white/50 text-[10px]">{store?.name || '—'}</p>
        </div>
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${planClr}`}>{planLabel}</span>
          <span className="text-white/40 font-mono text-[10px]">{isVideo ? 'VIDEO' : 'IMAGEN'}</span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-white/40 border-t border-white/5 pt-2">
          <span>{new Date(row.created_at).toLocaleDateString('es-VE')}</span>
          <span className="text-cyan-300 font-medium">{isPending ? 'Revisar →' : 'Ver detalle →'}</span>
        </div>
      </div>
    </button>
  );
}

function CampaignDetailModal({
  row, store, rejectReason, setRejectReason, busy, onClose, onApprove, onReject,
}: {
  row: any;
  store?: StoreLite;
  rejectReason: string;
  setRejectReason: (s: string) => void;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const status = row.approval_status || 'pending';
  const isPending = status === 'pending';
  const isVideo = row.media_type === 'video';
  const ui = approvalChip(status);

  return (
    <ModalShell title="Campaña en revisión" subtitle={row.brand_name} idHint={row.id} busy={busy} onClose={onClose}>
      <div className="px-6 py-5 space-y-4 text-sm">
        <div className="flex justify-center">
          <K2CampaignPreview
            src={row.media_url}
            type={isVideo ? 'video' : 'image'}
            brandName={row.brand_name}
            description={row.description}
            width={220}
          />
        </div>

        <DetailRow label="Estado">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${ui.cls}`}>{ui.txt}</span>
        </DetailRow>
        <DetailRow label="Tienda">{store?.name || '—'}</DetailRow>
        <DetailRow label="Plan">
          <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${PLAN_COLORS[row.plan_type] || 'text-white/40 bg-white/5'}`}>
            {PLAN_LABELS[row.plan_type] || row.plan_type}
          </span>
        </DetailRow>
        <DetailRow label="Tipo de media">{isVideo ? 'Video' : 'Imagen'}</DetailRow>
        <DetailRow label="Inicio"><span className="font-mono">{row.start_date || '—'}</span></DetailRow>
        <DetailRow label="Fin"><span className="font-mono">{row.end_date || '—'}</span></DetailRow>
        <DetailRow label="Duración"><span className="font-mono">{row.duration_seconds ?? 15}s</span></DetailRow>
        {row.description && (
          <DetailRow label="Descripción">
            <pre className="whitespace-pre-wrap text-[11px] text-white/60 font-sans">{row.description}</pre>
          </DetailRow>
        )}
        {row.rejection_reason && !isPending && (
          <DetailRow label="Motivo rechazo">
            <pre className="whitespace-pre-wrap text-[11px] text-red-300 font-sans">{row.rejection_reason}</pre>
          </DetailRow>
        )}

        {isPending && (
          <ApproveRejectFooter
            rejectReason={rejectReason}
            setRejectReason={setRejectReason}
            busy={busy}
            approveLabel="Aprobar campaña"
            rejectLabel="Rechazar campaña"
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
      </div>
    </ModalShell>
  );
}

// ───── Coupon card / modal ───────────────────────────────────────────────────

function CouponCard({
  row, store, onOpen,
}: { row: any; store?: StoreLite; onOpen: () => void }) {
  const status = row.approval_status || 'pending';
  const ui = approvalChip(status);
  const isPending = status === 'pending';
  const planLabel = PLAN_LABELS[row.plan_type] || row.plan_type;
  const planClr = PLAN_COLORS[row.plan_type] || 'text-white/40 bg-white/5';

  return (
    <button
      onClick={onOpen}
      className={`w-full text-left bg-[#0F0F0F] border rounded-xl overflow-hidden transition-all hover:bg-white/[0.04] hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 ${
        isPending ? 'border-amber-500/20' : 'border-white/5'
      }`}
    >
      <div className="h-36 bg-black relative">
        {row.image_url
          ? <img src={row.image_url} className="w-full h-full object-cover" alt={row.title} />
          : <div className="w-full h-full flex items-center justify-center text-white/20 text-xs">Sin imagen</div>}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
        <span className={`absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5 rounded border ${ui.cls}`}>
          {ui.txt}
        </span>
        <div className="absolute bottom-2 left-2 right-2">
          <p className="text-white font-semibold truncate">{row.title}</p>
          <p className="text-white/50 text-[10px]">{store?.name || '—'}</p>
        </div>
      </div>
      <div className="p-3 space-y-2 text-[11px]">
        <div className="flex items-center justify-between">
          <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${planClr}`}>{planLabel}</span>
          <span className="text-white/40 font-mono text-[10px]">{row.amount_available} disp.</span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-white/40 border-t border-white/5 pt-2">
          <span>{new Date(row.created_at).toLocaleDateString('es-VE')}</span>
          <span className="text-cyan-300 font-medium">{isPending ? 'Revisar →' : 'Ver detalle →'}</span>
        </div>
      </div>
    </button>
  );
}

function CouponDetailModal({
  row, store, rejectReason, setRejectReason, busy, onClose, onApprove, onReject,
}: {
  row: any;
  store?: StoreLite;
  rejectReason: string;
  setRejectReason: (s: string) => void;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const status = row.approval_status || 'pending';
  const isPending = status === 'pending';
  const ui = approvalChip(status);
  const startStr = row.start_date ? new Date(row.start_date).toLocaleDateString('es-VE') : '—';
  const endStr   = row.end_date   ? new Date(row.end_date).toLocaleDateString('es-VE')   : '—';

  return (
    <ModalShell title="Cupón en revisión" subtitle={row.title} idHint={row.id} busy={busy} onClose={onClose}>
      <div className="px-6 py-5 space-y-4 text-sm">
        <div className="relative w-full aspect-[4/3] max-h-[40vh] mx-auto bg-black border border-white/10 rounded-xl overflow-hidden flex items-center justify-center">
          {row.image_url
            ? <img src={row.image_url} className="max-w-full max-h-full object-contain" alt={row.title} />
            : <span className="text-white/30 text-xs">Sin imagen</span>}
        </div>

        <DetailRow label="Estado">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${ui.cls}`}>{ui.txt}</span>
        </DetailRow>
        <DetailRow label="Tienda">{store?.name || '—'}</DetailRow>
        <DetailRow label="Plan">
          <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${PLAN_COLORS[row.plan_type] || 'text-white/40 bg-white/5'}`}>
            {PLAN_LABELS[row.plan_type] || row.plan_type}
          </span>
        </DetailRow>
        <DetailRow label="Código"><span className="font-mono text-white/70">{row.code || '—'}</span></DetailRow>
        <DetailRow label="Descuento"><span className="font-mono text-emerald-300">{row.discount_percent}%</span></DetailRow>
        <DetailRow label="Stock"><span className="font-mono">{row.amount_available}</span></DetailRow>
        <DetailRow label="Categoría">{row.category || '—'}</DetailRow>
        <DetailRow label="Vigencia">
          <span className="font-mono">{startStr} → {endStr}</span>
        </DetailRow>
        {row.rejection_reason && !isPending && (
          <DetailRow label="Motivo rechazo">
            <pre className="whitespace-pre-wrap text-[11px] text-red-300 font-sans">{row.rejection_reason}</pre>
          </DetailRow>
        )}

        {isPending && (
          <ApproveRejectFooter
            rejectReason={rejectReason}
            setRejectReason={setRejectReason}
            busy={busy}
            approveLabel="Aprobar cupón"
            rejectLabel="Rechazar cupón"
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
      </div>
    </ModalShell>
  );
}

// ───── Shared primitives ─────────────────────────────────────────────────────

function ModalShell({
  title, subtitle, idHint, busy, onClose, children,
}: {
  title: string;
  subtitle: string;
  idHint: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-5 border-b border-white/10 flex items-start justify-between sticky top-0 bg-[#0E0E0E]/95 backdrop-blur z-10">
          <div>
            <p className="text-[11px] text-white/40 uppercase tracking-widest mb-1">{title}</p>
            <h3 className="text-xl font-bold text-white">{subtitle}</h3>
            <p className="text-[11px] text-white/40 font-mono mt-1">#{(idHint || '').slice(0, 8)}</p>
          </div>
          <button onClick={onClose} disabled={busy} className="text-white/40 hover:text-white/80 disabled:opacity-30">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ApproveRejectFooter({
  rejectReason, setRejectReason, busy, approveLabel, rejectLabel, onApprove, onReject,
}: {
  rejectReason: string;
  setRejectReason: (s: string) => void;
  busy: boolean;
  approveLabel: string;
  rejectLabel: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
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
          placeholder="Ej: imagen con texto ilegible / material fuera de marca"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={onReject} disabled={busy}
          className="flex-1 px-4 py-2.5 text-sm font-semibold bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 rounded-lg disabled:opacity-50"
        >
          {busy ? 'Procesando…' : rejectLabel}
        </button>
        <button
          onClick={onApprove} disabled={busy}
          className="flex-1 px-4 py-2.5 text-sm font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 rounded-lg disabled:opacity-50"
        >
          {busy ? 'Procesando…' : approveLabel}
        </button>
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

function BannerCard({
  row, store, onOpen,
}: { row: any; store?: StoreLite; onOpen: () => void }) {
  const status = row.approval_status || 'pending';
  const ui = approvalChip(status);
  const isPending = status === 'pending';
  const isVideo = row.media_type === 'video';

  return (
    <button
      onClick={onOpen}
      className={`w-full text-left bg-[#0F0F0F] border rounded-xl overflow-hidden transition-all hover:bg-white/[0.04] hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 ${
        isPending ? 'border-amber-500/20' : 'border-white/5'
      }`}
    >
      <div className="h-36 bg-black relative">
        {isVideo
          ? <video src={row.media_url} className="w-full h-full object-cover" muted autoPlay loop playsInline />
          : <img src={row.media_url} className="w-full h-full object-cover" alt="Banner" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
        <span className={`absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5 rounded border ${ui.cls}`}>
          {ui.txt}
        </span>
        <div className="absolute bottom-2 left-2 right-2">
          <p className="text-white font-semibold truncate">Banner: {row.ui_position}</p>
          <p className="text-white/50 text-[10px]">{store?.name || '—'}</p>
        </div>
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="px-2 py-0.5 rounded text-[10px] font-semibold text-emerald-300 bg-emerald-500/10">DIAMANTE</span>
          <span className="text-white/40 font-mono text-[10px]">Slot {row.slot_position || 1}</span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-white/40 border-t border-white/5 pt-2">
          <span>{row.created_at ? new Date(row.created_at).toLocaleDateString('es-VE') : '—'}</span>
          <span className="text-cyan-300 font-medium">{isPending ? 'Revisar →' : 'Ver detalle →'}</span>
        </div>
      </div>
    </button>
  );
}

function BannerDetailModal({
  row, store, rejectReason, setRejectReason,
  approvalPosition, setApprovalPosition, approvalSlot, setApprovalSlot,
  busy, onClose, onApprove, onReject,
}: {
  row: any;
  store?: StoreLite;
  rejectReason: string;
  setRejectReason: (s: string) => void;
  approvalPosition: string;
  setApprovalPosition: (s: string) => void;
  approvalSlot: string;
  setApprovalSlot: (s: string) => void;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const status = row.approval_status || 'pending';
  const isPending = status === 'pending';
  const isVideo = row.media_type === 'video';
  const ui = approvalChip(status);
  const positionValid = approvalPosition === 'top' || approvalPosition === 'bottom';

  return (
    <ModalShell title="Banner en revisión" subtitle={`${store?.name || '—'} · ${row.media_type?.toUpperCase()}`} idHint={row.id} busy={busy} onClose={onClose}>
      <div className="px-6 py-5 space-y-4 text-sm">
        <div className="flex items-start gap-4">
          <K2BannerPreview
            src={row.media_url}
            type={isVideo ? 'video' : 'image'}
            position={approvalPosition === 'bottom' ? 'bottom' : 'top'}
            previewWidth={140}
          />
          <div className="flex-1 bg-black border border-white/10 rounded-xl overflow-hidden" style={{ minHeight: 140 }}>
            {isVideo
              ? <video src={row.media_url} className="w-full h-full object-contain max-h-52" controls autoPlay loop playsInline />
              : <img src={row.media_url} className="w-full object-contain max-h-52" alt="Banner Preview" />}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/5 pt-3 text-[13px]">
          <div>
            <p className="text-white/40 font-medium">Tienda</p>
            <p className="text-white font-semibold">{store?.name || '—'}</p>
          </div>
          <div>
            <p className="text-white/40 font-medium">Tipo</p>
            <p className="text-white font-semibold uppercase">{row.media_type}</p>
          </div>
          <div>
            <p className="text-white/40 font-medium">Estado actual</p>
            <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border mt-0.5 ${ui.cls}`}>
              {ui.txt}
            </span>
          </div>
          <div>
            <p className="text-white/40 font-medium">Fechas</p>
            <p className="text-white font-semibold text-[11px] font-mono">
              {row.start_date ? row.start_date.split('T')[0] : '—'}
              {row.end_date ? ` → ${row.end_date.split('T')[0]}` : ''}
            </p>
          </div>
        </div>

        {/* Asignación de posición y slot — editable para el admin */}
        <div className="bg-cyan-500/[0.05] border border-cyan-500/20 rounded-lg p-3 space-y-3">
          <p className="text-[11px] text-cyan-200/80 font-semibold uppercase tracking-wider">
            Asignar posición en K2
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">Posición</label>
              <select
                value={approvalPosition}
                onChange={e => setApprovalPosition(e.target.value)}
                className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                <option value="top">top — franja superior</option>
                <option value="bottom">bottom — franja inferior</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">Slot #</label>
              <input
                type="number"
                min="1"
                max="22"
                value={approvalSlot}
                onChange={e => setApprovalSlot(e.target.value)}
                className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>
          {!positionValid && (
            <p className="text-[10px] text-amber-300">
              Solo "top" y "bottom" son renderizados por el K2. Otros valores no aparecerán en pantalla.
            </p>
          )}
          <p className="text-[10px] text-white/35">
            El banner aparecerá en el K2 en los próximos 3 minutos tras la aprobación (polling de caché).
          </p>
        </div>

        {row.rejection_reason && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-red-200 text-xs">
            <span className="font-bold">Motivo de rechazo:</span> {row.rejection_reason}
          </div>
        )}

        {isPending ? (
          <div className="border-t border-white/5 pt-4 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-white/55 uppercase tracking-wider mb-1">
                Motivo de rechazo (opcional)
              </label>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="Escribe la razón si vas a rechazar este banner..."
                className="w-full h-16 bg-black border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onReject}
                className="flex-1 py-2 text-xs font-semibold bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-200 rounded-lg transition-colors"
              >
                Rechazar banner
              </button>
              <button
                type="button"
                onClick={onApprove}
                disabled={!positionValid}
                className="flex-1 py-2 text-xs font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Aprobar banner
              </button>
            </div>
          </div>
        ) : (
          <div className="flex pt-2">
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2 text-xs font-semibold bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
