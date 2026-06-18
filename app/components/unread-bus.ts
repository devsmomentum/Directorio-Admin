'use client';

// Bus mínimo para que la página de notificaciones del panel admin avise al
// layout que el conteo de no-leídas cambió (tras marcar como leído), y el badge
// baje al instante en vez de esperar el sondeo de 30s.
//
// El portal cliente resuelve lo mismo vía store-context (refreshUnread); el
// panel admin no tiene un contexto compartido, así que usa este bus.

const listeners = new Set<() => void>();

export function onUnreadChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyUnreadChanged(): void {
  for (const l of listeners) l();
}
