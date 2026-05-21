'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
  FLASH_COUPON_DIARIO: 'Flash Coupon · Diario',
  FLASH_COUPON_SEMANAL: 'Flash Coupon · Semanal',
  PROMO_FLASH: 'Promo Flash',
};

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10',
  ORO: 'text-amber-400 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-400 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-400 bg-blue-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-400 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-400 bg-pink-500/10',
  PROMO_FLASH: 'text-pink-400 bg-pink-500/10',
};

type Range = '7d' | '30d' | '90d' | 'all';
const RANGE_LABELS: Record<Range, string> = {
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
  '90d': 'Últimos 90 días',
  'all': 'Todo',
};

function rangeStart(r: Range): string | null {
  if (r === 'all') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const days = r === '7d' ? 6 : r === '30d' ? 29 : 89;
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export default function ClienteDashboardPage() {
  const { selectedStore: store } = useClienteStore();
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [impressions, setImpressions] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [range, setRange] = useState<Range>('30d');
  const [loading, setLoading] = useState(true);

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  useEffect(() => {
    if (!store) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const start = rangeStart(range);

        const [campRes, couponsRes, reqRes] = await Promise.all([
          supabase.from('ad_campaigns')
            .select('id, brand_name, plan_type, start_date, end_date, is_active, payment_status, suspended_at, created_at, media_url, media_type, duration_seconds')
            .eq('store_id', store.id).order('created_at', { ascending: false }),
          supabase.from('coupons')
            .select('id, title, plan_type, code, amount_available, price_usd, category, start_date, end_date, campaign_id, created_at')
            .eq('store_id', store.id).order('created_at', { ascending: false }),
          supabase.from('plan_requests')
            .select('*')
            .eq('store_id', store.id)
            .order('created_at', { ascending: false }),
        ]);

        if (cancelled) return;
        const camps = campRes.data || [];
        const cps = couponsRes.data || [];
        setCampaigns(camps);
        setCoupons(cps);
        setRequests(reqRes.data || []);

        const campIds = camps.map(c => c.id);
        let impQ = supabase.from('ad_impressions_daily')
          .select('campaign_id, kiosk_id, day, count')
          .order('day', { ascending: false });
        if (campIds.length) impQ = impQ.in('campaign_id', campIds);
        else impQ = impQ.eq('campaign_id', '00000000-0000-0000-0000-000000000000');
        if (start) impQ = impQ.gte('day', start.split('T')[0]);
        const impRes = await impQ;

        const ids = [store.id, ...camps.map(c => c.id), ...cps.map(c => c.id)].filter(Boolean);
        const evSelect = 'id, kiosk_id, event_type, module, item_id, item_name, created_at, event_data';
        const evQueries: any[] = [];
        if (ids.length) {
          let q1: any = supabase.from('analytics_events').select(evSelect)
            .in('item_id', ids).order('created_at', { ascending: false }).limit(5000);
          if (start) q1 = q1.gte('created_at', start);
          evQueries.push(q1);
        }
        let q2: any = supabase.from('analytics_events').select(evSelect)
          .eq('item_name', store.name).order('created_at', { ascending: false }).limit(5000);
        if (start) q2 = q2.gte('created_at', start);
        evQueries.push(q2);
        const evResults = await Promise.all(evQueries);
        if (cancelled) return;

        const dedup = new Map<string, any>();
        for (const r of evResults) for (const e of (r.data || [])) dedup.set(e.id, e);

        setImpressions(impRes.data || []);
        setEvents(Array.from(dedup.values()).sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range, store]);

  const totalImpressions = useMemo(() =>
    impressions.reduce((s, d) => s + (d.count || 0), 0), [impressions]);

  const storeClicks = useMemo(() =>
    events.filter(e => (e.event_type === 'click' || e.event_type === 'tap') &&
      (e.item_id === store?.id || e.item_name === store?.name)).length,
    [events, store]);

  const searchClicks = useMemo(() =>
    events.filter(e => e.event_type === 'search_click' &&
      (e.item_id === store?.id || e.item_name === store?.name)).length,
    [events, store]);

  const flashShown = useMemo(() => {
    const couponIds = new Set(coupons.map(c => c.id));
    return events.filter(e => e.event_type === 'flash_coupon_shown' &&
      (couponIds.has(e.item_id) || e.item_name === store?.name)).length;
  }, [events, coupons, store]);

  const uniqueKiosks = useMemo(() => {
    const set = new Set<string>();
    for (const d of impressions) if (d.kiosk_id) set.add(d.kiosk_id);
    for (const e of events) if (e.kiosk_id) set.add(e.kiosk_id);
    return set.size;
  }, [impressions, events]);

  const activeCampaign = useMemo(() =>
    campaigns.find(c => c.is_active &&
      (!c.end_date || c.end_date >= today) &&
      (!c.start_date || c.start_date <= today) &&
      (c.payment_status ?? 'pending') !== 'overdue' &&
      !c.suspended_at) || null,
    [campaigns, today]);

  const pendingRequests = useMemo(
    () => requests.filter(r => r.status === 'pending').length,
    [requests]
  );

  const nextRenewal = useMemo(() => {
    const dates = requests
      .filter(r => r.status === 'approved' && r.expires_at && r.expires_at >= today)
      .map(r => r.expires_at as string)
      .sort();
    return dates[0] || null;
  }, [requests, today]);

  // Cambio de plan ya aprobado y pagado, pendiente de activarse
  const scheduledChange = useMemo(() => {
    return requests.find(r =>
      r.status === 'approved'
      && r.effective_date
      && r.effective_date > today
    ) || null;
  }, [requests, today]);

  // Solicitud aún en revisión por la administración
  const pendingChange = useMemo(() => {
    return requests.find(r => r.status === 'pending' || r.status === 'partial') || null;
  }, [requests]);

  const expiryDaysLeft = useMemo<number | null>(() => {
    if (!store?.contract_expiry_date) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(store.contract_expiry_date + 'T00:00:00');
    return Math.round((exp.getTime() - today.getTime()) / 86400000);
  }, [store]);

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20">
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center">
          <svg className="w-12 h-12 text-amber-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <h2 className="text-xl font-bold text-white mb-2">Sin tiendas vinculadas</h2>
          <p className="text-white/60 text-sm">
            Tu cuenta aún no está vinculada a ninguna tienda del directorio. Contacta a la administración para que vinculen tu cuenta.
          </p>
        </div>
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
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Dashboard</p>
          <h2 className="text-2xl font-bold text-white">{store.name}</h2>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {store.plan_type ? (
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider ${PLAN_COLORS[store.plan_type] || 'text-white/40 bg-white/5'}`}>
                {PLAN_LABELS[store.plan_type] || store.plan_type}
              </span>
            ) : (
              <span className="text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded text-[10px] font-semibold">
                Sin plan asignado
              </span>
            )}
            {store.categories?.name && (
              <span className="text-white/40 bg-white/5 px-2 py-0.5 rounded text-[10px]">{store.categories.name}</span>
            )}
            <span className="text-white/30 text-[10px] font-mono">
              {store.floor_level} · {store.local_number}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 bg-white/[0.03] border border-white/10 rounded-lg p-1">
          {(['7d', '30d', '90d', 'all'] as Range[]).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                range === r ? 'bg-cyan-500/20 text-cyan-300' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {store.plan_type && store.contract_expiry_date && expiryDaysLeft != null
        && expiryDaysLeft <= 7 && expiryDaysLeft >= 0
        && !scheduledChange && !pendingChange && (
        <div className={`border rounded-xl p-4 flex items-start gap-3 ${
          expiryDaysLeft <= 1
            ? 'bg-red-500/10 border-red-500/30'
            : expiryDaysLeft <= 3
              ? 'bg-orange-500/10 border-orange-500/30'
              : 'bg-amber-500/10 border-amber-500/30'
        }`}>
          <svg className={`w-5 h-5 mt-0.5 shrink-0 ${
            expiryDaysLeft <= 1 ? 'text-red-300'
            : expiryDaysLeft <= 3 ? 'text-orange-300'
            : 'text-amber-300'
          }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold ${
              expiryDaysLeft <= 1 ? 'text-red-200'
              : expiryDaysLeft <= 3 ? 'text-orange-200'
              : 'text-amber-200'
            }`}>
              {expiryDaysLeft === 0
                ? `Tu plan ${PLAN_LABELS[store.plan_type] || store.plan_type} vence HOY`
                : expiryDaysLeft === 1
                ? `Tu plan ${PLAN_LABELS[store.plan_type] || store.plan_type} vence MAÑANA`
                : `Tu plan ${PLAN_LABELS[store.plan_type] || store.plan_type} vence en ${expiryDaysLeft} días`}
            </p>
            <p className="text-xs text-white/70 mt-1 leading-relaxed">
              Si no registras la renovación antes del{' '}
              <span className="font-mono font-semibold">{store.contract_expiry_date}</span>,
              tu slot quedará libre y otra empresa podrá tomarlo. Renueva ahora para mantenerlo.
            </p>
            <Link
              href="/cliente/pagos"
              className="inline-block mt-2.5 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 rounded-md px-3 py-1.5"
            >
              Renovar ahora →
            </Link>
          </div>
        </div>
      )}

      {(store.plan_type || store.flash_coupon_plan || scheduledChange || pendingChange) && (
        <div className="bg-[#0A0A0A] border border-white/10 rounded-2xl overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/10">
            {/* Plan vigente */}
            <div className="p-5">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">
                Plan vigente
              </p>
              {store.plan_type ? (
                <>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="text-xl font-bold text-white">
                      {PLAN_LABELS[store.plan_type] || store.plan_type}
                    </h3>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider ${PLAN_COLORS[store.plan_type] || 'text-white/40 bg-white/5'}`}>
                      ACTIVO
                    </span>
                  </div>
                  {store.contract_expiry_date ? (
                    <p className="text-xs mt-2">
                      <span className="text-white/40">Vence el </span>
                      <span className={`font-mono font-semibold ${
                        expiryDaysLeft != null && expiryDaysLeft < 0 ? 'text-red-400'
                        : expiryDaysLeft != null && expiryDaysLeft <= 7 ? 'text-amber-300'
                        : 'text-white/80'
                      }`}>
                        {store.contract_expiry_date}
                      </span>
                      {expiryDaysLeft != null && expiryDaysLeft >= 0 && (
                        <span className="text-white/40"> · en {expiryDaysLeft} día{expiryDaysLeft === 1 ? '' : 's'}</span>
                      )}
                      {expiryDaysLeft != null && expiryDaysLeft < 0 && (
                        <span className="text-red-400"> · vencido</span>
                      )}
                    </p>
                  ) : (
                    <p className="text-xs mt-2 text-white/40">Sin fecha de vencimiento configurada</p>
                  )}
                  {!scheduledChange && !pendingChange && store.contract_expiry_date && (
                    <Link href="/cliente/pagos" className="inline-block mt-3 text-[11px] text-cyan-300 hover:text-cyan-200 font-medium">
                      Renovar →
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <h3 className="text-xl font-bold text-amber-300">Sin plan asignado</h3>
                  <p className="text-xs text-white/40 mt-2">Tu tienda aún no tiene un plan publicitario activo.</p>
                  <Link href="/cliente/planes" className="inline-block mt-3 text-[11px] text-cyan-300 hover:text-cyan-200 font-medium">
                    Ver catálogo de planes →
                  </Link>
                </>
              )}
              {/* Addon Flash Coupon (independiente del plan base) */}
              {store.flash_coupon_plan && (() => {
                const exp = store.flash_coupon_expiry_date;
                const expired = exp ? exp < today : false;
                return (
                  <div className="mt-4 pt-3 border-t border-white/5">
                    <p className="text-[10px] text-pink-300/70 uppercase tracking-widest font-medium mb-1.5">
                      Addon Flash Coupon
                    </p>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-bold text-white">
                        {PLAN_LABELS[store.flash_coupon_plan] || store.flash_coupon_plan}
                      </span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider ${
                        expired
                          ? 'bg-red-500/15 text-red-400'
                          : 'bg-pink-500/15 text-pink-300'
                      }`}>
                        {expired ? 'VENCIDO' : 'ACTIVO'}
                      </span>
                    </div>
                    {exp && (
                      <p className="text-[11px] mt-1 text-white/50">
                        {expired ? 'Venció el ' : 'Vence el '}
                        <span className="font-mono">{exp}</span>
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Próximo plan (agendado o en revisión) */}
            <div className={`p-5 ${
              scheduledChange ? 'bg-cyan-500/5'
              : pendingChange ? 'bg-amber-500/5'
              : ''
            }`}>
              {scheduledChange ? (
                <>
                  <p className="text-[10px] text-cyan-300/80 uppercase tracking-widest font-medium mb-2 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    Próximo plan · pago confirmado
                  </p>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="text-xl font-bold text-white">
                      {PLAN_LABELS[scheduledChange.plan_key] || scheduledChange.plan_key}
                    </h3>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider ${PLAN_COLORS[scheduledChange.plan_key] || 'text-white/40 bg-white/5'}`}>
                      AGENDADO
                    </span>
                  </div>
                  <p className="text-xs mt-2">
                    <span className="text-white/40">Se activa el </span>
                    <span className="font-mono font-semibold text-cyan-200">
                      {scheduledChange.effective_date}
                    </span>
                    {scheduledChange.expires_at && (
                      <>
                        <span className="text-white/40"> · vence el </span>
                        <span className="font-mono text-white/70">{scheduledChange.expires_at}</span>
                      </>
                    )}
                  </p>
                  <p className="text-[10px] text-white/40 mt-2">
                    Tu plan actual sigue activo hasta su fecha de vencimiento. El cambio entra en
                    vigor automáticamente al día siguiente.
                  </p>
                </>
              ) : pendingChange ? (
                <>
                  <p className="text-[10px] text-amber-300/80 uppercase tracking-widest font-medium mb-2 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    Solicitud en revisión
                  </p>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="text-xl font-bold text-white">
                      {PLAN_LABELS[pendingChange.plan_key] || pendingChange.plan_key}
                    </h3>
                    <span className="text-[10px] font-semibold tracking-wider text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                      {pendingChange.status === 'partial' ? 'PARCIAL' : 'PENDIENTE'}
                    </span>
                  </div>
                  {(() => {
                    const total = Number(pendingChange.total_amount_usd ?? 0);
                    const paid  = Number(pendingChange.paid_amount_usd ?? 0);
                    const outstanding = Math.max(total - paid, 0);
                    if (total <= 0) return null;
                    return (
                      <div className="grid grid-cols-3 gap-2 mt-3">
                        <div className="bg-white/[0.04] rounded p-1.5 text-center">
                          <p className="text-[9px] text-white/40 uppercase">Total</p>
                          <p className="text-white font-mono text-xs font-bold">${total.toFixed(2)}</p>
                        </div>
                        <div className="bg-white/[0.04] rounded p-1.5 text-center">
                          <p className="text-[9px] text-white/40 uppercase">Pagado</p>
                          <p className="text-emerald-300 font-mono text-xs font-bold">${paid.toFixed(2)}</p>
                        </div>
                        <div className="bg-amber-500/10 rounded p-1.5 text-center">
                          <p className="text-[9px] text-amber-300/70 uppercase">Saldo</p>
                          <p className="text-amber-300 font-mono text-xs font-bold">${outstanding.toFixed(2)}</p>
                        </div>
                      </div>
                    );
                  })()}
                  <p className="text-xs mt-2 text-white/60">
                    {pendingChange.status === 'partial'
                      ? 'Solicitud en curso con saldo pendiente. Reporta el faltante para activar el plan.'
                      : 'La administración está verificando tu pago. Te notificaremos al aprobarse.'}
                  </p>
                  <Link href="/cliente/planes" className="inline-block mt-3 text-[11px] text-amber-300 hover:text-amber-200 font-medium">
                    {pendingChange.status === 'partial' ? 'Reportar abono →' : 'Ver solicitud →'}
                  </Link>
                </>
              ) : (
                <>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">
                    Próximo plan
                  </p>
                  <p className="text-sm text-white/40">Sin cambios programados.</p>
                  <p className="text-[10px] text-white/30 mt-2 leading-relaxed">
                    Para cambiar de plan, solicita el plan deseado en el catálogo y reporta el pago.
                    El cambio se activará cuando tu plan actual venza.
                  </p>
                  <Link href="/cliente/planes" className="inline-block mt-3 text-[11px] text-cyan-300 hover:text-cyan-200 font-medium">
                    Ver catálogo →
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Impresiones" value={totalImpressions.toLocaleString('es-VE')} accent="text-orange-400"
          sub={`Reproducciones en K2 · ${RANGE_LABELS[range].toLowerCase()}`} />
        <Tile label="Clicks en directorio" value={storeClicks.toLocaleString('es-VE')} accent="text-violet-400"
          sub="click + tap sobre tu tienda" />
        <Tile label="Veces buscada" value={searchClicks.toLocaleString('es-VE')} accent="text-sky-400"
          sub="Clic tras búsqueda" />
        <Tile label="Apariciones flash" value={flashShown.toLocaleString('es-VE')} accent="text-pink-400"
          sub="Cupones flash mostrados" />
        <Tile label="Campaña activa" accent={activeCampaign ? 'text-emerald-400' : 'text-white/40'}
          value={activeCampaign ? 'Sí' : 'No'}
          sub={activeCampaign ? `Vence ${activeCampaign.end_date || '—'}` : `${campaigns.length} campañas totales`} />
        <Tile label="Cupones activos" value={coupons.filter(c =>
          (!c.end_date || c.end_date.split('T')[0] >= today)).length}
          accent="text-cyan-400" sub={`${coupons.length} históricos`} />
        <Tile label="Kioscos únicos" value={uniqueKiosks} sub="K2 con actividad de tu tienda" />
        <Tile label="Estado contrato"
          accent={store.contract_expiry_date && store.contract_expiry_date < today ? 'text-red-400' : 'text-white/70'}
          value={store.contract_expiry_date
            ? (store.contract_expiry_date < today ? 'Vencido' : 'Vigente')
            : '—'}
          sub={store.contract_expiry_date ? `Vence ${store.contract_expiry_date}` : 'Sin contrato'} />
        <Tile label="Próximo vencimiento"
          accent={nextRenewal ? 'text-amber-300' : 'text-white/40'}
          value={nextRenewal || '—'}
          sub={nextRenewal ? 'Recuerda renovar antes' : 'Sin plan aprobado'} />
        <Tile label="Solicitudes pendientes"
          accent={pendingRequests > 0 ? 'text-amber-300' : 'text-white/40'}
          value={pendingRequests}
          sub={`${requests.length} solicitudes totales`} />
      </div>


      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Campañas ({campaigns.length})</p>
        {campaigns.length === 0 ? (
          <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4 text-center text-white/30 text-xs">
            Aún no tienes campañas. <Link href="/cliente/planes" className="text-cyan-400 hover:underline">Solicita un plan</Link> para activarlas.
          </div>
        ) : (
          <div className="bg-white/[0.02] border border-white/5 rounded-lg overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                  <th className="px-3 py-2 font-medium">Marca</th>
                  <th className="px-3 py-2 font-medium">Plan</th>
                  <th className="px-3 py-2 font-medium">Vigencia</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2 font-medium text-right">Impresiones</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => {
                  const imp = impressions
                    .filter(d => d.campaign_id === c.id)
                    .reduce((s, d) => s + (d.count || 0), 0);
                  const live = c.is_active && (!c.end_date || c.end_date >= today);
                  return (
                    <tr key={c.id} className="border-b border-white/[0.03]">
                      <td className="px-3 py-2 text-white/80">{c.brand_name}</td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
                          {PLAN_LABELS[c.plan_type] || c.plan_type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-white/40 font-mono">{c.start_date || '—'} → {c.end_date || '∞'}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] font-medium ${live ? 'text-emerald-400' : 'text-white/30'}`}>
                          {c.suspended_at ? 'Suspendida' : live ? 'Activa' : 'Inactiva'}
                        </span>
                        {c.payment_status && c.payment_status !== 'paid' && (
                          <span className="ml-1.5 text-[9px] text-amber-400">· {c.payment_status}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-white/70">{imp.toLocaleString('es-VE')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {coupons.length > 0 && (
        <div>
          <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Cupones ({coupons.length})</p>
          <div className="bg-white/[0.02] border border-white/5 rounded-lg overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                  <th className="px-3 py-2 font-medium">Cupón</th>
                  <th className="px-3 py-2 font-medium">Plan</th>
                  <th className="px-3 py-2 font-medium">Vigencia</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map(c => {
                  const live = (!c.end_date || c.end_date.split('T')[0] >= today) &&
                               (!c.start_date || c.start_date.split('T')[0] <= today);
                  return (
                    <tr key={c.id} className="border-b border-white/[0.03]">
                      <td className="px-3 py-2 text-white/80">
                        {c.title}
                        <span className={`ml-2 text-[9px] ${live ? 'text-emerald-400' : 'text-white/30'}`}>
                          {live ? '● activo' : '○ vencido'}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
                          {PLAN_LABELS[c.plan_type] || c.plan_type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-white/40 font-mono">
                        {(c.start_date || '').split('T')[0] || '—'} → {(c.end_date || '').split('T')[0] || '∞'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Link href="/cliente/planes" className="bg-cyan-500/5 hover:bg-cyan-500/10 border border-cyan-500/20 hover:border-cyan-500/40 rounded-xl p-4 transition-colors">
          <p className="text-cyan-300 text-sm font-semibold mb-1">Solicitar un plan</p>
          <p className="text-white/40 text-xs">Mira el catálogo y solicita el plan que mejor se adapte a tu tienda.</p>
        </Link>
        <Link href="/cliente/pagos" className="bg-emerald-500/5 hover:bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40 rounded-xl p-4 transition-colors">
          <p className="text-emerald-300 text-sm font-semibold mb-1">Registrar un pago</p>
          <p className="text-white/40 text-xs">Reporta el pago de tu plan publicitario y mantén tu campaña activa.</p>
        </Link>
        <Link href="/cliente/tutorial" className="bg-amber-500/5 hover:bg-amber-500/10 border border-amber-500/20 hover:border-amber-500/40 rounded-xl p-4 transition-colors">
          <p className="text-amber-300 text-sm font-semibold mb-1">Tutorial & Centro de Pagos</p>
          <p className="text-white/40 text-xs">Guía de arte, especificaciones técnicas y cuentas para reportar tu pago.</p>
        </Link>
      </div>
    </div>
  );
}

function Tile({ label, value, accent, sub }: { label: string; value: React.ReactNode; accent?: string; sub?: string }) {
  return (
    <div className="bg-[#0A0A0A] border border-white/5 rounded-lg p-3.5">
      <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium mb-1.5">{label}</p>
      <p className={`text-xl font-semibold ${accent || 'text-white'} leading-none`}>{value}</p>
      {sub && <p className="text-[10px] text-white/30 mt-1.5">{sub}</p>}
    </div>
  );
}
