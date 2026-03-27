'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabase';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false); // Estado de seguridad

  useEffect(() => {
    checkSecurity();
  }, []);

  const checkSecurity = async () => {
    // Le preguntamos a Supabase si hay alguien logueado en este navegador
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      // Si no hay sesión, lo expulsamos al login reemplazando el historial
      router.replace('/login');
    } else {
      // Si hay sesión, le damos la llave para ver el contenido
      setIsAuthorized(true);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  const menuItems = [
    { name: 'Monitoreo Kioscos', path: '/dashboard', icon: '🖥️' },
    { name: 'Directorio Kioscos', path: '/dashboard/kioscos', icon: '🏪' },
    { name: 'Gestión de Banners', path: '/dashboard/banners', icon: '🎟️' },
    { name: 'Directorio Tiendas', path: '/dashboard/tiendas', icon: '🏪' },
    { name: 'Directorio Categorías', path: '/dashboard/categorias', icon: '🏪' },
    { name: 'Analíticas', path: '/dashboard/analiticas', icon: '📊' },
    { name: 'Gestión de Cupones', path: '/dashboard/cupons', icon: '🎟️' },
    { name: 'Mapas', path: '/dashboard/mapa', icon: '🗺️' },
    { name: 'Directorio Servicios', path: '/dashboard/services', icon: '🏪' }
  ];

  // Pantalla de carga de seguridad (evita que se vea el panel por 1 segundo)
  if (!isAuthorized) {
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
                  <span className="text-lg">{item.icon}</span>
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
            <span>🚪</span>
            <span>Cerrar Sesión</span>
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