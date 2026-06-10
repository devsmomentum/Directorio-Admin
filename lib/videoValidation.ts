// Validación de compatibilidad de video para los kioscos Sunmi K2 Pro.
//
// El K2 monta un MediaTek MT6765 cuyo decodificador HW (OMX.rk.video_decoder.avc)
// solo levanta H.264 (AVC) 8-bit hasta ~1080p / Level 4.x. Un master 4K, HEVC,
// High-10, o un Level/bitrate alto hace que ExoPlayer NO logre inicializar el
// codec: la campaña nunca se reproduce y el kiosco cae al fondo por defecto
// (confirmado en logcat: "Format exceeds selected codec's capabilities" +
// "OMX/mediaserver died"). Esta utilidad corre en el navegador ANTES de subir
// y rechaza esos archivos en origen, para no descubrir el problema recién en el
// equipo físico.

export interface VideoCheckResult {
  ok: boolean;
  /** Mensaje listo para mostrar al usuario (es-LA). Presente cuando ok === false. */
  message?: string;
  info?: {
    width: number;
    height: number;
    durationSec: number;
    approxBitrateBps: number;
    codec: string | null; // 'h264' | 'hevc' | 'av1' | 'vp9' | 'vp8' | 'dolby-vision' | null
    profileIdc?: number;
    levelIdc?: number;
  };
}

// Límites del MT6765 (Sunmi K2 Pro). Ver memoria "project-hardware-target".
const MAX_LONG_EDGE = 1920; // borde largo (1080p en cualquier orientación)
const MAX_SHORT_EDGE = 1080; // borde corto
const MAX_LEVEL_IDC = 41; // H.264 Level 4.1 (cubre 1080p30/60 con holgura)
const MAX_BITRATE_BPS = 12_000_000; // 12 Mbps — tope de cordura
const PROBE_TIMEOUT_MS = 15_000;
const MAX_MOOV_BYTES = 24 * 1024 * 1024; // moov sano de un anuncio corto es pequeño

// ── Metadata reproducible vía elemento <video> ──────────────────────────────
// No lee el archivo completo: el navegador hace stream de solo la metadata.
function probeWithVideoElement(
  file: File,
): Promise<{ width: number; height: number; durationSec: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let settled = false;
    const finish = (
      r: { width: number; height: number; durationSec: number } | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      try {
        v.load();
      } catch {
        /* noop */
      }
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () =>
      finish({
        width: v.videoWidth,
        height: v.videoHeight,
        durationSec: v.duration,
      });
    v.onerror = () => finish(null);
    v.src = url;
  });
}

// ── Parseo mínimo del contenedor MP4/MOV para sacar el codec ────────────────
function readU32(b: Uint8Array, o: number): number {
  // El byte alto se multiplica (no <<24) para evitar resultados negativos.
  return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

async function readBytes(file: File, start: number, end: number): Promise<Uint8Array> {
  const buf = await file.slice(start, end).arrayBuffer();
  return new Uint8Array(buf);
}

// Camina los boxes de nivel superior leyendo solo las cabeceras (16 bytes) y
// saltando el 'mdat' por tamaño — así NO descargamos la pista de video (puede
// pesar cientos de MB) solo para validar. Devuelve los bytes del box 'moov'.
async function locateMoov(file: File): Promise<Uint8Array | null> {
  const size = file.size;
  let offset = 0;
  for (let guard = 0; guard < 2048 && offset + 8 <= size; guard++) {
    const head = await readBytes(file, offset, Math.min(offset + 16, size));
    if (head.length < 8) return null;
    let boxSize = readU32(head, 0);
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    let headerLen = 8;
    if (boxSize === 1) {
      // largesize de 64 bits
      if (head.length < 16) return null;
      boxSize = readU32(head, 8) * 0x100000000 + readU32(head, 12);
      headerLen = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset; // se extiende hasta EOF
    }
    if (boxSize < headerLen) return null; // box corrupto
    if (type === 'moov') {
      const end = Math.min(offset + boxSize, size);
      if (end - offset > MAX_MOOV_BYTES) return null; // defensivo
      return readBytes(file, offset, end);
    }
    offset += boxSize;
  }
  return null;
}

function indexOfFourCC(b: Uint8Array, fourcc: string, from = 0): number {
  const c0 = fourcc.charCodeAt(0);
  const c1 = fourcc.charCodeAt(1);
  const c2 = fourcc.charCodeAt(2);
  const c3 = fourcc.charCodeAt(3);
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] === c0 && b[i + 1] === c1 && b[i + 2] === c2 && b[i + 3] === c3) {
      return i;
    }
  }
  return -1;
}

