'use client';

import { useState } from 'react';

// Réplica del home_screen.dart del K2 Pro (1080×1920, 9:16 vertical) — la
// pantalla donde se reproducen las campañas. El kiosco muestra el media a
// pantalla completa con BoxFit.cover y superpone UI fija: logo Millennium,
// badge de slot, nombre de marca, descripción, info WiFi/QR, botón COMENZAR y
// footer. Un archivo que no sea 9:16 recorta bordes — igual que en el equipo.
//
// Mismo patrón que K2BannerPreview: todo escala desde `width` (diseño base
// 200px) para verse nítido a cualquier tamaño. Así el preview del cliente y el
// del admin (al revisar la solicitud) son idénticos pixel a pixel.

export default function K2CampaignPreview({
  src,
  type,
  brandName,
  description,
  width = 200,
}: {
  src: string;
  type: 'image' | 'video';
  brandName?: string;
  description?: string;
  width?: number;
}) {
  const [mediaErr, setMediaErr] = useState(false);
  const s = width / 200;                       // factor de escala vs. diseño base
  const f = (n: number) => `${(n * s).toFixed(2)}px`;
  const hasMedia = !mediaErr && !!src;

  return (
    <div
      className="shrink-0 relative rounded-xl overflow-hidden bg-black border border-white/15 shadow-lg"
      style={{ width, aspectRatio: '9 / 16' }}
    >
      {/* 1. Media a pantalla completa con cover (igual al kiosco real) */}
      {hasMedia ? (
        type === 'video' ? (
          <video
            key={src}
            src={src}
            className="absolute inset-0 w-full h-full object-cover bg-black"
            autoPlay
            muted
            loop
            playsInline
            controls
            preload="metadata"
            onError={() => setMediaErr(true)}
          />
        ) : (
          <img
            src={src}
            alt="preview"
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setMediaErr(true)}
          />
        )
      ) : (
        <div
          className="absolute inset-0 flex items-center justify-center text-white/30"
          style={{ fontSize: f(8) }}
        >
          Sin archivo
        </div>
      )}

      {/* 2. Gradiente vertical (top transparente → bottom oscuro) */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-transparent via-black/30 to-black/85" />

      {/* 3. Logo Millennium (top-right, ~5% de alto) */}
      <div
        className="absolute bg-black/45 border border-white/20 rounded font-black tracking-widest text-white/80 leading-none"
        style={{ top: f(6), right: f(8), padding: `${f(2)} ${f(6)}`, fontSize: f(7) }}
      >
        MM
      </div>

      {/* 4. Bloque inferior: badge + marca + descripción + WiFi/QR + CTA + footer */}
      <div
        className="absolute left-0 right-0 flex flex-col items-start"
        style={{ bottom: f(8), paddingLeft: f(10), paddingRight: f(10), gap: f(4) }}
      >
        <span
          className="font-bold tracking-widest text-white bg-white/10 border border-white/20 rounded-full leading-none"
          style={{ fontSize: f(7), padding: `${f(2)} ${f(6)}` }}
        >
          📍 SLOT
        </span>
        <p
          className="font-black text-white leading-tight truncate max-w-full"
          style={{ fontSize: f(11) }}
        >
          {brandName?.trim() || 'Tu marca'}
        </p>
        <p
          className="text-white/75 leading-tight line-clamp-2 max-w-full"
          style={{ fontSize: f(8) }}
        >
          {description?.trim() || 'Toca para explorar el mall'}
        </p>
        <div className="flex items-center" style={{ marginTop: f(2), gap: f(4) }}>
          <span
            className="font-mono text-white/60 bg-white/10 border border-white/15 rounded leading-none"
            style={{ fontSize: f(6), padding: `${f(2)} ${f(4)}` }}
          >
            📶 WIFI
          </span>
          <span
            className="font-mono text-white/60 bg-white/10 border border-white/15 rounded leading-none"
            style={{ fontSize: f(6), padding: `${f(2)} ${f(4)}` }}
          >
            QR
          </span>
        </div>
        <button
          type="button"
          disabled
          className="w-full bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-black tracking-widest rounded-md shadow leading-none"
          style={{ marginTop: f(4), fontSize: f(8), paddingTop: f(4), paddingBottom: f(4) }}
        >
          COMENZAR ▸
        </button>
        <span
          className="text-white/40 tracking-wider leading-none"
          style={{ fontSize: f(6), marginTop: f(2) }}
        >
          Millennium Mall · Anavi
        </span>
      </div>

      {/* 5. Marca de aspecto */}
      <span
        className="absolute font-mono bg-black/65 text-white/75 rounded leading-none"
        style={{ top: f(6), left: f(6), fontSize: f(8), padding: `${f(2)} ${f(6)}` }}
      >
        9:16
      </span>
    </div>
  );
}
