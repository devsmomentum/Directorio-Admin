'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// Login unificado: única puerta para admin y cliente. signInWithPassword;
// luego decidimos destino con user_metadata.password_set + role de public.users.
//   - password_set != true → /bienvenida (definir nombre + contraseña).
//   - role admin           → /panel.
//   - role cliente         → /cliente/dashboard.
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const justSetPassword = searchParams?.get('just_set_password') === '1';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { data, error: signInErr } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (signInErr || !data.user) {
      setError('Correo o contraseña incorrectos.');
      setLoading(false);
      return;
    }

    const passwordSet = Boolean(
      (data.user.user_metadata as Record<string, unknown> | undefined)
        ?.password_set,
    );
    if (!passwordSet) {
      router.replace('/bienvenida');
      return;
    }

    // role lo leemos de public.users — fuente de verdad, no del metadata
    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', data.user.id)
      .maybeSingle();

    router.replace(profile?.role === 'admin' ? '/panel' : '/cliente/dashboard');
  };

  return (
    <div className="min-h-screen bg-[#0D0D0D] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-[#111111] border border-white/10 rounded-2xl p-8 shadow-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pink-500/10 mb-4">
            <svg
              className="w-8 h-8 text-pink-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <h2 className="text-3xl font-black text-white tracking-wider">
            MILLENNIUM
          </h2>
          <p className="text-white/50 mt-2 text-sm">Acceso al sistema</p>
        </div>

        {justSetPassword && (
          <div className="mb-6 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm p-3 rounded-lg text-center">
            Contraseña guardada. Inicia sesión con ella.
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-white/70 mb-2">
              Correo Electrónico
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              placeholder="tu-correo@ejemplo.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-white/70 mb-2">
              Contraseña
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl px-4 py-3 pr-12 text-white focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors"
              >
                {showPassword ? (
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-500 text-sm p-3 rounded-lg text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full text-white font-bold rounded-xl px-4 py-4 hover:opacity-90 transition-opacity disabled:opacity-50 mt-4 bg-gradient-to-r from-[#FF007A] to-[#FF5900] shadow-[0_0_20px_rgba(255,0,122,0.3)]"
          >
            {loading ? 'INGRESANDO…' : 'INICIAR SESIÓN'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={async () => {
              if (!email.trim()) {
                setError('Escribe tu correo para enviarte el enlace de recuperación.');
                return;
              }
              const origin =
                typeof window !== 'undefined' ? window.location.origin : '';
              const { error: resetErr } =
                await supabase.auth.resetPasswordForEmail(
                  email.trim().toLowerCase(),
                  { redirectTo: `${origin}/auth/callback?recover=1` },
                );
              if (resetErr) {
                setError(resetErr.message);
              } else {
                setError(null);
                alert(
                  'Si el correo existe, recibirás un enlace para restablecer tu contraseña.',
                );
              }
            }}
            className="text-xs text-white/40 hover:text-white/70 underline transition-colors"
          >
            ¿Olvidaste tu contraseña?
          </button>
        </div>
      </div>
    </div>
  );
}
