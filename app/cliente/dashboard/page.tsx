'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';
import { AbonoModal, AbonoRequest } from '../abono-modal';
import { downloadCSV, slugify } from '../../../lib/csv';
import { PLAN_LABELS, PLAN_BADGE as PLAN_COLORS } from '../../../lib/plans';
import { toast } from '../../components/toast';
import { ErrorState } from '../../components/ErrorState';
import { PageSpinner } from '../../components/PageSpinner';

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

type StoreMetrics = {
  campaigns: any[];
  coupons: any[];
  impressions: any[];
  searchRows: any[];
  couponRows: any[];
};

// Consulta las métricas de una tienda en el rango dado. El RLS de Supabase
// limita las filas a las tiendas vinculadas a la cuenta del cliente.
async function fetchStoreMetrics(storeId: string, startDay: string | null): Promise<StoreMetrics> {
  const [campRes, couponsRes] = await Promise.all([
    supabase.from('ad_campaigns')
      .select('id, brand_name, plan_type, start_date, end_date, is_active, created_at')
      .eq('store_id', storeId).order('created_at', { ascending: false }),
    supabase.from('coupons')
      .select('id, title, plan_type, code, amount_available, discount_percent, category, start_date, end_date, campaign_id, created_at')
      .eq('store_id', storeId).order('created_at', { ascending: false }),
  ]);

  // Las tablas core (campañas/cupones) son la fuente del dashboard: si fallan,
  // propagamos el error para mostrar un estado de error en vez de "vacío".
  if (campRes.error) throw campRes.error;
  if (couponsRes.error) throw couponsRes.error;
  const campaigns = campRes.data || [];
  const coupons = couponsRes.data || [];
  const campIds = campaigns.map(c => c.id);

  let impQ = supabase.from('ad_impressions_daily')
    .select('campaign_id, kiosk_id, day, count, impressions_valid, full_views')
    .order('day', { ascending: false });
  impQ = campIds.length
    ? impQ.in('campaign_id', campIds)
    : impQ.eq('campaign_id', '00000000-0000-0000-0000-000000000000');
  if (startDay) impQ = impQ.gte('day', startDay);

  let searchQ: any = supabase.from('search_daily_stats')
    .select('date, search_term, search_count')
    .eq('store_id_target', storeId);
  if (startDay) searchQ = searchQ.gte('date', startDay);

  let couponQ: any = supabase.from('coupon_daily_stats')
    .select('date, shown, redeemed')
    .eq('store_id', storeId);
  if (startDay) couponQ = couponQ.gte('date', startDay);

  const [impRes, searchRes, couponRes] = await Promise.all([impQ, searchQ, couponQ]);
  return {
    campaigns,
    coupons,
    impressions: impRes.data || [],
    searchRows: searchRes.data || [],
    couponRows: couponRes.data || [],
  };
}

// Lectura tolerante de los agregados diarios. Las filas anteriores a la
// migración 034 solo traen `count`; las nuevas traen impressions_valid (vistas
// >= 5 s) y full_views (vistas completas).
const validOf = (d: any) => (d.impressions_valid ?? d.count) || 0;
const fullOf = (d: any) => d.full_views || 0;

// Constructores de filas CSV (sin columna de tienda; se antepone para el export general).
function buildImpressionRows(campaigns: any[], impressions: any[]): unknown[][] {
  const byCamp: Record<string, string> = {};
  campaigns.forEach(c => { byCamp[c.id] = c.brand_name; });
  return impressions.slice()
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .map(d => {
      const valid = validOf(d);
      const full = fullOf(d);
      return [d.day, byCamp[d.campaign_id] || d.campaign_id, d.campaign_id, d.kiosk_id || '', valid, full, Math.max(0, valid - full)];
    });
}

function buildSearchRows(searchRows: any[]): unknown[][] {
  return searchRows.slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(r => {
      const isDirect = r.search_term === '(directo)' || r.search_term === '(mapa)';
      return [r.date, isDirect ? 'click_directorio' : 'busqueda', r.search_term || '', r.search_count ?? 0];
    });
}

