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

// Sube un archivo al bucket público `publicidad` y devuelve su URL pública.
// `path` es la ruta interna, p.ej. `campaigns/camp_123.mp4` o `logos/x.png`.
export async function uploadPublicidad(file: File, path: string): Promise<string> {
  const { error } = await supabase.storage
    .from('publicidad')
    .upload(path, file, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('publicidad').getPublicUrl(path);
  return data.publicUrl;
}

// ── Documentos legales privados (bucket `documentos`) ───────────────────────
// Antes duplicados verbatim en panel/clientes y panel/tiendas.

// Sube un documento al bucket privado `documentos` y devuelve solo el path.
export async function uploadPrivateDoc(file: File, path: string): Promise<string> {
  const { error } = await supabase.storage
    .from('documentos')
    .upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}

// Genera una URL firmada de 60s y abre el documento en una pestaña nueva.
export async function openPrivateDoc(path: string): Promise<void> {
  const { data, error } = await supabase.storage
    .from('documentos')
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) {
    alert('No se pudo abrir el documento.');
    return;
  }
  window.open(data.signedUrl, '_blank');
}

// Igual que openPrivateDoc pero fuerza la descarga con un nombre amigable.
export async function downloadPrivateDoc(path: string, filename: string): Promise<void> {
  const { data, error } = await supabase.storage
    .from('documentos')
    .createSignedUrl(path, 60, { download: filename });
  if (error || !data?.signedUrl) {
    alert('No se pudo descargar el documento.');
    return;
  }
  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Extensión (con punto) de un path de storage, p.ej. ".pdf". Cadena vacía si no hay.
export function fileExt(path: string): string {
  const m = String(path || '').match(/\.[a-z0-9]+$/i);
  return m ? m[0] : '';
}
