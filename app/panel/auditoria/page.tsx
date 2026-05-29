'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';

export default function AuditDashboard() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchAdmin, setSearchAdmin] = useState('');
  const [searchEntityName, setSearchEntityName] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    setRefreshing(true);
    try {
      const { data, error } = await supabase
        .from('admin_audit_logs')
        .select('*')
        .order('created_at', { ascending: sortOrder === 'asc' });

      if (error) throw error;
      if (data) setLogs(data);
    } catch (err: any) {
      console.error('Error fetching audit logs:', err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Volver a cargar si cambia el orden
  useEffect(() => {
    fetchLogs();
  }, [sortOrder]);

  // Filtrado de logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const adminMatch = !searchAdmin || log.admin_email.toLowerCase().includes(searchAdmin.toLowerCase());
      const entityNameMatch = !searchEntityName || (log.entity_name && log.entity_name.toLowerCase().includes(searchEntityName.toLowerCase()));
      const actionMatch = !actionFilter || log.action_type === actionFilter;
      const entityMatch = !entityFilter || log.entity_type === entityFilter;
      return adminMatch && entityNameMatch && actionMatch && entityMatch;
    });
  }, [logs, searchAdmin, searchEntityName, actionFilter, entityFilter]);

  const pg = usePagination(filteredLogs);

  // Estadísticas para las tarjetas superiores
  const stats = useMemo(() => {
    const total = logs.length;
    
    // Acciones en las últimas 24 horas
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const last24h = logs.filter(log => new Date(log.created_at) >= oneDayAgo).length;

    // Administradores activos
    const uniqueAdmins = new Set(logs.map(log => log.admin_email)).size;

    // Entidad más modificada
    const entityCounts: Record<string, number> = {};
    logs.forEach(log => {
      entityCounts[log.entity_type] = (entityCounts[log.entity_type] || 0) + 1;
    });
    let topEntity = 'Ninguna';
    let maxCount = 0;
    Object.entries(entityCounts).forEach(([ent, count]) => {
      if (count > maxCount) {
        maxCount = count;
        topEntity = ent.charAt(0).toUpperCase() + ent.slice(1);
      }
    });

    return { total, last24h, uniqueAdmins, topEntity: topEntity === 'Ninguna' ? '-' : `${topEntity} (${maxCount})` };
  }, [logs]);

  const getActionBadgeClass = (action: string) => {
    switch (action) {
      case 'CREAR':
      case 'APROBAR':
      case 'ACTIVAR':
        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      case 'EDITAR':
      case 'VINCULAR':
        return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      case 'ELIMINAR':
      case 'RECHAZAR':
      case 'DESACTIVAR':
      case 'DESVINCULAR':
        return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
      default:
        return 'text-blue-400 bg-blue-500/10 border-blue-500/20';
    }
  };

  const getEntityIcon = (entity: string) => {
    switch (entity) {
      case 'tienda':
        return '🛍️';
      case 'campaña':
        return '📺';
      case 'banner':
        return '🖼️';
      case 'cupón':
        return '🏷️';
      case 'kiosco':
        return '🖥️';
      case 'categoría':
        return '🗂️';
      case 'plan':
        return '💳';
      case 'servicio':
        return '🛠️';
      case 'pago':
        return '💰';
      default:
        return '📝';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('es-VE', {
      timeZone: 'America/Caracas',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  };

  const renderDetails = (details: any) => {
    if (!details) return <p className="text-white/30 text-xs italic">Sin detalles registrados.</p>;
    
    // Filtrar campos complejos o repetitivos para que se vea limpio
    const cleanDetails = { ...details };
    delete cleanDetails.logo_url;
    delete cleanDetails.image_url;
    delete cleanDetails.contract_url;
    delete cleanDetails.mercantil_url;
    delete cleanDetails.cedula_url;

    return (
      <div className="mt-3 bg-black/40 border border-white/5 rounded-xl p-4 text-[12px] font-mono text-white/80 max-w-full overflow-x-auto">
        <p className="text-[10px] text-white/40 uppercase tracking-wider mb-2 font-sans font-semibold">Carga útil del cambio (Payload):</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
          {Object.entries(cleanDetails).map(([key, val]) => {
            if (val === null || val === undefined) return null;
            let displayVal = String(val);
            if (typeof val === 'boolean') {
              displayVal = val ? 'Sí (True)' : 'No (False)';
            } else if (typeof val === 'object') {
              displayVal = JSON.stringify(val);
            }
            return (
              <div key={key} className="flex border-b border-white/5 py-1">
                <span className="text-cyan-400 font-semibold w-1/3 shrink-0">{key}:</span>
                <span className="text-white/90 break-all select-all">{displayVal}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <div className="w-8 h-8 border-2 border-brand-admin border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Seguridad & Cumplimiento</p>
          <h2 className="text-2xl font-bold text-white">Auditoría de Administradores</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchLogs}
            disabled={refreshing}
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? 'Actualizando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      {/* Cards de Estadísticas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#111] border border-white/5 rounded-2xl p-5 flex flex-col justify-between shadow-lg">
          <span className="text-xs text-white/40 font-medium uppercase tracking-wider">Total de Acciones</span>
          <span className="text-3xl font-extrabold text-white mt-2 font-mono">{stats.total}</span>
          <span className="text-[11px] text-white/30 mt-1">Registradas históricamente</span>
        </div>
        <div className="bg-[#111] border border-white/5 rounded-2xl p-5 flex flex-col justify-between shadow-lg">
          <span className="text-xs text-white/40 font-medium uppercase tracking-wider">Últimas 24 Horas</span>
          <span className="text-3xl font-extrabold text-emerald-400 mt-2 font-mono">{stats.last24h}</span>
          <span className="text-[11px] text-emerald-400/50 mt-1">Acciones registradas hoy</span>
        </div>
        <div className="bg-[#111] border border-white/5 rounded-2xl p-5 flex flex-col justify-between shadow-lg">
          <span className="text-xs text-white/40 font-medium uppercase tracking-wider">Admins Activos</span>
          <span className="text-3xl font-extrabold text-cyan-400 mt-2 font-mono">{stats.uniqueAdmins}</span>
          <span className="text-[11px] text-cyan-400/50 mt-1">Usuarios que han operado</span>
        </div>
        <div className="bg-[#111] border border-white/5 rounded-2xl p-5 flex flex-col justify-between shadow-lg">
          <span className="text-xs text-white/40 font-medium uppercase tracking-wider">Módulo Más Operado</span>
          <span className="text-lg font-bold text-amber-400 mt-2 truncate">{stats.topEntity}</span>
          <span className="text-[11px] text-amber-400/50 mt-1">Entidad con mayor número de eventos</span>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-[#111] border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
        <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wider">Filtrar registros</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Admin Email */}
          <div className="relative">
            <input
              type="text"
              value={searchAdmin}
              onChange={(e) => setSearchAdmin(e.target.value)}
              placeholder="Buscar por admin..."
              className="w-full bg-[#161616] border border-white/5 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
            />
          </div>

          {/* Nombre Entidad */}
          <div className="relative">
            <input
              type="text"
              value={searchEntityName}
              onChange={(e) => setSearchEntityName(e.target.value)}
              placeholder="Buscar por recurso (nombre)..."
              className="w-full bg-[#161616] border border-white/5 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
            />
          </div>

          {/* Tipo de Acción */}
          <div>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="w-full bg-[#161616] border border-white/5 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/10 transition-colors"
            >
              <option value="">Todas las acciones</option>
              <option value="CREAR">CREAR</option>
              <option value="EDITAR">EDITAR</option>
              <option value="ELIMINAR">ELIMINAR</option>
              <option value="APROBAR">APROBAR</option>
              <option value="RECHAZAR">RECHAZAR</option>
              <option value="ACTIVAR">ACTIVAR</option>
              <option value="DESACTIVAR">DESACTIVAR</option>
              <option value="VINCULAR">VINCULAR</option>
              <option value="DESVINCULAR">DESVINCULAR</option>
            </select>
          </div>

          {/* Tipo de Entidad */}
          <div>
            <select
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              className="w-full bg-[#161616] border border-white/5 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/10 transition-colors"
            >
              <option value="">Todas las entidades</option>
              <option value="tienda">Tiendas 🛍️</option>
              <option value="campaña">Campañas 📺</option>
              <option value="banner">Banners 🖼️</option>
              <option value="cupón">Cupones 🏷️</option>
              <option value="kiosco">Kioscos 🖥️</option>
              <option value="categoría">Categorías 🗂️</option>
              <option value="plan">Planes 💳</option>
              <option value="servicio">Servicios 🛠️</option>
              <option value="pago">Pagos 💰</option>
            </select>
          </div>

          {/* Orden */}
          <div>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as 'desc' | 'asc')}
              className="w-full bg-[#161616] border border-white/5 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/10 transition-colors"
            >
              <option value="desc">Más recientes primero</option>
              <option value="asc">Más antiguos primero</option>
            </select>
          </div>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-[#111] border border-white/5 rounded-2xl overflow-hidden shadow-lg">
        {filteredLogs.length === 0 ? (
          <div className="p-12 text-center">
            <svg className="w-12 h-12 text-white/10 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            <p className="text-white/40 text-sm font-medium">No se encontraron registros de auditoría que coincidan con los filtros.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {/* Header de tabla (escritorio) */}
            <div className="hidden md:grid md:grid-cols-12 gap-4 px-6 py-4 text-xs font-semibold text-white/40 uppercase tracking-wider bg-white/2">
              <div className="col-span-3">Fecha & Hora (CCS)</div>
              <div className="col-span-3">Administrador</div>
              <div className="col-span-2">Acción</div>
              <div className="col-span-3">Recurso / Entidad</div>
              <div className="col-span-1 text-right">Detalles</div>
            </div>

            {/* Registros */}
            {pg.paginated.map((log) => {
              const isExpanded = expandedLogId === log.id;
              return (
                <div key={log.id} className="transition-colors hover:bg-white/1">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4 px-6 py-4 items-center text-sm">
                    {/* Fecha */}
                    <div className="col-span-3 text-white/60 font-mono text-[13px] flex items-center gap-2">
                      <span className="md:hidden text-white/30 text-xs font-sans font-medium uppercase">Fecha:</span>
                      <svg className="w-3.5 h-3.5 text-white/30 hidden md:block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      {formatDate(log.created_at)}
                    </div>

                    {/* Administrador */}
                    <div className="col-span-3 text-white font-medium flex items-center gap-2">
                      <span className="md:hidden text-white/30 text-xs font-sans font-medium uppercase">Admin:</span>
                      <div className="w-5 h-5 rounded-full bg-brand-admin/20 flex items-center justify-center text-[10px] text-brand-admin font-bold">
                        {log.admin_email.substring(0, 1).toUpperCase()}
                      </div>
                      <span className="truncate">{log.admin_email}</span>
                    </div>

                    {/* Acción */}
                    <div className="col-span-2 flex items-center">
                      <span className="md:hidden text-white/30 text-xs font-sans font-medium uppercase mr-2">Acción:</span>
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold border ${getActionBadgeClass(log.action_type)}`}>
                        {log.action_type}
                      </span>
                    </div>

                    {/* Recurso */}
                    <div className="col-span-3 text-white/80 flex items-center gap-2 flex-wrap">
                      <span className="md:hidden text-white/30 text-xs font-sans font-medium uppercase mr-2">Recurso:</span>
                      <span className="inline-flex items-center gap-1 bg-white/5 text-white/70 px-2 py-0.5 rounded text-xs">
                        <span>{getEntityIcon(log.entity_type)}</span>
                        <span className="capitalize">{log.entity_type}</span>
                      </span>
                      {log.entity_name && (
                        <span className="font-semibold text-white/90 truncate max-w-[150px] md:max-w-[200px]" title={log.entity_name}>
                          {log.entity_name}
                        </span>
                      )}
                    </div>

                    {/* Expand/Collapse */}
                    <div className="col-span-1 text-right flex md:block justify-end">
                      <button
                        onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                        className="flex items-center justify-center gap-1.5 text-xs text-brand-admin hover:text-brand-admin/80 font-medium px-3 py-1.5 rounded-lg border border-brand-admin/20 bg-brand-admin/5 hover:bg-brand-admin/10 transition-colors w-full md:w-auto"
                      >
                        <span>{isExpanded ? 'Ocultar' : 'Ver'}</span>
                        <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                    </div>
                  </div>

                  {/* Detalle Expandido */}
                  {isExpanded && (
                    <div className="px-6 pb-6 pt-2 bg-white/1 border-t border-white/5 animate-fadeIn">
                      {renderDetails(log.details)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {pg.totalPages > 1 && (
        <Pagination
          page={pg.page}
          totalPages={pg.totalPages}
          total={pg.total}
          perPage={pg.perPage}
          label="registros"
          onPageChange={pg.setPage}
          onPerPageChange={pg.changePerPage}
        />
      )}
    </div>
  );
}
