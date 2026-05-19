'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// Home pública: una sola puerta de entrada al sistema. No revelamos que hay
// un panel admin separado — todo usuario empieza por /login y el routing
// post-autenticación decide por role.
export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setChecking(false);
        return;
      }
      // Si ya hay sesión, mandamos por role; el callback unificado se encarga
      // de /bienvenida en el flujo de magic link, así que aquí asumimos que
      // el usuario ya completó onboarding (caso normal de "abrir la home con
      // sesión guardada en el navegador").
      const { data: u } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();
      router.replace(u?.role === 'admin' ? '/panel' : '/cliente/dashboard');
    })();
  }, [router]);

  if (checking) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] flex flex-col items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-pink-500/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 left-1/3 w-[400px] h-[400px] bg-orange-500/5 rounded-full blur-[100px]" />
      </div>

      <div
        className="absolute inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-xl">
        <div className="mb-8 relative">
          <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-[#FF007A] to-[#FF5900] flex items-center justify-center shadow-[0_0_40px_rgba(255,0,122,0.3)]">
            <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
        </div>

        <h1 className="text-5xl sm:text-6xl font-black text-white tracking-tight mb-4">
          MILLENNIUM
        </h1>
        <div className="flex items-center gap-3 mb-6">
          <div className="h-px w-12 bg-gradient-to-r from-transparent to-pink-500/50" />
          <span className="text-sm font-bold tracking-[0.3em] text-pink-500 uppercase">
            Mall
          </span>
          <div className="h-px w-12 bg-gradient-to-l from-transparent to-pink-500/50" />
        </div>

        <p className="text-white/40 text-lg leading-relaxed mb-12 max-w-md">
          Bienvenido. Inicia sesión para continuar.
        </p>

        <button
          onClick={() => router.push('/login')}
          className="group relative bg-gradient-to-r from-[#FF007A] to-[#FF5900] text-white font-bold rounded-xl px-10 py-4 text-base hover:opacity-90 transition-all shadow-[0_0_30px_rgba(255,0,122,0.3)] hover:shadow-[0_0_40px_rgba(255,0,122,0.5)] cursor-pointer"
        >
          INICIAR SESIÓN
          <span className="inline-block ml-3 transition-transform group-hover:translate-x-1">&rarr;</span>
        </button>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-pink-500/20 to-transparent" />
    </div>
  );
}
