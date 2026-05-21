'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabase';
import { ClienteStore, ClienteStoreContext } from './store-context';

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
      .select('store_id')
      .eq('user_id', user.id);
    const storeIds = (links ?? []).map(l => l.store_id);

    if (storeIds.length === 0) {
      setStores([]);
      setSelectedId(null);
      if (typeof window !== 'undefined') localStorage.removeItem(STORE_LS_KEY);
      return;
    }

    const { data } = await supabase
      .from('stores')
      .select('id, name, plan_type, floor_level, local_number, rif, contract_expiry_date, flash_coupon_plan, flash_coupon_expiry_date, description, categories(id, name, icon)')
      .in('id', storeIds)
      .order('name', { ascending: true });
    const list = (data || []) as any as ClienteStore[];
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

  const ctxValue = useMemo(() => ({
    stores,
    selectedStore,
    setSelectedStoreId: handleSelect,
    refreshStores: fetchStores,
  }), [stores, selectedStore, fetchStores]);

  if (isBypassRoute) {
    return <>{children}</>;
  }

  if (isAuthorized === null) {
    return (
      <div className="min-h-screen bg-[#050505] flex flex-col items-center justify-center space-y-4">
        <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin" />
        <p className="text-white/50 text-sm font-mono tracking-widest uppercase">Verificando acceso...</p>
      </div>
    );
  }

  const menuItems = [
    { name: 'Dashboard', path: '/cliente/dashboard', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
    )},
    { name: 'Mi Tienda', path: '/cliente/cuenta', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
    )},
    { name: 'Planes', path: '/cliente/planes', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
    )},
    { name: 'Pagos', path: '/cliente/pagos', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    )},
    { name: 'Tutorial', path: '/cliente/tutorial', icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
    )},
  ];

  return (
    <ClienteStoreContext.Provider value={ctxValue}>
      <div className="flex h-screen bg-[#050505] text-white overflow-hidden">
        <aside className="w-64 bg-[#111111] border-r border-white/10 flex flex-col">
          <div className="p-6 border-b border-white/10">
            <h1 className="text-xl font-black tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">
              PORTAL CLIENTE
            </h1>
            <p className="text-xs text-white/50 mt-1">Millennium Mall</p>
          </div>

          {profile && (
            <div className="px-4 py-3 border-b border-white/5">
              <p className="text-[10px] text-white/30 uppercase tracking-wider">Sesión</p>
              <p className="text-sm text-white/80 truncate font-medium">
                {profile.full_name || <span className="text-white/40 italic">Sin nombre</span>}
              </p>
              <p className="text-[10px] text-white/40 truncate">{profile.email}</p>
            </div>
          )}

          {/* Selector de tienda */}
          <div className="px-4 py-3 border-b border-white/5">
            <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1.5">Tienda activa</p>
            {stores.length === 0 ? (
              <p className="text-[11px] text-amber-400">⚠ Sin tiendas vinculadas</p>
            ) : stores.length === 1 ? (
              <p className="text-sm text-white/80 truncate font-medium">{stores[0].name}</p>
            ) : (
              <select
                value={selectedId ?? ''}
                onChange={(e) => handleSelect(e.target.value)}
                className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
              >
                {stores.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            {stores.length > 1 && (
              <p className="text-[10px] text-white/30 mt-1.5">{stores.length} tiendas vinculadas</p>
            )}
          </div>

          <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
            {menuItems.map((item) => {
              const isActive = pathname === item.path;
              return (
                <Link key={item.path} href={item.path}>
                  <span className={`flex items-center space-x-3 px-4 py-3 rounded-xl transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-cyan-500/20 to-blue-500/20 border border-cyan-500/50 text-white'
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
              <span>Cerrar Sesión</span>
            </button>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-8">
          {children}
        </main>
      </div>
    </ClienteStoreContext.Provider>
  );
}
