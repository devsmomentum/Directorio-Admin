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

type RankItem = { name: string; count: number; location?: string };

export default function AnalyticsDashboard() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'trafico' | 'heatmap'>('trafico');
  const [selectedKioskId, setSelectedKioskId] = useState<string>('all');

  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [allEvents, setAllEvents] = useState<AnalyticsEvent[]>([]);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('top');


  useEffect(() => { fetchDashboardData(); }, []);

  const fetchDashboardData = async () => {
    setRefreshing(true);
    try {
      const [{ data: ks }, { data: analytics }, { data: campData }] = await Promise.all([
        supabase.from('kiosks').select('*'),
        supabase.from('analytics_events').select('id, kiosk_id, event_type, module, item_id, item_name, created_at, event_data').order('created_at', { ascending: false }).limit(3000),
        supabase.from('ad_campaigns').select('id, brand_name, start_date, end_date, is_active').order('brand_name').limit(500),
      ]);

      setKiosks(ks || []);
      setAllEvents((analytics as AnalyticsEvent[]) || []);
      setCampaigns((campData as Campaign[]) || []);
    } catch (error) {
      console.error('Error cargando analiticas:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filteredEvents = selectedKioskId === 'all'
    ? allEvents
    : allEvents.filter(e => e.kiosk_id === selectedKioskId);

  const now = new Date();
  const tenMinsAgo = new Date(now.getTime() - 10 * 60000);
  const activeKiosks = kiosks.filter(k => new Date(k.last_ping) > tenMinsAgo).length;

  const totalClicks = filteredEvents.length;
  const todayClicks = filteredEvents.filter(e => new Date(e.created_at).toLocaleDateString() === now.toLocaleDateString()).length;

  const storeCounts: Record<string, number> = {};
  const sectionCounts: Record<string, number> = {};
  const kioskActivity: Record<string, number> = {};

  filteredEvents.forEach(event => {
    if (event.kiosk_id) kioskActivity[event.kiosk_id] = (kioskActivity[event.kiosk_id] || 0) + 1;
    if (event.module === 'navigation') {
      sectionCounts[event.item_name] = (sectionCounts[event.item_name] || 0) + 1;
    } else {
      storeCounts[event.item_name] = (storeCounts[event.item_name] || 0) + 1;
    }
  });

  const topStores: RankItem[] = Object.entries(storeCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5);
  const topSections: RankItem[] = Object.entries(sectionCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5);
  const topKiosksActivity: RankItem[] = Object.entries(kioskActivity).map(([kId, count]) => {
    const m = kiosks.find(k => k.id === kId);
    return { name: m?.name || 'Desconocido', location: m?.location || '', count };
  }).sort((a, b) => b.count - a.count).slice(0, 5);

  const toDateKey = (value: string) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-CA');
  };

  const parseEventData = (data: AnalyticsEvent['event_data']) => {
    if (!data) return null;
    if (typeof data === 'string') {
      try { return JSON.parse(data) as Record<string, any>; } catch { return null; }
    }
    if (typeof data === 'object') return data as Record<string, any>;
    return null;
  };

  const campaignById = new Map(campaigns.map(c => [c.id, c]));
  const campaignNameToId = new Map(campaigns.map(c => [c.brand_name.toLowerCase().trim(), c.id]));

  const resolveCampaignId = (event: AnalyticsEvent) => {
    if (event.item_id && campaignById.has(event.item_id)) return event.item_id;
    const data = parseEventData(event.event_data);
    const dataCampaignId = data?.campaign_id || data?.campaignId || data?.ad_campaign_id || data?.adCampaignId;
    if (dataCampaignId && campaignById.has(dataCampaignId)) return dataCampaignId as string;
    const dataName = String(data?.brand_name || data?.campaign_name || data?.campaignName || '').trim().toLowerCase();
    if (dataName && campaignNameToId.has(dataName)) return campaignNameToId.get(dataName) || null;
    const itemName = String(event.item_name || '').trim().toLowerCase();
    if (itemName && campaignNameToId.has(itemName)) return campaignNameToId.get(itemName) || null;
    return null;
  };

  const isLikelyImpression = (event: AnalyticsEvent) => {
    const eventType = (event.event_type || '').toLowerCase();
    if (eventType.includes('click')) return false;
    const moduleName = (event.module || '').toLowerCase();
    const impressionHints = ['impression', 'view', 'show', 'display'];
    const moduleHints = ['campaign', 'ad', 'banner', 'promo'];
    return impressionHints.some(h => eventType.includes(h)) || moduleHints.some(h => moduleName.includes(h));
  };

  const isWithinReportingHours = (value: string) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return false;
    const hour = d.getHours();
    return hour >= 10 && hour <= 21;
  };

  const campaignRangeById = new Map<string, { start: Date | null; end: Date | null }>();
  campaigns.forEach(c => {
    const start = c.start_date ? new Date(`${c.start_date}T00:00:00`) : null;
    const end = c.end_date ? new Date(`${c.end_date}T23:59:59`) : null;
    campaignRangeById.set(c.id, { start, end });
  });

  const todayKey = toDateKey(now.toISOString());
  const campaignStatsById: Record<string, { total: number; today: number; daily: Record<string, number> }> = {};

  filteredEvents.forEach(event => {
    if (!isLikelyImpression(event)) return;
    const campaignId = resolveCampaignId(event);
    if (!campaignId) return;
    const range = campaignRangeById.get(campaignId);
    const eventDate = new Date(event.created_at);
    if (range?.start && eventDate < range.start) return;
    if (range?.end && eventDate > range.end) return;
    if (!isWithinReportingHours(event.created_at)) return;
    if (!campaignStatsById[campaignId]) campaignStatsById[campaignId] = { total: 0, today: 0, daily: {} };
    const dateKey = toDateKey(event.created_at);
    if (!dateKey) return;
    const stats = campaignStatsById[campaignId];
    stats.total += 1;
    stats.daily[dateKey] = (stats.daily[dateKey] || 0) + 1;
    if (dateKey === todayKey) stats.today += 1;
  });

  const campaignTotals = campaigns
    .map(c => ({ id: c.id, name: c.brand_name, total: campaignStatsById[c.id]?.total || 0 }))
    .filter(c => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(c => ({ name: c.name, count: c.total }));

  const selectedCampaign = campaigns.find(c => c.id === selectedCampaignId);
  const selectedStats = selectedCampaign ? (campaignStatsById[selectedCampaign.id] || { total: 0, today: 0, daily: {} }) : null;
  const selectedDailyRows = selectedStats
    ? Object.entries(selectedStats.daily).sort((a, b) => b[0].localeCompare(a[0]))
    : [];
  const maxDailyCount = selectedDailyRows.length > 0 ? Math.max(...selectedDailyRows.map(([, v]) => v)) : 1;
  const selectedRange = selectedCampaign ? campaignRangeById.get(selectedCampaign.id) : null;
  const rangeEnd = selectedRange?.end || now;
  const rangeStart = selectedRange?.start || null;
  const activeDays = rangeStart
    ? Math.max(1, Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)) + 1)
    : null;
  const avgPerDay = selectedStats && activeDays ? (selectedStats.total / activeDays).toFixed(2) : null;

  // ── Heatmap: kiosk × module ──────────────────────────────────────────────────
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

    // Top 8 modules by total volume
    const topModules = Object.entries(moduleTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([mod]) => mod);

    // Kiosks sorted by total event count
    const activeKioskIds = Object.keys(byKioskModule).sort((a, b) => {
      const aTotal = Object.values(byKioskModule[a]).reduce((s, v) => s + v, 0);
      const bTotal = Object.values(byKioskModule[b]).reduce((s, v) => s + v, 0);
      return bTotal - aTotal;
    });

    // Global max for color scaling
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
      .filter(c => (campaignStatsById[c.id]?.total || 0) > 0)
      .sort((a, b) => (campaignStatsById[b.id]?.total || 0) - (campaignStatsById[a.id]?.total || 0))
      .forEach(c => {
        const stats = campaignStatsById[c.id];
        Object.entries(stats.daily)
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
    // pink gradient: low = indigo tint, high = bright pink
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
        </div>
        <div className="flex items-center gap-3">
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

          {/* Rankings */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Top tiendas / elementos</h3>
              <RankingList items={topStores} color="text-pink-400" valueLabel="clics" />
            </div>
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Secciones visitadas</h3>
              <RankingList items={topSections} color="text-purple-400" valueLabel="visitas" />
            </div>
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Tráfico por kiosco</h3>
              <RankingList items={topKiosksActivity} color="text-cyan-400" valueLabel="usos" />
            </div>
          </div>

          {/* Impressions */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium">Campañas: impresiones</h3>
                <p className="text-white/20 text-xs mt-1">Eventos de visualización por campaña dentro de su periodo activo (10h–21h).</p>
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
