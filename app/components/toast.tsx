'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Toast compartido. Reemplaza los ~30 alert() nativos repartidos por el panel y
// el portal cliente, y los sistemas de toast reinventados por página.
//
// Uso desde cualquier handler (no hace falta hook ni context):
//   import { toast } from '../../components/toast';
//   toast.success('Guardado');
//   toast.error('No se pudo guardar: ' + e.message);
//
// Hay que montar <Toaster/> una vez por layout (panel y cliente).
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react';

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

let items: ToastItem[] = [];
let nextId = 1;
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
  return items;
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function push(kind: ToastKind, message: string, ms: number) {
  const id = nextId++;
  items = [...items, { id, kind, message }];
  emit();
  if (ms > 0) {
    setTimeout(() => dismiss(id), ms);
  }
  return id;
}

export const toast = {
  success: (message: string, ms = 3500) => push('success', message, ms),
  error: (message: string, ms = 6000) => push('error', message, ms),
  info: (message: string, ms = 4000) => push('info', message, ms),
  dismiss,
};

const KIND_STYLES: Record<ToastKind, string> = {
  success: 'border-success/40 text-fg',
  error: 'border-danger/40 text-fg',
  info: 'border-line text-fg',
};

const KIND_ICON_COLOR: Record<ToastKind, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-fg-muted',
};

function ToastIcon({ kind }: { kind: ToastKind }) {
  const cls = `h-5 w-5 shrink-0 ${KIND_ICON_COLOR[kind]}`;
  if (kind === 'success') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (kind === 'error') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!list.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[min(92vw,380px)]">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`flex items-start gap-2.5 rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg ${KIND_STYLES[t.kind]}`}
        >
          <span className="mt-0.5">
            <ToastIcon kind={t.kind} />
          </span>
          <span className="flex-1 whitespace-pre-line break-words">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="text-fg-muted hover:text-fg transition-colors"
            aria-label="Cerrar"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
