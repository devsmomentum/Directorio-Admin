// ─────────────────────────────────────────────────────────────────────────────
// lib/format.ts — formato de fecha y moneda compartido.
//
// Antes había ~13 archivos formateando fechas a mano con locales mezclados
// (es-VE, en-CA, o sin locale → dependiente del navegador) y moneda con
// prefijos "Bs"/"$" cosidos a mano. Esto centraliza el criterio: locale es-VE
// para todo lo que ve el usuario.
//
// Todas las funciones toleran null/undefined/'' devolviendo un guión, y aceptan
// Date | string | number.
// ─────────────────────────────────────────────────────────────────────────────

const LOCALE = 'es-VE';
const EMPTY = '—';

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Fecha corta: 18/6/2026
export function formatDate(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  return d ? d.toLocaleDateString(LOCALE) : EMPTY;
}

// Fecha + hora: 18 jun 2026, 14:30
export function formatDateTime(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return d.toLocaleString(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Monto en dólares: $1,234 (o $1,234.50 con decimals=2)
export function formatUSD(
  value: number | string | null | undefined,
  decimals = 0
): string {
  const n = Number(value);
  if (value == null || value === '' || isNaN(n)) return EMPTY;
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

// Monto en bolívares: Bs 1.234,56
export function formatBs(
  value: number | string | null | undefined,
  decimals = 2
): string {
  const n = Number(value);
  if (value == null || value === '' || isNaN(n)) return EMPTY;
  return (
    'Bs ' +
    n.toLocaleString(LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}
