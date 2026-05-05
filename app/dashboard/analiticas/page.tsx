'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

type AnalyticsEvent = {
  id: string;
  kiosk_id: string;
  event_type: string;
  module: string;
  item_name: string;
  created_at: string;
};

type Kiosk = {
  id: string;
  name: string;
  location: string;
  status: string;
  last_ping: string;
};

type RankItem = { name: string; count: number; location?: string };

export default function AnalyticsDashboard() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'trafico' | 'finanzas'>('trafico');
  const [selectedKioskId, setSelectedKioskId] = useState<string>('all');

  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [allEvents, setAllEvents] = useState<AnalyticsEvent[]>([]);
  const [allTransactions, setAllTransactions] = useState<any[]>([]);

  const [totalRevenueUSD, setTotalRevenueUSD] = useState(0);
  const [totalSalesCount, setTotalSalesCount] = useState(0);
  const [topSellingItems, setTopSellingItems] = useState<any[]>([]);

  useEffect(() => { fetchDashboardData(); }, []);

  const fetchDashboardData = async () => {
    setRefreshing(true);
    try {
      const [{ data: ks }, { data: analytics }, { data: transactions }] = await Promise.all([
        supabase.from('kiosks').select('*'),
        supabase.from('analytics_events').select('id, kiosk_id, event_type, module, item_name, created_at').order('created_at', { ascending: false }).limit(3000),
        supabase.from('transactions').select('*').order('created_at', { ascending: false }).limit(1000),
      ]);

      setKiosks(ks || []);
      setAllEvents((analytics as AnalyticsEvent[]) || []);

      if (transactions) {
        setAllTransactions(transactions);
        let totalUSD = 0, completed = 0;
        const itemSales: Record<string, { count: number; revenue: number }> = {};
        transactions.forEach(t => {
          if (t.status === 'completed') {
            const amount = Number(t.amount_usd) || 0;
            totalUSD += amount;
            completed++;
            if (!itemSales[t.item_name]) itemSales[t.item_name] = { count: 0, revenue: 0 };
            itemSales[t.item_name].count++;
            itemSales[t.item_name].revenue += amount;
          }
        });
        setTotalRevenueUSD(totalUSD);
        setTotalSalesCount(completed);
        setTopSellingItems(Object.entries(itemSales).map(([name, d]) => ({ name, count: d.count, revenue: d.revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 5));
      }
    } catch (error) {
      console.error('Error cargando analiticas:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Filtered events by selected kiosk
  const filteredEvents = selectedKioskId === 'all'
    ? allEvents
    : allEvents.filter(e => e.kiosk_id === selectedKioskId);

  // Derived stats from filtered events
  const now = new Date();
  const fiveMinsAgo = new Date(now.getTime() - 5 * 60000);
  const activeKiosks = kiosks.filter(k => new Date(k.last_ping) > fiveMinsAgo && k.status === 'online').length;

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

  const recentEvents = filteredEvents.slice(0, 30);

  const eventTypeLabel: Record<string, string> = {
    click: 'Tienda',
    filter: 'Categoría',
    navigate: 'Sección',
    view_modal: 'Servicio',
    tap: 'Servicio',
  };

  const eventTypeColor: Record<string, string> = {
    click: 'text-pink-400',
    filter: 'text-cyan-400',
    navigate: 'text-purple-400',
    view_modal: 'text-amber-400',
    tap: 'text-amber-400',
  };

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

  const handleExportSales = () => {
    if (!allTransactions.length) return alert('No hay transacciones para exportar.');
    const headers = ['ID', 'Tipo', 'Articulo', 'USD', 'Bs', 'Tasa', 'Pago', 'Email', 'Kiosco', 'Fecha'];
    const rows = allTransactions.map(t => [t.id, t.transaction_type, `"${t.item_name}"`, t.amount_usd || 0, t.amount_bs || 0, t.exchange_rate, t.payment_method, t.user_email || 'N/A', t.kiosk_id, new Date(t.created_at).toLocaleString()]);
    exportCSV(headers, rows, `Ventas_${new Date().toISOString().split('T')[0]}.csv`);
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Reportes</p>
          <h2 className="text-2xl font-bold text-white">Analiticas</h2>
        </div>
        <div className="flex items-center gap-3">
          {/* Kiosk filter */}
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
        <button onClick={() => setActiveTab('trafico')} className={`px-4 py-2 text-xs font-medium rounded-md transition-all ${activeTab === 'trafico' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/50'}`}>
          Trafico
        </button>
        <button onClick={() => setActiveTab('finanzas')} className={`px-4 py-2 text-xs font-medium rounded-md transition-all ${activeTab === 'finanzas' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/50'}`}>
          Finanzas
        </button>
      </div>

      {/* ===== TRAFICO ===== */}
      {activeTab === 'trafico' && (
        <div className="space-y-6">
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5">
              <span className="text-white/30 text-[10px] uppercase tracking-wider">Total interacciones</span>
              <div className="text-xl font-bold text-white leading-tight mt-1">{totalClicks.toLocaleString()}</div>
            </div>
            <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5">
              <span className="text-white/30 text-[10px] uppercase tracking-wider">Hoy</span>
              <div className="text-xl font-bold text-white leading-tight mt-1">{todayClicks.toLocaleString()}</div>
            </div>
            <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5">
              <span className="text-white/30 text-[10px] uppercase tracking-wider">Kioscos online</span>
              <div className="text-xl font-bold text-white leading-tight mt-1 flex items-center gap-1">
                {activeKiosks}<span className="text-white/20 text-xs">/{kiosks.length}</span>
                {activeKiosks > 0 && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1" />}
              </div>
            </div>
            <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5">
              <span className="text-white/30 text-[10px] uppercase tracking-wider">Mas buscada</span>
              <div className="text-sm font-bold text-white leading-tight mt-1 truncate">{topStores[0]?.name || '—'}</div>
            </div>
          </div>

          {/* Export */}
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
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Trafico por kiosco</h3>
              <RankingList items={topKiosksActivity} color="text-cyan-400" valueLabel="usos" />
            </div>
          </div>

          {/* Recent events feed */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Eventos recientes</h3>
            {recentEvents.length === 0 ? (
              <p className="text-white/20 text-sm py-4">Sin eventos registrados</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-white/20 text-left border-b border-white/5">
                      <th className="pb-2 font-medium pr-4">Tipo</th>
                      <th className="pb-2 font-medium pr-4">Elemento</th>
                      <th className="pb-2 font-medium pr-4">Kiosco</th>
                      <th className="pb-2 font-medium">Hora</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {recentEvents.map(event => {
                      const kiosk = kiosks.find(k => k.id === event.kiosk_id);
                      const typeLabel = eventTypeLabel[event.event_type] || event.event_type;
                      const typeColor = eventTypeColor[event.event_type] || 'text-white/40';
                      return (
                        <tr key={event.id} className="hover:bg-white/2">
                          <td className="py-2 pr-4">
                            <span className={`${typeColor} font-medium`}>{typeLabel}</span>
                          </td>
                          <td className="py-2 pr-4 text-white/60 max-w-[180px] truncate">{event.item_name}</td>
                          <td className="py-2 pr-4 text-white/40">{kiosk?.name || event.kiosk_id || '—'}</td>
                          <td className="py-2 text-white/25 whitespace-nowrap">{new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {new Date(event.created_at).toLocaleDateString()}</td>
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

      {/* ===== FINANZAS ===== */}
      {activeTab === 'finanzas' && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5">
              <span className="text-white/30 text-[10px] uppercase tracking-wider">Ingresos brutos</span>
              <div className="text-xl font-bold text-emerald-400 leading-tight mt-1">${totalRevenueUSD.toFixed(2)}</div>
            </div>
            <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5">
              <span className="text-white/30 text-[10px] uppercase tracking-wider">Operaciones</span>
              <div className="text-xl font-bold text-white leading-tight mt-1">{totalSalesCount}</div>
            </div>
            <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5">
              <span className="text-white/30 text-[10px] uppercase tracking-wider">Ticket promedio</span>
              <div className="text-xl font-bold text-white leading-tight mt-1">
                ${totalSalesCount > 0 ? (totalRevenueUSD / totalSalesCount).toFixed(2) : '0.00'}
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={handleExportSales} className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Exportar CSV
            </button>
          </div>

          <div className="bg-[#111] border border-white/5 rounded-xl p-5">
            <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Top articulos por recaudacion</h3>
            {topSellingItems.length === 0 ? (
              <p className="text-white/20 text-sm py-4">Sin ventas registradas</p>
            ) : (
              <div className="space-y-3">
                {topSellingItems.map((item, i) => {
                  const max = topSellingItems[0].revenue;
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-white/20 text-[10px] font-mono w-4">{i + 1}</span>
                          <span className="text-white/70">{item.name}</span>
                          <span className="text-white/15 text-[10px]">{item.count} ventas</span>
                        </div>
                        <span className="text-emerald-400 font-semibold">${item.revenue.toFixed(2)}</span>
                      </div>
                      <div className="w-full bg-white/5 rounded-full h-1">
                        <div className="h-1 rounded-full bg-emerald-500/60 transition-all duration-700" style={{ width: `${(item.revenue / max) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
