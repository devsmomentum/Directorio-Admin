'use client';

// =====================================================================
// CLIENTE · Candidatos
// Lista las reservas PENDIENTES de la tienda activa y permite CANJEARLAS.
// El canje (redeem_coupon) es la ÚNICA operación que baja el stock, y es
// atómico/race-safe en el servidor. El cliente identifica al usuario por:
//   - Escaneo del QR del correo (redemption_token), o
//   - Búsqueda por cédula / nombre / correo.
// =====================================================================

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';
import { couponBadge } from '../../../lib/coupon-offers';

type Candidate = {
  id: string;
  coupon_id: string;
  first_name: string | null;
  last_name: string | null;
  id_document: string | null;
  telefono: string | null;
  email: string;
  status: string;
  created_at: string;
  redemption_token: string;
  coupons: {
    title: string | null;
    code: string | null;
    discount_percent: number | null;
    offer_type: string | null;
    offer_label: string | null;
    end_date: string | null;
    image_url: string | null;
    amount_available: number | null;
    category: string | null;
    plan_type: string | null;
  } | null;
};

type RedeemError =
  | 'ALREADY_REDEEMED'
  | 'OUT_OF_STOCK'
  | 'NOT_AUTHORIZED'
  | 'CLAIM_NOT_FOUND'
  | 'UNKNOWN';

const ERROR_COPY: Record<RedeemError, string> = {
  ALREADY_REDEEMED: 'Esta reserva ya fue canjeada (o expiró).',
  OUT_OF_STOCK: 'El cupón se quedó sin stock. No se pudo canjear.',
  NOT_AUTHORIZED: 'No tienes permiso para canjear cupones de esta tienda.',
  CLAIM_NOT_FOUND: 'No se encontró la reserva.',
  UNKNOWN: 'No se pudo canjear. Intenta de nuevo.',
};

function parseRedeemError(message: string | undefined): RedeemError {
  const m = message ?? '';
  if (m.includes('ALREADY_REDEEMED')) return 'ALREADY_REDEEMED';
  if (m.includes('OUT_OF_STOCK')) return 'OUT_OF_STOCK';
  if (m.includes('NOT_AUTHORIZED')) return 'NOT_AUTHORIZED';
  if (m.includes('CLAIM_NOT_FOUND')) return 'CLAIM_NOT_FOUND';
  return 'UNKNOWN';
}

