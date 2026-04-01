'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

export default function AnalyticsDashboard() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'trafico' | 'finanzas'>('trafico');

  const [totalClicks, setTotalClicks] = useState(0);
  const [todayClicks, setTodayClicks] = useState(0);
  const [activeKiosks, setActiveKiosks] = useState(0);
  const [totalKiosks, setTotalKiosks] = useState(0);
  const [topStores, setTopStores] = useState<any[]>([]);
  const [topCategories, setTopCategories] = useState<any[]>([]);
  const [topKiosksActivity, setTopKiosksActivity] = useState<any[]>([]);
  const [allAnalyticsEvents, setAllAnalyticsEvents] = useState<any[]>([]);

  const [totalRevenueUSD, setTotalRevenueUSD] = useState(0);
  const [totalSalesCount, setTotalSalesCount] = useState(0);
  const [topSellingItems, setTopSellingItems] = useState<any[]>([]);
  const [allTransactions, setAllTransactions] = useState<any[]>([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    setRefreshing(true);
    try {
      const { data: kiosks } = await supabase.from('kiosks').select('*');
      const now = new Date();
      const fiveMinsAgo = new Date(now.getTime() - 5 * 60000);

      let onlineCount = 0;
      (kiosks || []).forEach(k => {
        const lastPing = new Date(k.last_ping);
        if (lastPing > fiveMinsAgo && k.status === 'online') onlineCount++;
      });
      setActiveKiosks(onlineCount);
      setTotalKiosks((kiosks || []).length);

      const { data: analytics } = await supabase.from('analytics_events').select('*').order('created_at', { ascending: false });

      if (analytics) {
        setAllAnalyticsEvents(analytics);
        setTotalClicks(analytics.length);

        const storeCounts: Record<string, number> = {};
        const categoryCounts: Record<string, number> = {};
        const kioskActivity: Record<string, number> = {};
        let clicksTodayCounter = 0;

        analytics.forEach(event => {
          const eventDate = new Date(event.created_at);
          if (eventDate.toLocaleDateString() === now.toLocaleDateString()) clicksTodayCounter++;
          if (event.kiosk_id) kioskActivity[event.kiosk_id] = (kioskActivity[event.kiosk_id] || 0) + 1;

          let rawData = event.event_data || event.item_name;
          if (typeof rawData === 'string') { try { rawData = JSON.parse(rawData); } catch {} }

          let dataStr = '';
          if (typeof rawData === 'object' && rawData !== null) dataStr = rawData.store_name || '';
          else if (typeof rawData === 'string') dataStr = rawData;

          if (dataStr) {
            if (dataStr.startsWith('Categoría:')) {
              categoryCounts[dataStr.replace('Categoría:', '').trim()] = (categoryCounts[dataStr.replace('Categoría:', '').trim()] || 0) + 1;
            } else {
              storeCounts[dataStr] = (storeCounts[dataStr] || 0) + 1;
            }
          }
        });

        setTodayClicks(clicksTodayCounter);
        setTopStores(Object.entries(storeCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5));
        setTopCategories(Object.entries(categoryCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5));
        setTopKiosksActivity(
          Object.entries(kioskActivity).map(([kId, count]) => {
            const m = (kiosks || []).find(k => k.id === kId);
            return { name: m?.name || 'Desconocido', location: m?.location || '', count };
          }).sort((a, b) => b.count - a.count).slice(0, 5)
        );
      }

      const { data: transactions } = await supabase.from('transactions').select('*').order('created_at', { ascending: false });
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
    if (!allAnalyticsEvents.length) return alert('No hay eventos para exportar.');
    const headers = ['ID', 'Tipo', 'Modulo', 'Elemento', 'Kiosco ID', 'Fecha'];
    const rows = allAnalyticsEvents.map(e => {
      let rawData = e.event_data || e.item_name;
      if (typeof rawData === 'string') { try { rawData = JSON.parse(rawData); } catch {} }
      const dataStr = typeof rawData === 'object' && rawData !== null ? rawData.store_name || '' : String(rawData || '');
      return [e.id, e.event_type || 'click', e.module || 'directorio', `"${dataStr}"`, e.kiosk_id || 'N/A', new Date(e.created_at).toLocaleString()];
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

  const RankingList = ({ items, color, valueLabel }: { items: { name: string; count: number; location?: string }[]; color: string; valueLabel: string }) => {
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
      <div className="flex items-end justify-between">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Reportes</p>
          <h2 className="text-2xl font-bold text-white">Analiticas</h2>
        </div>
        <button
          onClick={fetchDashboardData}
          disabled={refreshing}
          className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50"
        >
          <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          {refreshing ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-[#111] rounded-lg p-1 border border-white/5 w-fit">
        <button
          onClick={() => setActiveTab('trafico')}
          className={`px-4 py-2 text-xs font-medium rounded-md transition-all ${
            activeTab === 'trafico'
              ? 'bg-white/10 text-white'
              : 'text-white/30 hover:text-white/50'
          }`}
        >
          Trafico
        </button>
        <button
          onClick={() => setActiveTab('finanzas')}
          className={`px-4 py-2 text-xs font-medium rounded-md transition-all ${
            activeTab === 'finanzas'
              ? 'bg-white/10 text-white'
              : 'text-white/30 hover:text-white/50'
          }`}
        >
          Finanzas
        </button>
      </div>

      {/* ===== TRAFICO ===== */}
      {activeTab === 'trafico' && (
        <div className="space-y-6">
          {/* Stats */}
          <div className="grid grid-cols-4 gap-3">
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
                {activeKiosks}<span className="text-white/20 text-xs">/{totalKiosks}</span>
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
            <button
              onClick={handleExportTraffic}
              className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Exportar CSV
            </button>
          </div>

          {/* Rankings */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Top tiendas</h3>
              <RankingList items={topStores} color="text-pink-400" valueLabel="clics" />
            </div>
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Top categorias</h3>
              <RankingList items={topCategories} color="text-cyan-400" valueLabel="busq." />
            </div>
            <div className="bg-[#111] border border-white/5 rounded-xl p-5">
              <h3 className="text-[11px] text-white/30 uppercase tracking-wider font-medium mb-4">Trafico por kiosco</h3>
              <RankingList items={topKiosksActivity} color="text-purple-400" valueLabel="usos" />
            </div>
          </div>
        </div>
      )}

      {/* ===== FINANZAS ===== */}
      {activeTab === 'finanzas' && (
        <div className="space-y-6">
          {/* Stats */}
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

          {/* Export */}
          <div className="flex justify-end">
            <button
              onClick={handleExportSales}
              className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Exportar CSV
            </button>
          </div>

          {/* Top selling */}
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
