'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

export type PaymentMethod = 'transfer_bs' | 'transfer_usd' | 'cash_usd' | 'cash_bs';

export type PaymentState = {
  method: PaymentMethod;
  bank: string;
  reference: string;
  amountBs: string;
  amountUsd: string;
  bcvRate: string;
};

export const BANK_BS_OPTIONS = [
  'Bancamiga',
  'Banesco',
  'Banco de Venezuela',
  'Banco Mercantil',
  'BBVA Provincial',
  'Banco Nacional de Crédito',
  'Banco Plaza',
  'Banco del Tesoro',
  'Banco Bicentenario',
  'Otro',
];

export const COMPANY_BANK_ACCOUNTS = {
  rif: 'J506637529',
  bs: '0172-0125-52-1255415786',
  usd: '0172-0125-57-1255412486',
  email: 'anavidirectorios@gmail.com',
};

export const BANK_USD_OPTIONS = [
  'Bancamiga USD',
];

export const METHOD_OPTIONS: { key: PaymentMethod; label: string; sub: string }[] = [
  { key: 'transfer_bs', label: 'Transferencia Bs', sub: 'Banco · tasa BCV' },
  { key: 'transfer_usd', label: 'Transferencia USD', sub: 'Bancamiga' },
  { key: 'cash_usd', label: 'Efectivo USD', sub: 'Dólares en efectivo' },
];

export function emptyPaymentState(): PaymentState {
  return { method: 'transfer_bs', bank: BANK_BS_OPTIONS[0], reference: '', amountBs: '', amountUsd: '', bcvRate: '' };
}

/**
 * Convierte el estado del form al payload que aceptan tanto la RPC
 * request_plan_atomic como un insert directo en transactions.
 * Devuelve { error } si hay validación incompleta, o { payload } válido.
 */
export function buildPaymentPayload(s: PaymentState, expectedUsd?: number): {
  error?: string;
  payload?: {
    method: PaymentMethod;
    bank: string | null;
    reference: string | null;
    amountBs: number | null;
    amountUsd: number | null;
    bcvRate: number | null;
  };
} {
  const needsTransfer = s.method === 'transfer_bs' || s.method === 'transfer_usd';
  const needsBs = s.method === 'transfer_bs' || s.method === 'cash_bs';
  const needsUsd = s.method === 'transfer_usd' || s.method === 'cash_usd';

  if (needsTransfer) {
    if (!s.reference.trim()) return { error: 'Indica el número de referencia.' };
    if (!s.bank.trim()) return { error: 'Indica el banco emisor.' };
  }
  let amountBsNum: number | null = null;
  let amountUsdNum: number | null = null;
  let bcvRateNum: number | null = null;

  if (needsBs) {
    // En pagos en Bs el usuario sólo tipea USD; la tasa BCV viene del DB
    // (s.bcvRate la sincroniza el componente). El Bs es derivado.
    amountUsdNum = parseFloat(s.amountUsd);
    if (!Number.isFinite(amountUsdNum) || amountUsdNum <= 0) {
      return { error: 'Indica el monto pagado en USD.' };
    }
    bcvRateNum = parseFloat(s.bcvRate);
    if (!Number.isFinite(bcvRateNum) || bcvRateNum <= 0) {
      return { error: 'Aún no se ha cargado la tasa BCV oficial. Espera unos segundos o recarga la página.' };
    }
    amountBsNum = Math.round(amountUsdNum * bcvRateNum * 100) / 100;
  } else if (needsUsd) {
    amountUsdNum = parseFloat(s.amountUsd);
    if (!Number.isFinite(amountUsdNum) || amountUsdNum <= 0) {
      return { error: 'Indica el monto pagado en USD.' };
    }
  }

  // Si nada se pudo capturar y conocemos el USD esperado, lo guardamos como
  // referencia para la administración. El backend re-valida igualmente.
  if (amountUsdNum == null && expectedUsd != null) amountUsdNum = expectedUsd;

  return {
    payload: {
      method: s.method,
      bank: needsTransfer ? s.bank.trim() : null,
      reference: needsTransfer ? s.reference.trim() : null,
      amountBs: amountBsNum,
      amountUsd: amountUsdNum,
      bcvRate: bcvRateNum,
    },
  };
}

