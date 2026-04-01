'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

export default function AnalyticsDashboard() {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'trafico' | 'finanzas'>('trafico');
  
  // --- STATES DE TRÁFICO ---
  const [totalClicks, setTotalClicks] = useState(0);
  const [todayClicks, setTodayClicks] = useState(0);
  const [activeKiosks, setActiveKiosks] = useState(0);
  const [topStores, setTopStores] = useState<any[]>([]);
  const [topCategories, setTopCategories] = useState<any[]>([]);
  const [topKiosksActivity, setTopKiosksActivity] = useState<any[]>([]);
  const [kiosksStatus, setKiosksStatus] = useState<any[]>([]);
  
  // 🚀 NUEVO STATE: Guardamos todos los eventos para el Excel de Tráfico
  const [allAnalyticsEvents, setAllAnalyticsEvents] = useState<any[]>([]);

  // --- STATES DE FINANZAS ---
  const [totalRevenueUSD, setTotalRevenueUSD] = useState(0);
  const [totalSalesCount, setTotalSalesCount] = useState(0);
  const [topSellingItems, setTopSellingItems] = useState<any[]>([]);
  const [allTransactions, setAllTransactions] = useState<any[]>([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    setLoading(true);

    try {
      // 1. Obtener Kioscos y su estado
      const { data: kiosks } = await supabase.from('kiosks').select('*');
      
      const now = new Date();
      const fiveMinsAgo = new Date(now.getTime() - 5 * 60000);
      
      let onlineCount = 0;
      const statusList = (kiosks || []).map(k => {
        const lastPing = new Date(k.last_ping);
        const isOnline = lastPing > fiveMinsAgo && k.status === 'online';
        if (isOnline) onlineCount++;
        return { ...k, isOnline };
      });

      setActiveKiosks(onlineCount);
      setKiosksStatus(statusList);

      // 2. Obtener toda la analítica de eventos (Trafico)
      const { data: analytics } = await supabase.from('analytics_events').select('*').order('created_at', { ascending: false });
      
      if (analytics) {
        setAllAnalyticsEvents(analytics); // 🚀 Guardamos la data cruda para exportar
        setTotalClicks(analytics.length);

        const storeCounts: Record<string, number> = {};
        const categoryCounts: Record<string, number> = {};
        const kioskActivity: Record<string, number> = {};
        let clicksTodayCounter = 0;

        analytics.forEach(event => {
          // --- A) Contar los clics de HOY (Corregido con toLocaleDateString) ---
          const eventDate = new Date(event.created_at);
          if (eventDate.toLocaleDateString() === now.toLocaleDateString()) {
            clicksTodayCounter++;
          }

          // --- B) Contar actividad por Kiosco Físico ---
          if (event.kiosk_id) {
            kioskActivity[event.kiosk_id] = (kioskActivity[event.kiosk_id] || 0) + 1;
          }

          // --- C) Parseo Inteligente del JSONB / String (Corregido) ---
          let dataStr = '';
          let rawData = event.event_data || event.item_name; // Soportamos ambos formatos

          // Intentar parsear si Supabase lo mandó como un string JSON
          if (typeof rawData === 'string') {
            try {
              rawData = JSON.parse(rawData);
            } catch (e) {
              // Si falla el parseo, significa que es un string normal (ej. "Categoría: Ropa")
            }
          }

          if (typeof rawData === 'object' && rawData !== null) {
            dataStr = rawData.store_name || '';
          } else if (typeof rawData === 'string') {
            dataStr = rawData;
          }

          // --- D) Agrupar Categorías vs Tiendas ---
          if (dataStr) {
            if (dataStr.startsWith('Categoría:')) {
              const catName = dataStr.replace('Categoría:', '').trim();
              categoryCounts[catName] = (categoryCounts[catName] || 0) + 1;
            } else {
              storeCounts[dataStr] = (storeCounts[dataStr] || 0) + 1;
            }
          }
        });

        setTodayClicks(clicksTodayCounter);

        setTopStores(
          Object.entries(storeCounts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
        );

        setTopCategories(
          Object.entries(categoryCounts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
        );

        setTopKiosksActivity(
          Object.entries(kioskActivity)
            .map(([kId, count]) => {
              const matchedKiosk = (kiosks || []).find(k => k.id === kId);
              return { 
                name: matchedKiosk ? matchedKiosk.name : 'Kiosco Desconocido', 
                location: matchedKiosk ? matchedKiosk.location : 'Sin ubicación',
                count 
              };
            })
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
        );
      }

      // 3. Obtener Transacciones (Finanzas)
      const { data: transactions } = await supabase.from('transactions').select('*').order('created_at', { ascending: false });
      
      if (transactions) {
        setAllTransactions(transactions);
        
        let totalUSD = 0;
        let completedSales = 0;
        const itemSales: Record<string, { count: number, revenue: number }> = {};

        transactions.forEach(t => {
          if (t.status === 'completed') {
            // (Corregido: Prevenir NaN si amount_usd es nulo/vacío)
            const amount = Number(t.amount_usd) || 0; 
            
            totalUSD += amount;
            completedSales += 1;
            
            if (!itemSales[t.item_name]) itemSales[t.item_name] = { count: 0, revenue: 0 };
            itemSales[t.item_name].count += 1;
            itemSales[t.item_name].revenue += amount;
          }
        });

        setTotalRevenueUSD(totalUSD);
        setTotalSalesCount(completedSales);
        
        setTopSellingItems(Object.entries(itemSales)
          .map(([name, data]) => ({ name, count: data.count, revenue: data.revenue }))
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 5)
        );
      }

    } catch (error) {
      console.error("Error cargando analíticas:", error);
    } finally {
      setLoading(false);
    }
  };

  // 🚀 NUEVO: FUNCIÓN PARA EXPORTAR EXCEL DE TRÁFICO (INTERACCIONES)
  const handleExportTrafficCSV = () => {
    if (allAnalyticsEvents.length === 0) return alert("No hay eventos de tráfico para exportar.");
    
    const headers = ["ID Evento", "Tipo Evento", "Módulo", "Elemento Interes (Tienda/Categoría)", "Kiosco ID", "Fecha y Hora"];
    const csvRows = allAnalyticsEvents.map(e => {
      let dataStr = '';
      
      // Mismo fix de parseo para la exportación
      let rawData = e.event_data || e.item_name;
      if (typeof rawData === 'string') {
        try {
          rawData = JSON.parse(rawData);
        } catch (err) {}
      }

      if (typeof rawData === 'object' && rawData !== null) {
        dataStr = rawData.store_name || JSON.stringify(rawData);
      } else if (typeof rawData === 'string') {
        dataStr = rawData;
      }

      return [
        e.id, 
        e.event_type || 'click', 
        e.module || 'directorio', 
        `"${dataStr}"`, // Comillas para evitar que comas en los nombres rompan el CSV
        e.kiosk_id || 'N/A', 
        new Date(e.created_at).toLocaleString()
      ];
    });

    const csvContent = [headers.join(","), ...csvRows.map(e => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Reporte_Trafico_Interacciones_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // 🚀 FUNCIÓN PARA EXPORTAR EXCEL DE FINANZAS (VENTAS)
  const handleExportCSV = () => {
    if (allTransactions.length === 0) return alert("No hay transacciones para exportar.");
    
    const headers = ["ID", "Tipo", "Articulo", "Monto USD", "Monto Bs", "Tasa BCV", "Metodo Pago", "Email", "Kiosco", "Fecha"];
    const csvRows = allTransactions.map(t => [
      t.id, t.transaction_type, `"${t.item_name}"`, t.amount_usd || 0, t.amount_bs || 0, t.exchange_rate, 
      t.payment_method, t.user_email || 'N/A', t.kiosk_id, new Date(t.created_at).toLocaleString()
    ]);

    const csvContent = [headers.join(","), ...csvRows.map(e => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Reporte_Ventas_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-pink-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-10">
      
      {/* 🚀 CABECERA Y TABS */}
      <div>
        <h2 className="text-3xl font-bold text-white tracking-tight">Dashboard de Inteligencia</h2>
        <p className="text-white/50 mt-2 mb-6">Métricas en tiempo real del ecosistema Kiosco.</p>
        
        {/* Selector de Pestañas */}
        <div className="flex space-x-4 border-b border-white/10 pb-4">
          <button 
            onClick={() => setActiveTab('trafico')}
            className={`px-6 py-2 rounded-full font-bold transition-all ${activeTab === 'trafico' ? 'bg-pink-600 text-white shadow-[0_0_15px_rgba(236,72,153,0.4)]' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
          >
            <span className="material-icons text-sm align-middle mr-2">touch_app</span>
            Publicidad / Tráfico
          </button>
          <button 
            onClick={() => setActiveTab('finanzas')}
            className={`px-6 py-2 rounded-full font-bold transition-all ${activeTab === 'finanzas' ? 'bg-green-600 text-white shadow-[0_0_15px_rgba(22,163,74,0.4)]' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
          >
            <span className="material-icons text-sm align-middle mr-2">monetization_on</span>
            Cupones / Servicios (Finanzas)
          </button>
        </div>
      </div>

      {/* =========================================================
          PESTAÑA 1: PUBLICIDAD Y TRÁFICO
          ========================================================= */}
      {activeTab === 'trafico' && (
        <div className="space-y-8 animate-fade-in">
          
          <div className="flex justify-end">
            <button onClick={handleExportTrafficCSV} className="bg-pink-600 hover:bg-pink-500 text-white px-6 py-2 rounded-xl font-bold flex items-center shadow-[0_0_15px_rgba(236,72,153,0.4)] transition-all">
              <span className="material-icons mr-2">download</span> Exportar Interacciones
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#111111] border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-pink-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-pink-500/20 transition-all"></div>
              <h3 className="text-white/50 text-sm font-medium">Total Interacciones</h3>
              <p className="text-4xl font-black text-white mt-2">{totalClicks}</p>
              <p className="text-pink-500 text-xs mt-2 font-bold flex items-center">
                <span className="material-icons text-[14px] mr-1">trending_up</span> Histórico global
              </p>
            </div>

            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#111111] border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-purple-500/20 transition-all"></div>
              <h3 className="text-white/50 text-sm font-medium">Interacciones Hoy</h3>
              <p className="text-4xl font-black text-white mt-2">{todayClicks}</p>
              <p className="text-purple-400 text-xs mt-2 font-bold flex items-center">
                <span className="material-icons text-[14px] mr-1">today</span> Tráfico de la jornada
              </p>
            </div>

            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#111111] border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-cyan-500/20 transition-all"></div>
              <h3 className="text-white/50 text-sm font-medium">Kioscos Online</h3>
              <p className="text-4xl font-black text-white mt-2">{activeKiosks} <span className="text-xl text-white/30">/ {kiosksStatus.length}</span></p>
              <p className="text-cyan-400 text-xs mt-2 font-bold flex items-center">
                <span className="w-2 h-2 rounded-full bg-cyan-400 mr-2 animate-pulse"></span> Equipos reportando
              </p>
            </div>

            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#111111] border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-orange-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-orange-500/20 transition-all"></div>
              <h3 className="text-white/50 text-sm font-medium">Tienda Tendencia</h3>
              <p className="text-3xl font-black text-white mt-2 truncate">
                {topStores.length > 0 ? topStores[0].name : 'N/A'}
              </p>
              <p className="text-orange-400 text-xs mt-2 font-bold flex items-center">
                <span className="material-icons text-[14px] mr-1">local_fire_department</span> Más buscada
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-[#111111] border border-white/10 rounded-2xl p-6 flex flex-col">
              <h3 className="text-lg font-bold text-white mb-6 flex items-center">
                <span className="material-icons text-pink-500 mr-2">storefront</span> 
                Top 5 Tiendas
              </h3>
              <div className="space-y-6 flex-1">
                {topStores.length === 0 ? (
                  <p className="text-white/50 text-sm">No hay datos suficientes.</p>
                ) : (
                  topStores.map((store, index) => {
                    const max = topStores[0].count;
                    const percentage = (store.count / max) * 100;
                    return (
                      <div key={index}>
                        <div className="flex justify-between text-sm mb-2">
                          <span className="text-white font-medium truncate pr-4">{store.name}</span>
                          <span className="text-pink-500 font-bold whitespace-nowrap">{store.count} clics</span>
                        </div>
                        <div className="w-full bg-white/5 rounded-full h-2">
                          <div 
                            className="bg-gradient-to-r from-pink-600 to-pink-400 h-2 rounded-full shadow-[0_0_10px_rgba(236,72,153,0.5)] transition-all duration-1000 ease-out" 
                            style={{ width: `${percentage}%` }}
                          ></div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="bg-[#111111] border border-white/10 rounded-2xl p-6 flex flex-col">
              <h3 className="text-lg font-bold text-white mb-6 flex items-center">
                <span className="material-icons text-cyan-400 mr-2">category</span> 
                Top 5 Categorías
              </h3>
              <div className="space-y-6 flex-1">
                {topCategories.length === 0 ? (
                  <p className="text-white/50 text-sm">No hay datos suficientes.</p>
                ) : (
                  topCategories.map((cat, index) => {
                    const max = topCategories[0].count;
                    const percentage = (cat.count / max) * 100;
                    return (
                      <div key={index}>
                        <div className="flex justify-between text-sm mb-2">
                          <span className="text-white font-medium truncate pr-4">{cat.name}</span>
                          <span className="text-cyan-400 font-bold whitespace-nowrap">{cat.count} búsquedas</span>
                        </div>
                        <div className="w-full bg-white/5 rounded-full h-2">
                          <div 
                            className="bg-gradient-to-r from-cyan-600 to-cyan-400 h-2 rounded-full shadow-[0_0_10px_rgba(34,211,238,0.5)] transition-all duration-1000 ease-out" 
                            style={{ width: `${percentage}%` }}
                          ></div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="bg-[#111111] border border-white/10 rounded-2xl p-6 flex flex-col">
              <h3 className="text-lg font-bold text-white mb-6 flex items-center">
                <span className="material-icons text-purple-400 mr-2">important_devices</span> 
                Tráfico por Kiosco
              </h3>
              <div className="space-y-6 flex-1">
                {topKiosksActivity.length === 0 ? (
                  <p className="text-white/50 text-sm">No hay datos suficientes.</p>
                ) : (
                  topKiosksActivity.map((kiosk, index) => {
                    const max = topKiosksActivity[0].count;
                    const percentage = (kiosk.count / max) * 100;
                    return (
                      <div key={index}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-white font-medium truncate pr-4">{kiosk.name}</span>
                          <span className="text-purple-400 font-bold whitespace-nowrap">{kiosk.count} usos</span>
                        </div>
                        <p className="text-[10px] text-white/40 mb-2 truncate">{kiosk.location}</p>
                        <div className="w-full bg-white/5 rounded-full h-2">
                          <div 
                            className="bg-gradient-to-r from-purple-600 to-purple-400 h-2 rounded-full shadow-[0_0_10px_rgba(168,85,247,0.5)] transition-all duration-1000 ease-out" 
                            style={{ width: `${percentage}%` }}
                          ></div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          PESTAÑA 2: FINANZAS (Cupones y Servicios) 
          ========================================================= */}
      {activeTab === 'finanzas' && (
        <div className="space-y-8 animate-fade-in">
          
          <div className="flex justify-end">
            <button onClick={handleExportCSV} className="bg-green-600 hover:bg-green-500 text-white px-6 py-2 rounded-xl font-bold flex items-center shadow-[0_0_15px_rgba(22,163,74,0.4)] transition-all">
              <span className="material-icons mr-2">download</span> Exportar Ventas
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#111111] border border-green-500/30 rounded-2xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-green-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-green-500/20 transition-all"></div>
              <h3 className="text-white/50 text-sm font-medium">Ingresos Totales Brutos</h3>
              <p className="text-5xl font-black text-white mt-2">${totalRevenueUSD.toFixed(2)}</p>
              <p className="text-green-400 text-xs mt-2 font-bold flex items-center">
                <span className="material-icons text-[14px] mr-1">verified</span> Pagos procesados exitosamente
              </p>
            </div>

            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#111111] border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-blue-500/20 transition-all"></div>
              <h3 className="text-white/50 text-sm font-medium">Operaciones Exitosas</h3>
              <p className="text-5xl font-black text-white mt-2">{totalSalesCount}</p>
              <p className="text-blue-400 text-xs mt-2 font-bold flex items-center">
                <span className="material-icons text-[14px] mr-1">shopping_cart</span> Cupones / Servicios vendidos
              </p>
            </div>
          </div>

          <div className="bg-[#111111] border border-white/10 rounded-2xl p-6 flex flex-col">
            <h3 className="text-lg font-bold text-white mb-6 flex items-center">
              <span className="material-icons text-green-400 mr-2">military_tech</span> 
              Top 5 Artículos de Mayor Recaudación
            </h3>
            <div className="space-y-6 flex-1">
              {topSellingItems.length === 0 ? (
                <p className="text-white/50 text-sm">No hay ventas registradas aún.</p>
              ) : (
                topSellingItems.map((item, index) => {
                  const max = topSellingItems[0].revenue;
                  const percentage = (item.revenue / max) * 100;
                  return (
                    <div key={index}>
                      <div className="flex justify-between text-sm mb-2">
                        <span className="text-white font-medium pr-4">{item.name} <span className="text-white/40 text-xs ml-2">({item.count} ventas)</span></span>
                        <span className="text-green-400 font-black whitespace-nowrap">${item.revenue.toFixed(2)}</span>
                      </div>
                      <div className="w-full bg-white/5 rounded-full h-3">
                        <div 
                          className="bg-gradient-to-r from-green-600 to-green-400 h-3 rounded-full shadow-[0_0_10px_rgba(74,222,128,0.5)] transition-all duration-1000 ease-out" 
                          style={{ width: `${percentage}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

        </div>
      )}

    </div>
  );
}