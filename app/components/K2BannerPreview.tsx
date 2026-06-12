'use client';

import { useState } from 'react';

// Replica el layout real del K2 Pro (1080×1920 portrait).
//
// Comportamiento Flutter verificado en screen_ad_banners.dart + safe_network_image.dart:
//   VIDEO → SizedBox.expand + FittedBox(BoxFit.cover)
//           El video LLENA toda la franja (ancho y alto). CSS: object-fit cover.
//   IMAGEN → SafeNetworkImage envuelve la Image en un AnimatedSwitcher (fadeIn);
//            su Stack pasa constraints SUELTAS, así que la Image se dimensiona
//            conservando su aspect-ratio DENTRO de la franja (efecto contain),
//            centrada sobre el fondo negro del Container. El BoxFit.cover nunca
//            recorta porque la caja resultante ya tiene el AR de la imagen.
//            → Una imagen que no sea 5.625:1 (1080×192) muestra bordes negros
//            a los lados (o arriba/abajo si es ultra-panorámica).
//            CSS: object-fit contain sobre fondo negro.
//
// AppColors Flutter: background #000 · surface #111 · primary #0707DD · secondary #74BD26

const GRAD_LR = 'linear-gradient(to right, #0707DD, #74BD26)';
const GRAD_NEON = 'linear-gradient(to right, transparent, #0707DD 35%, #74BD26 65%, transparent)';

export default function K2BannerPreview({
  src,
  type,
  position = 'top',
  previewWidth = 160,
}: {
  src: string;
  type: 'image' | 'video';
  position?: 'top' | 'bottom';
  previewWidth?: number;
}) {
  const [mediaErr, setMediaErr] = useState(false);

  const previewH = Math.round(previewWidth * (1920 / 1080));
  const bannerH = Math.round(previewH * 0.1);               // 10% — franja banner
  const barH = Math.round(previewH * (72 / 1920));          // header y nav (72px nativos)
  const contentH = previewH - bannerH * 2 - barH * 2;

  const hasMedia = !mediaErr && !!src;

  // Franja del banner con el comportamiento real de Flutter
  function bannerSlot(active: boolean) {
    if (!active || !hasMedia) {
      // Placeholder Flutter: gradiente oscuro + círculos decorativos
      return (
        <div
          className="w-full h-full relative overflow-hidden"
          style={{ background: 'linear-gradient(135deg,#181818 0%,#2A2A2A 100%)' }}
        >
          <div
            className="absolute rounded-full pointer-events-none"
            style={{ left: '-8%', top: '-30%', width: '40%', height: '120%', background: 'rgba(255,64,129,0.12)' }}
          />
          <div
            className="absolute rounded-full pointer-events-none"
            style={{ right: '-10%', bottom: '-30%', width: '45%', height: '120%', background: 'rgba(255,152,0,0.10)' }}
          />
        </div>
      );
    }

    if (type === 'video') {
      // Flutter: SizedBox.expand + FittedBox(BoxFit.cover) → llena ANCHO y ALTO
      return (
        <video
          src={src}
          className="w-full h-full object-cover"
          muted
          autoPlay
          loop
          playsInline
          onError={() => setMediaErr(true)}
        />
      );
    }

    // Imagen: en el K2 la franja muestra la imagen completa conservando su
    // aspect-ratio, centrada sobre negro (ver nota del encabezado). Solo un
    // archivo 5.625:1 llena la franja sin bordes.
    return (
      <div className="w-full h-full" style={{ background: '#000' }}>
        <img
          src={src}
          alt=""
          className="w-full h-full object-contain"
          onError={() => setMediaErr(true)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1.5 shrink-0">
      <div
        className="overflow-hidden rounded-lg border border-white/10 shadow-xl shadow-black/60"
        style={{ width: previewWidth, height: previewH, background: '#000000' }}
      >
        {/* ── TOP BANNER ── */}
        <div className="overflow-hidden" style={{ height: bannerH }}>
          {bannerSlot(position === 'top')}
        </div>

        {/* ── HEADER ── */}
        <div
          className="relative flex items-center gap-0.5 px-1.5 overflow-hidden"
          style={{ height: barH, background: '#111111' }}
        >
          <div className="absolute inset-x-0 top-0 pointer-events-none" style={{ height: 1, background: GRAD_LR }} />
          <div
            className="shrink-0 rounded-sm bg-white/20"
            style={{ width: Math.max(3, barH * 0.38), height: Math.max(3, barH * 0.38) }}
          />
          <span className="font-black text-white leading-none ml-px shrink-0" style={{ fontSize: Math.max(4, barH * 0.36) }}>
            MM
          </span>
          <div className="flex-1" />
          <span className="text-white/30 leading-none font-mono shrink-0" style={{ fontSize: Math.max(3, barH * 0.26) }}>
            12:00
          </span>
          <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: 1, background: GRAD_LR }} />
        </div>

        {/* ── CONTENIDO PRINCIPAL ── */}
        <div style={{ height: contentH, background: '#050505' }} />

        {/* ── BOTTOM NAV ── */}
        <div
          className="relative flex items-center justify-around px-1.5 overflow-hidden"
          style={{ height: barH, background: '#111111' }}
        >
          <div className="absolute inset-x-1.5 top-0 pointer-events-none" style={{ height: 1, background: GRAD_NEON }} />
          {[0, 1, 2, 3, 4].map(i => (
            <div
              key={i}
              className="rounded-full bg-white/20"
              style={{ width: Math.max(2, barH * 0.22), height: Math.max(2, barH * 0.22) }}
            />
          ))}
        </div>

        {/* ── BOTTOM BANNER ── */}
        <div className="overflow-hidden" style={{ height: bannerH }}>
          {bannerSlot(position === 'bottom')}
        </div>
      </div>

      <p className="text-[8px] font-mono text-white/25 flex items-center gap-1">
        <span>K2 Pro 1080×1920</span>
        <span className="text-white/10">·</span>
        <span className={position === 'top' ? 'text-cyan-400/60' : 'text-amber-400/60'}>
          {position === 'top' ? '▲ top 10%' : '▼ bottom 10%'}
        </span>
      </p>
    </div>
  );
}
