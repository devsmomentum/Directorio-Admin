'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// ─────────────────────────────────────────────────────────────────────────────
// Callback unificado de magic links / invitaciones / reset-password.
//
// 1. Captura los tokens SINCRÓNICAMENTE al cargar el módulo, antes de que el
//    SDK (detectSessionInUrl=true) los procese y limpie la URL.
// 2. Cierra cualquier sesión local previa (admin con sesión activa, otra
//    cliente, etc) para evitar mezclar identidades dentro del mismo navegador.
// 3. Aplica la sesión nueva con setSession (flow legacy de hash) o
//    exchangeCodeForSession (flow PKCE).
// 4. Decide destino:
//    - ?recover=1 → fuerza /bienvenida (reset password). El usuario debe
//      definir nueva contraseña.
//    - user_metadata.password_set ≠ true → /bienvenida (onboarding).
//    - resto → role admin → /panel; role cliente → /cliente/dashboard.
// ─────────────────────────────────────────────────────────────────────────────

type Captured = {
  code?: string;
  access_token?: string;
  refresh_token?: string;
  error?: string;
};

let captured: Captured = {};
// Promesa única: garantiza que aunque React StrictMode monte el effect dos
// veces en dev, sólo procesamos los tokens UNA vez. Sin esto, la segunda
// invocación llama a exchangeCodeForSession con un code ya consumido y
// Supabase responde "expired" — el síntoma reportado de "magic link expiró".
let processing: Promise<{ ok: true } | { ok: false; message: string }> | null = null;

if (typeof window !== 'undefined') {
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : '';
  const hashParams = new URLSearchParams(hash);
  const searchParams = new URLSearchParams(window.location.search);
  captured = {
    access_token: hashParams.get('access_token') ?? undefined,
    refresh_token: hashParams.get('refresh_token') ?? undefined,
    code: searchParams.get('code') ?? undefined,
    error:
      hashParams.get('error_description') ??
      searchParams.get('error_description') ??
      hashParams.get('error') ??
      searchParams.get('error') ??
      undefined,
  };

  // Tokens/code se quedan en el historial del navegador (back button, capturas
  // de pantalla, extensiones). Una vez capturados en memoria, reescribimos la
  // URL para que no queden visibles ni indexables.
  try {
    const preserved = new URLSearchParams();
    const recover = searchParams.get('recover');
    if (recover) preserved.set('recover', recover);
    const cleanUrl =
      window.location.pathname + (preserved.toString() ? `?${preserved}` : '');
    window.history.replaceState(null, '', cleanUrl);
  } catch {
    /* noop */
  }
}

// Cualquier mensaje crudo del proveedor de auth puede contener referencias
// internas (URLs de la BD, IDs, sub del JWT). Lo normalizamos a un texto
// genérico antes de mostrarlo al usuario.
function sanitizeAuthError(_raw: string | undefined): string {
  return 'No pudimos validar el enlace. Pide uno nuevo al administrador.';
}

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'verifying' | 'error'>('verifying');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const isRecover = searchParams?.get('recover') === '1';

  useEffect(() => {
    let cancelled = false;

    const finish = async () => {
      if (captured.error) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg(sanitizeAuthError(captured.error));
        }
        return;
      }

      // Memoizamos el procesamiento en una promesa module-scope: si el effect
      // se monta dos veces (StrictMode en dev), la segunda await espera el
      // resultado de la primera en lugar de reintentar y romper el code.
      if (!processing) {
        processing = (async () => {
          await supabase.auth.signOut({ scope: 'local' });

          if (captured.access_token && captured.refresh_token) {
            const { error } = await supabase.auth.setSession({
              access_token: captured.access_token,
              refresh_token: captured.refresh_token,
            });
            return error
              ? { ok: false as const, message: sanitizeAuthError(error.message) }
              : { ok: true as const };
          }
          if (captured.code) {
            const { error } = await supabase.auth.exchangeCodeForSession(captured.code);
            return error
              ? { ok: false as const, message: sanitizeAuthError(error.message) }
              : { ok: true as const };
          }
          return {
            ok: false as const,
            message: 'El enlace ya no es válido. Pide uno nuevo al administrador.',
          };
        })();
      }
      const result = await processing;

      if (!result.ok) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg(result.message);
        }
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg('No se pudo establecer la sesión.');
        }
        return;
      }

      const passwordSet = Boolean(
        (session.user.user_metadata as Record<string, unknown> | undefined)
          ?.password_set,
      );

      // En recover queremos forzar /bienvenida (que reutilizamos como
      // "definir contraseña nueva"). El usuario ya autenticado puede
      // updateUser sin problema; al guardar marca password_set=true.
      if (isRecover || !passwordSet) {
        if (!cancelled) router.replace('/bienvenida');
        return;
      }

      // role decide el destino. Lo leemos de public.users (fuente de verdad).
      const { data: profile } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();
      if (!cancelled) {
        router.replace(profile?.role === 'admin' ? '/panel' : '/cliente/dashboard');
      }
    };

    finish();
    return () => {
      cancelled = true;
    };
  }, [router, isRecover]);

  return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-[#111111] border border-white/10 rounded-2xl p-8 text-center">
        {status === 'verifying' ? (
          <>
            <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-white/70 text-sm font-mono tracking-widest uppercase">
              Verificando enlace...
            </p>
            <p className="text-white/40 text-xs mt-2">
              Cerrando sesiones previas y aplicando tu acceso.
            </p>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-6 h-6 text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-3l-7.07-12a2 2 0 00-3.48 0L3.19 16a2 2 0 001.74 3z"
                />
              </svg>
            </div>
            <p className="text-white/80 text-sm font-semibold">
              No pudimos completar el acceso
            </p>
            <p className="text-white/50 text-xs mt-2 break-words">{errorMsg}</p>
            <button
              onClick={() => router.replace('/login')}
              className="mt-6 text-xs text-cyan-400 hover:text-cyan-300 underline"
            >
              Volver a iniciar sesión
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#050505] flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-[#111111] border border-white/10 rounded-2xl p-8 text-center">
            <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-white/70 text-sm font-mono tracking-widest uppercase">
              Verificando enlace...
            </p>
          </div>
        </div>
      }
    >
      <AuthCallbackInner />
    </Suspense>
  );
}
