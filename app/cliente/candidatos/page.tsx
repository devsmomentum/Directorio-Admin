'use client';

// =====================================================================
// CLIENTE · Candidatos
// Lista las reservas PENDIENTES de la tienda activa y permite CANJEARLAS.
// El canje (redeem_coupon) es la ÚNICA operación que baja el stock, y es
// atómico/race-safe en el servidor. El cliente identifica al usuario por:
//   - Escaneo del QR del correo (redemption_token), o
//   - Búsqueda por cédula / nombre / correo.
// =====================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';

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
  coupons: { title: string | null } | null;
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

  const fetchData = useCallback(async () => {
    if (!store) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('coupon_leads')
      .select(
        'id, coupon_id, first_name, last_name, id_document, telefono, email, status, created_at, redemption_token, coupons(title)',
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

  // Auto-ocultar el toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
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
        name.includes(q)
      );
    });
  }, [candidates, query]);

  const handleRedeem = async (c: Candidate) => {
    if (redeemingId) return;
    setRedeemingId(c.id);
    const { data, error } = await supabase.rpc('redeem_coupon', {
      p_claim_id: c.id,
      p_coupon_id: c.coupon_id,
    });
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

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Canje de cupones · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Candidatos</h2>
          <p className="text-white/50 text-sm mt-2">
            Usuarios que reservaron un cupón y aún no lo han canjeado. Escanea su QR o búscalo
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
          <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
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
              onRedeem={() => handleRedeem(c)}
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
    </div>
  );
}

function CandidateRow({
  c,
  onRedeem,
  busy,
  disabled,
}: {
  c: Candidate;
  onRedeem: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '(sin nombre)';
  return (
    <div className="rounded-xl border border-white/10 bg-[#0F0F0F] p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white truncate">{name}</p>
        <p className="text-[13px] text-white/60 truncate">{c.coupons?.title ?? 'Cupón'}</p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-white/40 font-mono">
          {c.id_document && <span>CI: {c.id_document}</span>}
          {c.telefono && <span>Tel: {c.telefono}</span>}
          <span className="truncate">{c.email}</span>
        </div>
        <p className="text-[10px] text-white/25 font-mono mt-1">
          Reservado: {new Date(c.created_at).toLocaleString('es-VE')}
        </p>
      </div>
      <button
        onClick={onRedeem}
        disabled={busy || disabled}
        className="shrink-0 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-40 px-5 py-2.5 text-sm font-bold text-white transition-colors"
      >
        {busy ? 'Canjeando…' : 'Canjear'}
      </button>
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
