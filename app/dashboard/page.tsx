'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../lib/supabase';

export default function DashboardPage() {
  const [kiosks, setKiosks] = useState<any[]>([]);
  const [stores, setStores] = useState<number>(0);
  const [campaigns, setCampaigns] = useState<number>(0);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [cobrosAlert, setCobrosAlert] = useState<any[]>([]);
  const [contractsAlert, setContractsAlert] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setRefreshing(true);
    const today = new Date().toISOString().split('T')[0];
    const in3days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const in30days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [kiosksRes, storesRes, campaignsRes, notifRes, cobrosRes, contractsRes] = await Promise.all([
      supabase.from('kiosks').select('*').order('created_at', { ascending: false }),
      supabase.from('stores').select('id', { count: 'exact', head: true }),
      supabase.from('ad_campaigns').select('id', { count: 'exact', head: true }),
      supabase.from('admin_notifications').select('*').is('read_at', null).order('created_at', { ascending: false }).limit(5),
      supabase.from('ad_campaigns')
        .select('id, brand_name, end_date, payment_status')
        .gte('end_date', today)
        .lte('end_date', in3days)
        .eq('is_active', true)
        .neq('payment_status', 'paid')
        .limit(10),
      supabase.from('stores')
        .select('id, name, contract_expiry_date')
        .not('contract_expiry_date', 'is', null)
        .gte('contract_expiry_date', today)
        .lte('contract_expiry_date', in30days)
        .order('contract_expiry_date', { ascending: true })
        .limit(10),
    ]);

    if (kiosksRes.data) setKiosks(kiosksRes.data);
    if (storesRes.count != null) setStores(storesRes.count);
    if (campaignsRes.count != null) setCampaigns(campaignsRes.count);
    if (notifRes.data) setNotifications(notifRes.data);
    if (cobrosRes.data) setCobrosAlert(cobrosRes.data);
    if (contractsRes.data) setContractsAlert(contractsRes.data);
    setLoading(false);
    setRefreshing(false);
  };

  // Un kiosco se considera online si last_ping es reciente (toleramos
  // hasta 10 min para cubrir el intervalo de ping de la app Flutter).
  const onlineCutoff = Date.now() - 10 * 60_000;
  const isKioskOnline = (k: any) =>
    !!k.last_ping &&
    new Date(k.last_ping).getTime() > onlineCutoff;
  const online = kiosks.filter(isKioskOnline).length;
  const offline = kiosks.length - online;

  const getTimeSince = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Ahora';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Dashboard</p>
          <h2 className="text-2xl font-bold text-white">Monitoreo de Hardware</h2>
        </div>
        <button
          onClick={fetchData}
          disabled={refreshing}
          className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50"
        >
          <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          {refreshing ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5 flex items-center justify-between">
          <div>
            <span className="text-white/30 text-[10px] uppercase tracking-wider">En linea</span>
            <div className="text-xl font-bold text-white leading-tight">{online}<span className="text-white/20 text-xs ml-0.5">/{kiosks.length}</span></div>
          </div>
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
        </div>

        <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5 flex items-center justify-between">
          <div>
            <span className="text-white/30 text-[10px] uppercase tracking-wider">Offline</span>
            <div className={`text-xl font-bold leading-tight ${offline > 0 ? 'text-red-400' : 'text-white'}`}>{offline}</div>
          </div>
          <span className="w-2 h-2 rounded-full bg-red-500" />
        </div>

        <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5 flex items-center justify-between">
          <div>
            <span className="text-white/30 text-[10px] uppercase tracking-wider">Tiendas</span>
            <div className="text-xl font-bold text-white leading-tight">{stores}</div>
          </div>
          <svg className="w-3.5 h-3.5 text-white/15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
        </div>

        <div className="bg-[#111] rounded-lg px-4 py-3 border border-white/5 flex items-center justify-between">
          <div>
            <span className="text-white/30 text-[10px] uppercase tracking-wider">Campanas</span>
            <div className="text-xl font-bold text-white leading-tight">{campaigns}</div>
          </div>
          <svg className="w-3.5 h-3.5 text-white/15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        </div>
      </div>

      {/* Alerts bar */}
      {(offline > 0 || notifications.length > 0 || cobrosAlert.length > 0 || contractsAlert.length > 0) && (
        <div className="flex flex-col gap-3">
          {/* Cobros alert — highest priority */}
          {cobrosAlert.length > 0 && (
            <Link
              href="/dashboard/campanias"
              className="flex items-start gap-3 bg-red-950/20 hover:bg-red-950/30 border border-red-500/25 hover:border-red-500/40 rounded-lg px-4 py-3 transition-colors group"
            >
              <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              <div className="flex-1 min-w-0">
                <p className="text-red-400 text-sm font-semibold flex items-center gap-1.5">
                  Alerta Cobranzas — {cobrosAlert.length} campaña{cobrosAlert.length > 1 ? 's' : ''} por vencer sin pago
                  <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" /></svg>
                </p>
                <p className="text-red-300/50 text-xs mt-0.5 truncate">
                  {cobrosAlert.map((c: any) => c.brand_name).join(', ')} — vencen en ≤3 días
                </p>
              </div>
            </Link>
          )}
          {/* Contratos por vencer ≤30 días */}
          {contractsAlert.length > 0 && (
            <Link
              href="/dashboard/tiendas"
              className="flex items-start gap-3 bg-amber-950/20 hover:bg-amber-950/30 border border-amber-500/20 hover:border-amber-500/35 rounded-lg px-4 py-3 transition-colors group"
            >
              <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              <div className="flex-1 min-w-0">
                <p className="text-amber-400 text-sm font-semibold flex items-center gap-1.5">
                  Contratos por vencer — {contractsAlert.length} tienda{contractsAlert.length > 1 ? 's' : ''} en ≤30 días
                  <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" /></svg>
                </p>
                <p className="text-amber-300/50 text-xs mt-0.5 truncate">
                  {contractsAlert.map((s: any) => `${s.name} (${new Date(s.contract_expiry_date).toLocaleDateString()})`).join(', ')}
                </p>
              </div>
            </Link>
          )}

          <div className="flex flex-wrap gap-3">
            {offline > 0 && (
              <div className="flex items-center gap-2 bg-red-500/5 border border-red-500/20 rounded-lg px-4 py-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                <span className="text-red-400 text-sm">{offline} kiosco{offline > 1 ? 's' : ''} sin conexion</span>
              </div>
            )}
            {notifications.length > 0 && (
              <Link
                href="/dashboard/campanias?highlight=expiring"
                className="flex items-start gap-2 bg-purple-500/5 hover:bg-purple-500/10 border border-purple-500/20 hover:border-purple-500/40 rounded-lg px-4 py-2.5 transition-colors group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 mt-1" />
                <div className="space-y-1 flex-1 min-w-0">
                  <p className="text-purple-300 text-sm font-medium flex items-center gap-1.5">
                    Campanas por vencer ({notifications.length})
                    <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                    </svg>
                  </p>
                  {notifications.map(n => (
                    <p key={n.id} className="text-purple-200/80 text-xs truncate">{n.message || n.title}</p>
                  ))}
                </div>
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Kiosk grid */}
      {kiosks.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
          <p className="text-white/30 text-sm">No hay kioscos registrados</p>
          <p className="text-white/15 text-xs mt-1">Agrega kioscos desde el Directorio de Kioscos</p>
        </div>
      ) : (
        <div>
          <p className="text-white/30 text-xs font-medium uppercase tracking-wider mb-4">Kioscos registrados</p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {kiosks.map((kiosk) => {
              const isOnline = isKioskOnline(kiosk);
              return (
                <div
                  key={kiosk.id}
                  className="bg-[#111] border border-white/5 rounded-xl p-5 hover:border-white/10 transition-colors group"
                >
                  {/* Top row: name + status */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-white text-sm truncate">
                        {kiosk.name || 'Kiosco sin nombre'}
                      </h3>
                      <p className="text-white/30 text-xs mt-0.5 truncate">{kiosk.location || 'Sin ubicacion'}</p>
                    </div>
                    <span className={`shrink-0 ml-3 flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md ${
                      isOnline
                        ? 'text-emerald-400 bg-emerald-500/10'
                        : 'text-red-400 bg-red-500/10'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {isOnline ? 'Online' : 'Offline'}
                    </span>
                  </div>

                  {/* Details */}
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-white/30">Hardware</span>
                      {kiosk.hardware_id ? (
                        <span className="text-white/60 font-mono">{kiosk.hardware_id.substring(0, 8)}</span>
                      ) : (
                        <span className="text-amber-400/70">Sin vincular</span>
                      )}
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-white/30">Ultimo ping</span>
                      <span className="text-white/40 font-mono">
                        {kiosk.last_ping ? getTimeSince(kiosk.last_ping) : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
