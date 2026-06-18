'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Diálogo de confirmación compartido. Reemplaza los confirm() nativos.
//
// Uso (la función devuelve una promesa booleana):
//   import { confirmDialog } from '../../components/confirm-dialog';
//   if (!(await confirmDialog({ title: 'Eliminar', message: '¿Seguro?',
//       confirmLabel: 'Eliminar', tone: 'danger' }))) return;
//
// Hay que montar <ConfirmHost/> una vez por layout (panel y cliente).
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}

interface State {
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
}

let state: State | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getSnapshot() {
  return state;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  // Si ya hay uno abierto, lo resolvemos como cancelado antes de abrir el nuevo.
  if (state) state.resolve(false);
  return new Promise<boolean>((resolve) => {
    state = { opts, resolve };
    emit();
  });
}

function settle(value: boolean) {
  const current = state;
  state = null;
  emit();
  current?.resolve(value);
}

export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!current) return null;
  const { title, message, confirmLabel, cancelLabel, tone } = current.opts;
  const danger = tone === 'danger';
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => settle(false)}
    >
      <div
        className={`w-full max-w-sm rounded-2xl border bg-surface p-5 shadow-2xl ${
          danger ? 'border-danger/40' : 'border-line'
        }`}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <h3 className={`text-base font-semibold ${danger ? 'text-danger' : 'text-fg'}`}>
          {title}
        </h3>
        {message && (
          <p className="mt-2 text-sm text-fg-muted whitespace-pre-line">{message}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => settle(false)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-fg-muted hover:text-fg hover:bg-glass transition-colors"
          >
            {cancelLabel || 'Cancelar'}
          </button>
          <button
            onClick={() => settle(true)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors ${
              danger ? 'bg-danger/90 hover:bg-danger' : 'bg-brand-cliente-from/90 hover:bg-brand-cliente-from'
            }`}
          >
            {confirmLabel || 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}
