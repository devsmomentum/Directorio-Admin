'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.push('/dashboard');
      } else {
        setChecking(false);
      }
    });
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
      {/* Background effects */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-pink-500/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 left-1/3 w-[400px] h-[400px] bg-orange-500/5 rounded-full blur-[100px]" />
        <div className="absolute top-1/2 right-1/4 w-[300px] h-[300px] bg-purple-500/5 rounded-full blur-[80px]" />
      </div>

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-2xl">
        {/* Logo icon */}
        <div className="mb-8 relative">
          <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-[#FF007A] to-[#FF5900] flex items-center justify-center shadow-[0_0_40px_rgba(255,0,122,0.3)]">
            <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-green-500 border-2 border-[#050505]" />
        </div>

        {/* Title */}
        <h1 className="text-5xl sm:text-6xl font-black text-white tracking-tight mb-4">
          MILLENNIUM
        </h1>
        <div className="flex items-center gap-3 mb-6">
          <div className="h-px w-12 bg-gradient-to-r from-transparent to-pink-500/50" />
          <span className="text-sm font-bold tracking-[0.3em] text-pink-500 uppercase">
            Panel de Administracion
          </span>
          <div className="h-px w-12 bg-gradient-to-l from-transparent to-pink-500/50" />
        </div>

        {/* Description */}
        <p className="text-white/40 text-lg leading-relaxed mb-12 max-w-md">
          Sistema centralizado de gestion y monitoreo de kioscos interactivos, tiendas, publicidad y analiticas.
        </p>

        {/* Stats preview */}
        <div className="grid grid-cols-3 gap-6 mb-12 w-full max-w-sm">
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4">
            <div className="text-2xl font-black text-white">9</div>
            <div className="text-[11px] text-white/30 uppercase tracking-wider mt-1">Modulos</div>
          </div>
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4">
            <div className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#FF007A] to-[#FF5900]">24/7</div>
            <div className="text-[11px] text-white/30 uppercase tracking-wider mt-1">Monitoreo</div>
          </div>
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4">
            <div className="text-2xl font-black text-white">5</div>
            <div className="text-[11px] text-white/30 uppercase tracking-wider mt-1">Pisos</div>
          </div>
        </div>

        {/* CTA Button */}
        <button
          onClick={() => router.push('/login')}
          className="group relative bg-gradient-to-r from-[#FF007A] to-[#FF5900] text-white font-bold rounded-xl px-10 py-4 text-lg hover:opacity-90 transition-all shadow-[0_0_30px_rgba(255,0,122,0.3)] hover:shadow-[0_0_40px_rgba(255,0,122,0.5)] cursor-pointer"
        >
          INGRESAR AL SISTEMA
          <span className="inline-block ml-3 transition-transform group-hover:translate-x-1">&rarr;</span>
        </button>

        {/* Footer hint */}
        <p className="text-white/20 text-xs mt-8 tracking-wider">
          Acceso exclusivo para administradores autorizados
        </p>
      </div>

      {/* Bottom decorative bar */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-pink-500/20 to-transparent" />
    </div>
  );
}