function buildCouponStatRows(couponRows: any[]): unknown[][] {
  return couponRows.slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(r => [r.date, r.shown ?? 0, r.redeemed ?? 0]);
}

function summaryMetrics(data: StoreMetrics) {
  const totalImpressions = data.impressions.reduce((s, d) => s + validOf(d), 0);
  const totalFullViews = data.impressions.reduce((s, d) => s + fullOf(d), 0);
  const storeClicks = data.searchRows
    .filter(r => r.search_term === '(directo)' || r.search_term === '(mapa)')
    .reduce((s, r) => s + (r.search_count || 0), 0);
  const searchClicks = data.searchRows
    .filter(r => r.search_term !== '(directo)' && r.search_term !== '(mapa)')
    .reduce((s, r) => s + (r.search_count || 0), 0);
  const flashShown = data.couponRows.reduce((s, r) => s + (r.shown || 0), 0);
  const flashRedeemed = data.couponRows.reduce((s, r) => s + (r.redeemed || 0), 0);
  const kioskSet = new Set<string>();
  data.impressions.forEach(d => { if (d.kiosk_id) kioskSet.add(d.kiosk_id); });
  return {
    impresiones: totalImpressions,
    visualizaciones_completas: totalFullViews,
    visualizaciones_parciales: Math.max(0, totalImpressions - totalFullViews),
    clicks_directorio: storeClicks,
    veces_buscada: searchClicks,
    flash_mostrados: flashShown,
    flash_canjeados: flashRedeemed,
    kioscos_unicos: kioskSet.size,
    campanias: data.campaigns.length,
    cupones: data.coupons.length,
  };
}

const SUMMARY_COLUMNS = [
  'impresiones', 'visualizaciones_completas', 'visualizaciones_parciales', 'clicks_directorio', 'veces_buscada',
  'flash_mostrados', 'flash_canjeados', 'kioscos_unicos', 'campanias', 'cupones',
] as const;

