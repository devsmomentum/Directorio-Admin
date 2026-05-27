'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { ThemeToggle } from '../components/ThemeToggle';
import { MallHubBrand } from '../components/MallHubMark';

// Login de Mall Hub. El destino post-login depende del rol que
// devuelve public.users, pero la UI nunca lo menciona.
//   - password_set != true → /bienvenida.
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

    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', data.user.id)
      .maybeSingle();

    router.replace(profile?.role === 'admin' ? '/panel' : '/cliente/dashboard');
  };

  return (
    // Mobile permite altura natural (teclado virtual). Desktop = viewport
    // estricto sin scroll, todo el contenido cabe.
    <div className="relative min-h-dvh overflow-x-hidden bg-mesh lg:h-dvh lg:overflow-hidden">
      <div className="bg-grid-fade pointer-events-none absolute inset-0" />

      {/* Halos brand — opacidad fina para que no compita con el contenido */}
      <div
        className="orb-1 pointer-events-none absolute -top-40 -left-32 h-[480px] w-[480px] rounded-full blur-3xl opacity-25 dark:opacity-45"
        style={{ background: 'radial-gradient(circle, var(--brand-admin-from), transparent 65%)' }}
      />
      <div
        className="orb-2 pointer-events-none absolute -right-40 top-1/3 h-[520px] w-[520px] rounded-full blur-3xl opacity-20 dark:opacity-40"
        style={{ background: 'radial-gradient(circle, var(--brand-cliente-from), transparent 65%)' }}
      />

      {/* Header — minimal, brand a la izquierda, toggle a la derecha */}
      <header className="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
        <MallHubBrand
          variant="mix"
          wordSize="md"
          tileSize={36}
          tagline="Portal · Multi-mall · v2.4"
        />
        <ThemeToggle />
      </header>

      <main className="relative z-10 grid min-h-dvh lg:h-dvh lg:grid-cols-2">
        {/* ============== HERO (sólo desktop) ============== */}
        <section className="relative hidden h-full flex-col justify-between overflow-hidden border-r border-line/60 px-10 pt-24 pb-10 lg:flex xl:px-16 xl:pt-28 xl:pb-12">
          {/* Anillo cónico decorativo, esquina inferior derecha */}
          <div className="pointer-events-none absolute -right-44 -bottom-44 h-[520px] w-[520px] opacity-15 dark:opacity-25">
            <div
              className="spin-slow absolute inset-0 rounded-full"
              style={{
                background:
                  'conic-gradient(from 0deg, transparent, var(--brand-admin-from), transparent 32%, var(--brand-cliente-from), transparent 62%, var(--brand-cliente-to), transparent)',
              }}
            />
            <div className="absolute inset-8 rounded-full bg-bg" />
          </div>

          {/* Eyebrow superior */}
          <div className="relative">
            <div className="inline-flex items-center gap-2.5 rounded-md border border-line bg-surface/70 px-3 py-1.5 backdrop-blur">
              <span className="tech-dot" />
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-fg-muted">
                Mall · Hub · Operativo
              </span>
            </div>
          </div>

          {/* Mensaje principal — el wordmark juega con las letras: Mall · Hub */}
          <div className="relative max-w-xl">
            <h1 className="text-[42px] font-black leading-[1.04] tracking-tight text-fg xl:text-[52px]">
              <span className="block">Donde cada</span>
              <span className="block">
                <span className="text-brand-mix">Mall</span>
                <span
                  aria-hidden
                  className="brand-mix mx-3 inline-block h-3 w-3 translate-y-[-6px] rounded-full xl:h-4 xl:w-4"
                />
                <span className="text-brand-mix">Hub</span>
              </span>
              <span className="block">a sus comercios.</span>
            </h1>
            <p className="mt-6 max-w-md text-[15px] leading-relaxed text-fg-muted xl:text-base">
              Mall Hub conecta cada mall con sus tiendas: promociones que llegan
              a los visitantes, analíticas en vivo y renovaciones sin papeleo —
              todo desde un mismo lugar.
            </p>
          </div>

          {/* KPI stats inferior */}
          <div className="relative">
            
            <div className="grid grid-cols-3 gap-3">
              <Stat value="+12" label="malls" sub="conectados" />
              <Stat value="+200" label="comercios" sub="activos" />
              <Stat value="1.4M" label="visitantes" sub="mensuales" />
            </div>
          </div>
        </section>

        {/* ============== FORM ============== */}
        <section className="relative flex h-full items-center justify-center px-5 pt-24 pb-10 sm:px-8 sm:pt-24 lg:px-10 lg:pt-20 lg:pb-12">
          <div className="w-full max-w-[400px]">
            {/* Card */}
            <div className="hud-corners-4 relative">
              <span className="hud-c tl" />
              <span className="hud-c tr" />
              <span className="hud-c bl" />
              <span className="hud-c br" />

              <div className="surface-glass-strong relative overflow-hidden rounded-2xl p-6 shadow-[var(--shadow-pop)] sm:p-7">
                <div className="scanline" />

                {/* Línea brand */}
                <div className="absolute -top-px left-10 right-10 h-px brand-mix opacity-90" />

               

                <div className="relative mb-6">
                  <h2 className="text-[26px] font-black tracking-tight text-fg sm:text-[28px]">
                    Iniciar sesión
                  </h2>
                  <p className="mt-1.5 text-sm text-fg-muted">
                    Accede a la gestión de tu comercio.
                  </p>
                </div>

                {justSetPassword && (
                  <Alert kind="success" className="relative mb-5">
                    Contraseña guardada. Inicia sesión con ella.
                  </Alert>
                )}

                <form
                  onSubmit={handleLogin}
                  className="relative space-y-4"
                  noValidate
                >
                  <Field label="Correo electrónico" htmlFor="email" code="A1">
                    <div className="relative">
                      <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint">
                        <path d="M3 8l9 6 9-6M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z" />
                      </Icon>
                      <input
                        id="email"
                        name="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoFocus
                        autoComplete="email"
                        inputMode="email"
                        spellCheck={false}
                        className="input-brand pl-10"
                        placeholder="tu-correo@ejemplo.com"
                      />
                    </div>
                  </Field>

                  <Field
                    label="Contraseña"
                    htmlFor="password"
                    code="A2"
                    right={
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle hover:text-fg"
                      >
                        {showPassword ? 'Ocultar' : 'Mostrar'}
                      </button>
                    }
                  >
                    <div className="relative">
                      <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint">
                        <path d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2zm10-10V7a4 4 0 0 0-8 0v4h8z" />
                      </Icon>
                      <input
                        id="password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoComplete="current-password"
                        className="input-brand pl-10 pr-11"
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
                        tabIndex={-1}
                      >
                        {showPassword ? (
                          <Icon className="h-4 w-4">
                            <path d="M13.875 18.825A10.05 10.05 0 0 1 12 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 0 1 1.563-3.029m5.858.908a3 3 0 1 1 4.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18" />
                          </Icon>
                        ) : (
                          <Icon className="h-4 w-4">
                            <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
                            <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </Icon>
                        )}
                      </button>
                    </div>
                  </Field>

                  {error && <Alert kind="danger">{error}</Alert>}

                  <button
                    type="submit"
                    disabled={loading || !email || !password}
                    className="btn-brand mt-1 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold uppercase tracking-[0.18em]"
                  >
                    {loading ? (
                      <>
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                        Autenticando
                      </>
                    ) : (
                      <>
                        Acceder
                        <Icon className="h-4 w-4" stroke={2.5}>
                          <path d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </Icon>
                      </>
                    )}
                  </button>

                  <div className="flex items-center justify-between pt-1">
                    <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-fg-faint">
                      cifrado
                    </span>
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
                          // Evitamos exponer el mensaje crudo del proveedor de
                          // auth (puede contener URLs internas / IDs).
                          setError('No se pudo enviar el enlace de recuperación. Intenta más tarde.');
                        } else {
                          setError(null);
                          alert(
                            'Si el correo existe, recibirás un enlace para restablecer tu contraseña.',
                          );
                        }
                      }}
                      className="text-xs text-fg-muted transition-colors hover:text-fg hover:underline"
                    >
                      Recuperar contraseña
                    </button>
                  </div>
                </form>
              </div>
            </div>

            <p className="mt-4 text-center text-[11px] text-fg-subtle">
              ¿Aún no tienes acceso?{' '}
              <span className="font-medium text-fg-muted">
                Habla con la administración de tu mall.
              </span>
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

