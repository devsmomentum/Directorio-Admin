// ─────────────────────────────────────────────────────────────────────────────
// lib/csv.ts — exportación CSV compartida.
//
// Antes vivían copias verbatim de csvCell/downloadCSV/slugify en
// app/cliente/dashboard y app/panel/tiendas, y un exportCSV divergente (con y
// sin BOM) en analiticas/finanzas. Esta es la versión única: comillas dobladas,
// envoltura si hay coma/quote/newline, y BOM UTF-8 para que Excel respete los
// acentos.
// ─────────────────────────────────────────────────────────────────────────────

// Escapa un valor para una celda CSV.
export function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Construye y descarga un CSV. Incluye BOM para Excel.
export function downloadCSV(filename: string, headers: string[], rows: unknown[][]) {
  const body = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Normaliza un nombre a slug seguro para nombre de archivo (sin acentos,
// minúsculas, separado por guión bajo, máx 40 chars).
export function slugify(s: string): string {
  return (s || 'tienda')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
