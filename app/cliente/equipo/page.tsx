'use client';

// =====================================================================
// CLIENTE · Equipo (solo DUEÑO)
// El dueño gestiona el staff de SU tienda:
//   · vendedor   (seller)     → solo canje de cupones.
//   · publicista (advertiser) → solo publicidad (cupones + campañas).
// Invitar crea el usuario + envía magic link vía la Edge Function
// `invite-store-staff` (que revalida que el caller es dueño). Listar/quitar
// usan los RPC owner_list_store_staff / owner_remove_store_staff.
// La autorización real vive en el servidor; esta pantalla solo orquesta.
// =====================================================================

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';
import { confirmDialog } from '../../components/confirm-dialog';

type StaffRow = {
  user_id: string;
  email: string;
  full_name: string | null;
  telefono_personal: string | null;
  store_role: 'seller' | 'advertiser';
  created_at: string;
};

const ROLE_LABEL: Record<string, string> = {
  seller: 'Vendedor',
  advertiser: 'Publicista',
};
const ROLE_DESC: Record<string, string> = {
  seller: 'Solo canje de cupones (Candidatos).',
  advertiser: 'Solo publicidad: cupones y campañas.',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readFnError(error: unknown): Promise<string> {
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = await ctx.json();
      if (body?.error) return String(body.error);
    }
  } catch {
    /* ignore */
  }
  return (error as { message?: string })?.message ?? 'Error desconocido';
}

