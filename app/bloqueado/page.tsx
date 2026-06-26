'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { ThemeToggle } from '../components/ThemeToggle';
import { MallHubLogo } from '../components/MallHubLogo';

// /bloqueado — vista para clientes a los que el admin les bloqueó el acceso.
// Vive fuera de /cliente/* a propósito: el layout del portal redirige aquí, así
// que esta ruta NO debe pasar por ese guard (evita el bucle de redirección).
//
// No se le muestra al cliente la razón del bloqueo (es de uso administrativo);
// solo se le pide que contacte a la administración de Mall Hub. Si un usuario
// NO bloqueado cae aquí, lo devolvemos a su destino normal.
export default function BloqueadoPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!session) { router.replace('/login'); return; }

      const { data: u } = await supabase
        .from('users')
        .select('email, role, is_blocked')
        .eq('id', session.user.id)
        .maybeSingle();
      if (!mounted) return;

      // Sin bloqueo activo → no tiene nada que hacer aquí.
      if (!u || !u.is_blocked) {
        router.replace(u?.role === 'admin' ? '/panel' : '/cliente/dashboard');
        return;
      }
      setEmail(u.email ?? session.user.email ?? null);
      setChecking(false);
    })();
    return () => { mounted = false; };
  }, [router]);

  const handleLogout = async () => {
    await supabase.auth.signOut({ scope: 'local' });
    router.replace('/login');
  };

  if (checking) {
    return (
      <div className="min-h-dvh bg-mesh flex flex-col items-center justify-center space-y-4">
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 rounded-full border-2 border-line" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[color:var(--brand-cliente-from)] border-r-[color:var(--brand-cliente-to)] animate-spin" />
        </div>
        <p className="text-fg-muted text-xs font-mono tracking-[0.3em] uppercase">Verificando acceso</p>
      </div>
    );
  }

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-mesh flex flex-col">
      <div className="bg-grid-fade pointer-events-none absolute inset-0" />

      {/* Halos brand — mismo lenguaje visual del login */}
      <div
        className="orb-1 pointer-events-none absolute -top-40 -left-32 h-[480px] w-[480px] rounded-full blur-3xl opacity-25 dark:opacity-45"
        style={{ background: 'radial-gradient(circle, var(--brand-admin-from), transparent 65%)' }}
      />
      <div
        className="orb-2 pointer-events-none absolute -right-40 top-1/3 h-[520px] w-[520px] rounded-full blur-3xl opacity-20 dark:opacity-40"
        style={{ background: 'radial-gradient(circle, var(--brand-cliente-from), transparent 65%)' }}
      />

      {/* Header — brand a la izquierda, toggle a la derecha */}
      <header className="relative z-30 flex items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
        <MallHubLogo markSize={42} wordSize="md" />
        <ThemeToggle />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[440px]">
          <div className="hud-corners-4 relative">
            <span className="hud-c tl" />
            <span className="hud-c tr" />
            <span className="hud-c bl" />
            <span className="hud-c br" />

            <div className="surface-glass-strong relative overflow-hidden rounded-2xl p-6 shadow-[var(--shadow-pop)] sm:p-7">
              <div className="scanline" />
              <div className="brand-rule absolute -top-px left-10 right-10" />

              {/* Icono de candado */}
              <div
                className="relative mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl"
                style={{
                  background: 'var(--danger-bg)',
                  boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--danger) 35%, transparent)',
                }}
              >
                <svg
                  className="h-7 w-7"
                  style={{ color: 'var(--danger)' }}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2zm10-10V7a4 4 0 0 0-8 0v4h8z" />
                </svg>
              </div>

              <div className="relative text-center">
                <h2 className="text-[22px] font-black tracking-tight text-fg sm:text-[24px]">
                  Acceso suspendido
                </h2>
                <p className="mt-2.5 text-sm leading-relaxed text-fg-muted">
                  Tu acceso al portal ha sido bloqueado temporalmente. Para conocer
                  el motivo y reactivar tu cuenta, comunícate con la administración
                  de <span className="font-semibold text-fg">Mall Hub</span>.
                </p>

                {email && (
                  <p className="mt-4 inline-flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-3 py-1.5 font-mono text-[11px] text-fg-muted">
                    <svg className="h-3.5 w-3.5 text-fg-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 8l9 6 9-6M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z" />
                    </svg>
                    {email}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={handleLogout}
                className="btn-brand relative mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold uppercase tracking-[0.18em]"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Cerrar sesión
              </button>
            </div>
          </div>

          <p className="mt-4 text-center text-[11px] text-fg-subtle">
            ¿Crees que es un error?{' '}
            <span className="font-medium text-fg-muted">
              Habla con la administración de tu mall.
            </span>
          </p>
        </div>
      </main>
    </div>
  );
}