export function PaymentFields({
  value, onChange, expectedUsd,
}: {
  value: PaymentState;
  onChange: (next: PaymentState) => void;
  expectedUsd?: number;
}) {
  const s = value;
  const set = (patch: Partial<PaymentState>) => onChange({ ...s, ...patch });

  // Al cambiar método, resetea el banco al primer item de la lista relevante.
  const switchMethod = (m: PaymentMethod) => {
    const banks = (m === 'transfer_usd') ? BANK_USD_OPTIONS : BANK_BS_OPTIONS;
    onChange({
      ...s,
      method: m,
      bank: banks[0],
      // Limpia campos no aplicables a evitar enviar datos sucios
      reference: (m === 'cash_usd' || m === 'cash_bs') ? '' : s.reference,
      amountBs: (m === 'transfer_usd' || m === 'cash_usd') ? '' : s.amountBs,
      amountUsd: (m === 'transfer_bs' || m === 'cash_bs') ? '' : s.amountUsd,
      bcvRate: (m === 'transfer_usd' || m === 'cash_usd') ? '' : s.bcvRate,
    });
  };

  const banks = s.method === 'transfer_usd' ? BANK_USD_OPTIONS : BANK_BS_OPTIONS;

  const needsTransfer = s.method === 'transfer_bs' || s.method === 'transfer_usd';
  const needsBs = s.method === 'transfer_bs' || s.method === 'cash_bs';
  const needsUsd = s.method === 'transfer_usd' || s.method === 'cash_usd';

  // Tasa BCV oficial: vive en app_config, refrescada por la edge update-rate.
  // El usuario NO la edita; el backend la re-lee al validar para que sea
  // imposible burlar el cálculo desde el front.
  const [bcvRate, setBcvRate] = useState<number | null>(null);
  const [bcvUpdatedAt, setBcvUpdatedAt] = useState<string | null>(null);
  const [bcvLoading, setBcvLoading] = useState<boolean>(true);
  const [bcvError, setBcvError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBcvLoading(true);
      setBcvError(null);
      const { data, error } = await supabase
        .from('app_config')
        .select('value, updated_at')
        .eq('key', 'bcv_exchange_rate')
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setBcvError('No se pudo obtener la tasa BCV.');
        setBcvRate(null);
      } else {
        const rate = data?.value ? parseFloat(data.value) : NaN;
        if (Number.isFinite(rate) && rate > 0) {
          setBcvRate(rate);
          setBcvUpdatedAt(data?.updated_at ?? null);
        } else {
          setBcvError('La tasa BCV aún no está cargada en el sistema.');
          setBcvRate(null);
        }
      }
      setBcvLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Mantenemos s.bcvRate sincronizado con la tasa oficial para que el payload
  // hacia la RPC ya lleve el valor correcto (el backend igualmente la re-lee).
  useEffect(() => {
    const target = bcvRate != null ? String(bcvRate) : '';
    if (s.bcvRate !== target) onChange({ ...s, bcvRate: target });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bcvRate]);

  // Bs derivado: el usuario tipea USD; la tasa viene del DB.
  const computedBs = useMemo(() => {
    if (!needsBs || bcvRate == null) return null;
    const usd = parseFloat(s.amountUsd);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return Math.round(bcvRate * usd * 100) / 100;
  }, [needsBs, bcvRate, s.amountUsd]);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
          Método de pago
        </label>
        <div className="grid grid-cols-2 gap-2">
          {METHOD_OPTIONS.map(m => {
            const active = s.method === m.key;
            return (
              <button
                key={m.key} type="button" onClick={() => switchMethod(m.key)}
                className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${active
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200'
                    : 'bg-white/[0.02] border-white/10 text-white/60 hover:border-white/20'
                  }`}
              >
                <p className="text-xs font-semibold">{m.label}</p>
                <p className={`text-[10px] mt-0.5 ${active ? 'text-cyan-300/70' : 'text-white/30'}`}>
                  {m.sub}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {needsBs && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
          <p className="text-amber-300 text-[11px] font-semibold uppercase tracking-wider mb-1">
            💱 Tasa BCV del día
          </p>
          <p className="text-white/70 text-[11px] leading-relaxed">
            La tasa <strong className="text-amber-200">oficial del BCV</strong> la fija el sistema
            automáticamente. Solo indica cuántos USD estás pagando y verás el monto exacto a
            transferir en Bs.
          </p>
        </div>
      )}

      {needsTransfer && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
              {s.method === 'transfer_usd' ? 'Plataforma / banco' : 'Banco emisor'}
            </label>
            <select
              value={s.bank} onChange={(e) => set({ bank: e.target.value })}
              className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            >
              {banks.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
              Nº de referencia
            </label>
            <input
              type="text" required
              value={s.reference} onChange={(e) => set({ reference: e.target.value })}
              className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/50"
              placeholder="012345678901"
            />
          </div>
        </div>
      )}

      {needsBs && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                Monto pagado (USD)
              </label>
              <input
                type="number" step="0.01" min="0"
                value={s.amountUsd} onChange={(e) => set({ amountUsd: e.target.value })}
                className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                placeholder={expectedUsd != null ? expectedUsd.toFixed(2) : '120.00'}
              />
            </div>
            <div>
              <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                Tasa BCV oficial
              </label>
              <div
                className="w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2.5 text-sm font-mono flex items-center justify-between gap-2"
                aria-readonly="true"
                title="Tasa fijada por el sistema. No editable."
              >
                <span className={bcvRate != null ? 'text-white' : 'text-white/40'}>
                  {bcvLoading
                    ? 'Cargando…'
                    : bcvRate != null
                    ? bcvRate.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '—'}
                </span>
                <span className="text-[10px] text-white/30 normal-case font-sans">🔒 BCV</span>
              </div>
            </div>
          </div>

          {bcvError && (
            <p className="text-[11px] text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-2.5 py-1.5">
              {bcvError} Contacta a la administración para refrescarla.
            </p>
          )}
          {!bcvError && bcvUpdatedAt && (
            <p className="text-[10px] text-white/30">
              Tasa actualizada el{' '}
              <span className="font-mono text-white/50">
                {new Date(bcvUpdatedAt).toLocaleDateString('es-VE')}
              </span>
              
            </p>
          )}

          <div className="bg-cyan-500/[0.06] border border-cyan-500/20 rounded-lg px-3 py-2.5 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] text-cyan-200/70 uppercase tracking-wider font-semibold">
                Monto a transferir en Bs
              </p>
              <p className="text-[10px] text-white/40 mt-0.5">USD × tasa BCV · calculado por el sistema</p>
            </div>
            <p className="text-white font-mono text-base font-bold whitespace-nowrap">
              {computedBs != null
                ? `Bs ${computedBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : '—'}
            </p>
          </div>
        </div>
      )}

      {needsUsd && (
        <div>
          <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
            Monto pagado en USD
          </label>
          <input
            type="number" step="0.01" min="0"
            value={s.amountUsd} onChange={(e) => set({ amountUsd: e.target.value })}
            className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            placeholder={expectedUsd != null ? expectedUsd.toFixed(2) : '120.00'}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Mapea PaymentMethod -> string compatible con transactions.payment_method
 * (mantenemos compat con valores legacy que ya usaba la tabla).
 */
export function methodLabel(m?: string | null): string {
  switch (m) {
    case 'transfer_bs': return 'Transferencia Bs';
    case 'transfer_usd': return 'Transferencia USD';
    case 'cash_usd': return 'Efectivo USD';
    case 'cash_bs': return 'Efectivo Bs';
    case 'bancamiga_bs': return 'Bancamiga · Bs';
    case 'bancamiga_usd': return 'Bancamiga · USD';
    case 'binance': return 'Binance';
    case 'efectivo': return 'Efectivo';
    case 'otro': return 'Otro';
    default: return m || '—';
  }
}