export default function CandidatosPage() {
  const { selectedStore: store } = useClienteStore();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [detailCandidate, setDetailCandidate] = useState<Candidate | null>(null);
  const [confirmRedeemCandidate, setConfirmRedeemCandidate] = useState<Candidate | null>(null);

  const fetchData = useCallback(async () => {
    if (!store) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('coupon_leads')
      .select(
        'id, coupon_id, first_name, last_name, id_document, telefono, email, status, created_at, redemption_token, coupons(title, code, discount_percent, offer_type, offer_label, end_date, image_url, amount_available, category, plan_type)',
      )
      .eq('store_id', store.id)
      .eq('status', 'PENDIENTE')
      .order('created_at', { ascending: false })
      .limit(500);
    setCandidates((data || []) as unknown as Candidate[]);
    setLoading(false);
  }, [store]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Errores duran más para que el vendedor los pueda leer.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'err' ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => {
      const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.toLowerCase();
      return (
        c.redemption_token.toLowerCase() === q ||
        (c.id_document ?? '').toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.telefono ?? '').replace(/[\s\-]/g, '').includes(q.replace(/[\s\-]/g, '')) ||
        name.includes(q)
      );
    });
  }, [candidates, query]);

  const handleRedeem = async (c: Candidate) => {
    if (redeemingId) return;
    setRedeemingId(c.id);

    let data: unknown, error: { message?: string } | null;
    try {
      const res = await supabase.rpc('redeem_coupon', {
        p_claim_id: c.id,
        p_coupon_id: c.coupon_id,
      });
      data = res.data;
      error = res.error;
    } catch {
      setRedeemingId(null);
      setToast({ kind: 'err', text: 'Error de red. Verifica la conexión e intenta de nuevo.' });
      return;
    }
    setRedeemingId(null);

    if (error) {
      const code = parseRedeemError(error.message);
      setToast({ kind: 'err', text: ERROR_COPY[code] });
      // Si ya estaba canjeado/agotado, lo sacamos de la lista para reflejar realidad.
      if (code === 'ALREADY_REDEEMED' || code === 'OUT_OF_STOCK') {
        setCandidates((prev) => prev.filter((x) => x.id !== c.id));
      }
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const remaining = row?.remaining;
    setCandidates((prev) => prev.filter((x) => x.id !== c.id));
    setToast({
      kind: 'ok',
      text: `✓ Cupón canjeado para ${c.first_name ?? c.email}.${
        typeof remaining === 'number' ? ` Quedan ${remaining} en stock.` : ''
      }`,
    });
  };

  const onScanned = (token: string) => {
    setScanOpen(false);
    setQuery(token);
    const match = candidates.find((c) => c.redemption_token === token);
    if (!match) {
      setToast({ kind: 'err', text: 'El QR no corresponde a una reserva pendiente de esta tienda.' });
    }
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver tus candidatos.
      </div>
    );
  }

  // Defensa en profundidad: el canje es solo para dueño o vendedor. El
  // publicista no debe llegar aquí (el layout ya redirige), pero por si acaso
  // evitamos mostrar la pantalla. La barrera real es RLS + el RPC redeem_coupon.
  if (store.store_role !== 'owner' && store.store_role !== 'seller') {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        El canje de cupones no está disponible para tu rol en esta tienda.
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Canje de cupones · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Canjes</h2>
          <p className="text-white/50 text-sm mt-2">
            Clientes que reservaron un cupón y aún no lo han canjeado. Escanea su QR o búscalo
            por cédula/nombre y presiona <strong>Canjear</strong>. El stock solo baja al canjear.
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
            onClick={() => setScanOpen(true)}
            className="shrink-0 text-sm font-medium bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-200 rounded-lg px-4 py-2"
          >
            📷 Escanear QR
          </button>
        </div>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por cédula, nombre, correo o código de canje…"
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder-white/30 focus:border-red-500 focus:outline-none"
      />

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <PageSpinner />
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-10 text-center">
          <p className="text-white/30 text-sm">
            {query
              ? 'Ningún candidato coincide con la búsqueda.'
              : 'No hay reservas pendientes por canjear.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((c) => (
            <CandidateRow
              key={c.id}
              c={c}
              onRedeem={() => setConfirmRedeemCandidate(c)}
              onViewDetails={() => setDetailCandidate(c)}
              busy={redeemingId === c.id}
              disabled={redeemingId !== null && redeemingId !== c.id}
            />
          ))}
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-xl px-5 py-3 text-sm font-medium shadow-2xl border ${
            toast.kind === 'ok'
              ? 'bg-emerald-600 border-emerald-400 text-white'
              : 'bg-red-600 border-red-400 text-white'
          }`}
        >
          {toast.text}
        </div>
      )}

      {scanOpen && <QrScanner onClose={() => setScanOpen(false)} onScanned={onScanned} />}

      {/* Modal: Detalle de Cupón/Reserva */}
      {detailCandidate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/85 backdrop-blur-sm"
            onClick={() => setDetailCandidate(null)}
          />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between shrink-0">
              <h3 className="text-base font-bold text-white">
                Detalles del Cupón y Reserva
              </h3>
              <button
                onClick={() => setDetailCandidate(null)}
                className="text-white/50 hover:text-white text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-6 py-5 space-y-5 overflow-y-auto">
              {/* Coupon Info */}
              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 space-y-3">
                <span className="inline-block bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold font-mono">
                  Detalles del Cupón
                </span>
                {detailCandidate.coupons?.image_url && (
                  <div className="relative h-32 w-full rounded-lg overflow-hidden bg-black/50 border border-white/5 flex items-center justify-center">
                    <img
                      src={detailCandidate.coupons.image_url}
                      alt={detailCandidate.coupons.title ?? 'Cupón'}
                      className="h-full w-full object-cover"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <h4 className="text-lg font-bold text-white leading-tight">
                    {detailCandidate.coupons?.title ?? 'Cupón Promocional'}
                  </h4>
                  <div className="grid grid-cols-2 gap-3 text-xs pt-1">
                    <div className="bg-white/5 rounded-lg p-2 border border-white/5">
                      <span className="block text-white/45 text-[10px] uppercase">Promoción</span>
                      <span className="text-emerald-400 font-bold font-mono text-sm">
                        {detailCandidate.coupons ? couponBadge(detailCandidate.coupons) : '—'}
                      </span>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 border border-white/5">
                      <span className="block text-white/45 text-[10px] uppercase">Código de Cupón</span>
                      <span className="text-white/80 font-bold font-mono text-sm">
                        {detailCandidate.coupons?.code ?? '—'}
                      </span>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 border border-white/5">
                      <span className="block text-white/45 text-[10px] uppercase">Categoría</span>
                      <span className="text-white/80 font-semibold text-sm">
                        {detailCandidate.coupons?.category ?? 'General'}
                      </span>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 border border-white/5">
                      <span className="block text-white/45 text-[10px] uppercase">Stock Disponible</span>
                      <span className="text-white/80 font-semibold font-mono text-sm">
                        {detailCandidate.coupons?.amount_available ?? 0} u.
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center text-[11px] text-white/40 pt-2 border-t border-white/5 font-mono">
                    {detailCandidate.coupons?.plan_type && (
                      <span>Plan: {detailCandidate.coupons.plan_type}</span>
                    )}
                    {detailCandidate.coupons?.end_date && (
                      <span>Vence: {new Date(detailCandidate.coupons.end_date).toLocaleDateString('es-VE')}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Client Info */}
              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 space-y-3">
                <span className="inline-block bg-white/5 text-white/60 border border-white/10 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold font-mono">
                  Datos del Cliente
                </span>
                <div className="space-y-2.5">
                  <div>
                    <span className="block text-white/40 text-[10px] uppercase">Nombre Completo</span>
                    <span className="text-white font-semibold">
                      {`${detailCandidate.first_name ?? ''} ${detailCandidate.last_name ?? ''}`.trim() || '(sin nombre)'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="block text-white/40 text-[10px] uppercase">Cédula / Documento</span>
                      <span className="text-white/80 font-mono text-xs">
                        {detailCandidate.id_document ?? '—'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-white/40 text-[10px] uppercase">Teléfono</span>
                      <span className="text-white/80 font-mono text-xs">
                        {detailCandidate.telefono ?? '—'}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="block text-white/40 text-[10px] uppercase">Correo Electrónico</span>
                    <span className="text-white/80 text-xs font-mono">
                      {detailCandidate.email}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 border-t border-white/5 pt-2 text-[11px] text-white/40 font-mono">
                    <div>
                      <span>Reservado:</span>
                      <span className="block mt-0.5 font-sans">
                        {new Date(detailCandidate.created_at).toLocaleString('es-VE')}
                      </span>
                    </div>
                    <div>
                      <span>Token:</span>
                      <span className="block mt-0.5 text-white/60 truncate">
                        {detailCandidate.redemption_token}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-white/10 flex gap-3 bg-[#0a0a0a] shrink-0">
              <button
                type="button"
                onClick={() => setDetailCandidate(null)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white/80 bg-white/5 hover:bg-white/10 rounded-lg transition-colors border border-white/10"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={() => {
                  const candidate = detailCandidate;
                  setDetailCandidate(null);
                  setConfirmRedeemCandidate(candidate);
                }}
                className="flex-1 px-4 py-2.5 text-sm font-bold bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors shadow-lg shadow-emerald-500/10"
              >
                Ir a Canjear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Confirmación de Canje */}
      {confirmRedeemCandidate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/85 backdrop-blur-sm"
            onClick={() => setConfirmRedeemCandidate(null)}
          />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between shrink-0">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span className="inline-flex w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                ¿Confirmar Canje del Cupón?
              </h3>
              <button
                onClick={() => setConfirmRedeemCandidate(null)}
                className="text-white/50 hover:text-white text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-6 py-5 space-y-5 overflow-y-auto">
              <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-4 flex gap-3">
                <div className="shrink-0 text-emerald-400 pt-0.5">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="text-xs text-white/70 space-y-1">
                  <p className="font-semibold text-emerald-400">Verifica los datos antes de proceder.</p>
                  <p>Asegúrate de que el cupón y la identidad del cliente coinciden con los presentados.</p>
                </div>
              </div>

              {/* Summary table */}
              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 space-y-4">
                <div>
                  <span className="text-[10px] text-white/40 uppercase block tracking-wider font-mono">Cupón a Canjear</span>
                  <span className="text-white font-bold text-base block mt-0.5">
                    {confirmRedeemCandidate.coupons?.title ?? 'Cupón Promocional'}
                  </span>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs font-mono">
                    {confirmRedeemCandidate.coupons && couponBadge(confirmRedeemCandidate.coupons) !== '—' && (
                      <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded font-bold">
                        {couponBadge(confirmRedeemCandidate.coupons)}
                      </span>
                    )}
                    {confirmRedeemCandidate.coupons?.code && (
                      <span className="bg-white/5 text-white/75 border border-white/10 px-1.5 py-0.5 rounded font-bold">
                        Código: {confirmRedeemCandidate.coupons.code}
                      </span>
                    )}
                  </div>
                </div>

                <div className="border-t border-white/5 pt-3">
                  <span className="text-[10px] text-white/40 uppercase block tracking-wider font-mono">Cliente / Receptor</span>
                  <span className="text-white font-semibold text-sm block mt-0.5">
                    {`${confirmRedeemCandidate.first_name ?? ''} ${confirmRedeemCandidate.last_name ?? ''}`.trim() || '(sin nombre)'}
                  </span>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/60 font-mono">
                    {confirmRedeemCandidate.id_document && <span>CI: {confirmRedeemCandidate.id_document}</span>}
                    <span>Email: {confirmRedeemCandidate.email}</span>
                  </div>
                </div>
              </div>

              <p className="text-[11px] text-amber-400/80 bg-amber-500/5 border border-amber-500/10 rounded-lg p-3 leading-relaxed font-sans">
                ⚠️ <strong>Nota:</strong> Esta acción descontará stock inmediatamente y cambiará el estado de la reserva a canjeado.
              </p>
            </div>

            <div className="px-6 py-4 border-t border-white/10 flex gap-3 bg-[#0a0a0a] shrink-0">
              <button
                type="button"
                onClick={() => setConfirmRedeemCandidate(null)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors border border-white/5"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  const candidate = confirmRedeemCandidate;
                  setConfirmRedeemCandidate(null);
                  handleRedeem(candidate);
                }}
                className="flex-1 px-4 py-2.5 text-sm font-bold bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors shadow-lg shadow-emerald-500/10"
              >
                Sí, Canjear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  c,
  onRedeem,
  onViewDetails,
  busy,
  disabled,
}: {
  c: Candidate;
  onRedeem: () => void;
  onViewDetails: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '(sin nombre)';
  return (
    <div className="rounded-xl border border-white/10 bg-[#0F0F0F] p-4 flex flex-col md:flex-row md:items-center gap-4 justify-between font-sans">
      {/* Left: Client/Candidate info */}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center bg-white/5 text-white/70 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold font-mono">
            Candidato
          </span>
          <p className="text-sm font-semibold text-white truncate">{name}</p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-white/50 font-mono">
          {c.id_document && <span>CI: {c.id_document}</span>}
          {c.telefono && <span>Tel: {c.telefono}</span>}
          <span className="truncate">{c.email}</span>
        </div>
        <p className="text-[10px] text-white/30 font-mono">
          Reservado: {new Date(c.created_at).toLocaleString('es-VE')}
        </p>
      </div>

      {/* Middle: Coupon info */}
      <div className="border-t border-white/5 md:border-t-0 md:border-l md:pl-4 pt-3 md:pt-0 min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold font-mono">
            Cupón
          </span>
          <p className="text-sm font-bold text-white truncate">{c.coupons?.title ?? 'Cupón'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {c.coupons && couponBadge(c.coupons) !== '—' && (
            <span className="inline-block bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded font-bold font-mono">
              {couponBadge(c.coupons)}
            </span>
          )}
          {c.coupons?.code && (
            <span className="text-[11px] text-white/60 font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">
              Código: {c.coupons.code}
            </span>
          )}
          {c.coupons?.end_date && (
            <span className="text-[11px] text-white/40">
              Vence: {new Date(c.coupons.end_date).toLocaleDateString('es-VE')}
            </span>
          )}
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2 border-t border-white/5 md:border-t-0 pt-3 md:pt-0 shrink-0">
        <button
          onClick={onViewDetails}
          className="rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2.5 text-xs font-semibold text-white/80 transition-colors"
        >
          Ver Detalle
        </button>
        <button
          onClick={onRedeem}
          disabled={busy || disabled}
          className="rounded-lg bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-40 px-5 py-2.5 text-sm font-bold text-white transition-colors"
        >
          {busy ? 'Canjeando…' : 'Canjear'}
        </button>
      </div>
    </div>
  );
}

// ── Escáner de QR usando la API nativa BarcodeDetector (sin dependencias). ──
// Si el navegador no la soporta, el cliente puede usar la búsqueda manual.
function QrScanner({
  onClose,
  onScanned,
}: {
  onClose: () => void;
  onScanned: (token: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    const Detector = (globalThis as unknown as { BarcodeDetector?: any }).BarcodeDetector;
    if (!Detector) {
      setError('Tu navegador no soporta escaneo de cámara. Usa la búsqueda manual.');
      return;
    }
    const detector = new Detector({ formats: ['qr_code'] });

    const tick = async () => {
      if (stopped || !videoRef.current) return;
      try {
        const codes = await detector.detect(videoRef.current);
        if (codes && codes.length > 0 && codes[0].rawValue) {
          onScanned(String(codes[0].rawValue).trim());
          return;
        }
      } catch {
        /* frame sin código; seguimos */
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          raf = requestAnimationFrame(tick);
        }
      } catch {
        setError('No se pudo acceder a la cámara. Revisa los permisos o usa la búsqueda manual.');
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onScanned]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white">Escanear QR de canje</h3>
          <button onClick={onClose} className="text-white/50 hover:text-white text-xl leading-none">
            ×
          </button>
        </div>
        {error ? (
          <p className="text-[13px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
            {error}
          </p>
        ) : (
          <div className="relative overflow-hidden rounded-xl bg-black aspect-square">
            <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
            <div className="pointer-events-none absolute inset-8 border-2 border-red-500/70 rounded-lg" />
          </div>
        )}
        <p className="mt-3 text-[11px] text-white/40 text-center">
          Apunta al QR del correo del usuario.
        </p>
      </div>
    </div>
  );
}
