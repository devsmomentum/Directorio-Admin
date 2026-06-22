'use client';

import { useState } from 'react';
import Link from 'next/link';
import { COMPANY_BANK_ACCOUNTS } from '../payment-fields';

export default function ClienteTutorialPage() {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Portal del Aliado</p>
        <h2 className="text-3xl font-bold text-white">Tutorial &amp; Centro de Pagos</h2>
        <p className="text-white/50 text-sm mt-3 max-w-2xl">
          Bienvenido al portal de clientes de Millennium Mall. Aquí encontrarás las especificaciones técnicas
          para tus creativos y las instrucciones para reportar tus pagos. La administración garantiza un
          proceso transparente y automatizado de cobranza.
        </p>
      </div>

      {/* ── 1. Guía de Arte y Especificaciones Técnicas ── */}
      <section className="bg-[#111] border border-white/5 rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-cyan-500/15 flex items-center justify-center">
            <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
          <div>
            <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Sección 1</p>
            <h3 className="text-lg font-bold text-white">Guía de Arte y Especificaciones Técnicas</h3>
          </div>
        </div>

        <p className="text-white/60 text-sm">
          Para garantizar que el <span className="text-cyan-300 font-semibold">Ad-Server Dinámico</span> luzca
          profesional en las pantallas de 24 pulgadas, tus creativos deben cumplir estas especificaciones:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Campaña (video) */}
          <div className="bg-gradient-to-br from-cyan-500/10 to-blue-500/5 border border-cyan-500/20 rounded-xl p-5">
            <p className="text-[10px] text-cyan-300 uppercase tracking-widest font-bold mb-2">📺 Campaña</p>
            <h4 className="text-white font-bold mb-1">Video del loop publicitario</h4>
            <p className="text-[10px] text-white/40 mt-0.5">Diamante · Oro · Publi Promo</p>
            <div className="space-y-2 mt-4">
              <Spec label="Resolución" value="1080 × 1920 px (vertical · 9:16)" />
              <Spec label="Duración" value="15 segundos (fija)" />
              <Spec label="Formato" value=".MP4 (H.264) o .WebM" />
              <Spec label="Peso máx." value="30 MB" />
            </div>
          </div>

          {/* Banner */}
          <div className="bg-gradient-to-br from-purple-500/10 to-fuchsia-500/5 border border-purple-500/20 rounded-xl p-5">
            <p className="text-[10px] text-purple-300 uppercase tracking-widest font-bold mb-2">🖼 Banner</p>
            <h4 className="text-white font-bold mb-1">Franja del menú kiosco</h4>
            <p className="text-[10px] text-white/40 mt-0.5">Exclusivo plan Diamante</p>
            <div className="space-y-2 mt-4">
              <Spec label="Resolución" value="1920 × 342 px (≈ 5.625:1)" />
              <Spec label="Formato" value=".MP4 (H.264) · .PNG · .JPG" />
              <Spec label="Peso máx." value="15 MB video · 2 MB imagen" />
              <Spec label="Nota" value="Cover: texto y logos centrados" />
            </div>
          </div>

          {/* Cupón */}
          <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/5 border border-amber-500/20 rounded-xl p-5">
            <p className="text-[10px] text-amber-300 uppercase tracking-widest font-bold mb-2">🎟️ Cupón</p>
            <h4 className="text-white font-bold mb-1">Tarjeta de la cuponera</h4>
            <p className="text-[10px] text-white/40 mt-0.5">⚡ Cupón Flash </p>
            <div className="space-y-2 mt-4">
              <Spec label="Resolución" value="1200 × 900 px (4:3)" />
              <Spec label="Formato" value=".PNG o .JPG" />
              <Spec label="Peso máx." value="500 KB" />
              <Spec label="Nota" value="Logo/QR centrado, fondo limpio" />
            </div>
          </div>
        </div>

        <div className="bg-pink-500/5 border border-pink-500/20 rounded-lg p-4">
          <p className="text-pink-300 text-sm">
            <span className="font-bold">💡 Tip:</span> El código QR de descuento debe ser el protagonista del
            arte. Menos texto y más QR = mejor conversión en kiosco.
          </p>
        </div>
      </section>

      {/* ── 2. Protocolo de Pagos ── */}
      <section className="bg-[#111] border border-white/5 rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center">
            <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
          </div>
          <div>
            <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">Sección 2</p>
            <h3 className="text-lg font-bold text-white">Protocolo de Pagos Automatizado</h3>
          </div>
        </div>

        {/* Centro de pagos card */}
        <div className="bg-gradient-to-br from-emerald-500/15 via-cyan-500/5 to-transparent border-2 border-emerald-500/30 rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-6">
          <div className="flex-1 text-center sm:text-left">
            <p className="text-[10px] text-emerald-300 uppercase tracking-widest font-bold mb-1">⚡ Automatizado</p>
            <h4 className="text-2xl font-black text-white mb-3">FACTURACIÓN CENTRALIZADA</h4>
            <p className="text-white/70 text-sm">
              Ya no necesitas reportar tus pagos por correo. Usa el portal nativo para registrar tu referencia
              bancaria y aprovechar la <span className="text-emerald-300 font-bold">tasa oficial del BCV</span>.
            </p>
          </div>
          <Link
            href="/cliente/pagos"
            className="shrink-0 bg-emerald-500 hover:bg-emerald-400 text-black font-bold px-6 py-3 rounded-xl transition-colors"
          >
            Ir a Pagos
          </Link>
        </div>

        {/* Cuentas bancarias */}
        <div>
          <h4 className="text-white font-bold mb-3 text-sm">🏦 Cuentas Bancarias · Bancamiga</h4>
          <div className="space-y-2">
            <BankRow label="RIF" value={COMPANY_BANK_ACCOUNTS.rif} onCopy={() => copyToClipboard(COMPANY_BANK_ACCOUNTS.rif, 'rif')} copied={copied === 'rif'} />
            <BankRow label="Bolívares" value={COMPANY_BANK_ACCOUNTS.bs} raw={COMPANY_BANK_ACCOUNTS.bs.replace(/-/g, '')} onCopy={() => copyToClipboard(COMPANY_BANK_ACCOUNTS.bs.replace(/-/g, ''), 'bs')} copied={copied === 'bs'} />
            <BankRow label="Dólares" value={COMPANY_BANK_ACCOUNTS.usd} raw={COMPANY_BANK_ACCOUNTS.usd.replace(/-/g, '')} onCopy={() => copyToClipboard(COMPANY_BANK_ACCOUNTS.usd.replace(/-/g, ''), 'usd')} copied={copied === 'usd'} />
          </div>
          <p className="text-white/40 text-xs mt-3 italic">
            También aceptamos <span className="text-white/60 font-medium">Efectivo</span> y{' '}
            <span className="text-white/60 font-medium">Binance</span> (solicita el link de pago).
          </p>
        </div>
      </section>

      {/* Footer note */}
      <div className="text-center pt-4 pb-8">
        <p className="text-white/30 text-xs">
          ¿Dudas? Escribe a{' '}
          <a href={`mailto:${COMPANY_BANK_ACCOUNTS.email}`} className="text-white/60 hover:text-white underline">
            {COMPANY_BANK_ACCOUNTS.email}
          </a>{' '}
          o llama al{' '}
          <span className="text-white/60 font-mono">+58 412-5570011</span>.
        </p>
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-3 text-xs">
      <span className="text-white/40 uppercase tracking-wider">{label}</span>
      <span className="text-white/90 font-mono text-right">{value}</span>
    </div>
  );
}

function BankRow({ label, value, raw, onCopy, copied }: { label: string; value: string; raw?: string; onCopy: () => void; copied: boolean }) {
  return (
    <button
      onClick={onCopy}
      className="w-full bg-[#0A0A0A] hover:bg-white/[0.03] border border-white/10 hover:border-white/20 rounded-lg px-4 py-3 flex items-center justify-between transition-colors group"
    >
      <div className="text-left">
        <p className="text-[10px] text-white/40 uppercase tracking-wider">{label}</p>
        <p className="text-white/90 font-mono text-sm mt-0.5">{value}</p>
      </div>
      <span className="text-[10px] text-emerald-400 uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity">
        {copied ? '✓ Copiado' : 'Copiar'}
      </span>
    </button>
  );
}
