import { ReactNode } from 'react';

export function EmptyState({
  title = 'Sin resultados',
  message = 'No se encontraron elementos.',
  icon,
  action,
}: {
  title?: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto mt-12 max-w-md rounded-2xl border border-dashed border-line bg-surface/50 p-8 text-center backdrop-blur-sm">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-fg-muted shadow-sm">
        {icon || (
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        )}
      </div>
      <p className="text-[15px] font-semibold text-fg">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
