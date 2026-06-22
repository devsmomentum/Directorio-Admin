'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabase';
import { ClienteStore, ClienteStoreContext, StoreRole } from './store-context';
import { ThemeToggle } from '../components/ThemeToggle';
import { MallHubLogo } from '../components/MallHubLogo';

type ClienteProfile = {
  id: string;
  email: string;
  role: 'admin' | 'cliente';
  full_name: string | null;
};

const STORE_LS_KEY = 'cliente.selectedStoreId';

export default function ClienteLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [profile, setProfile] = useState<ClienteProfile | null>(null);
  const [stores, setStores] = useState<ClienteStore[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState<number>(0);

  // Ya no hay rutas hijas que el layout deba dejar pasar sin guard: el login y
  // el callback unificado viven fuera de /cliente/* (en /login y /auth/callback).
  const isBypassRoute = false;

  const fetchStores = useCallback(async () => {
    // Defensa en profundidad: en lugar de confiar 100% en las RLS de stores
    // (que dependen de user_owns_store), filtramos explícitamente por las
    // user_stores del usuario actual. Si hubiera un agujero en las policies
    // (catálogo público anon, política vieja sin borrar, etc.), aquí el
    // cliente NO va a ver tiendas que no son suyas porque ni siquiera las
    // pedimos.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setStores([]); setSelectedId(null); return; }

    const { data: links } = await supabase
      .from('user_stores')
      .select('store_id, store_role')
      .eq('user_id', user.id);
    const storeIds = (links ?? []).map(l => l.store_id);
    // Mapa tienda → rol del usuario en ella (define nav/permisos en la UI).
    const roleById = new Map<string, ClienteStore['store_role']>(
      (links ?? []).map(l => [l.store_id, (l.store_role ?? 'owner') as ClienteStore['store_role']]),
    );

    if (storeIds.length === 0) {
      setStores([]);
      setSelectedId(null);
      if (typeof window !== 'undefined') localStorage.removeItem(STORE_LS_KEY);
      return;
    }

    const { data } = await supabase
      .from('stores')
      .select('id, name, plan_type, floor_level, local_number, rif, contract_expiry_date, flash_coupon_plan, flash_coupon_expiry_date, is_ally, ally_campaign_limit, ally_flash_enabled, description, categories(id, name, icon)')
      .in('id', storeIds)
      .order('name', { ascending: true });
    const list = ((data || []) as any[]).map(s => ({
      ...s,
      store_role: roleById.get(s.id) ?? 'owner',
    })) as ClienteStore[];
    setStores(list);

    // Recuperar selección persistida si sigue siendo válida
    const lsId = typeof window !== 'undefined' ? localStorage.getItem(STORE_LS_KEY) : null;
    const valid = lsId && list.find(s => s.id === lsId) ? lsId : (list[0]?.id ?? null);
    setSelectedId(valid);
    if (typeof window !== 'undefined') {
      if (valid) localStorage.setItem(STORE_LS_KEY, valid);
      else localStorage.removeItem(STORE_LS_KEY);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;

      if (!session) {
        router.replace('/login');
        return;
      }

      // Defensa en profundidad: si el usuario aún no completó el onboarding
      // (no definió contraseña + nombre), lo forzamos a /bienvenida. Esto evita
      // que un magic link que no pasó por el callback unificado deje al cliente
      // dentro del portal con full_name vacío y el sidebar mostrando el email.
      const passwordSet = Boolean(
        (session.user.user_metadata as Record<string, unknown> | undefined)
          ?.password_set,
      );
      if (!passwordSet) { router.replace('/bienvenida'); return; }

      const { data: u } = await supabase
        .from('users')
        .select('id, email, role, full_name')
        .eq('id', session.user.id)
        .maybeSingle();

      if (!mounted) return;
      if (!u) { router.replace('/login'); return; }
      if (u.role === 'admin') { router.replace('/panel'); return; }

      setProfile(u);
      await fetchStores();
      if (!mounted) return;
      setIsAuthorized(true);
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (!session) router.replace('/login');
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [router, isBypassRoute, fetchStores]);

  // Cierra drawer móvil al cambiar de ruta
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  // Notificaciones sin leer de la tienda seleccionada. Expuesto en el contexto
  // como refreshUnread para que la página de notificaciones lo invoque al marcar
  // como leído y el badge baje al instante (sin esperar el sondeo de 30s).
  const refreshUnread = useCallback(async () => {
    if (!isAuthorized || !selectedId) { setUnreadNotifications(0); return; }
    const { count } = await supabase
      .from('client_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', selectedId)
      .is('read_at', null);
    setUnreadNotifications(count ?? 0);
  }, [isAuthorized, selectedId]);

  // Refresca en cada navegación, focus de ventana y cada 30s.
  useEffect(() => {
    if (!isAuthorized || !selectedId) { setUnreadNotifications(0); return; }
    refreshUnread();
    const id = setInterval(refreshUnread, 30_000);
    const onFocus = () => refreshUnread();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [isAuthorized, selectedId, pathname, refreshUnread]);

  const handleLogout = async () => {
    if (typeof window !== 'undefined') localStorage.removeItem(STORE_LS_KEY);
    await supabase.auth.signOut({ scope: 'local' });
    router.replace('/login');
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    if (typeof window !== 'undefined') localStorage.setItem(STORE_LS_KEY, id);
  };

  const selectedStore = useMemo(
    () => stores.find(s => s.id === selectedId) ?? null,
    [stores, selectedId]
  );

  // Landing/guard por rol en la tienda activa: el vendedor solo puede estar en
  // Candidatos y el publicista solo en Promociones. Si navega (o cae) en otra
  // ruta, lo devolvemos a su pantalla. El dueño no tiene restricción. Esto es
  // cosmético/UX; la barrera real es RLS + RPC del lado servidor.
  useEffect(() => {
    if (!isAuthorized || !selectedStore) return;
    const role = selectedStore.store_role;
    if (role === 'owner') return;
    const home = role === 'seller' ? '/cliente/candidatos' : '/cliente/promociones';
    if (pathname !== home) router.replace(home);
  }, [isAuthorized, selectedStore, pathname, router]);

  const ctxValue = useMemo(() => ({
    stores,
    selectedStore,
    setSelectedStoreId: handleSelect,
    refreshStores: fetchStores,
    unreadNotifications,
    refreshUnread,
  }), [stores, selectedStore, fetchStores, unreadNotifications, refreshUnread]);

  // Si el rol del vendedor/publicista aún no coincide con la ruta, el redirect
  // de abajo ya se disparó pero el render se adelanta (React es síncrono,
  // useEffect no). Mostramos spinner en el área de contenido para suprimir
  // el flash del dashboard del dueño.
  const isRoutePending = Boolean(
    selectedStore &&
    selectedStore.store_role !== 'owner' &&
    pathname !== (selectedStore.store_role === 'seller' ? '/cliente/candidatos' : '/cliente/promociones'),
  );

  if (isBypassRoute) {
    return <>{children}</>;
  }

  if (isAuthorized === null) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center space-y-4">
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 rounded-full border-2 border-line" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[color:var(--brand-cliente-from)] border-r-[color:var(--brand-cliente-to)] animate-spin" />
        </div>
        <p className="text-fg-muted text-xs font-mono tracking-[0.3em] uppercase">Verificando acceso</p>
      </div>
    );
  }

  // Navegación agrupada por objetivo del comerciante (no lista plana): así el
  // dueño sabe de un vistazo a dónde ir según lo que quiere hacer.
  const navGroups: { label: string | null; items: { name: string; path: string; icon: ReactNode }[] }[] = [
    { label: null, items: [
      { name: 'Resumen', path: '/cliente/dashboard', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
      )},
    ]},
    { label: 'Publicidad', items: [
      { name: 'Promociones', path: '/cliente/promociones', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
      )},
      { name: 'Canjes', path: '/cliente/candidatos', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      )},
    ]},
    { label: 'Plan y pagos', items: [
      { name: 'Planes', path: '/cliente/planes', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
      )},
      { name: 'Pagos', path: '/cliente/pagos', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      )},
    ]},
    { label: 'Mi negocio', items: [
      { name: 'Mi cuenta', path: '/cliente/cuenta', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
      )},
      { name: 'Equipo', path: '/cliente/equipo', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4 0m8-2a3 3 0 10-2.5-4.5M7 8.5A3 3 0 104.5 4" /></svg>
      )},
      { name: 'Notificaciones', path: '/cliente/notificaciones', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
      )},
    ]},
    { label: 'Ayuda', items: [
      { name: 'Tutorial', path: '/cliente/tutorial', icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
      )},
    ]},
  ];

  // Visibilidad según el rol en la tienda activa (la barrera real es RLS/RPC):
  //   · owner      → todo.
  //   · seller     → solo Canjes.
  //   · advertiser → solo Promociones (publicidad: cupones + campañas).
  const role: StoreRole = selectedStore?.store_role ?? 'owner';
  const allowedPaths =
    role === 'owner' ? null
    : role === 'seller' ? ['/cliente/candidatos']
    : ['/cliente/promociones'];
  const visibleGroups = navGroups
    .map((g) => ({ ...g, items: allowedPaths ? g.items.filter((i) => allowedPaths.includes(i.path)) : g.items }))
    .filter((g) => g.items.length > 0);

  const initials = (profile?.full_name || profile?.email || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p[0]?.toUpperCase()).join('') || '?';

  return (
    <ClienteStoreContext.Provider value={ctxValue}>
      <div className="relative flex h-screen overflow-hidden bg-bg text-fg">
        <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 opacity-[0.04]" />
        <div aria-hidden className="halo-cliente pointer-events-none absolute -top-32 right-0 h-[440px] w-[640px] opacity-70" />

        {/* Drawer móvil */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}

        <aside
          className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-line bg-surface/85 backdrop-blur-xl transition-transform duration-300 md:static md:translate-x-0 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          }`}
        >
          {/* logo */}
          <div className="relative h-14 shrink-0 flex items-center border-b border-line px-5">
            <div className="brand-rule absolute inset-x-0 top-0" />
            <MallHubLogo markSize={32} wordSize="sm" subtitle="Portal comercio" />
          </div>

          {/* Tienda activa — compacta */}
          <div className="border-b border-line px-4 py-3">
            {stores.length === 0 ? (
              <p
                className="rounded-xl border px-3 py-2.5 text-[11px] font-medium"
                style={{
                  background: 'var(--warning-bg)',
                  borderColor: 'color-mix(in oklab, var(--warning) 30%, transparent)',
                  color: 'var(--warning)',
                }}
              >
                ⚠ Sin tiendas vinculadas
              </p>
            ) : stores.length === 1 ? (
              /* Una sola tienda: nombre + badges inline */
              <div className="flex items-center gap-2.5">
                <div className="brand-cliente glow-cliente flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                  <svg className="h-4 w-4 text-fg-on-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-fg leading-tight">{selectedStore?.name ?? '—'}</p>
                  {(selectedStore?.plan_type || selectedStore?.is_ally) && (
                    <div className="flex flex-wrap items-center gap-1 mt-0.5">
                      {selectedStore.plan_type && (
                        <span className="rounded-full border border-line bg-surface px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-fg-muted">
                          {String(selectedStore.plan_type).replace(/_/g, ' ')}
                        </span>
                      )}
                      {selectedStore.is_ally && (
                        <span
                          className="rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-brand-cliente"
                          style={{ background: 'color-mix(in oklab, var(--brand-cliente-from) 16%, transparent)' }}
                        >
                          ★ Aliado
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Múltiples tiendas: select compacto */
              <div className="flex items-center gap-2.5">
                <div className="brand-cliente glow-cliente flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                  <svg className="h-4 w-4 text-fg-on-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <select
                    value={selectedId ?? ''}
                    onChange={(e) => handleSelect(e.target.value)}
                    className="w-full rounded-lg border border-line bg-surface-2 px-2 py-1 text-sm font-semibold text-fg focus:outline-none focus:ring-2"
                    style={{ '--tw-ring-color': 'var(--brand-cliente-from)' } as React.CSSProperties}
                  >
                    {stores.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {(selectedStore?.plan_type || selectedStore?.is_ally) && (
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      {selectedStore.plan_type && (
                        <span className="rounded-full border border-line bg-surface px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-fg-muted">
                          {String(selectedStore.plan_type).replace(/_/g, ' ')}
                        </span>
                      )}
                      {selectedStore.is_ally && (
                        <span
                          className="rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-brand-cliente"
                          style={{ background: 'color-mix(in oklab, var(--brand-cliente-from) 16%, transparent)' }}
                        >
                          ★ Aliado
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* nav agrupado por objetivo */}
          <nav className="flex-1 space-y-4 overflow-y-auto p-3">
            {visibleGroups.map((group, gi) => (
              <div key={group.label ?? `g${gi}`} className="space-y-1">
                {group.label && (
                  <p className="px-3.5 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => {
                  const isActive = pathname === item.path;
                  const badgeCount = item.path === '/cliente/notificaciones' ? unreadNotifications : 0;
                  const showBadge = badgeCount > 0;
                  return (
                    <Link key={item.path} href={item.path} className="block">
                      <span
                        className={`group relative flex items-center gap-3 overflow-hidden rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all ${
                          isActive
                            ? 'text-fg'
                            : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                        }`}
                        style={isActive ? {
                          backgroundImage:
                            'linear-gradient(135deg, color-mix(in oklab, var(--brand-cliente-from) 24%, transparent), color-mix(in oklab, var(--accent-fuchsia) 12%, transparent) 72%)',
                          boxShadow:
                            'inset 0 0 0 1px color-mix(in oklab, var(--brand-cliente-from) 38%, transparent), 0 8px 24px -10px rgba(68, 171, 225, 0.5)',
                        } : undefined}
                      >
                        {isActive && (
                          <span className="brand-cliente glow-cliente absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full" />
                        )}
                        <span className={`shrink-0 relative transition-colors ${isActive ? 'text-brand-cliente' : 'group-hover:text-fg'}`}>
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
              </div>
            ))}
          </nav>

          {/* footer: tema + logout */}
          <div className="space-y-2 border-t border-line p-3">
            
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
          {/* topbar */}
          <header className="h-14 shrink-0 flex items-center border-b border-line bg-surface px-4 md:px-6">
            {/* Móvil: hamburguesa */}
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Abrir menú"
              className="rounded-lg border border-line p-1.5 text-fg-muted hover:text-fg md:hidden"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            {/* Móvil: nombre de tienda centrado */}
            <span className="flex-1 truncate text-center text-sm font-bold text-fg md:hidden">
              {selectedStore?.name ?? 'Portal comercio'}
            </span>

            {/* Spacer para empujar todo a la derecha en desktop */}
            <div className="hidden md:block flex-1" />

            {/* Bloque derecho: usuario + acciones */}
            <div className="flex items-center gap-3">
              {/* Identidad del usuario (solo desktop) */}
              {profile && (
                <div className="hidden md:flex items-center gap-2 mr-1">
                  <div className="brand-cliente flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-fg-on-brand">
                    {initials}
                  </div>
                  <p className="max-w-[160px] truncate text-sm font-medium text-fg leading-tight">
                    {profile.full_name || <span className="italic text-fg-faint">Sin nombre</span>}
                  </p>
                  <span className="rounded-full border border-line px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-fg-subtle">
                    {role === 'owner' ? 'Dueño' : role === 'seller' ? 'Vendedor' : 'Publicista'}
                  </span>
                </div>
              )}

              {/* Separador vertical (solo desktop, solo si hay perfil) */}
              {profile && (
                <div className="hidden md:block w-px h-5 bg-line" />
              )}

              {/* Notificaciones */}
              {role === 'owner' && (
                <Link
                  href="/cliente/notificaciones"
                  className="relative rounded-lg border border-line p-1.5 text-fg-muted transition-colors hover:text-fg"
                  aria-label={`Notificaciones${unreadNotifications > 0 ? `, ${unreadNotifications} sin leer` : ''}`}
                >
                  <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  {unreadNotifications > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold text-white ring-2 ring-surface">
                      {unreadNotifications > 99 ? '99+' : unreadNotifications}
                    </span>
                  )}
                </Link>
              )}

              {/* Tema */}
              <ThemeToggle />
            </div>
          </header>

          <main className="relative flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1600px] p-6 md:p-8">
              {isRoutePending ? (
                <div className="flex h-full min-h-[40vh] items-center justify-center">
                  <PageSpinner />
                </div>
              ) : children}
            </div>
          </main>
        </div>
      </div>
    </ClienteStoreContext.Provider>
  );
}
