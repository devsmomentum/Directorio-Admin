'use client';

import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  PaymentFields,
  PaymentState,
  emptyPaymentState,
  buildPaymentPayload,
} from './payment-fields';

export type AbonoRequest = {
  id: string;
  plan_key: string;
  total_amount_usd: number | string | null;
  paid_amount_usd: number | string | null;
};

type Props = {
  request: AbonoRequest | null;
  onClose: () => void;
  onSuccess?: (msg: string) => void;
};

export function AbonoModal({ request, onClose, onSuccess }: Props) {
  const [payment, setPayment] = useState<PaymentState>(emptyPaymentState());
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!request) return null;

  const total = Number(request.total_amount_usd ?? 0);
  const paid = Number(request.paid_amount_usd ?? 0);
  const outstanding = Math.max(total - paid, 0);

  const close = () => {
    if (submitting) return;
    setPayment(emptyPaymentState());
    setErr(null);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    // En exoneración el monto se fija al saldo pendiente (el backend lo fuerza
    // igualmente); para los demás métodos es lo que reporta el cliente.
    const built = buildPaymentPayload(payment, outstanding);
    if (built.error || !built.payload) {
      setErr(built.error || 'Datos de pago incompletos.');
      return;
    }
    const p = built.payload;
    const reported = Number(p.amountUsd ?? 0);
    if (reported <= 0) {
      setErr('Indica el monto en USD.');
      return;
    }
    if (reported > outstanding + 0.005) {
      setErr(`El abono (${reported.toFixed(2)} USD) supera el saldo pendiente (${outstanding.toFixed(2)} USD).`);
      return;
    }
    setSubmitting(true);
    const baseNotes = `Abono a solicitud ${request.plan_key}`;
    const { error } = await supabase.rpc('report_additional_payment_atomic', {
      p_request_id:        request.id,
      p_payment_method:    p.method,
      p_payment_reference: p.reference,
      p_payment_bank:      p.bank,
      p_amount_bs:         p.amountBs,
      p_amount_usd:        p.amountUsd ?? 0,
      p_bcv_rate:          p.bcvRate,
      p_notes:             p.notes ? `${baseNotes} · Motivo exoneración: ${p.notes}` : baseNotes,
    });
    setSubmitting(false);
    if (error) { setErr(error.message); return; }
    setPayment(emptyPaymentState());
    onSuccess?.('Abono reportado. Será verificado por la administración.');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="bg-gradient-to-br from-amber-500/15 to-orange-500/5 px-6 py-5 border-b border-white/10">
          <p className="text-[11px] text-white/60 uppercase tracking-widest mb-1">
            Abono a solicitud
          </p>
          <h3 className="text-xl font-bold text-white">{request.plan_key}</h3>
          <div className="grid grid-cols-3 gap-3 mt-4 text-center">
            <div className="bg-white/[0.04] rounded-lg p-2">
              <p className="text-[9px] text-white/40 uppercase">Total</p>
              <p className="text-white font-mono text-sm font-bold">${total.toFixed(2)}</p>
            </div>
            <div className="bg-white/[0.04] rounded-lg p-2">
              <p className="text-[9px] text-white/40 uppercase">Pagado</p>
              <p className="text-emerald-300 font-mono text-sm font-bold">${paid.toFixed(2)}</p>
            </div>
            <div className="bg-amber-500/10 rounded-lg p-2">
              <p className="text-[9px] text-amber-300/70 uppercase">Saldo</p>
              <p className="text-amber-300 font-mono text-sm font-bold">${outstanding.toFixed(2)}</p>
            </div>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <PaymentFields value={payment} onChange={setPayment} />
          {err && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg p-2.5 text-xs">
              {err}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button" onClick={close} disabled={submitting}
              className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg"
            >
              Cancelar
            </button>
            <button
              type="submit" disabled={submitting}
              className="flex-1 px-4 py-2.5 text-sm font-semibold bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-100 rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Enviando…' : 'Reportar abono'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
