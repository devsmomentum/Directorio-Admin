'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// Página de "definir contraseña" — sirve para dos flujos:
//
//   1) ONBOARDING inicial (cliente recién invitado, sin password todavía):
//      pide contraseña + confirmación. Marca password_set=true.
//
//   2) RECOVERY (usuario que pidió reset desde /login): viene con ?recover=1.
//      Sólo pide nueva contraseña + confirmación; el nombre ya existe y no
//      se vuelve a tocar.
//
// Tras submit en cualquiera de los dos, hacemos signOut local y mandamos a
// /login. Doble propósito:
//   - El usuario verifica de inmediato que la nueva contraseña funciona.
//   - Limpiamos la sesión temporal del magic-link/recovery del navegador.
//
// Requiere sesión activa (la pone /auth/callback antes de redirigir aquí).
export default function BienvenidaPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isRecover = searchParams?.get('recover') === '1';

  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!session) {
        router.replace('/login');
        return;
      }
      setEmail(session.user.email ?? '');

      // En recovery el password ya existe — el usuario viene a cambiarlo.
      // Saltamos la guarda de "ya completaste onboarding".
      if (!isRecover) {
        const passwordSet = Boolean(
          (session.user.user_metadata as Record<string, unknown> | undefined)
            ?.password_set,
        );
        if (passwordSet) {
          const { data: profile } = await supabase
            .from('users')
            .select('role')
            .eq('id', session.user.id)
            .maybeSingle();
          router.replace(profile?.role === 'admin' ? '/panel' : '/cliente/dashboard');
          return;
        }
      }
      setReady(true);
    })();
    return () => {
      mounted = false;
    };
  }, [router, isRecover]);

  const validate = (): string | null => {
    if (password.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      return 'La contraseña debe incluir letras y números.';
    }
    if (password !== confirm) return 'Las contraseñas no coinciden.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);

    // 1. Setear password (+ metadata si es onboarding inicial).
    // updateUser({password}) escribe en auth.users.encrypted_password. Si
    // falla, abortamos antes de tocar public.users.
    const metaPatch = { password_set: true };

    const { data: updateData, error: updateErr } = await supabase.auth.updateUser({
      password,
      data: metaPatch,
    });
    if (updateErr || !updateData.user) {
      // No exponemos updateErr.message porque puede incluir detalles internos
      // del proveedor de auth (URLs, IDs de usuario, sub del JWT).
      setError('No se pudo guardar la contraseña. Intenta nuevamente.');
      setSubmitting(false);
      return;
    }

    // 2. Cerrar sesión y mandar a /login para que el usuario pruebe la
    // contraseña recién definida. Esto confirma de un vistazo que sí quedó
    // grabada y limpia los tokens del magic-link/recovery.
    await supabase.auth.signOut({ scope: 'local' });
    router.replace('/login?just_set_password=1');
  };

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin" />
      </div>
    );
  }

  const titleText = isRecover ? 'NUEVA CONTRASEÑA' : 'BIENVENIDO A MILLENNIUM';
  const subtitleText = isRecover
    ? 'Define la nueva contraseña para entrar a tu cuenta.'
    : 'Define una contraseña para entrar a tu cuenta.';
  const buttonText = isRecover ? 'GUARDAR CONTRASEÑA' : 'ACTIVAR CUENTA';

  return (
    <div className="min-h-screen bg-[#0D0D0D] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-[#111111] border border-white/10 rounded-2xl p-8 shadow-2xl">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-cyan-500/10 mb-4">
            <svg
              className="w-8 h-8 text-cyan-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
          </div>
          <h2 className="text-2xl font-black text-white tracking-wider">
            {titleText}
          </h2>
          <p className="text-white/50 mt-2 text-xs">
            {subtitleText}
          </p>
          {email && (
            <p className="text-white/30 text-[11px] mt-1 font-mono">{email}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">

          <div>
            <label className="block text-sm font-medium text-white/70 mb-2">
              {isRecover ? 'Nueva contraseña' : 'Contraseña'}
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoFocus={isRecover}
                autoComplete="new-password"
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-3 pr-12 text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
                placeholder="Mínimo 8 caracteres con letras y números"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors"
              >
                {showPassword ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-white/70 mb-2">
              Confirma tu contraseña
            </label>
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
              placeholder="Repite la contraseña"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-500 text-sm p-3 rounded-lg text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full text-white font-bold rounded-xl px-4 py-4 hover:opacity-90 transition-opacity disabled:opacity-50 bg-gradient-to-r from-cyan-500 to-blue-500 shadow-[0_0_20px_rgba(34,211,238,0.3)]"
          >
            {submitting ? 'GUARDANDO…' : buttonText}
          </button>
        </form>
      </div>
    </div>
  );
}
