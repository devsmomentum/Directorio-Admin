'use client';

// =====================================================================
// Web temporal de captura del USUARIO (visitante del mall).
// La abre el QR dinámico del kiosco: /cupon/<couponId>.
//
// Flujo: muestra el cupón -> el usuario deja sus datos -> se crea una
// RESERVA 'PENDIENTE' (vía Edge Function `reserve-flash-coupon`, que NO
// toca el stock) -> el usuario recibe un correo con el QR de redención.
//
// Ruta pública SIN auth: vive fuera de /panel y /cliente, así que no
// pasa por sus guards de sesión.
// =====================================================================

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { use, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

type CouponView = {
  id: string;
  title: string | null;
  image_url: string | null;
  discount_percent: number | null;
  offer_type: string | null;
  offer_label: string | null;
  amount_available: number;
  end_date: string;
  plan_type: string;
  is_active: boolean;
  approval_status: string;
  stores: { name: string | null } | null;
};

type Phase = 'loading' | 'invalid' | 'form' | 'submitting' | 'done';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Solo dígitos para cédula/teléfono; el correo con un patrón básico.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeString(input: string): string {
  return input
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function CapturaCuponPage({
  params,
}: {
  params: Promise<{ couponId: string }>;
}) {
  const { couponId } = use(params);

  const [phase, setPhase] = useState<Phase>('loading');
  const [coupon, setCoupon] = useState<CouponView | null>(null);
  const [invalidReason, setInvalidReason] = useState<string>('');

  const [nombre, setNombre] = useState('');
  const [cedulaType, setCedulaType] = useState('V');
  const [cedulaNum, setCedulaNum] = useState('');
  const [phonePrefix, setPhonePrefix] = useState('0412');
  const [phoneNum, setPhoneNum] = useState('');
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // 1) Cargar y validar el cupón (lectura anónima permitida por RLS).
  useEffect(() => {
    if (!UUID_RE.test(couponId)) {
      setInvalidReason('Este cupón no existe o el enlace es inválido.');
      setPhase('invalid');
      return;
    }
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from('coupons')
        .select(
          'id, title, image_url, discount_percent, offer_type, offer_label, amount_available, end_date, plan_type, is_active, approval_status, stores(name)',
        )
        .eq('id', couponId)
        .maybeSingle();

      if (!alive) return;

      if (error || !data) {
        setInvalidReason('Este cupón no existe o el enlace es inválido.');
        setPhase('invalid');
        return;
      }

      const c = data as unknown as CouponView;
      const expired = new Date(c.end_date).getTime() <= Date.now();
      const REDEEMABLE_TYPES = ['PUBLI_PROMO', 'FLASH_COUPON_SEMANAL', 'FLASH_COUPON_DIARIO'];
      const usable =
        REDEEMABLE_TYPES.includes(c.plan_type) &&
        c.is_active &&
        c.approval_status === 'approved' &&
        !expired &&
        c.amount_available > 0;

      if (!usable) {
        setInvalidReason(
          expired
            ? 'Este cupón ya venció.'
            : c.amount_available <= 0
            ? '¡Lo sentimos! Este cupón se agotó.'
            : 'Este cupón no está disponible en este momento.',
        );
        setCoupon(c);
        setPhase('invalid');
        return;
      }

      setCoupon(c);
      setPhase('form');
    })();
    return () => {
      alive = false;
    };
  }, [couponId]);

  const discountLabel = useMemo(() => {
    // Contrato unificado: offer_label si existe; si no y hay %, "X% OFF"; si no, nada.
    const l = coupon?.offer_label?.trim();
    if (l) return l;
    const d = Number(coupon?.discount_percent ?? 0);
    return d > 0 ? `${d % 1 === 0 ? d.toFixed(0) : d}% OFF` : null;
  }, [coupon]);

  const validate = (): string | null => {
    if (nombre.trim().length < 2) return 'Ingresa tu nombre.';
    if (cedulaNum.trim().length < 5) return 'Ingresa una cédula válida.';
    if (phonePrefix.startsWith('+')) {
      if (phoneNum.trim().length < 6) return 'Ingresa un teléfono válido.';
    } else {
      if (phoneNum.trim().length < 7) return 'Ingresa un teléfono de 7 dígitos.';
    }
    if (!EMAIL_RE.test(email.trim())) return 'Ingresa un correo válido.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setPhase('submitting');

    const cleanNombre = sanitizeString(nombre);
    const formattedCedula = `${cedulaType}-${cedulaNum.trim()}`;
    const formattedTelefono = `${phonePrefix}-${phoneNum.trim()}`;

    const { data, error } = await supabase.functions.invoke('reserve-flash-coupon', {
      body: {
        coupon_id: couponId,
        nombre: cleanNombre,
        cedula: formattedCedula,
        telefono: formattedTelefono,
        email: email.trim().toLowerCase(),
      },
    });

    // supabase.functions.invoke devuelve `error` para status >= 400; el cuerpo
    // con nuestro código de error viaja en error.context (Response) o en data.
    if (error) {
      let code = '';
      try {
        // FunctionsHttpError expone la Response en context.
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json();
          code = body?.error ?? '';
        }
      } catch {
        /* ignore */
      }
      setPhase('form');
      if (code === 'lead_duplicate') {
        setFormError('Ya reservaste este cupón con ese correo. Revisa tu bandeja de entrada.');
      } else if (code === 'coupon_unavailable') {
        setFormError('Lo sentimos, el cupón se agotó o venció mientras llenabas el formulario.');
      } else {
        setFormError('No pudimos procesar tu reserva. Intenta de nuevo en unos segundos.');
      }
      return;
    }

    if ((data as { ok?: boolean })?.ok) {
      setPhase('done');
    } else {
      setPhase('form');
      setFormError('No pudimos procesar tu reserva. Intenta de nuevo.');
    }
  };

  // ---- UI ----
  return (
    <main className="min-h-screen bg-gradient-to-b from-neutral-950 to-neutral-900 text-white flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {phase === 'loading' && (
          <div className="flex flex-col items-center gap-4 py-20">
            <PageSpinner />
            <p className="text-white/50 text-sm">Cargando cupón…</p>
          </div>
        )}

        {phase === 'invalid' && (
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-8 text-center">
            <div className="text-5xl mb-4">🎟️</div>
            <h1 className="text-xl font-bold mb-2">Cupón no disponible</h1>
            <p className="text-white/60 text-sm">{invalidReason}</p>
          </div>
        )}

        {(phase === 'form' || phase === 'submitting') && coupon && (
          <div className="rounded-2xl border border-white/10 bg-neutral-900 overflow-hidden shadow-2xl">
            {coupon.image_url && (
              <div className="relative aspect-video bg-black">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={coupon.image_url}
                  alt={coupon.title ?? 'Cupón'}
                  className="h-full w-full object-cover"
                />
                {discountLabel && (
                  <span className="absolute top-3 right-3 rounded-full bg-red-600 px-3 py-1 text-sm font-black shadow-lg">
                    {discountLabel}
                  </span>
                )}
              </div>
            )}

            <div className="p-6">
              <p className="text-[11px] uppercase tracking-[0.2em] text-red-400 font-semibold">
                {coupon.stores?.name ?? 'Flash Coupon'}
              </p>
              <h1 className="mt-1 text-xl font-bold leading-tight">
                {coupon.title ?? 'Cupón Promocional'}
              </h1>
              <p className="mt-2 text-sm text-amber-300">
                ⚠️ Stock limitado — déjanos tus datos y recibe tu QR para canjear en la tienda.
                ¡Ve rápido antes de que se agote!
              </p>

              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
                <Field
                  label="Nombre completo"
                  value={nombre}
                  onChange={setNombre}
                  placeholder="Tu nombre"
                  autoComplete="name"
                />

                <div className="block">
                  <span className="text-[11px] uppercase tracking-wider text-white/50">Cédula / Documento</span>
                  <div className="flex gap-2 mt-1">
                    <select
                      value={cedulaType}
                      onChange={(e) => setCedulaType(e.target.value)}
                      className="rounded-lg border border-white/15 bg-neutral-800 px-3 py-2.5 text-sm text-white focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 font-sans"
                    >
                      <option value="V">V</option>
                      <option value="E">E</option>
                    </select>
                    <input
                      type="text"
                      value={cedulaNum}
                      onChange={(e) => setCedulaNum(e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="12345678"
                      inputMode="numeric"
                      className="flex-1 rounded-lg border border-white/15 bg-neutral-800 px-3 py-2.5 text-sm text-white placeholder-white/30 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 font-sans"
                    />
                  </div>
                </div>

                <div className="block">
                  <span className="text-[11px] uppercase tracking-wider text-white/50">Teléfono</span>
                  <div className="flex gap-2 mt-1">
                    <select
                      value={phonePrefix}
                      onChange={(e) => setPhonePrefix(e.target.value)}
                      className="rounded-lg border border-white/15 bg-neutral-800 px-3 py-2.5 text-sm text-white focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 font-sans"
                    >
                      <option value="0412">0412</option>
                      <option value="0414">0414</option>
                      <option value="0424">0424</option>
                      <option value="0416">0416</option>
                      <option value="0426">0426</option>
                      <option value="0212">0212</option>
                      <option value="+58">+58</option>
                      <option value="+1">+1</option>
                    </select>
                    <input
                      type="text"
                      value={phoneNum}
                      onChange={(e) => setPhoneNum(e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="1234567"
                      inputMode="tel"
                      className="flex-1 rounded-lg border border-white/15 bg-neutral-800 px-3 py-2.5 text-sm text-white placeholder-white/30 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 font-sans"
                    />
                  </div>
                </div>

                <Field
                  label="Correo electrónico"
                  value={email}
                  onChange={setEmail}
                  placeholder="tucorreo@ejemplo.com"
                  inputMode="email"
                  autoComplete="email"
                />

                {formError && (
                  <p className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-[13px] text-red-200">
                    {formError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={phase === 'submitting'}
                  className="w-full rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 py-3 font-bold tracking-wide transition-colors"
                >
                  {phase === 'submitting' ? 'Reservando…' : 'Reservar mi cupón'}
                </button>
                <p className="text-center text-[11px] text-white/40">
                  Al reservar aceptas recibir el cupón en tu correo.
                </p>
              </form>
            </div>
          </div>
        )}

        {phase === 'done' && coupon && (
          <div className="rounded-2xl border border-emerald-500/30 bg-neutral-900 p-8 text-center">
            <div className="text-5xl mb-4">📧</div>
            <h1 className="text-xl font-bold mb-2">¡Cupón reservado!</h1>
            <p className="text-white/70 text-sm leading-relaxed">
              Te enviamos un correo a <strong className="text-white">{email}</strong> con tu
              <strong className="text-emerald-300"> QR de redención</strong>. Muéstralo en{' '}
              <strong>{coupon.stores?.name ?? 'la tienda'}</strong> para canjear tu cupón.
            </p>
            <p className="mt-4 text-amber-300 text-sm font-semibold">
              ⚠️ El stock es limitado. ¡Ve rápido a la tienda!
            </p>
            <p className="mt-4 text-[11px] text-white/40">
              ¿No ves el correo? Revisa tu carpeta de spam.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: 'text' | 'tel' | 'email';
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-white/50">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        className="mt-1 w-full rounded-lg border border-white/15 bg-neutral-800 px-3 py-2.5 text-sm text-white placeholder-white/30 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
      />
    </label>
  );
}
