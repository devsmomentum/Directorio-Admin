// Tipos de promoción de cupón, compartidos por el panel admin (/panel/cupons)
// y el portal del cliente (/cliente/promociones) para que NO diverjan.
//
// El cupón ya no es solo "% de descuento": puede ser 2x1/NxM, precio fijo/combo,
// regalo o una etiqueta libre. Ver migración `coupon_promo_types`.
//
// CONTRATO de badge (idéntico en admin, web /cupon y app Flutter en producción):
//   mostrar offer_label si existe; si no y discount_percent > 0 -> "X% OFF"; si no, nada.
// Por eso `percentage` deja offer_label NULL y la app vieja sigue leyendo discount_percent.

export type OfferType = 'percentage' | 'nxm' | 'fixed_price' | 'gift' | 'text';

export const OFFER_TYPES: { key: OfferType; label: string; hint: string }[] = [
  { key: 'percentage',  label: 'Descuento %',         hint: 'Porcentaje de descuento clásico (ej. 20% OFF).' },
  { key: 'nxm',         label: '2x1 / NxM',           hint: 'Lleva N y paga M (2x1, 3x2, …).' },
  { key: 'fixed_price', label: 'Precio fijo / combo', hint: 'Precio especial fijo (ej. combo a $9.99).' },
  { key: 'gift',        label: 'Regalo / gift',       hint: 'Obsequio gratis con la compra.' },
  { key: 'text',        label: 'Texto libre',         hint: 'Etiqueta de promo personalizada (ej. “Envío gratis”).' },
];

export interface OfferInputs {
  discountPercent: number;
  buyQty: number;
  payQty: number;
  fixedPrice: number;
  giftText: string;
  freeText: string;
}

export interface BuiltOffer {
  offer_label: string | null;
  offer_value: Record<string, unknown> | null;
  // Se conserva por retrocompatibilidad con la app Flutter en producción.
  discount_percent: number;
}

// Construye los 3 campos que persistimos a partir del tipo + inputs del form.
export function buildOffer(type: OfferType, f: OfferInputs): BuiltOffer {
  switch (type) {
    case 'nxm':
      return { offer_label: `${f.buyQty}x${f.payQty}`, offer_value: { buy: f.buyQty, pay: f.payQty }, discount_percent: 0 };
    case 'fixed_price': {
      const price = f.fixedPrice;
      const pretty = Number.isInteger(price) ? String(price) : price.toFixed(2);
      return { offer_label: `$${pretty}`, offer_value: { price }, discount_percent: 0 };
    }
    case 'gift': {
      const item = f.giftText.trim();
      return { offer_label: item || 'Regalo', offer_value: { item: item || null }, discount_percent: 0 };
    }
    case 'text': {
      const label = f.freeText.trim();
      return { offer_label: label || null, offer_value: null, discount_percent: 0 };
    }
    case 'percentage':
    default:
      return { offer_label: null, offer_value: null, discount_percent: f.discountPercent };
  }
}

// Valida los inputs del tipo elegido. Devuelve un mensaje de error o null si OK.
export function validateOffer(type: OfferType, f: OfferInputs): string | null {
  switch (type) {
    case 'percentage':
      return (f.discountPercent <= 0 || f.discountPercent > 100)
        ? 'El descuento debe estar entre 1 y 100%.' : null;
    case 'nxm':
      return (f.buyQty < 2 || f.payQty < 1 || f.payQty >= f.buyQty)
        ? 'En NxM, "lleva" debe ser mayor que "paga" (ej. 2x1, 3x2).' : null;
    case 'fixed_price':
      return f.fixedPrice <= 0 ? 'Ingresa un precio fijo válido.' : null;
    case 'gift':
      return !f.giftText.trim() ? 'Describe el regalo/obsequio.' : null;
    case 'text':
      return !f.freeText.trim() ? 'Ingresa el texto de la promoción.' : null;
    default:
      return null;
  }
}

// Etiqueta lista para mostrar en cualquier UI. Mismo contrato que web/app Flutter.
export function couponBadge(c: { offer_label?: string | null; discount_percent?: number | null }): string {
  const l = c.offer_label?.trim();
  if (l) return l;
  const d = Number(c.discount_percent ?? 0);
  if (d > 0) return `${d % 1 === 0 ? d.toFixed(0) : d}% OFF`;
  return '—';
}
