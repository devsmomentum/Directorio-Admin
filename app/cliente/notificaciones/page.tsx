'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';
import { toast } from '../../components/toast';
import { ErrorState } from '../../components/ErrorState';
import { PageSpinner } from '../../components/PageSpinner';

type Notification = {
  id: string;
  store_id: string;
  type: string;
  title: string | null;
  message: string | null;
  metadata: any;
  created_at: string;
  read_at: string | null;
};

type Filter = 'unread' | 'all';

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  campaign_approved: { label: 'CAMPAÑA APROBADA',  cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/40' },
  campaign_rejected: { label: 'CAMPAÑA RECHAZADA', cls: 'text-red-300 bg-red-500/15 border-red-500/40' },
  coupon_approved:   { label: 'CUPÓN APROBADO',    cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/40' },
  coupon_rejected:   { label: 'CUPÓN RECHAZADO',   cls: 'text-red-300 bg-red-500/15 border-red-500/40' },
  info:              { label: 'AVISO',             cls: 'text-cyan-300 bg-cyan-500/15 border-cyan-500/30' },
};

export default function ClienteNotificacionesPage() {
  const { selectedStore: store, refreshUnread } = useClienteStore();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<Filter>('unread');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetchData = async () => {
    if (!store) { setLoading(false); return; }
    setLoading(true);
    setError(false);
    const { data, error: err } = await supabase
      .from('client_notifications')
      .select('*')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (err) {
      setError(true);
      setLoading(false);
      return;
    }
    setNotifications(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store?.id]);

  const visible = useMemo(() => {
    if (filter === 'all') return notifications;
    return notifications.filter(n => !n.read_at);
  }, [notifications, filter]);

  const unreadCount = useMemo(
    () => notifications.filter(n => !n.read_at).length,
    [notifications]
  );

  const markOne = async (n: Notification) => {
    if (n.read_at) return;
    setBusy(true);
    const { error } = await supabase.rpc('mark_client_notification_read', { p_id: n.id });
    setBusy(false);
    if (error) { toast.error('No se pudo marcar como leída.'); return; }
    setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
    refreshUnread();
  };

  const markAll = async () => {
    if (!store || unreadCount === 0) return;
    setBusy(true);
    const { error } = await supabase.rpc('mark_all_client_notifications_read', { p_store_id: store.id });
    setBusy(false);
    if (error) { toast.error('No se pudieron marcar como leídas.'); return; }
    const now = new Date().toISOString();
    setNotifications(prev => prev.map(n => n.read_at ? n : { ...n, read_at: now }));
    refreshUnread();
    toast.success('Notificaciones marcadas como leídas.');
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver tus notificaciones.
      </div>
    );
  }

  if (loading) {
    return <PageSpinner label="Cargando notificaciones…" />;
  }

  if (error) {
    return (
      <ErrorState
        title="No se pudieron cargar las notificaciones"
        message="Revisa tu conexión e inténtalo de nuevo."
        onRetry={fetchData}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Centro de mensajes · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Notificaciones</h2>
          <p className="text-white/50 text-sm mt-2">
            Resultado de la revisión de tus campañas y cupones, y avisos del administrador.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={fetchData}
            className="shrink-0 text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 rounded-lg px-4 py-2"
          >
            ↻ Refrescar
          </button>
          <button
            onClick={markAll}
            disabled={busy || unreadCount === 0}
            className="shrink-0 text-sm font-medium bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-200 rounded-lg px-4 py-2 disabled:opacity-40"
          >
            Marcar todas como leídas
          </button>
        </div>
      </div>

      <div className="flex bg-white/[0.03] border border-white/10 rounded-lg p-1 w-fit">
        {(['unread', 'all'] as Filter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
              filter === f ? 'bg-cyan-500/20 text-cyan-300' : 'text-white/40 hover:text-white/70'
            }`}
          >
            {f === 'unread' ? 'No leídas' : 'Todas'}
            {f === 'unread' && unreadCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-amber-500/20 text-amber-300 rounded text-[10px] font-bold">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-10 text-center">
          <p className="text-white/30 text-sm">{filter === 'unread' ? 'No tienes notificaciones sin leer.' : 'Aún no tienes notificaciones.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(n => (
            <NotificationRow key={n.id} n={n} onMarkRead={() => markOne(n)} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  n, onMarkRead, busy,
}: { n: Notification; onMarkRead: () => void; busy: boolean }) {
  const badge = TYPE_BADGE[n.type] || TYPE_BADGE.info;
  const isUnread = !n.read_at;
  const isRejection = n.type === 'campaign_rejected' || n.type === 'coupon_rejected';
  const rejectionReason = n.metadata?.rejection_reason as string | null | undefined;
  const target = '/cliente/promociones';

  return (
    <div className={`relative rounded-xl border p-4 transition-colors ${
      isRejection
        ? 'bg-red-500/[0.06] border-red-500/40'
        : isUnread
        ? 'bg-cyan-500/[0.04] border-cyan-500/25'
        : 'bg-[#0F0F0F] border-white/5 opacity-70'
    }`}>
      {isUnread && (
        <span className={`absolute top-4 right-4 w-2 h-2 rounded-full ${isRejection ? 'bg-red-400' : 'bg-cyan-400'}`} />
      )}
      <div className="flex items-start gap-3 pr-8">
        <span className={`shrink-0 text-[10px] font-bold tracking-widest px-2 py-1 rounded border ${badge.cls}`}>
          {badge.label}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${isRejection ? 'text-red-100' : 'text-white'}`}>
            {n.title || 'Notificación'}
          </p>
          {n.message && (
            <p className={`text-[13px] mt-1 leading-snug ${isRejection ? 'text-red-100/90' : 'text-white/70'}`}>
              {n.message}
            </p>
          )}
          {isRejection && rejectionReason && (
            <div className="mt-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2">
              <p className="text-[10px] text-red-300/80 uppercase tracking-wider font-semibold">Motivo</p>
              <p className="text-[13px] text-red-100 leading-snug">{rejectionReason}</p>
            </div>
          )}
          <p className="text-[10px] text-white/30 font-mono mt-2">
            {new Date(n.created_at).toLocaleString('es-VE')}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-white/5">
        <Link
          href={target}
          className="text-[11px] font-medium text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
        >
          Ir a promociones →
        </Link>
        {isUnread && (
          <button
            onClick={onMarkRead}
            disabled={busy}
            className="text-[11px] font-medium text-white/50 hover:text-white/80 bg-white/5 hover:bg-white/10 rounded-md px-2.5 py-1 disabled:opacity-40"
          >
            Marcar leída
          </button>
        )}
      </div>
    </div>
  );
}
