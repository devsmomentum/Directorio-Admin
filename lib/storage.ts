import { supabase } from './supabase';

const PUBLICIDAD_MARKER = '/publicidad/';

// Saca el path interno (campaigns/foo.mp4 ó coupons/bar.jpg) de una URL pública
// de Supabase. Devuelve null si la URL no apunta al bucket publicidad — así un
// cupón sin imagen o una URL externa simplemente se ignora sin romper el delete.
export function pathFromPublicidadUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const idx = url.indexOf(PUBLICIDAD_MARKER);
  if (idx < 0) return null;
  const tail = url.slice(idx + PUBLICIDAD_MARKER.length).split('?')[0];
  return tail || null;
}

// Borra del bucket `publicidad` el archivo apuntado por una URL pública.
// Silencia errores: el delete de la fila en DB es la fuente de verdad, y un
// archivo huérfano es preferible a abortar la operación del usuario.
export async function removePublicidadFile(url: string | null | undefined): Promise<void> {
  const path = pathFromPublicidadUrl(url);
  if (!path) return;
  await supabase.storage.from('publicidad').remove([path]);
}
