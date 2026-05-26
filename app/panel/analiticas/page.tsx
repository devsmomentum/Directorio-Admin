'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

type AnalyticsEvent = {
  id: string;
  kiosk_id: string;
  event_type: string;
  module: string;
  item_id?: string | null;
  item_name: string;
  created_at: string;
  event_data?: unknown;
};

type Kiosk = {
  id: string;
  name: string;
  location: string;
  status: string;
  last_ping: string;
};

type Campaign = {
  id: string;
  brand_name: string;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
};

type CampaignImpressionTotals = {
  campaign_id: string;
  brand_name: string;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean | null;
  today: number;
  last_7d: number;
  last_30d: number;
  total: number;
};

type ImpressionDaily = {
  campaign_id: string;
  kiosk_id: string;
  day: string;
  count: number;
};

type RankItem = { name: string; count: number; location?: string };

export default function AnalyticsDashboard() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'trafico' | 'heatmap'>('trafico');
  const [selectedKioskId, setSelectedKioskId] = useState<string>('all');
  const [periodFilter, setPeriodFilter] = useState<'day' | 'week' | 'month' | 'all'>('week');

  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [allEvents, setAllEvents] = useState<AnalyticsEvent[]>([]);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [impressionTotals, setImpressionTotals] = useState<CampaignImpressionTotals[]>([]);
  const [impressionDaily, setImpressionDaily] = useState<ImpressionDaily[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('top');


  useEffect(() => { fetchDashboardData(); }, []);

  const fetchDashboardData = async () => {
    setRefreshing(true);
    try {
      const [
        { data: ks },
        { data: analytics },
        { data: campData },
        { data: totals },
        { data: daily },
      ] = await Promise.all([
        supabase.from('kiosks').select('*'),
        // analytics_events ahora solo trae clicks/navegación (no impresiones)
        supabase
          .from('analytics_events')
          .select('id, kiosk_id, event_type, module, item_id, item_name, created_at, event_data')
          .order('created_at', { ascending: false })
          .limit(3000),
        supabase
          .from('ad_campaigns')
          .select('id, brand_name, start_date, end_date, is_active')
          .order('brand_name')
          .limit(500),
        supabase
          .from('v_campaign_impressions')
          .select('campaign_id, brand_name, start_date, end_date, is_active, today, last_7d, last_30d, total'),
        supabase
          .from('ad_impressions_daily')
          .select('campaign_id, kiosk_id, day, count')
          .order('day', { ascending: false })
          .limit(10000),
      ]);

      setKiosks(ks || []);
      setAllEvents((analytics as AnalyticsEvent[]) || []);
      setCampaigns((campData as Campaign[]) || []);
      setImpressionTotals((totals as CampaignImpressionTotals[]) || []);
      setImpressionDaily((daily as ImpressionDaily[]) || []);
    } catch (error) {
      console.error('Error cargando analiticas:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const now = new Date();

  // ── Filtro de período (día/semana/mes/todo) ─────────────────────────────────
  const periodStart = useMemo(() => {
    if (periodFilter === 'all') return null;
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    if (periodFilter === 'day')   return d;
    if (periodFilter === 'week')  { d.setDate(d.getDate() - 6);  return d; }  // últimos 7 días
    if (periodFilter === 'month') { d.setDate(d.getDate() - 29); return d; }  // últimos 30 días
    return null;
  }, [periodFilter, now]);

  const periodLabel = {
    day:   'hoy',
    week:  'últimos 7 días',
    month: 'últimos 30 días',
    all:   'todo el histórico',
  }[periodFilter];

  const inPeriod = (iso: string) => {
    if (!periodStart) return true;
    return new Date(iso) >= periodStart;
  };

  const kioskFilteredEvents = selectedKioskId === 'all'
    ? allEvents
    : allEvents.filter(e => e.kiosk_id === selectedKioskId);

  const filteredEvents = kioskFilteredEvents.filter(e => inPeriod(e.created_at));

  // ── Clasificación por categoría según whitelist ─────────────────────────────
  // clicks            → event_type IN ('click','tap')
  // búsquedas         → event_type IN ('filter','select')
  // clic post-búsqueda → event_type = 'search_click'  (tienda abierta tras tipear)
  // navegaciones      → event_type IN ('navigate','navigation')
  // flash coupons     → event_type = 'flash_coupon_shown'
  const isClick       = (e: AnalyticsEvent) => e.event_type === 'click' || e.event_type === 'tap';
  const isSearch      = (e: AnalyticsEvent) => e.event_type === 'filter' || e.event_type === 'select';
  const isSearchClick = (e: AnalyticsEvent) => e.event_type === 'search_click';
  const isNav         = (e: AnalyticsEvent) => e.event_type === 'navigate' || e.event_type === 'navigation';
  const isFlash       = (e: AnalyticsEvent) => e.event_type === 'flash_coupon_shown';

  const todayKey = now.toLocaleDateString();
  const isToday  = (e: AnalyticsEvent) => new Date(e.created_at).toLocaleDateString() === todayKey;

  const clickEvents       = filteredEvents.filter(isClick);
  const searchEvents      = filteredEvents.filter(isSearch);
  const searchClickEvents = filteredEvents.filter(isSearchClick);
  const navEvents         = filteredEvents.filter(isNav);
  const flashEvents       = filteredEvents.filter(isFlash);

  const totals = {
    clicks:       { total: clickEvents.length,       today: clickEvents.filter(isToday).length },
    searches:     { total: searchEvents.length,      today: searchEvents.filter(isToday).length },
    searchClicks: { total: searchClickEvents.length, today: searchClickEvents.filter(isToday).length },
    navs:         { total: navEvents.length,         today: navEvents.filter(isToday).length },
    flash:        { total: flashEvents.length,       today: flashEvents.filter(isToday).length },
  };

  // Rankings por categoría
  const countBy = (events: AnalyticsEvent[]) => {
    const acc: Record<string, number> = {};
    events.forEach(e => { acc[e.item_name] = (acc[e.item_name] || 0) + 1; });
    return acc;
  };
  const toRanking = (counts: Record<string, number>, limit = 5): RankItem[] =>
    Object.entries(counts).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, limit);

  const topClicks         = toRanking(countBy(clickEvents));
  const topSearches       = toRanking(countBy(searchEvents));
  const topSearchedStores = toRanking(countBy(searchClickEvents));
  const topSections       = toRanking(countBy(navEvents));

  // Tráfico por kiosco: solo interacciones reales (whitelist completo)
  const interactionEvents = filteredEvents.filter(e => isClick(e) || isSearch(e) || isSearchClick(e) || isNav(e) || isFlash(e));
  const kioskActivity: Record<string, number> = {};
  interactionEvents.forEach(event => {
    if (event.kiosk_id) kioskActivity[event.kiosk_id] = (kioskActivity[event.kiosk_id] || 0) + 1;
  });
  const topKiosksActivity: RankItem[] = Object.entries(kioskActivity).map(([kId, count]) => {
    const m = kiosks.find(k => k.id === kId);
    return { name: m?.name || 'Desconocido', location: m?.location || '', count };
  }).sort((a, b) => b.count - a.count).slice(0, 5);

  // ── Impresiones de campañas (filtradas por período + kiosko) ────────────────
  const impressionsByCampaign = useMemo(() => {
    const map = new Map<string, { total: number; today: number; daily: Record<string, number> }>();
    const todayKey = new Date().toLocaleDateString('en-CA');
    const startStr = periodStart ? periodStart.toLocaleDateString('en-CA') : null;

    impressionDaily.forEach(d => {
      if (selectedKioskId !== 'all' && d.kiosk_id !== selectedKioskId) return;
      if (startStr && d.day < startStr) return;
      const entry = map.get(d.campaign_id) || { total: 0, today: 0, daily: {} };
      entry.total += d.count;
      entry.daily[d.day] = (entry.daily[d.day] || 0) + d.count;
      if (d.day === todayKey) entry.today += d.count;
      map.set(d.campaign_id, entry);
    });

    return map;
  }, [impressionDaily, selectedKioskId, periodStart]);

  const campaignTotals = campaigns
    .map(c => ({ id: c.id, name: c.brand_name, total: impressionsByCampaign.get(c.id)?.total || 0 }))
    .filter(c => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(c => ({ name: c.name, count: c.total }));

  const selectedCampaign = campaigns.find(c => c.id === selectedCampaignId);
  const selectedStats = selectedCampaign ? impressionsByCampaign.get(selectedCampaign.id) || { today: 0, total: 0, daily: {} } : null;
  const selectedDailyRows = selectedStats
    ? Object.entries(selectedStats.daily).sort((a, b) => b[0].localeCompare(a[0]))
    : [];
  const maxDailyCount = selectedDailyRows.length > 0 ? Math.max(...selectedDailyRows.map(([, v]) => v)) : 1;

  const selectedRange = selectedCampaign
    ? {
        start: selectedCampaign.start_date ? new Date(`${selectedCampaign.start_date}T00:00:00`) : null,
        end: selectedCampaign.end_date ? new Date(`${selectedCampaign.end_date}T23:59:59`) : null,
      }
    : null;
  const rangeEnd = selectedRange?.end || now;
  const rangeStart = selectedRange?.start || null;
  const activeDays = rangeStart
    ? Math.max(1, Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)) + 1)
    : null;
  const avgPerDay = selectedStats && activeDays ? (selectedStats.total / activeDays).toFixed(2) : null;

  // ── Heatmap: kiosk × module (sigue usando analytics_events para clicks/navegación) ──
  const heatmapData = useMemo(() => {
    const byKioskModule: Record<string, Record<string, number>> = {};
    const moduleTotals: Record<string, number> = {};

    filteredEvents.forEach(e => {
      if (!e.kiosk_id || !e.module) return;
      const mod = e.module.toLowerCase();
      if (!byKioskModule[e.kiosk_id]) byKioskModule[e.kiosk_id] = {};
      byKioskModule[e.kiosk_id][mod] = (byKioskModule[e.kiosk_id][mod] || 0) + 1;
      moduleTotals[mod] = (moduleTotals[mod] || 0) + 1;
    });

    const topModules = Object.entries(moduleTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([mod]) => mod);

    const activeKioskIds = Object.keys(byKioskModule).sort((a, b) => {
      const aTotal = Object.values(byKioskModule[a]).reduce((s, v) => s + v, 0);
      const bTotal = Object.values(byKioskModule[b]).reduce((s, v) => s + v, 0);
      return bTotal - aTotal;
    });

    let globalMax = 1;
    activeKioskIds.forEach(kid => {
      topModules.forEach(mod => {
        const v = byKioskModule[kid]?.[mod] || 0;
        if (v > globalMax) globalMax = v;
      });
    });

    const rows = activeKioskIds.map(kid => {
      const kioskInfo = kiosks.find(k => k.id === kid);
      return {
        kioskId: kid,
        kioskName: kioskInfo?.name || kid.slice(0, 8),
        location: kioskInfo?.location || '',
        cells: topModules.map(mod => ({
          module: mod,
          count: byKioskModule[kid]?.[mod] || 0,
        })),
      };
    });

    return { topModules, rows, globalMax };
  }, [filteredEvents, kiosks]);

  const exportCSV = (headers: string[], rows: string[][], filename: string) => {
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleExportTraffic = () => {
    if (!filteredEvents.length) return alert('No hay eventos para exportar.');
    const headers = ['ID', 'Tipo', 'Modulo', 'Elemento', 'Kiosco ID', 'Kiosco', 'Fecha'];
    const rows = filteredEvents.map(e => {
      const k = kiosks.find(k => k.id === e.kiosk_id);
      return [e.id, e.event_type, e.module, `"${e.item_name}"`, e.kiosk_id || 'N/A', `"${k?.name || 'Desconocido'}"`, new Date(e.created_at).toLocaleString()];
    });
    exportCSV(headers, rows, `Trafico_${new Date().toISOString().split('T')[0]}.csv`);
  };

  const handleExportImpressions = () => {
    const rows: string[][] = [];
    campaigns
      .map(c => ({ c, stats: impressionsByCampaign.get(c.id) }))
      .filter(({ stats }) => (stats?.total || 0) > 0)
      .sort((a, b) => (b.stats?.total || 0) - (a.stats?.total || 0))
      .forEach(({ c, stats }) => {
        Object.entries(stats!.daily)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .forEach(([day, count]) => {
            rows.push([`"${c.brand_name}"`, day, String(count)]);
          });
      });
    if (!rows.length) return alert('Sin impresiones registradas para exportar.');
    exportCSV(['Campana', 'Fecha', 'Impresiones'], rows, `Impresiones_${new Date().toISOString().split('T')[0]}.csv`);
  };


  const handleExportHeatmap = () => {
    if (!heatmapData.rows.length) return alert('Sin datos de heatmap para exportar.');
    const headers = ['Kiosco', 'Ubicacion', ...heatmapData.topModules];
    const rows = heatmapData.rows.map(r => [
      `"${r.kioskName}"`,
      `"${r.location}"`,
      ...r.cells.map(c => String(c.count)),
    ]);
    exportCSV(headers, rows, `Heatmap_${new Date().toISOString().split('T')[0]}.csv`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const StatCard = ({ label, total, today, accent }: { label: string; total: number; today: number; accent: 'pink'|'purple'|'cyan'|'emerald'|'sky' }) => {
    const accentClass = {
      pink:    'text-pink-400',
      purple:  'text-purple-400',
      cyan:    'text-cyan-400',
      emerald: 'text-emerald-400',
      sky:     'text-sky-400',
    }[accent];
    return (
      <div className="bg-[#111] border border-white/5 rounded-xl p-4">
        <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium">{label}</p>
        <p className={`text-2xl font-bold ${accentClass} mt-1`}>{total.toLocaleString()}</p>
        <p className="text-[10px] text-white/30 mt-1">
          {periodFilter === 'day'
            ? <>En el día</>
            : <>Hoy: <span className="text-white/60 font-mono">{today}</span></>}
        </p>
      </div>
    );
  };

  const RankingList = ({ items, color, valueLabel }: { items: RankItem[]; color: string; valueLabel: string }) => {
    if (!items.length) return <p className="text-white/20 text-sm py-4">Sin datos</p>;
    const max = items[0].count;
    return (
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i}>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-white/20 text-[10px] font-mono w-4 shrink-0">{i + 1}</span>
                <div className="min-w-0">
                  <span className="text-white/70 truncate block">{item.name}</span>
                  {item.location && <span className="text-white/15 text-[10px] block truncate">{item.location}</span>}
                </div>
              </div>
              <span className={`${color} font-semibold shrink-0 ml-2`}>{item.count} {valueLabel}</span>
            </div>
            <div className="w-full bg-white/5 rounded-full h-1">
              <div className={`h-1 rounded-full transition-all duration-700 ${
                color === 'text-pink-400' ? 'bg-pink-500/60' :
                color === 'text-cyan-400' ? 'bg-cyan-500/60' :
                color === 'text-purple-400' ? 'bg-purple-500/60' :
                'bg-emerald-500/60'
              }`} style={{ width: `${(item.count / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Heat cell color: 0 → transparent, max → pink-500
  const heatCellStyle = (count: number, globalMax: number): React.CSSProperties => {
    if (count === 0) return { backgroundColor: 'rgba(255,255,255,0.03)' };
    const t = count / globalMax;
    const r = Math.round(80 + t * 175);
    const g = Math.round(20 + t * 10);
    const b = Math.round(120 - t * 30);
    const a = 0.15 + t * 0.70;
    return { backgroundColor: `rgba(${r},${g},${b},${a})` };
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Reportes</p>
          <h2 className="text-2xl font-bold text-white">Analiticas</h2>
          <p className="text-white/30 text-xs mt-1">Período: <span className="text-white/60">{periodLabel}</span></p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Filtro de período */}
          <div className="flex gap-1 bg-[#111] rounded-lg p-1 border border-white/5">
            {([
              { v: 'day',   l: 'Día'     },
              { v: 'week',  l: 'Semana'  },
              { v: 'month', l: 'Mes'     },
              { v: 'all',   l: 'Todo'    },
            ] as const).map(opt => (
              <button
                key={opt.v}
                onClick={() => setPeriodFilter(opt.v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  periodFilter === opt.v ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
                }`}
              >
                {opt.l}
              </button>
            ))}
          </div>
          <select
            value={selectedKioskId}
            onChange={e => setSelectedKioskId(e.target.value)}
            className="text-xs bg-[#111] border border-white/10 text-white/70 rounded-lg px-3 py-2 focus:outline-none focus:border-pink-500"
          >
            <option value="all">Todos los kioscos</option>
            {kiosks.map(k => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
          <button
            onClick={fetchDashboardData}
            disabled={refreshing}
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? 'Actualizando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-[#111] rounded-lg p-1 border border-white/5 w-fit">
        {(['trafico', 'heatmap'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-all capitalize ${
              activeTab === tab ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/50'
            }`}
          >
            {tab === 'heatmap' ? 'Mapa de calor' : 'Tráfico'}
          </button>
        ))}
      </div>

      {/* ===== TRAFICO ===== */}
      {activeTab === 'trafico' && (
        <div className="space-y-6">
          <div className="flex justify-end">
            <button onClick={handleExportTraffic} className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Exportar CSV
            </button>
          </div>

          {/* Stat cards: 5 categorías */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Clicks"          total={totals.clicks.total}       today={totals.clicks.today}       accent="pink"    />
            <StatCard label="Búsquedas"       total={totals.searches.total}     today={totals.searches.today}     accent="purple"  />
            <StatCard label="Clic post-búsq." total={totals.searchClicks.total} today={totals.searchClicks.today} accent="sky"     />
            <StatCard label="Navegaciones"    total={totals.navs.total}         today={totals.navs.today}         accent="cyan"    />
            <StatCard label="Flash Coupons"   total={totals.flash.total}        today={totals.flash.today}        accent="emerald" />
          </div>

          {/* Rankings */}
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Top clicks</h3>
              <RankingList items={topClicks} color="text-pink-400" valueLabel="clicks" />
            </div>
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Top búsquedas</h3>
              <p className="text-white/15 text-[10px] -mt-3 mb-3">categorías filtradas + tiendas elegidas</p>
              <RankingList items={topSearches} color="text-purple-400" valueLabel="acciones" />
            </div>
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Tiendas más buscadas</h3>
              <p className="text-white/15 text-[10px] -mt-3 mb-3">tienda abierta tras tipear en la barra de búsqueda</p>
              <RankingList items={topSearchedStores} color="text-sky-400" valueLabel="búsquedas" />
            </div>
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Secciones navegadas</h3>
              <RankingList items={topSections} color="text-emerald-400" valueLabel="visitas" />
            </div>
          </div>

          {/* Tráfico por kiosco */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Tráfico por kiosco</h3>
            <p className="text-white/15 text-[10px] -mt-3 mb-3">solo interacciones de usuario (clicks + búsquedas + clic post-búsqueda + navegaciones + flash coupons)</p>
            <RankingList items={topKiosksActivity} color="text-cyan-400" valueLabel="usos" />
          </div>

          {/* Impressions */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium">Campañas: impresiones</h3>
                <p className="text-white/20 text-xs mt-1">Reproducciones registradas por el Ad-Server en kioscos (tabla <code className="text-white/40">ad_impressions</code>).</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleExportImpressions} className="flex items-center gap-1.5 text-xs text-emerald-400/60 hover:text-emerald-400 bg-emerald-500/5 hover:bg-emerald-500/10 rounded-lg px-3 py-2 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  Exportar impresiones
                </button>
                <select
                  value={selectedCampaignId}
                  onChange={e => setSelectedCampaignId(e.target.value)}
                  className="text-xs bg-[#0f0f0f] border border-white/10 text-white/70 rounded-lg px-3 py-2 focus:outline-none focus:border-pink-500"
                >
                  <option value="top">Top 5</option>
                  {campaigns.map(c => (
                    <option key={c.id} value={c.id}>{c.brand_name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
              <div className="bg-white/5 rounded-lg p-4">
                <h4 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-3">Top por impresiones</h4>
                <RankingList items={campaignTotals} color="text-emerald-400" valueLabel="impresiones" />
              </div>

              <div className="bg-white/5 rounded-lg p-4">
                <h4 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-3">Detalle diario</h4>
                {!selectedCampaign || selectedCampaignId === 'top' ? (
                  <p className="text-white/20 text-sm py-4">Selecciona una campaña para ver el detalle diario.</p>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-white/40">
                      <span>Periodo: {selectedCampaign.start_date || '—'} → {selectedCampaign.end_date || 'hoy'}</span>
                      {activeDays && <span>Días activos: {activeDays}</span>}
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-black/20 rounded-lg px-3 py-2">
                        <p className="text-white/30 text-[10px] uppercase tracking-wider">Total</p>
                        <p className="text-white text-sm font-semibold">{selectedStats?.total || 0}</p>
                      </div>
                      <div className="bg-black/20 rounded-lg px-3 py-2">
                        <p className="text-white/30 text-[10px] uppercase tracking-wider">Hoy</p>
                        <p className="text-white text-sm font-semibold">{selectedStats?.today || 0}</p>
                      </div>
                      <div className="bg-black/20 rounded-lg px-3 py-2">
                        <p className="text-white/30 text-[10px] uppercase tracking-wider">Promedio/día</p>
                        <p className="text-white text-sm font-semibold">{avgPerDay || '—'}</p>
                      </div>
                    </div>
                    {selectedDailyRows.length === 0 ? (
                      <p className="text-white/20 text-sm py-2">Sin impresiones registradas.</p>
                    ) : (
                      <div className="max-h-56 overflow-auto space-y-2 pr-1">
                        {selectedDailyRows.map(([day, count]) => (
                          <div key={day}>
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="text-white/50 font-mono">{day}</span>
                              <span className="text-emerald-300 font-semibold">{count}</span>
                            </div>
                            <div className="w-full bg-white/5 rounded-full h-0.5">
                              <div
                                className="h-0.5 rounded-full bg-emerald-500/70 transition-all duration-500"
                                style={{ width: `${(count / maxDailyCount) * 100}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== HEATMAP ===== */}
      {activeTab === 'heatmap' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-white/30 text-xs">
              Intensidad de interacción por kiosco y módulo. Top 8 módulos más activos.
            </p>
            <button onClick={handleExportHeatmap} className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Exportar CSV
            </button>
          </div>

          {heatmapData.rows.length === 0 ? (
            <div className="bg-[#111] border border-white/5 rounded-xl p-10 text-center">
              <p className="text-white/20 text-sm">Sin datos de eventos para generar el mapa de calor.</p>
            </div>
          ) : (
            <div className="bg-[#111] border border-white/5 rounded-xl p-5 overflow-x-auto">
              <table className="w-full border-collapse" style={{ minWidth: `${heatmapData.topModules.length * 90 + 180}px` }}>
                <thead>
                  <tr>
                    <th className="text-left py-2 pr-4 text-[11px] text-white/20 font-medium uppercase tracking-wider w-40">
                      Kiosco
                    </th>
                    {heatmapData.topModules.map(mod => (
                      <th key={mod} className="py-2 px-1 text-[11px] text-white/30 font-medium uppercase tracking-wider text-center max-w-[80px]">
                        <span className="truncate block" title={mod}>{mod.length > 10 ? mod.slice(0, 9) + '…' : mod}</span>
                      </th>
                    ))}
                    <th className="py-2 pl-3 text-[11px] text-white/20 font-medium uppercase tracking-wider text-right">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {heatmapData.rows.map(row => {
                    const rowTotal = row.cells.reduce((s, c) => s + c.count, 0);
                    return (
                      <tr key={row.kioskId} className="group">
                        <td className="py-2 pr-4">
                          <div className="text-xs text-white/70 font-medium truncate">{row.kioskName}</div>
                          {row.location && <div className="text-[10px] text-white/20 truncate">{row.location}</div>}
                        </td>
                        {row.cells.map(cell => (
                          <td key={cell.module} className="py-1.5 px-1 text-center">
                            <div
                              className="rounded-md mx-auto flex items-center justify-center text-[11px] font-semibold transition-all duration-300"
                              style={{
                                ...heatCellStyle(cell.count, heatmapData.globalMax),
                                width: '56px',
                                height: '36px',
                                color: cell.count === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.85)',
                              }}
                              title={`${row.kioskName} / ${cell.module}: ${cell.count}`}
                            >
                              {cell.count === 0 ? '—' : cell.count}
                            </div>
                          </td>
                        ))}
                        <td className="py-2 pl-3 text-right">
                          <span className="text-xs text-white/40 font-mono">{rowTotal}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* Column totals */}
                <tfoot className="border-t border-white/10">
                  <tr>
                    <td className="pt-2 pr-4 text-[11px] text-white/20 uppercase tracking-wider">Total</td>
                    {heatmapData.topModules.map(mod => {
                      const colTotal = heatmapData.rows.reduce((s, r) => s + (r.cells.find(c => c.module === mod)?.count || 0), 0);
                      return (
                        <td key={mod} className="pt-2 px-1 text-center text-xs text-white/40 font-mono">{colTotal}</td>
                      );
                    })}
                    <td className="pt-2 pl-3 text-right text-xs text-white/50 font-mono font-semibold">
                      {heatmapData.rows.reduce((s, r) => s + r.cells.reduce((rs, c) => rs + c.count, 0), 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>

              {/* Legend */}
              <div className="mt-4 flex items-center gap-3 text-[10px] text-white/20">
                <span>Intensidad:</span>
                <div className="flex items-center gap-1">
                  {[0.1, 0.3, 0.5, 0.7, 1.0].map(t => (
                    <div
                      key={t}
                      className="w-5 h-3 rounded-sm"
                      style={{ backgroundColor: `rgba(${Math.round(80 + t * 175)},${Math.round(20 + t * 10)},${Math.round(120 - t * 30)},${0.15 + t * 0.70})` }}
                    />
                  ))}
                </div>
                <span>baja → alta</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
