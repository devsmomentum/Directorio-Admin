// ─────────────────────────────────────────────────────────────────────────────
// lib/plans.ts — fuente única de etiquetas y colores de plan.
//
// Antes vivían ~10 copias divergentes de PLAN_LABELS / PLAN_COLORS repartidas
// por panel y cliente, con labels inconsistentes ("Flash Coupon" vs "Cupones
// Flash") y estructuras de color distintas. Esto las unifica.
//
// Hay cuatro presentaciones de color según el contexto de UI:
//   - planBadge:          badge simple (texto + fondo translúcido)
//   - planBadgeBordered:  badge con borde (loop / asignación de kioscos)
//   - planColorParts:     piezas sueltas {badge,border,bg,dot} (CRUD de planes)
//   - planGradient:       tarjeta con gradiente (selección de plan en cliente)
// ─────────────────────────────────────────────────────────────────────────────

// PROMO_FLASH es un alias legacy que todavía aparece en datos del cliente.
export type PlanKey =
  | 'DIAMANTE'
  | 'ORO'
  | 'IA_PERFORMANCE'
  | 'PUBLI_PROMO_DIARIO'
  | 'PUBLI_PROMO_SEMANAL'
  | 'FLASH_COUPON_DIARIO'
  | 'FLASH_COUPON_SEMANAL'
  | 'PROMO_FLASH';

export const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
  FLASH_COUPON_DIARIO: 'Cupones Flash · Diario',
  FLASH_COUPON_SEMANAL: 'Cupones Flash · Semanal',
  PROMO_FLASH: 'Promo Flash',
};

export function planLabel(key: string | null | undefined): string {
  if (!key) return '—';
  return PLAN_LABELS[key] ?? key;
}

// Badge simple — texto + fondo. Usado por solicitudes, tiendas, cupons, pagos,
// dashboard, promociones.
export const PLAN_BADGE: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10',
  ORO: 'text-amber-400 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-400 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-400 bg-blue-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-400 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-400 bg-pink-500/10',
  PROMO_FLASH: 'text-pink-400 bg-pink-500/10',
};

export const PLAN_BADGE_DEFAULT = 'text-white/50 bg-white/5';

export function planBadge(key: string | null | undefined): string {
  if (!key) return PLAN_BADGE_DEFAULT;
  return PLAN_BADGE[key] ?? PLAN_BADGE_DEFAULT;
}

// Badge con borde — usado en el loop (campanias) y la asignación de kioscos.
export const PLAN_BADGE_BORDERED: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  ORO: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  IA_PERFORMANCE: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  PUBLI_PROMO_DIARIO: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  PUBLI_PROMO_SEMANAL: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  FLASH_COUPON_DIARIO: 'text-pink-400 bg-pink-500/10 border-pink-500/30',
  FLASH_COUPON_SEMANAL: 'text-pink-400 bg-pink-500/10 border-pink-500/30',
  PROMO_FLASH: 'text-pink-400 bg-pink-500/10 border-pink-500/30',
};

export const PLAN_BADGE_BORDERED_DEFAULT = 'text-white/50 bg-white/5 border-white/10';

export function planBadgeBordered(key: string | null | undefined): string {
  if (!key) return PLAN_BADGE_BORDERED_DEFAULT;
  return PLAN_BADGE_BORDERED[key] ?? PLAN_BADGE_BORDERED_DEFAULT;
}

// Piezas sueltas para el CRUD de planes (badge/borde/fondo/punto por separado).
export interface PlanColorParts {
  badge: string;
  border: string;
  bg: string;
  dot: string;
}

export const PLAN_COLOR_PARTS: Record<string, PlanColorParts> = {
  DIAMANTE: { badge: 'text-cyan-400 bg-cyan-500/10', border: 'border-cyan-500/30', bg: 'bg-cyan-500/5', dot: 'bg-cyan-400' },
  ORO: { badge: 'text-amber-400 bg-amber-500/10', border: 'border-amber-500/30', bg: 'bg-amber-500/5', dot: 'bg-amber-400' },
  IA_PERFORMANCE: { badge: 'text-purple-400 bg-purple-500/10', border: 'border-purple-500/30', bg: 'bg-purple-500/5', dot: 'bg-purple-400' },
  PUBLI_PROMO_DIARIO: { badge: 'text-blue-400 bg-blue-500/10', border: 'border-blue-500/30', bg: 'bg-blue-500/5', dot: 'bg-blue-400' },
  PUBLI_PROMO_SEMANAL: { badge: 'text-blue-400 bg-blue-500/10', border: 'border-blue-500/30', bg: 'bg-blue-500/5', dot: 'bg-blue-400' },
  FLASH_COUPON_DIARIO: { badge: 'text-pink-400 bg-pink-500/10', border: 'border-pink-500/30', bg: 'bg-pink-500/5', dot: 'bg-pink-400' },
  FLASH_COUPON_SEMANAL: { badge: 'text-pink-400 bg-pink-500/10', border: 'border-pink-500/30', bg: 'bg-pink-500/5', dot: 'bg-pink-400' },
};

export const DEFAULT_PLAN_COLOR: PlanColorParts = {
  badge: 'text-white/40 bg-white/5',
  border: 'border-white/10',
  bg: 'bg-white/5',
  dot: 'bg-white/30',
};

export function planColorParts(key: string | null | undefined): PlanColorParts {
  if (!key) return DEFAULT_PLAN_COLOR;
  return PLAN_COLOR_PARTS[key] ?? DEFAULT_PLAN_COLOR;
}

// Gradiente para las tarjetas de selección de plan en el portal cliente.
export const PLAN_GRADIENT: Record<string, string> = {
  DIAMANTE: 'from-cyan-500/20 to-blue-500/10 border-cyan-500/30 text-cyan-300',
  ORO: 'from-amber-500/20 to-orange-500/10 border-amber-500/30 text-amber-300',
  IA_PERFORMANCE: 'from-purple-500/20 to-pink-500/10 border-purple-500/30 text-purple-300',
  PUBLI_PROMO_DIARIO: 'from-blue-500/20 to-cyan-500/10 border-blue-500/30 text-blue-300',
  PUBLI_PROMO_SEMANAL: 'from-blue-500/20 to-cyan-500/10 border-blue-500/30 text-blue-300',
  FLASH_COUPON_DIARIO: 'from-pink-500/20 to-rose-500/10 border-pink-500/30 text-pink-300',
  FLASH_COUPON_SEMANAL: 'from-pink-500/20 to-rose-500/10 border-pink-500/30 text-pink-300',
};

export const PLAN_GRADIENT_DEFAULT =
  'from-white/10 to-white/5 border-white/10 text-white/60';

export function planGradient(key: string | null | undefined): string {
  if (!key) return PLAN_GRADIENT_DEFAULT;
  return PLAN_GRADIENT[key] ?? PLAN_GRADIENT_DEFAULT;
}

// Conjunto de plan_keys que corresponden al addon Cupones Flash (no plan base).
export const FLASH_COUPON_PLANS = new Set(['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL']);

export function isFlashPlan(key: string | null | undefined): boolean {
  return !!key && FLASH_COUPON_PLANS.has(key);
}
