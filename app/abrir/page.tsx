'use client';

import { useEffect, useState } from 'react';

// Puerta humana para magic-links enviados por mensajería (WhatsApp, etc.).
//
// Por qué existe: WhatsApp Web (y muchos otros) hace prefetch del link al
// mostrar el preview del chat. Si el link es un magic-link de Supabase
// single-use, ese prefetch lo CONSUME — y cuando el humano hace click, el
// token ya quedó marcado como usado → "link expirado".
//
// Esta página rompe el ciclo:
//   - Renderiza sólo HTML estático con un botón.
//   - La navegación al action_link real ocurre con JS (window.location.href)
//     dentro de un onClick. Los bots de preview no ejecutan JS, así que
//     nunca tocan el endpoint de Supabase.
//   - El humano hace click → vamos al action_link → Supabase verifica el
//     token y redirige a /auth/callback (callback unificado).
//
// El `next` viene en query string. Validamos que sea http(s) absoluto antes
// de redirigir para no convertirnos en open redirector.
export default function AbrirPage() {
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('next');
    if (!raw) {
      setError('Falta el enlace de destino.');
      return;
    }
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        setError('Enlace inválido.');
        return;
      }
      setNext(raw);
    } catch {
      setError('Enlace inválido.');
    }
  }, []);

  const handleContinue = () => {
    if (next) window.location.href = next;
  };

  return (
    <div className="min-h-screen bg-[#0D0D0D] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-[#111111] border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-blue-500/20 mb-4 relative overflow-hidden">
          <svg viewBox="0 0 40 40" className="w-10 h-10 text-cyan-300">
            <text x="6" y="17" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={900} fontSize={15} fill="currentColor" letterSpacing="-0.5">M</text>
            <text x="22" y="34" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={900} fontSize={15} fill="currentColor" letterSpacing="-0.5">H</text>
            <circle cx="20" cy="20" r="6.5" stroke="currentColor" strokeWidth={1.2} fill="none" opacity={0.55} />
            <circle cx="26.5" cy="20" r="1.4" fill="currentColor" />
          </svg>
        </div>
        <h2 className="text-2xl font-black text-white tracking-wider inline-flex items-center gap-2">
          <span>Mall</span>
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
          <span>Hub</span>
        </h2>
        <p className="text-white/60 text-sm mt-3">
          Recibimos tu enlace de acceso. Toca el botón para continuar.
        </p>

        {error ? (
          <div className="mt-6 bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-300 text-sm">
            {error}
          </div>
        ) : (
          <button
            type="button"
            onClick={handleContinue}
            disabled={!next}
            className="mt-8 w-full text-white font-bold rounded-xl px-6 py-4 hover:opacity-90 transition-opacity disabled:opacity-50 bg-gradient-to-r from-cyan-500 to-blue-500 shadow-[0_0_20px_rgba(34,211,238,0.3)]"
          >
            CONTINUAR
          </button>
        )}

        <p className="text-white/30 text-xs mt-6">
          El enlace expira pronto. Si no te llevó a la página correcta, pide
          uno nuevo al administrador.
        </p>
      </div>
    </div>
  );
}
