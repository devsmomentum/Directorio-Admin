// Spinner de carga compartido. Reemplaza los ~19 spinners reinventados por
// página (cada uno con un color distinto). Neutro por defecto.

export function PageSpinner({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 py-20 ${className}`}>
      <div className="w-8 h-8 border-2 border-line border-t-fg rounded-full animate-spin" />
      {label && <p className="text-sm text-fg-muted">{label}</p>}
    </div>
  );
}

// Variante inline pequeña (para botones / encabezados).
export function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return <div className={`${className} border-2 border-line border-t-fg rounded-full animate-spin`} />;
}
