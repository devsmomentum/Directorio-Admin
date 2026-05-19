'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'from-cyan-500/20 to-blue-500/10 border-cyan-500/30 text-cyan-300',
  ORO: 'from-amber-500/20 to-orange-500/10 border-amber-500/30 text-amber-300',
  IA_PERFORMANCE: 'from-purple-500/20 to-pink-500/10 border-purple-500/30 text-purple-300',
  PUBLI_PROMO_DIARIO: 'from-blue-500/20 to-cyan-500/10 border-blue-500/30 text-blue-300',
  PUBLI_PROMO_SEMANAL: 'from-blue-500/20 to-cyan-500/10 border-blue-500/30 text-blue-300',
  FLASH_COUPON_DIARIO: 'from-pink-500/20 to-rose-500/10 border-pink-500/30 text-pink-300',
  FLASH_COUPON_SEMANAL: 'from-pink-500/20 to-rose-500/10 border-pink-500/30 text-pink-300',
};

export default function ClientePlanesPage() {
  const { selectedStore: store } = useClienteStore();
  const [plans, setPlans] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  useEffect(() => {
    if (!store) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [plansRes, reqRes] = await Promise.all([
        supabase.from('plans').select('*').eq('is_active', true).order('display_order', { ascending: true }),
        supabase.from('plan_requests').select('*').eq('store_id', store.id).order('created_at', { ascending: false }),
      ]);
      if (cancelled) return;
      setPlans(plansRes.data || []);
      setRequests(reqRes.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [store]);

  const handleRequest = async (plan: any) => {
    if (!store) {
      setFeedback({ type: 'err', msg: 'No hay tienda seleccionada.' });
      return;
    }
    setSubmitting(plan.plan_key);
    setFeedback(null);
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('plan_requests').insert([{
      store_id: store.id,
      plan_key: plan.plan_key,
      requested_by: user?.id ?? null,
      status: 'pending',
      notes: `Solicitud para plan ${plan.name} · tienda ${store.name}`,
    }]).select().single();

    setSubmitting(null);
    if (error) {
      setFeedback({ type: 'err', msg: 'No se pudo enviar la solicitud: ' + error.message });
    } else {
      setFeedback({ type: 'ok', msg: `Solicitud enviada para el plan ${plan.name}. El admin revisará y te confirmará.` });
      if (data) setRequests(r => [data, ...r]);
    }
  };

  const pendingByPlan = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const r of requests) if (r.status === 'pending') map[r.plan_key] = true;
    return map;
  }, [requests]);

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver y solicitar planes.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
          Catálogo · {store.name}
        </p>
        <h2 className="text-2xl font-bold text-white">Planes Publicitarios</h2>
        <p className="text-white/50 text-sm mt-2">
          Elige el plan que mejor se adapte a tu marca. Tras solicitar, la administración revisará y te
          contactará para confirmar la activación.
        </p>
      </div>

      {store.plan_type && (
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <p className="text-emerald-300 text-sm font-semibold">
            Plan actual de {store.name}: <span className="font-bold">{store.plan_type}</span>
          </p>
          <p className="text-white/50 text-xs mt-1">
            Si quieres cambiar de plan, solicita el nuevo y el admin coordinará el upgrade.
          </p>
        </div>
      )}

      {feedback && (
        <div className={`rounded-lg p-3 text-sm border ${
          feedback.type === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {feedback.msg}
        </div>
      )}

      {plans.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">No hay planes disponibles en este momento.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map(p => {
            const colors = PLAN_COLORS[p.plan_key] || 'from-white/5 to-white/0 border-white/10 text-white/70';
            const isPending = pendingByPlan[p.plan_key];
            const isCurrent = store.plan_type === p.plan_key;
            return (
              <div key={p.id} className={`bg-gradient-to-br ${colors} border rounded-2xl p-5 flex flex-col`}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-bold text-white">{p.name}</h3>
                    <p className="text-[11px] text-white/50 font-mono uppercase tracking-wider mt-0.5">
                      {p.plan_key}
                    </p>
                  </div>
                  {isCurrent && (
                    <span className="text-[10px] text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md font-semibold">
                      ACTUAL
                    </span>
                  )}
                </div>

                {p.description && (
                  <p className="text-white/60 text-xs mb-4 leading-relaxed">{p.description}</p>
                )}

                <div className="space-y-1.5 mb-4">
                  {p.price_usd != null && (
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-black text-white">${Number(p.price_usd).toLocaleString('en-US')}</span>
                      <span className="text-white/40 text-xs">USD</span>
                    </div>
                  )}
                  <p className="text-white/40 text-xs">
                    {p.duration_days} días · {p.video_seconds}s video · prioridad {p.priority_level}
                  </p>
                </div>

                {p.features?.length > 0 && (
                  <ul className="space-y-1.5 mb-5 flex-1">
                    {p.features.map((f: string, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-white/70">
                        <svg className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  onClick={() => handleRequest(p)}
                  disabled={isPending || isCurrent || submitting === p.plan_key}
                  className={`w-full text-sm font-semibold rounded-lg px-4 py-2.5 transition-colors ${
                    isCurrent
                      ? 'bg-emerald-500/10 text-emerald-400 cursor-default'
                      : isPending
                      ? 'bg-amber-500/10 text-amber-400 cursor-default'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  } disabled:opacity-60`}
                >
                  {isCurrent
                    ? 'Plan actual'
                    : isPending
                    ? 'Solicitud pendiente'
                    : submitting === p.plan_key
                    ? 'Enviando...'
                    : 'Solicitar plan'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {requests.length > 0 && (
        <div className="mt-8">
          <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-3">
            Solicitudes de {store.name} ({requests.length})
          </p>
          <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 font-medium">Notas</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} className="border-b border-white/[0.03]">
                    <td className="px-4 py-2.5 text-white/80 font-mono text-xs">{r.plan_key}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                        r.status === 'approved' ? 'text-emerald-400 bg-emerald-500/10'
                        : r.status === 'rejected' ? 'text-red-400 bg-red-500/10'
                        : 'text-amber-400 bg-amber-500/10'
                      }`}>
                        {r.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-white/40 text-xs">
                      {new Date(r.created_at).toLocaleString('es-VE')}
                    </td>
                    <td className="px-4 py-2.5 text-white/50 text-xs">{r.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