export default function ClienteDashboardPage() {
  const { selectedStore: store, stores } = useClienteStore();
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [impressions, setImpressions] = useState<any[]>([]);
  const [searchRows, setSearchRows] = useState<any[]>([]);
  const [couponRows, setCouponRows] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [range, setRange] = useState<Range>('30d');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [abonoRequest, setAbonoRequest] = useState<AbonoRequest | null>(null);
  const [abonoFeedback, setAbonoFeedback] = useState<string | null>(null);

  // Historial de canjes — solo para el dueño; no depende del rango de métricas.
  const [redeemed, setRedeemed] = useState<any[]>([]);
  const [redeemedQuery, setRedeemedQuery] = useState('');
  const [redeemedLoading, setRedeemedLoading] = useState(false);

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  useEffect(() => {
    if (!store) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const start = rangeStart(range);
        const startDay = start ? start.split('T')[0] : null;

        // Métricas de la tienda desde los agregados diarios (las tablas crudas
        // ya no se consultan: se purgan a los 30 días). El RLS deja a la tienda
        // ver sólo sus propias filas.
        const [metrics, reqRes] = await Promise.all([
          fetchStoreMetrics(store.id, startDay),
          supabase.from('plan_requests')
            .select('*')
            .eq('store_id', store.id)
            .order('created_at', { ascending: false }),
        ]);

        if (cancelled) return;
        setCampaigns(metrics.campaigns);
        setCoupons(metrics.coupons);
        setImpressions(metrics.impressions);
        setSearchRows(metrics.searchRows);
        setCouponRows(metrics.couponRows);
        setRequests(reqRes.data || []);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range, store, reloadKey]);

  const totalImpressions = useMemo(() =>
    impressions.reduce((s, d) => s + validOf(d), 0), [impressions]);

  const totalFullViews = useMemo(() =>
    impressions.reduce((s, d) => s + fullOf(d), 0), [impressions]);

  const storeClicks = useMemo(() =>
    searchRows
      .filter(r => r.search_term === '(directo)' || r.search_term === '(mapa)')
      .reduce((s, r) => s + (r.search_count || 0), 0),
    [searchRows]);

  const searchClicks = useMemo(() =>
    searchRows
      .filter(r => r.search_term !== '(directo)' && r.search_term !== '(mapa)')
      .reduce((s, r) => s + (r.search_count || 0), 0),
    [searchRows]);

  const flashShown = useMemo(() =>
    couponRows.reduce((s, r) => s + (r.shown || 0), 0),
    [couponRows]);

  const uniqueKiosks = useMemo(() => {
    const set = new Set<string>();
    for (const d of impressions) if (d.kiosk_id) set.add(d.kiosk_id);
    return set.size;
  }, [impressions]);

  const planVigente = !store?.contract_expiry_date || store.contract_expiry_date >= today;
  const activeCampaign = useMemo(() => {
    if (!planVigente) return null;
    return campaigns.find(c => c.is_active &&
      (!c.end_date || c.end_date >= today) &&
      (!c.start_date || c.start_date <= today)) || null;
  }, [campaigns, today, planVigente]);

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

  // Solicitudes con saldo pendiente — habilitan el botón "Reportar abono".
  const openRequests = useMemo(
    () => requests.filter((r: any) => {
      if (r.status !== 'pending' && r.status !== 'partial') return false;
      const outstanding = Number(r.total_amount_usd ?? 0) - Number(r.paid_amount_usd ?? 0);
      return outstanding > 0.005;
    }),
    [requests]
  );

  const expiryDaysLeft = useMemo<number | null>(() => {
    if (!store?.contract_expiry_date) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(store.contract_expiry_date + 'T00:00:00');
    return Math.round((exp.getTime() - today.getTime()) / 86400000);
  }, [store]);

  // Fetch canjes del dueño (independiente del rango de métricas).
  useEffect(() => {
    if (!store || store.store_role !== 'owner') { setRedeemed([]); return; }
    let cancelled = false;
    setRedeemedLoading(true);
    (async () => {
      const { data } = await supabase
        .from('coupon_leads')
        .select('id, first_name, last_name, id_document, email, telefono, redeemed_at, coupons(title)')
        .eq('store_id', store.id)
        .eq('status', 'CANJEADO')
        .order('redeemed_at', { ascending: false })
        .limit(200);
      if (cancelled) return;
      setRedeemed(data || []);
      setRedeemedLoading(false);
    })();
    return () => { cancelled = true; };
  }, [store]);

  const visibleRedeemed = useMemo(() => {
    const q = redeemedQuery.trim().toLowerCase();
    if (!q) return redeemed;
    return redeemed.filter((r) => {
      const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.toLowerCase();
      return (
        (r.id_document ?? '').toLowerCase().includes(q) ||
        (r.email ?? '').toLowerCase().includes(q) ||
        name.includes(q)
      );
    });
  }, [redeemed, redeemedQuery]);

  const [exporting, setExporting] = useState<string | null>(null);

  const stamp = useMemo(
    () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
    [],
  );

  // ── Descargas: tienda seleccionada (usa la data ya cargada) ──────────────
  const selData: StoreMetrics = { campaigns, coupons, impressions, searchRows, couponRows };

  const exportSelImpresiones = () => {
    const rows = buildImpressionRows(campaigns, impressions);
    if (!rows.length) { toast.info('Sin impresiones de campaña en el rango seleccionado.'); return; }
    downloadCSV(`metricas_${slugify(store!.name)}_impresiones_${stamp}.csv`,
      ['fecha', 'campania', 'campaign_id', 'kiosk_id', 'impresiones_validas', 'vistas_completas', 'vistas_parciales'], rows);
  };

  const exportSelBusquedas = () => {
    const rows = buildSearchRows(searchRows);
    if (!rows.length) { toast.info('Sin búsquedas ni clicks en el rango seleccionado.'); return; }
    downloadCSV(`metricas_${slugify(store!.name)}_busquedas_${stamp}.csv`,
      ['fecha', 'tipo', 'termino', 'cantidad'], rows);
  };

  const exportSelCupones = () => {
    const rows = buildCouponStatRows(couponRows);
    if (!rows.length) { toast.info('Sin actividad de cupones flash en el rango seleccionado.'); return; }
    downloadCSV(`metricas_${slugify(store!.name)}_cupones_${stamp}.csv`,
      ['fecha', 'mostrados', 'canjeados'], rows);
  };

  const exportSelResumen = () => {
    const m = summaryMetrics(selData);
    downloadCSV(`metricas_${slugify(store!.name)}_resumen_${stamp}.csv`,
      ['metrica', 'valor'],
      [
        ['tienda', store!.name],
        ['plan', store!.plan_type || ''],
        ['rango', RANGE_LABELS[range]],
        ...SUMMARY_COLUMNS.map(k => [k, (m as Record<string, number>)[k]]),
      ]);
  };

  // ── Descargas: todas las tiendas vinculadas (consulta cada tienda) ───────
  const exportGeneral = async (kind: 'impresiones' | 'busquedas' | 'cupones' | 'resumen') => {
    if (!stores.length || exporting) return;
    setExporting(kind);
    try {
      const startDay = (() => { const s = rangeStart(range); return s ? s.split('T')[0] : null; })();
      const all = await Promise.all(
        stores.map(async s => ({ store: s, data: await fetchStoreMetrics(s.id, startDay) })),
      );

      if (kind === 'resumen') {
        const rows = all.map(({ store: s, data }) => {
          const m = summaryMetrics(data);
          return [s.name, s.plan_type || '', ...SUMMARY_COLUMNS.map(k => (m as Record<string, number>)[k])];
        });
        downloadCSV(`metricas_todas_tiendas_resumen_${stamp}.csv`,
          ['tienda', 'plan', ...SUMMARY_COLUMNS], rows);
        return;
      }

      const rows: unknown[][] = [];
      for (const { store: s, data } of all) {
        const part = kind === 'impresiones'
          ? buildImpressionRows(data.campaigns, data.impressions)
          : kind === 'busquedas'
            ? buildSearchRows(data.searchRows)
            : buildCouponStatRows(data.couponRows);
        for (const r of part) rows.push([s.name, ...r]);
      }
      if (!rows.length) { toast.info('Sin datos para exportar en el rango seleccionado.'); return; }

      const header = kind === 'impresiones'
        ? ['tienda', 'fecha', 'campania', 'campaign_id', 'kiosk_id', 'impresiones_validas', 'vistas_completas', 'vistas_parciales']
        : kind === 'busquedas'
          ? ['tienda', 'fecha', 'tipo', 'termino', 'cantidad']
          : ['tienda', 'fecha', 'mostrados', 'canjeados'];
      downloadCSV(`metricas_todas_tiendas_${kind}_${stamp}.csv`, header, rows);
    } finally {
      setExporting(null);
    }
  };

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
    return <PageSpinner label="Cargando tu tablero…" />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="No se pudo cargar tu tablero"
        message="Hubo un problema al traer tus métricas. Revisa tu conexión e inténtalo de nuevo."
        onRetry={() => setReloadKey(k => k + 1)}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Resumen</p>
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

      {abonoFeedback && (
        <div className="rounded-lg p-3 text-sm border bg-emerald-500/10 border-emerald-500/30 text-emerald-300">
          {abonoFeedback}
        </div>
      )}

      {openRequests.length > 0 && (
        <div className="space-y-2">
          {openRequests.map((r: any) => {
            const total = Number(r.total_amount_usd ?? 0);
            const paid = Number(r.paid_amount_usd ?? 0);
            const outstanding = Math.max(total - paid, 0);
            const planLabel = PLAN_LABELS[r.plan_key] || r.plan_key;
            return (
              <div
                key={r.id}
                className="relative overflow-hidden bg-gradient-to-br from-amber-500/15 via-orange-500/10 to-transparent border border-amber-500/40 rounded-2xl p-5 shadow-[0_0_30px_-10px_rgba(245,158,11,0.4)]"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="inline-flex w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      <p className="text-amber-200 text-xs font-bold uppercase tracking-widest">
                        Tienes un abono por reportar
                      </p>
                    </div>
                    <p className="text-white text-base font-bold">
                      Solicitud {planLabel}
                      <span className="ml-2 text-[10px] font-mono uppercase bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded">
                        {r.status === 'partial' ? 'PARCIAL' : 'EN REVISIÓN'}
                      </span>
                    </p>
                    <p className="text-white/70 text-sm mt-1.5">
                      Pagado <span className="font-mono text-emerald-300">${paid.toFixed(2)}</span>{' '}
                      de <span className="font-mono text-white">${total.toFixed(2)}</span> · saldo{' '}
                      <span className="font-mono text-amber-300 font-bold">${outstanding.toFixed(2)}</span>
                    </p>
                    <p className="text-white/50 text-xs mt-1">
                      Reporta tu abono aquí mismo. El plan se activa cuando el saldo llegue a $0.00.
                    </p>
                  </div>
                  <button
                    onClick={() => setAbonoRequest({
                      id: r.id,
                      plan_key: r.plan_key,
                      total_amount_usd: r.total_amount_usd,
                      paid_amount_usd: r.paid_amount_usd,
                    })}
                    className="shrink-0 text-sm font-bold bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-black rounded-lg px-5 py-2.5 shadow-lg transition-colors"
                  >
                    Reportar abono →
                  </button>
                </div>
              </div>
            );
          })}
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
                  {(() => {
                    const total = Number(pendingChange.total_amount_usd ?? 0);
                    const paid = Number(pendingChange.paid_amount_usd ?? 0);
                    const outstanding = Math.max(total - paid, 0);
                    if (outstanding > 0.005) {
                      return (
                        <button
                          onClick={() => setAbonoRequest({
                            id: pendingChange.id,
                            plan_key: pendingChange.plan_key,
                            total_amount_usd: pendingChange.total_amount_usd,
                            paid_amount_usd: pendingChange.paid_amount_usd,
                          })}
                          className="inline-block mt-3 text-[11px] font-bold bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-100 rounded-md px-3 py-1.5"
                        >
                          Reportar abono →
                        </button>
                      );
                    }
                    return (
                      <Link href="/cliente/pagos" className="inline-block mt-3 text-[11px] text-amber-300 hover:text-amber-200 font-medium">
                        Ver solicitud →
                      </Link>
                    );
                  })()}
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
        <Tile label="Impresiones (>5s)" value={totalImpressions.toLocaleString('es-VE')} accent="text-orange-400"
          sub={`Vistas válidas en K2 · ${RANGE_LABELS[range].toLowerCase()}`} />
        <Tile label="Visualizaciones completas" value={totalFullViews.toLocaleString('es-VE')} accent="text-emerald-400"
          sub={`Vieron el spot completo · ${RANGE_LABELS[range].toLowerCase()}`} />
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


      {/* Descarga de métricas */}
      <div className="bg-[#0A0A0A] border border-white/10 rounded-2xl p-5">
        <div className="flex items-start gap-3 mb-4">
          <svg className="w-5 h-5 text-cyan-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-white">Descargar métricas</p>
            <p className="text-xs text-white/40 mt-0.5">
              Exporta tus métricas en CSV (Excel) · {RANGE_LABELS[range].toLowerCase()}
            </p>
          </div>
        </div>

        {/* Tienda seleccionada */}
        <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">
          Tienda actual · {store.name}
        </p>
        <div className="flex flex-wrap gap-2">
          <ExportBtn label="Impresiones" onClick={exportSelImpresiones} />
          <ExportBtn label="Búsquedas y clicks" onClick={exportSelBusquedas} />
          <ExportBtn label="Cupones flash" onClick={exportSelCupones} />
          <ExportBtn label="Resumen" onClick={exportSelResumen} primary />
        </div>

        {/* Todas las tiendas vinculadas */}
        {stores.length > 1 && (
          <>
            <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mt-5 mb-2">
              Todas mis tiendas ({stores.length})
            </p>
            <div className="flex flex-wrap gap-2">
              <ExportBtn label="Impresiones" busy={exporting === 'impresiones'} disabled={!!exporting} onClick={() => exportGeneral('impresiones')} />
              <ExportBtn label="Búsquedas y clicks" busy={exporting === 'busquedas'} disabled={!!exporting} onClick={() => exportGeneral('busquedas')} />
              <ExportBtn label="Cupones flash" busy={exporting === 'cupones'} disabled={!!exporting} onClick={() => exportGeneral('cupones')} />
              <ExportBtn label="Resumen comparativo" busy={exporting === 'resumen'} disabled={!!exporting} onClick={() => exportGeneral('resumen')} primary />
            </div>
          </>
        )}
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
                  <th className="px-3 py-2 font-medium text-right">Impresiones (&gt;5s)</th>
                  <th className="px-3 py-2 font-medium text-right">Vistas completas</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => {
                  const rows = impressions.filter(d => d.campaign_id === c.id);
                  const imp = rows.reduce((s, d) => s + validOf(d), 0);
                  const full = rows.reduce((s, d) => s + fullOf(d), 0);
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
                          {live ? 'Activa' : 'Inactiva'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-white/70">{imp.toLocaleString('es-VE')}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-400/80">{full.toLocaleString('es-VE')}</td>
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

      {/* Canjes de cupones — solo para el dueño */}
      {store.store_role === 'owner' && (
        <div>
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
              Personas que canjearon ({redeemed.length})
            </p>
            <input
              value={redeemedQuery}
              onChange={(e) => setRedeemedQuery(e.target.value)}
              placeholder="Buscar por cédula, nombre o correo…"
              className="h-8 w-64 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-xs text-white placeholder-white/30 focus:border-cyan-500/50 focus:outline-none"
            />
          </div>
          {redeemedLoading ? (
            <div className="flex h-20 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-cyan-400" />
            </div>
          ) : visibleRedeemed.length === 0 ? (
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-6 text-center text-white/30 text-xs">
              {redeemedQuery ? 'Ningún canje coincide con la búsqueda.' : 'Aún no hay canjes registrados para esta tienda.'}
            </div>
          ) : (
            <div className="bg-white/[0.02] border border-white/5 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                    <th className="px-3 py-2 font-medium">Nombre</th>
                    <th className="px-3 py-2 font-medium">Cédula</th>
                    <th className="px-3 py-2 font-medium">Correo</th>
                    <th className="px-3 py-2 font-medium">Cupón</th>
                    <th className="px-3 py-2 font-medium">Canjeado</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRedeemed.map((r) => {
                    const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '—';
                    const dt = r.redeemed_at ? new Date(r.redeemed_at).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }) : '—';
                    return (
                      <tr key={r.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-white/80 font-medium">{name}</td>
                        <td className="px-3 py-2 text-white/50 font-mono">{r.id_document || '—'}</td>
                        <td className="px-3 py-2 text-white/50 truncate max-w-[180px]">{r.email}</td>
                        <td className="px-3 py-2 text-white/60">{(r.coupons as any)?.title ?? '—'}</td>
                        <td className="px-3 py-2 text-white/40 font-mono whitespace-nowrap">{dt}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <AbonoModal
        request={abonoRequest}
        onClose={() => setAbonoRequest(null)}
        onSuccess={async (msg) => {
          setAbonoFeedback(msg);
          if (store) {
            const { data } = await supabase
              .from('plan_requests')
              .select('*')
              .eq('store_id', store.id)
              .order('created_at', { ascending: false });
            setRequests(data || []);
          }
        }}
      />

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

function ExportBtn({ label, onClick, primary, busy, disabled }: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        primary
          ? 'bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-200'
          : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/70'
      }`}
    >
      {busy ? (
        <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        </svg>
      )}
      {busy ? 'Generando…' : label}
      {!busy && <span className="text-[9px] font-mono text-white/30">CSV</span>}
    </button>
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
