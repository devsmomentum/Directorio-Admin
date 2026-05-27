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
        {/* Monograma MH gigante — letras desplazadas con anillo orbital */}
        <div className="mb-8 relative">
          <div className="w-28 h-28 rounded-3xl bg-gradient-to-br from-[#FF007A] to-[#FF5900] flex items-center justify-center shadow-[0_0_40px_rgba(255,0,122,0.3)] relative overflow-hidden">
            <svg viewBox="0 0 80 80" className="absolute inset-0 w-full h-full text-white">
              <text x="10" y="36" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={900} fontSize={32} fill="currentColor" letterSpacing="-1">M</text>
              <text x="44" y="70" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={900} fontSize={32} fill="currentColor" letterSpacing="-1">H</text>
              <circle cx="40" cy="40" r="14" stroke="currentColor" strokeWidth={1.4} fill="none" opacity={0.55} />
              <circle cx="54" cy="40" r="2.4" fill="currentColor" />
            </svg>
          </div>
        </div>

        {/* Wordmark: las letras juegan, el punto entre Mall y Hub es el "hub" */}
        <h1 className="font-black text-white tracking-tight mb-4 flex items-baseline gap-3 sm:gap-4">
          <span className="text-5xl sm:text-6xl">Mall</span>
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 sm:h-4 sm:w-4 rounded-full bg-gradient-to-br from-[#FF007A] to-[#FF5900] shadow-[0_0_18px_rgba(255,0,122,0.6)]"
          />
          <span className="text-5xl sm:text-6xl">Hub</span>
        </h1>

        <div className="flex items-center gap-3 mb-6">
          <div className="h-px w-12 bg-gradient-to-r from-transparent to-pink-500/50" />
          <span className="text-[11px] font-bold tracking-[0.4em] text-pink-500 uppercase">
            Portal · Multi-mall · Stores
          </span>
          <div className="h-px w-12 bg-gradient-to-l from-transparent to-pink-500/50" />
        </div>

        <p className="text-white/40 text-lg leading-relaxed mb-12 max-w-md">
          El hub de tus comercios. Inicia sesión para continuar.
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
