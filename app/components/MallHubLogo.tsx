'use client';

import React, { useState } from 'react';

// Marca Mall Hub. Se compone del SÍMBOLO real (la "M" en gradiente Morna, vive
// en /public/simbolo.png — se ve bien sobre cualquier fondo) + el wordmark
// "MALL HUB" recreado con el gradiente de marca, porque el texto del logo
// original es negro y sería ilegible sobre el morado oscuro del tema.
//   - MallHubMark: solo el símbolo (topbar móvil / espacios compactos).
//   - MallHubLogo: símbolo + wordmark "MALL HUB" (+ subtítulo opcional).

export const MARK_SRC = '/simbolo.png';

export function MallHubMark({
  size = 40,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        className={`brand-mix inline-flex shrink-0 items-center justify-center rounded-xl font-black text-fg-on-brand ${className}`}
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        aria-hidden
      >
        M
      </span>
    );
  }

  return (
    <img
      src={MARK_SRC}
      alt="Mall Hub"
      style={{ width: size, height: size }}
      className={`block shrink-0 select-none object-contain ${className}`}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

const WORD_SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-xs',
  md: 'text-lg',
  lg: 'text-2xl',
};

export function MallHubLogo({
  markSize = 38,
  wordSize = 'md',
  subtitle = 'Directory',
  className = '',
}: {
  markSize?: number;
  wordSize?: 'sm' | 'md' | 'lg';
  subtitle?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <MallHubMark size={markSize} className="drop-shadow-[0_0_14px_rgba(228,18,240,0.35)]" />
      <div className="flex flex-col leading-none">
        <span
          className={`text-brand-mix brand-animate font-black tracking-tight ${WORD_SIZE[wordSize]}`}
        >
          MALL&nbsp;HUB
        </span>
        {subtitle && (
          <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.3em] text-fg-subtle">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}
