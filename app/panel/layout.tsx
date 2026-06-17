'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { ThemeToggle } from '../components/ThemeToggle';
import { MallHubTile, MallHubWordmark } from '../components/MallHubMark';

// Shell del panel admin. Guard + sidebar fijo + área de contenido scrollable.
// Guard:
//   1. sesión activa (si no, /login)
//   2. user_metadata.password_set === true (si no, /bienvenida)
//   3. public.users.role === 'admin' (si es cliente, /cliente/dashboard)
// RLS de Supabase ya protege la BD; este guard evita además que el cliente
// vea la UI del admin.
export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [unreadNotifications, setUnreadNotifications] = useState<number>(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let mounted = true;

    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!session) { router.replace('/login'); return; }

      const passwordSet = Boolean(
        (session.user.user_metadata as Record<string, unknown> | undefined)
          ?.password_set,
      );
      if (!passwordSet) { router.replace('/bienvenida'); return; }

      const { data: u } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();
      if (!mounted) return;
      if (u?.role !== 'admin') { router.replace('/cliente/dashboard'); return; }
      setAuthorized(true);
    };

    check();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!mounted) return;
      if (!s) router.replace('/login');
    });

    return () => { mounted = false; subscription.unsubscribe(); };
  }, [router]);

  // Pendientes en la cola del admin (solicitudes + pagos de renovación).
  // Refresca: al montar, al cambiar de ruta y cada 30s para que el badge
  // refleje en ~tiempo real lo que llega del cliente.
  useEffect(() => {
    if (authorized !== true) return;
    let cancelled = false;
    const load = async () => {
      const [reqRes, txRes, campRes, coupRes, bannerRes, notifRes] = await Promise.all([
        supabase.from('plan_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase.from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('transaction_type', 'plan_payment')
          .eq('status', 'pending'),
        supabase.from('ad_campaigns')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending'),
        supabase.from('coupons')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending'),
        supabase.from('banners')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending'),
        supabase.from('admin_notifications')
          .select('id', { count: 'exact', head: true })
          .is('read_at', null),
      ]);
      if (cancelled) return;
      setPendingCount(
        (reqRes.count ?? 0) + (txRes.count ?? 0) + (campRes.count ?? 0) + (coupRes.count ?? 0) + (bannerRes.count ?? 0)
      );
      setUnreadNotifications(notifRes.count ?? 0);
    };
    load();
    const id = setInterval(load, 30_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [authorized, pathname]);

  // Cierra drawer móvil al navegar
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  const handleLogout = async () => {
    await supabase.auth.signOut({ scope: 'local' });
    router.replace('/login');
  };

  const menuItems = [
    { name: 'Inicio', path: '/panel/inicio', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
    )},
    { name: 'Kioscos', path: '/panel/kioscos', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
    )},
    { name: 'Tiendas', path: '/panel/tiendas', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
    )},
    { name: 'Clientes', path: '/panel/clientes', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-5.13a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
    )},
    { name: 'Aliados', path: '/panel/aliados', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    )},
    { name: 'Solicitudes', path: '/panel/solicitudes', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    )},
    { name: 'Cupones y Combos', path: '/panel/cupons', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
    )},
    { name: 'Banners', path: '/panel/banners', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
    )},
    { name: 'Campañas', path: '/panel/campanias', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.882V15a1 1 0 01-1.447.894L15 13.5M4 6a2 2 0 012-2h9a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" /></svg>
    )},
    { name: 'Planes', path: '/panel/planes', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 9V4a1 1 0 011-1z" /></svg>
    )},
    { name: 'Analíticas', path: '/panel/analiticas', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
    )},
    { name: 'Finanzas', path: '/panel/finanzas', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    )},
    { name: 'Notificaciones', path: '/panel/notificaciones', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
    )},
    { name: 'Auditoría', path: '/panel/auditoria', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
    )},
  ];

  if (authorized === null) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center space-y-4">
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 rounded-full border-2 border-line" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[color:var(--brand-admin-from)] border-r-[color:var(--brand-admin-to)] animate-spin" />
        </div>
        <p className="text-fg-muted text-xs font-mono tracking-[0.3em] uppercase">Verificando credenciales</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen overflow-hidden bg-bg text-fg">
      {/* halo de marca, decorativo */}
      <div className="halo-admin pointer-events-none absolute -top-32 right-0 h-[400px] w-[600px] opacity-60" />

      {/* Drawer móvil */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-line bg-surface transition-transform duration-300 md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {/* logo */}
        <div className="relative h-20 shrink-0 flex items-center border-b border-line px-6">
          <div className="absolute inset-x-0 top-0 h-px brand-admin opacity-70" />
          <div className="flex items-center gap-3">
            <MallHubTile variant="admin" size={40} />
            <div>
              <MallHubWordmark variant="admin" size="md" className="tracking-wider" />
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-fg-subtle">Panel admin</p>
            </div>
          </div>
        </div>

        {/* nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {menuItems.map((item) => {
            const isActive = pathname === item.path;
            const badgeCount = item.path === '/panel/solicitudes'
              ? pendingCount
              : item.path === '/panel/notificaciones'
              ? unreadNotifications
              : 0;
            const showBadge = badgeCount > 0;
            return (
              <Link key={item.path} href={item.path} className="block">
                <span
                  className={`group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-surface-2 text-fg shadow-[var(--shadow-card)]'
                      : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-6 -translate-y-1/2 w-1 rounded-r-full brand-admin" />
                  )}
                  <span className={`shrink-0 relative transition-colors ${isActive ? 'text-brand-admin' : ''}`}>
                    {item.icon}
                    {showBadge && (
                      <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-warning ring-2 ring-surface animate-pulse" />
                    )}
                  </span>
                  <span className="flex-1">{item.name}</span>
                  {showBadge && (
                    <span className="ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* footer: tema + logout */}
        <div className="border-t border-line p-3 space-y-2">
          
          <button
            onClick={handleLogout}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-transparent px-3 py-2.5 text-sm font-medium text-fg-muted transition-colors hover:border-line hover:bg-surface-2 hover:text-[color:var(--danger)]"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            <span>Cerrar sesión</span>
          </button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* topbar — visible en todos los tamaños */}
        <header className="h-20 shrink-0 flex items-center justify-between border-b border-line bg-surface px-6 md:px-8">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Abrir menú"
            className="rounded-lg border border-line p-2 text-fg-muted hover:text-fg md:hidden"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <MallHubWordmark variant="admin" size="sm" className="tracking-wider md:hidden" />
          <div className="flex items-center gap-2 md:ml-auto">
            <Link
              href="/panel/notificaciones"
              className="relative rounded-lg border border-line p-2 text-fg-muted transition-colors hover:text-fg"
              aria-label={`Notificaciones${unreadNotifications > 0 ? `, ${unreadNotifications} sin leer` : ''}`}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {unreadNotifications > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-warning px-1 text-[10px] font-bold text-white ring-2 ring-surface">
                  {unreadNotifications > 99 ? '99+' : unreadNotifications}
                </span>
              )}
            </Link>
            <ThemeToggle />
          </div>
        </header>

        <main className="relative flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[1600px] p-6 md:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