/* ====================== helpers de UI ====================== */

function Field({
  label,
  htmlFor,
  code,
  right,
  children,
}: {
  label: string;
  htmlFor: string;
  code?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted"
        >
          {code && (
            <span className="font-mono text-[9px] tracking-[0.22em] text-fg-faint">
              {code}
            </span>
          )}
          {label}
        </label>
        {right}
      </div>
      {children}
    </div>
  );
}

function Alert({
  kind,
  className = '',
  children,
}: {
  kind: 'success' | 'danger' | 'info' | 'warning';
  className?: string;
  children: React.ReactNode;
}) {
  const color =
    kind === 'success' ? 'var(--success)' :
    kind === 'danger'  ? 'var(--danger)' :
    kind === 'warning' ? 'var(--warning)' :
                         'var(--info)';
  const bg =
    kind === 'success' ? 'var(--success-bg)' :
    kind === 'danger'  ? 'var(--danger-bg)' :
    kind === 'warning' ? 'var(--warning-bg)' :
                         'var(--info-bg)';
  return (
    <div
      role={kind === 'danger' ? 'alert' : 'status'}
      className={`rounded-xl border px-4 py-3 text-center text-sm ${className}`}
      style={{
        background: bg,
        borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
        color,
      }}
    >
      {children}
    </div>
  );
}

function Icon({
  children,
  className = '',
  stroke = 1.75,
}: {
  children: React.ReactNode;
  className?: string;
  stroke?: number;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function Stat({
  value,
  label,
  sub,
}: {
  value: string;
  label: string;
  sub: string;
}) {
  return (
    <div className="relative rounded-xl border border-line/70 bg-surface/50 px-3.5 py-3 backdrop-blur-sm">
      <span className="pointer-events-none absolute right-2 top-2 h-2.5 w-2.5 border-t border-r border-fg-faint opacity-50" />
      <p className="text-[26px] font-black leading-none tracking-tight text-brand-mix">
        {value}
      </p>
      <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.22em] text-fg-muted">
        {label}
      </p>
      <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-fg-faint">
        {sub}
      </p>
    </div>
  );
}
