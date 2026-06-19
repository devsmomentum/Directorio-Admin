'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { toast } from '../../components/toast';
import { notifyUnreadChanged } from '../../components/unread-bus';

type Notification = {
  id: string;
  type: string;
  title: string | null;
  message: string | null;
  metadata: any;
  created_at: string;
  read_at: string | null;
};

type Filter = 'unread' | 'all';

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  review:  { label: 'REVISIÓN',   cls: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
  info:    { label: 'INFO',       cls: 'text-cyan-300 bg-cyan-500/15 border-cyan-500/30' },
  warning: { label: 'AVISO',      cls: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
  error:   { label: 'ERROR',      cls: 'text-red-300 bg-red-500/15 border-red-500/30' },
};

export default function AdminNotificacionesPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<Filter>('unread');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const fetchData = async () => {
    const { data } = await supabase
      .from('admin_notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    setNotifications(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

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
    const { error } = await supabase.rpc('mark_admin_notification_read', { p_id: n.id });
    setBusy(false);
    if (error) { toast.error('No se pudo marcar como leída.'); return; }
    setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
    notifyUnreadChanged();
  };

  const markAll = async () => {
    if (unreadCount === 0) return;
    setBusy(true);
    const { error } = await supabase.rpc('mark_all_admin_notifications_read');
    setBusy(false);
    if (error) { toast.error('No se pudieron marcar como leídas.'); return; }
    const now = new Date().toISOString();
    setNotifications(prev => prev.map(n => n.read_at ? n : { ...n, read_at: now }));
    notifyUnreadChanged();
    toast.success('Notificaciones marcadas como leídas.');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <PageSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Centro de mensajes</p>
          <h2 className="text-2xl font-bold text-white">Notificaciones</h2>
          <p className="text-white/50 text-sm mt-2">
            Avisos del sistema, kill-switch del loop, vencimientos y contenido pendiente de revisión.
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
          <p className="text-white/30 text-sm">{filter === 'unread' ? 'No hay notificaciones sin leer.' : 'No hay notificaciones.'}</p>
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
  const entity = n.metadata?.entity as string | undefined;
  const entityId = n.metadata?.entity_id as string | undefined;
  const reviewLink = entity && entityId
    ? `/panel/solicitudes?focus=${entity}:${entityId}`
    : null;

  return (
    <div className={`relative rounded-xl border p-4 transition-colors ${
      isUnread
        ? 'bg-cyan-500/[0.04] border-cyan-500/25 hover:bg-cyan-500/[0.06]'
        : 'bg-[#0F0F0F] border-white/5 opacity-70'
    }`}>
      {isUnread && (
        <span className="absolute top-4 right-4 w-2 h-2 rounded-full bg-cyan-400" />
      )}
      <div className="flex items-start gap-3 pr-8">
        <span className={`shrink-0 text-[10px] font-bold tracking-widest px-2 py-1 rounded border ${badge.cls}`}>
          {badge.label}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">{n.title || 'Notificación'}</p>
          {n.message && <p className="text-[13px] text-white/70 mt-1 leading-snug">{n.message}</p>}
          <p className="text-[10px] text-white/30 font-mono mt-2">
            {new Date(n.created_at).toLocaleString('es-VE')}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-white/5">
        {reviewLink && (
          <Link
            href={reviewLink}
            className="text-[11px] font-medium text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
          >
            Ir a revisión →
          </Link>
        )}
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
