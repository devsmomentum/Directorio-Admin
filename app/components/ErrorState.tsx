// Estado de error con reintento. Reemplaza el patrón de "tragarse el error" del
// portal cliente, donde una carga fallida se veía igual que una vacía.

export function ErrorState({
  title = 'No se pudo cargar',
  message = 'Ocurrió un error al cargar los datos. Revisa tu conexión e inténtalo de nuevo.',
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="mx-auto mt-12 max-w-md rounded-2xl border border-danger/30 bg-danger/[0.06] p-8 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-danger/40 text-danger">
        <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 12.99A1.5 1.5 0 004.14 19.5h15.72a1.5 1.5 0 001.3-2.57l-7.5-12.99a1.5 1.5 0 00-2.62 0z" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      <p className="mt-1 text-sm text-fg-muted">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 rounded-lg border border-line bg-glass px-4 py-2 text-sm font-medium text-fg hover:bg-glass-strong transition-colors"
        >
          Reintentar
        </button>
      )}
    </div>
  );
}