export default function ClienteEquipoPage() {
  const { selectedStore: store } = useClienteStore();

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Reenvío de enlace por colaborador
  const [resendOpenFor, setResendOpenFor] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendPhone, setResendPhone] = useState('');

  // Formulario de invitación
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [staffRole, setStaffRole] = useState<'seller' | 'advertiser'>('seller');
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isOwner = store?.store_role === 'owner';

  const fetchStaff = useCallback(async () => {
    if (!store || store.store_role !== 'owner') {
      setStaff([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.rpc('owner_list_store_staff', { p_store_id: store.id });
    if (error) {
      setToast({ kind: 'err', text: 'No se pudo cargar el equipo.' });
      setStaff([]);
    } else {
      setStaff((data || []) as StaffRow[]);
    }
    setLoading(false);
  }, [store]);

  useEffect(() => {
    fetchStaff();
  }, [fetchStaff]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const validate = (): string | null => {
    if (!EMAIL_RE.test(email.trim())) return 'Ingresa un correo válido.';
    if (channel === 'whatsapp' && phone.trim().length < 7) return 'Ingresa un teléfono válido para WhatsApp.';
    return null;
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setSubmitting(true);

    const { data, error } = await supabase.functions.invoke('invite-store-staff', {
      body: {
        email: email.trim().toLowerCase(),
        store_id: store.id,
        store_role: staffRole,
        channel,
        phone: channel === 'whatsapp' ? phone.trim() : undefined,
        profile: {
          full_name: fullName.trim() || null,
          telefono_personal: channel === 'whatsapp' ? phone.trim() : undefined,
        },
      },
    });
    setSubmitting(false);

    if (error || !(data as { ok?: boolean })?.ok) {
      const msg = error ? await readFnError(error) : 'No se pudo enviar la invitación.';
      setFormError(msg);
      return;
    }

    setToast({
      kind: 'ok',
      text: `Invitación enviada a ${email.trim().toLowerCase()} como ${ROLE_LABEL[staffRole].toLowerCase()}.`,
    });
    setEmail('');
    setFullName('');
    setPhone('');
    fetchStaff();
  };

  const handleRemove = async (row: StaffRow) => {
    if (!store) return;
    const ok = await confirmDialog({
      title: 'Quitar del equipo',
      message: `¿Quitar a ${row.full_name || row.email} del equipo de ${store.name}?`,
      confirmLabel: 'Quitar',
      tone: 'danger',
    });
    if (!ok) return;
    setRemovingId(row.user_id);
    const { error } = await supabase.rpc('owner_remove_store_staff', {
      p_user_id: row.user_id,
      p_store_id: store.id,
    });
    setRemovingId(null);
    if (error) {
      setToast({ kind: 'err', text: 'No se pudo quitar al miembro.' });
      return;
    }
    setStaff((prev) => prev.filter((s) => s.user_id !== row.user_id));
    setToast({ kind: 'ok', text: 'Miembro quitado del equipo.' });
  };

  const handleResend = async (row: StaffRow, ch: 'email' | 'whatsapp', phoneArg?: string) => {
    if (!store) return;
    if (ch === 'whatsapp' && (phoneArg ?? '').trim().length < 7) {
      setToast({ kind: 'err', text: 'Ingresa un teléfono válido para reenviar por WhatsApp.' });
      return;
    }
    setResendingId(row.user_id);
    const { data, error } = await supabase.functions.invoke('invite-store-staff', {
      body: {
        email: row.email,
        store_id: store.id,
        store_role: row.store_role,
        channel: ch,
        phone: ch === 'whatsapp' ? (phoneArg ?? '').trim() : undefined,
        profile: {
          full_name: row.full_name,
          telefono_personal: ch === 'whatsapp' ? (phoneArg ?? '').trim() : undefined,
        },
      },
    });
    setResendingId(null);

    if (error || !(data as { ok?: boolean })?.ok) {
      const msg = error ? await readFnError(error) : 'No se pudo reenviar el enlace.';
      setToast({ kind: 'err', text: msg });
      return;
    }

    setToast({
      kind: 'ok',
      text: `Enlace reenviado a ${row.email} por ${ch === 'email' ? 'correo' : 'WhatsApp'}.`,
    });
    if (ch === 'whatsapp') {
      const saved = (phoneArg ?? '').trim();
      setStaff((prev) =>
        prev.map((s) => (s.user_id === row.user_id ? { ...s, telefono_personal: saved } : s)),
      );
    }
    setResendOpenFor(null);
    setResendPhone('');
  };

  const roleOptions = useMemo(() => (['seller', 'advertiser'] as const), []);

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 rounded-2xl border border-line bg-surface p-8 text-center text-fg-muted">
        Selecciona una tienda en el panel lateral.
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="max-w-2xl mx-auto mt-20 rounded-2xl border border-line bg-surface p-8 text-center text-fg-muted">
        Solo el dueño de la tienda puede gestionar el equipo.
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <p className="mb-1 font-mono text-xs uppercase tracking-wider text-fg-subtle">
          Equipo · {store.name}
        </p>
        <h2 className="text-2xl font-bold text-fg">Gestiona tu equipo</h2>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Invita colaboradores con acceso limitado a tu tienda. El{' '}
          <strong className="text-fg">vendedor</strong> solo puede canjear cupones; el{' '}
          <strong className="text-fg">publicista</strong> solo gestiona la publicidad (cupones y
          campañas). Recibirán un enlace para definir su contraseña.
        </p>
      </div>

      {/* Formulario de invitación */}
      <form
        onSubmit={handleInvite}
        className="rounded-2xl border border-line bg-surface p-5 space-y-4"
      >
        <h3 className="text-sm font-bold uppercase tracking-wider text-fg-muted">Invitar colaborador</h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Correo electrónico">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colaborador@ejemplo.com"
              autoComplete="off"
              className="input-brand"
            />
          </Field>
          <Field label="Nombre (opcional)">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Nombre y apellido"
              className="input-brand"
            />
          </Field>
        </div>

        <Field label="Rol (uno por tienda)">
          <div className="grid gap-2 sm:grid-cols-2">
            {roleOptions.map((r) => {
              const taken = staff.some((s) => s.store_role === r);
              return (
                <button
                  type="button"
                  key={r}
                  disabled={taken}
                  onClick={() => setStaffRole(r)}
                  className={`rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    staffRole === r && !taken
                      ? 'border-[color:var(--brand-cliente-from)] bg-surface-2'
                      : 'border-line hover:bg-surface-2'
                  }`}
                >
                  <p className="text-sm font-semibold text-fg">
                    {ROLE_LABEL[r]}
                    {taken && <span className="ml-1 text-[11px] font-normal text-fg-subtle">· ya asignado</span>}
                  </p>
                  <p className="mt-0.5 text-[12px] text-fg-subtle">{ROLE_DESC[r]}</p>
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Enviar invitación por">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'email' | 'whatsapp')}
              className="input-brand"
            >
              <option value="email">Correo</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </Field>
          {channel === 'whatsapp' && (
            <Field label="Teléfono (WhatsApp)">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
                placeholder="0412-1234567"
                inputMode="tel"
                className="input-brand"
              />
            </Field>
          )}
        </div>

        {formError && (
          <p className="rounded-lg border border-[color:color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color:var(--danger-bg)] px-3 py-2 text-sm text-[color:var(--danger)]">
            {formError}
          </p>
        )}

        {staff.some((s) => s.store_role === staffRole) && (
          <p className="text-[12px] text-fg-subtle">
            Ya tienes un {ROLE_LABEL[staffRole].toLowerCase()} en esta tienda. Quítalo abajo para
            invitar a otro.
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || staff.some((s) => s.store_role === staffRole)}
          className="brand-cliente glow-cliente rounded-xl px-5 py-2.5 text-sm font-bold text-fg-on-brand disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Enviando…' : 'Enviar invitación'}
        </button>
      </form>

      {/* Lista de staff */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-wider text-fg-muted">
          Colaboradores actuales
        </h3>
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <PageSpinner />
          </div>
        ) : staff.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-fg-subtle">
            Aún no has invitado a nadie. Usa el formulario de arriba.
          </div>
        ) : (
          <div className="space-y-2">
            {staff.map((row) => {
              const resendOpen = resendOpenFor === row.user_id;
              const busy = resendingId === row.user_id;
              return (
              <div
                key={row.user_id}
                className="rounded-xl border border-line bg-surface p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-fg">
                      {row.full_name || <span className="italic text-fg-faint">Sin nombre</span>}
                    </p>
                    <p className="truncate text-[13px] text-fg-muted">{row.email}</p>
                  </div>
                  <span
                    className="shrink-0 rounded-full border border-line bg-surface-2 px-3 py-1 text-[11px] font-semibold text-fg-muted"
                  >
                    {ROLE_LABEL[row.store_role] ?? row.store_role}
                  </span>
                  <button
                    onClick={() => {
                      setResendPhone(resendOpen ? '' : (row.telefono_personal ?? ''));
                      setResendOpenFor(resendOpen ? null : row.user_id);
                    }}
                    className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                      resendOpen
                        ? 'border-[color:var(--brand-cliente-from)] bg-surface-2 text-fg'
                        : 'border-line text-fg-muted hover:bg-surface-2'
                    }`}
                  >
                    Reenviar enlace
                  </button>
                  <button
                    onClick={() => handleRemove(row)}
                    disabled={removingId === row.user_id}
                    className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:border-[color:color-mix(in_oklab,var(--danger)_40%,transparent)] hover:text-[color:var(--danger)] disabled:opacity-50"
                  >
                    {removingId === row.user_id ? 'Quitando…' : 'Quitar'}
                  </button>
                </div>

                {resendOpen && (
                  <div className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3 sm:flex-row sm:items-center">
                    <span className="shrink-0 text-[12px] font-medium text-fg-subtle">
                      Reenviar enlace por:
                    </span>
                    <button
                      onClick={() => handleResend(row, 'email')}
                      disabled={busy}
                      className="shrink-0 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
                    >
                      {busy ? 'Enviando…' : 'Correo'}
                    </button>
                    <div className="flex flex-1 gap-2">
                      <input
                        value={resendPhone}
                        onChange={(e) => setResendPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
                        placeholder="Teléfono WhatsApp (0412-1234567)"
                        inputMode="tel"
                        className="input-brand flex-1"
                      />
                      <button
                        onClick={() => handleResend(row, 'whatsapp', resendPhone)}
                        disabled={busy}
                        className="shrink-0 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
                      >
                        {busy ? 'Enviando…' : 'WhatsApp'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl px-5 py-3 text-sm font-medium shadow-2xl ${
            toast.kind === 'ok'
              ? 'bg-emerald-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
        {label}
      </span>
      {children}
    </label>
  );
}
