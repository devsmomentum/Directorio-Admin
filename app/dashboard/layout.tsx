'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabase';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // null = aún no sabemos; false = sin sesión; true = autorizado
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;

    // 1. Obtener la sesión actual de forma asíncrona para asegurar
    // que el cliente de Supabase ha hidratado el token desde localStorage.
    const initializeAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (mounted) {
        if (!session) {
          router.replace('/login');
        } else {
          setIsAuthorized(true);
        }
      }
    };

    initializeAuth();

    // 2. Suscribirse a cambios futuros (login/logout en otras pestañas, expiración)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) {
        if (!session) {
          router.replace('/login');
        } else {
          setIsAuthorized(true);
        }
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [router]);

  const handleLogout = async () => {
    try {
      setIsAuthorized(false);
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) {
        console.error('Logout failed:', error);
      }
    } finally {
      router.replace('/login');
    }
  };

  const menuItems = [
    { name: 'Inicio', path: '/dashboard', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
    )},
    { name: 'Kioscos', path: '/dashboard/kioscos', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
    )},
    { name: 'Tiendas', path: '/dashboard/tiendas', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
    )},
    { name: 'Cupones y Combos', path: '/dashboard/cupons', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
    )},
    { name: 'Banners', path: '/dashboard/banners', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
    )},
    { name: 'Campañas Publicitarias', path: '/dashboard/campanias', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.882V15a1 1 0 01-1.447.894L15 13.5M4 6a2 2 0 012-2h9a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" /></svg>
    )},
    { name: 'Analiticas', path: '/dashboard/analiticas', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
    )},
    { name: 'Finanzas', path: '/dashboard/finanzas', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    )}
  ];


  // Solo mostramos el spinner cuando realmente no sabemos el estado (null = verificando)
  if (isAuthorized === null) {
    return (
      <div className="min-h-screen bg-[#050505] flex flex-col items-center justify-center space-y-4">
        <div className="w-12 h-12 border-4 border-[#FF007A]/20 border-t-[#FF007A] rounded-full animate-spin"></div>
        <p className="text-white/50 text-sm font-mono tracking-widest uppercase">Verificando credenciales...</p>
      </div>
    );
  }

  // Si pasa la seguridad, renderizamos el panel normal
  return (
    <div className="flex h-screen bg-[#050505] text-white overflow-hidden">
      {/* Sidebar Lateral */}
      <aside className="w-64 bg-[#111111] border-r border-white/10 flex flex-col">
        <div className="p-6 border-b border-white/10">
          <h1 className="text-xl font-black tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-[#FF007A] to-[#FF5900]">
            MORNA ADMIN
          </h1>
          <p className="text-xs text-white/50 mt-1">Millennium Mall</p>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          {menuItems.map((item) => {
            const isActive = pathname === item.path;
            return (
              <Link key={item.path} href={item.path}>
                <span className={`flex items-center space-x-3 px-4 py-3 rounded-xl transition-all ${
                  isActive 
                    ? 'bg-gradient-to-r from-[#FF007A]/20 to-[#FF5900]/20 border border-[#FF007A]/50 text-white' 
                    : 'text-white/70 hover:bg-white/5 hover:text-white'
                }`}>
                  <span className="shrink-0">{item.icon}</span>
                  <span className="font-medium text-sm">{item.name}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/10">
          <button 
            onClick={handleLogout}
            className="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl text-white/70 hover:bg-red-500/10 hover:text-red-500 transition-colors text-sm font-medium"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            <span>Cerrar Sesion</span>
          </button>
        </div>
      </aside>

      {/* Contenido Principal */}
      <main className="flex-1 overflow-y-auto p-8">
        {children}
      </main>
    </div>
  );
}