function sniffCodec(moov: Uint8Array): {
  codec: string | null;
  profileIdc?: number;
  levelIdc?: number;
} {
  // HEVC / Dolby Vision / AV1 / VP9 / VP8 → incompatibles con el K2.
  if (
    indexOfFourCC(moov, 'hvcC') >= 0 ||
    indexOfFourCC(moov, 'hev1') >= 0 ||
    indexOfFourCC(moov, 'hvc1') >= 0
  ) {
    return { codec: 'hevc' };
  }
  if (indexOfFourCC(moov, 'dvhe') >= 0 || indexOfFourCC(moov, 'dvh1') >= 0) {
    return { codec: 'dolby-vision' };
  }
  if (indexOfFourCC(moov, 'av01') >= 0) return { codec: 'av1' };
  if (indexOfFourCC(moov, 'vp09') >= 0) return { codec: 'vp9' };
  if (indexOfFourCC(moov, 'vp08') >= 0) return { codec: 'vp8' };

  // H.264: leemos profile_idc / level_idc del box 'avcC'.
  // Layout: [size:4]['avcC':4][configurationVersion:1][profile_idc:1]
  //         [profile_compatibility:1][level_idc:1]...
  const avcc = indexOfFourCC(moov, 'avcC');
  if (avcc >= 0) {
    if (avcc + 8 <= moov.length) {
      return { codec: 'h264', profileIdc: moov[avcc + 5], levelIdc: moov[avcc + 7] };
    }
    return { codec: 'h264' };
  }
  if (indexOfFourCC(moov, 'avc1') >= 0 || indexOfFourCC(moov, 'avc3') >= 0) {
    return { codec: 'h264' };
  }
  return { codec: null };
}

/**
 * Valida que un archivo de video sea reproducible en el kiosco K2 Pro.
 * Pensada para llamarse en el handler del <input type="file"> antes de subir.
 * Conservadora: si el parseo del codec falla, NO bloquea por esa vía y se apoya
 * en las dimensiones/bitrate; solo rechaza cuando detecta algo positivamente
 * incompatible.
 */
export async function validateKioskVideo(file: File): Promise<VideoCheckResult> {
  // 1) Metadata reproducible (dimensiones + duración).
  const meta = await probeWithVideoElement(file);
  if (!meta || !meta.width || !meta.height) {
    // El navegador no pudo leer el video → formato/codec casi seguro no
    // soportado (típico de HEVC/H.265 o un MP4 raro).
    return {
      ok: false,
      message:
        'No pudimos leer este video. Súbelo en MP4 con video H.264 (AVC) y audio AAC. Evita HEVC/H.265 y archivos 4K.',
    };
  }

  const longEdge = Math.max(meta.width, meta.height);
  const shortEdge = Math.min(meta.width, meta.height);
  const durationSec =
    isFinite(meta.durationSec) && meta.durationSec > 0 ? meta.durationSec : 0;
  const approxBitrateBps =
    durationSec > 0 ? Math.round((file.size * 8) / durationSec) : 0;

  // 2) Codec (solo contenedores tipo MP4/MOV; webm cae a null sin bloquear).
  let codecInfo: { codec: string | null; profileIdc?: number; levelIdc?: number } = {
    codec: null,
  };
  try {
    const moov = await locateMoov(file);
    if (moov) codecInfo = sniffCodec(moov);
  } catch {
    // Parseo best-effort: un fallo aquí no debe impedir subir un archivo válido.
  }

  const info = {
    width: meta.width,
    height: meta.height,
    durationSec,
    approxBitrateBps,
    ...codecInfo,
  };

  // 3) Reglas de compatibilidad del MT6765.
  if (codecInfo.codec && codecInfo.codec !== 'h264') {
    return {
      ok: false,
      info,
      message: `Códec no compatible (${codecInfo.codec.toUpperCase()}). El kiosco solo reproduce H.264 (AVC). Re-exporta el video como MP4 / H.264.`,
    };
  }
  if (codecInfo.profileIdc !== undefined && codecInfo.profileIdc >= 110) {
    return {
      ok: false,
      info,
      message:
        'Perfil de video no compatible (10-bit / 4:2:2 / 4:4:4). Exporta en H.264 perfil Main o High de 8 bits (4:2:0).',
    };
  }
  if (longEdge > MAX_LONG_EDGE || shortEdge > MAX_SHORT_EDGE) {
    return {
      ok: false,
      info,
      message: `Resolución ${meta.width}×${meta.height} demasiado alta. El máximo es 1080p (1920×1080 horizontal o 1080×1920 vertical). Si es 4K, re-expórtalo a 1080p.`,
    };
  }
  if (codecInfo.levelIdc !== undefined && codecInfo.levelIdc > MAX_LEVEL_IDC) {
    return {
      ok: false,
      info,
      message: `Nivel H.264 demasiado alto (Level ${(codecInfo.levelIdc / 10).toFixed(1)}). Exporta a 1080p 30fps para que quede en Level 4.0–4.1.`,
    };
  }
  if (approxBitrateBps > MAX_BITRATE_BPS) {
    return {
      ok: false,
      info,
      message: `Bitrate muy alto (~${(approxBitrateBps / 1e6).toFixed(1)} Mbps). Mantén el video por debajo de 12 Mbps (recomendado 4–8 Mbps a 1080p).`,
    };
  }

  return { ok: true, info };
}
