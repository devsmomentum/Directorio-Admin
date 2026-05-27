'use client';

import React from 'react';

// Identidad visual de Mall Hub:
//   - tile cuadrado con monograma "M" / "H" (apilados en diagonal)
//   - una órbita/dot que representa el "hub" central
//   - wordmark MALL HUB acompañado de un punto orbital entre las palabras
//
// Las variantes (admin / cliente / mix) reutilizan los gradients del theme,
// no introducen una paleta nueva. La tipografía juega con tracking ancho,
// font-black y el punto como "satélite" entre Mall y Hub.

type Variant = 'admin' | 'cliente' | 'mix';

const TILE_BG: Record<Variant, string> = {
  admin: 'brand-admin glow-admin',
  cliente: 'brand-cliente glow-cliente',
  mix: 'brand-mix',
};

const WORD_COLOR: Record<Variant, string> = {
  admin: 'text-brand-admin',
  cliente: 'text-brand-cliente',
  mix: 'text-brand-mix',
};

export function MallHubTile({
  variant = 'mix',
  size = 40,
  className = '',
}: {
  variant?: Variant;
  size?: number;
  className?: string;
}) {
  // SVG vectorial: M arriba-izquierda, H abajo-derecha, anillo central con
  // un punto. Todo escalado proporcionalmente a `size`.
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl shadow-[0_6px_18px_-6px_rgba(0,0,0,0.35)] ${TILE_BG[variant]} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        viewBox="0 0 40 40"
        className="text-fg-on-brand"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
      >
        {/* M esquina superior-izquierda */}
        <text
          x="6"
          y="17"
          fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
          fontWeight={900}
          fontSize={15}
          fill="currentColor"
          stroke="none"
          letterSpacing="-0.5"
        >
          M
        </text>
        {/* H esquina inferior-derecha */}
        <text
          x="22"
          y="34"
          fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
          fontWeight={900}
          fontSize={15}
          fill="currentColor"
          stroke="none"
          letterSpacing="-0.5"
        >
          H
        </text>
        {/* Anillo central — la "órbita" del hub */}
        <circle cx="20" cy="20" r="6.5" strokeWidth={1.2} opacity={0.55} />
        {/* Satélite */}
        <circle cx="26.5" cy="20" r="1.4" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

export function MallHubWordmark({
  variant = 'mix',
  size = 'md',
  className = '',
}: {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  // Wordmark con un satélite entre las palabras (referencia al hub).
  // tracking-tight para el peso black, salvo en sm donde lo dejamos más ancho.
  const fontSize =
    size === 'sm'
      ? 'text-sm'
      : size === 'lg'
        ? 'text-2xl'
        : size === 'xl'
          ? 'text-4xl sm:text-5xl'
          : 'text-base';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-black leading-none tracking-tight ${fontSize} ${WORD_COLOR[variant]} ${className}`}
    >
      <span>Mall</span>
      <span
        aria-hidden
        className={`inline-block rounded-full ${
          variant === 'admin'
            ? 'brand-admin'
            : variant === 'cliente'
              ? 'brand-cliente'
              : 'brand-mix'
        }`}
        style={{
          width: size === 'xl' ? 10 : size === 'lg' ? 8 : 6,
          height: size === 'xl' ? 10 : size === 'lg' ? 8 : 6,
        }}
      />
      <span>Hub</span>
    </span>
  );
}

export function MallHubBrand({
  variant = 'mix',
  tagline = 'Portal · Multi-mall · Stores',
  tileSize = 40,
  wordSize = 'md',
  className = '',
}: {
  variant?: Variant;
  tagline?: React.ReactNode;
  tileSize?: number;
  wordSize?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <MallHubTile variant={variant} size={tileSize} />
      <div className="flex flex-col leading-tight">
        <MallHubWordmark variant={variant} size={wordSize} />
        {tagline && (
          <span className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.28em] text-fg-subtle">
            {tagline}
          </span>
        )}
      </div>
    </div>
  );
}
