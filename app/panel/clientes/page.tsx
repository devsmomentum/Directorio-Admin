'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { uploadPrivateDoc, openPrivateDoc, downloadPrivateDoc, fileExt } from '../../../lib/storage';

// ─────────────────────────────────────────────────────────────────────────────
// /panel/clientes — gestión de usuarios cliente del portal.
//
// Responsabilidades:
//   - CRUD de la "identidad" del cliente: nombre, cédula, correo personal,
//     teléfono. La fila vive en public.users con role='cliente'. El auth.user
//     correspondiente se crea vía edge function send-magic-link (channel='none')
//     en el primer guardado (idempotente: si ya existe, no hace nada).
//   - Vincular / desvincular tiendas (N:M). Reusa la RPC admin_link_store_user.
//   - Envío de magic-link de invitación: por correo o WhatsApp. Reusa la edge
//     function send-magic-link.
//
// Lo que NO se hace aquí: el form de /panel/tiendas pasa a ser solo read-only
// para el usuario vinculado; cualquier alta/edición de cliente o envío de link
// ocurre acá.
// ─────────────────────────────────────────────────────────────────────────────

type ClientRow = {
  id: string;
  email: string;
  full_name: string | null;
  doc_tipo: string | null;
  cedula_numero: string | null;
  cedula_url: string | null;
  telefono_personal: string | null;
  created_at: string;
};

// Límites de caracteres por campo para prevenir inyección SQL
const MAX_LEN = {
  email: 120,
  fullName: 100,
  cedula: 15,
  telefono: 20,
} as const;

// Límites mínimos
const MIN_LEN = {
  fullName: 2,
  cedula: 6,
} as const;

// Validación de email: RFC simplificada — local@dominio.tld con TLD ≥ 2
// caracteres. No aceptamos espacios ni caracteres de control. Es estricta a
// propósito: el correo se usa como login y como key en public.users.
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Valida formato de teléfono: debe empezar con +código de país.
// 1-4 dígitos de código + 6-15 dígitos significativos (E.164 permite hasta 15).
const PHONE_REGEX = /^\+\d{1,4}\s?\d[\d\s-]{5,18}$/;

// Nombre: letras (incluye acentos / ñ), espacios, apóstrofo, guión, punto.
// Bloquea HTML, números, símbolos peligrosos y caracteres de control.
const NAME_REGEX = /^[\p{L}][\p{L}\p{M}\s'\-.]*[\p{L}.]$/u;

// Quita caracteres de control (C0, DEL, C1, zero-width, bidi overrides) y
// normaliza espacios múltiples a uno. Aplicar a TODOS los strings que se
// persisten. Defensa contra ataques tipo Trojan Source y bypass de filtros
// por caracteres invisibles.
function sanitizeString(input: string): string {
  return input
    // NFC normaliza acentos compuestos vs precompuestos (defensa contra
    // bypasses de validación con homoglyphs/combiners).
    .normalize('NFC')
    // Control chars: C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F),
    // zero-width (200B-200D, FEFF), bidi overrides (202A-202E, 2066-2069).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Convierte +58XXXXXXXXXX → 0XXXXXXXXXX para guardar en BD
function phoneForDb(raw: string): string {
  const clean = raw.replace(/[\s-]/g, '');
  if (clean.startsWith('+58')) return '0' + clean.slice(3);
  return clean;
}

// Para mostrar en la tabla: si empieza con 0 y tiene 11 dígitos, es +58
function phoneForDisplay(stored: string | null): string {
  if (!stored) return '—';
  return stored;
}

type StoreLite = { id: string; name: string };

export default function ClientesPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [stores, setStores] = useState<StoreLite[]>([]);
  const [storesByClient, setStoresByClient] = useState<Record<string, StoreLite[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  // Cliente cuyo detalle (solo lectura) se muestra al hacer clic en su nombre.
  const [detailClient, setDetailClient] = useState<ClientRow | null>(null);

  // form state
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ClientRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [docTipo, setDocTipo] = useState<'V' | 'E'>('V');
  const [cedula, setCedula] = useState('');
  const [telefono, setTelefono] = useState('');
  const [cedulaFile, setCedulaFile] = useState<File | null>(null);
  const [cedulaUrl, setCedulaUrl] = useState('');
  const [pickedStoreIds, setPickedStoreIds] = useState<string[]>([]);
  const [storeSearch, setStoreSearch] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  // invite/setInvite quedó deshabilitado al mover el envío del enlace WhatsApp
  // a la tabla de clientes. Lo dejamos comentado para reactivarlo si vuelve a
  // exponerse el flujo de envío por correo desde el form.
  // const [invite, setInvite] = useState<{ state: 'idle' | 'sending' | 'sent' | 'error'; msg: string }>({ state: 'idle', msg: '' });

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setRefreshing(true);
    const [clientsRes, storesRes, linksRes] = await Promise.all([
      supabase
        .from('users')
        .select('id, email, full_name, doc_tipo, cedula_numero, cedula_url, telefono_personal, created_at')
        .eq('role', 'cliente')
        .order('created_at', { ascending: false }),
      supabase
        .from('stores')
        .select('id, name')
        .order('name', { ascending: true }),
      supabase
        .from('user_stores')
        .select('user_id, store_id'),
    ]);

    const clientList = (clientsRes.data ?? []) as ClientRow[];
    const storeList = (storesRes.data ?? []) as StoreLite[];
    const links = linksRes.data ?? [];

    setClients(clientList);
    setStores(storeList);

    // Index tiendas por cliente para mostrar chips en la tabla.
    const storesById = new Map(storeList.map(s => [s.id, s]));
    const map: Record<string, StoreLite[]> = {};
    for (const l of links) {
      const s = storesById.get(l.store_id);
      if (!s) continue;
      (map[l.user_id] ||= []).push(s);
    }
    setStoresByClient(map);
    setLoading(false);
    setRefreshing(false);
  };

  const openCreate = () => {
    setEditing(null);
    setEmail('');
    setFullName(''); setDocTipo('V'); setCedula(''); setTelefono('');
    setCedulaFile(null); setCedulaUrl('');
    setPickedStoreIds([]);
    setStoreSearch('');
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (c: ClientRow) => {
    setEditing(c);
    setEmail(c.email);
    setFullName(c.full_name ?? '');
    setDocTipo((c.doc_tipo as 'V' | 'E') ?? 'V');
    setCedula(c.cedula_numero ?? '');
    setCedulaUrl(c.cedula_url ?? '');
    setCedulaFile(null);
    setTelefono(c.telefono_personal ? phoneForDisplay(c.telefono_personal) : '');
    setPickedStoreIds((storesByClient[c.id] ?? []).map(s => s.id));
    setStoreSearch('');
    setFormError(null);
    setShowForm(true);
  };

  const resetForm = () => {
    setShowForm(false);
    setEditing(null);
    setSubmitting(false);
  };

  // Eliminar cliente: borra el auth.user (cascade a public.users y user_stores).
  // Requiere la edge function o el service_role; como el admin tiene policy
  // admin_write, eliminamos la fila de public.users y dejamos que el trigger
  // on_delete_cascade se encargue. Si no hay cascade, se usa deleteUser.
  const handleDeleteClient = async (c: ClientRow) => {
    const linkedStores = storesByClient[c.id] ?? [];
    const storeNames = linkedStores.map(s => s.name).join(', ');
    const msg = linkedStores.length > 0
      ? `¿Eliminar al cliente "${c.full_name || c.email}"?\n\nTiene ${linkedStores.length} tienda(s) vinculada(s): ${storeNames}.\nSe desvincularán automáticamente.`
      : `¿Eliminar al cliente "${c.full_name || c.email}"?\n\nEsta acción no se puede deshacer.`;

    if (!confirm(msg)) return;

    try {
      // Primero desvincular tiendas
      for (const s of linkedStores) {
        await supabase.rpc('admin_unlink_store_user', {
          p_user_id: c.id,
          p_store_id: s.id,
        });
      }
      // Eliminar de public.users (cascade desde auth.users manejado por FK)
      const { error } = await supabase.from('users').delete().eq('id', c.id);
      if (error) throw error;
      await fetchAll();
    } catch {
      // No mostramos err.message: Supabase puede incluir referencias internas
      // (URL/host de la BD, IDs) en el texto del error.
      alert('No se pudo eliminar el cliente. Intenta nuevamente.');
    }
  };

  // Crea o actualiza al cliente. Pasos:
  //   1) Si NO existe en public.users con este email, llama a la edge function
  //      send-magic-link (channel='none', profile={...}) que crea el auth.user
  //      e inserta el perfil. La función es idempotente; si ya existía solo
  //      actualiza el perfil.
  //   2) Si existe (editando), actualiza directamente public.users.
  //   3) Reconcilia user_stores: vincula los store_ids elegidos y desvincula
  //      los que estaban antes y ya no están.
  const validateDoc = (file: File): boolean => {
    if (file.size > 2 * 1024 * 1024) { alert('El documento debe pesar menos de 2 MB.'); return false; }
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) {
      alert('Solo se admiten PDF, JPG o PNG.'); return false;
    }
    return true;
  };

  const handleSave = async () => {
    setFormError(null);

    // sanitizeString aplica NFC + quita control chars / zero-width / bidi
    // overrides + colapsa espacios. Después aplicamos validaciones de formato.
    const cleanEmail = sanitizeString(email).toLowerCase();
    const cleanName = sanitizeString(fullName);
    const cleanCedula = sanitizeString(cedula);
    const cleanTelefono = sanitizeString(telefono);

    // ── Correo ──
    if (!cleanEmail) return setFormError('El correo es obligatorio.');
    if (cleanEmail.length > MAX_LEN.email) return setFormError(`El correo no puede exceder ${MAX_LEN.email} caracteres.`);
    if (!EMAIL_REGEX.test(cleanEmail)) return setFormError('Formato de correo inválido. Ejemplo: nombre@dominio.com');

    // ── Nombre ──
    if (!cleanName) return setFormError('El nombre es obligatorio.');
    if (cleanName.length < MIN_LEN.fullName) return setFormError(`El nombre debe tener al menos ${MIN_LEN.fullName} caracteres.`);
    if (cleanName.length > MAX_LEN.fullName) return setFormError(`El nombre no puede exceder ${MAX_LEN.fullName} caracteres.`);
    if (!NAME_REGEX.test(cleanName)) return setFormError('El nombre solo puede contener letras, espacios, guiones, apóstrofos y puntos.');

    // ── Documento de identidad: solo enteros ──
    if (cleanCedula) {
      if (!/^\d+$/.test(cleanCedula)) return setFormError('El documento de identidad debe contener solo números.');
      if (cleanCedula.length < MIN_LEN.cedula) return setFormError(`El documento debe tener al menos ${MIN_LEN.cedula} dígitos.`);
      if (cleanCedula.length > MAX_LEN.cedula) return setFormError(`El documento no puede exceder ${MAX_LEN.cedula} dígitos.`);
    }

    // ── Teléfono: debe empezar con +código de país ──
    if (cleanTelefono) {
      if (!cleanTelefono.startsWith('+')) return setFormError('El teléfono debe empezar con + y el código de país (ej: +58, +1, +34).');
      if (!PHONE_REGEX.test(cleanTelefono)) return setFormError('Formato de teléfono inválido. Ejemplo: +58 4141234567');
      if (cleanTelefono.length > MAX_LEN.telefono) return setFormError(`El teléfono no puede exceder ${MAX_LEN.telefono} caracteres.`);
    }
    // Valor a persistir en BD: +58 → 0...
    const telefonoDb = cleanTelefono ? phoneForDb(cleanTelefono) : null;

    setSubmitting(true);

    try {
      // ── Unicidad: documento, teléfono, correo ──
      const currentId = editing?.id ?? null;

      if (cleanCedula) {
        const { data: dupDoc } = await supabase
          .from('users')
          .select('id')
          .eq('role', 'cliente')
          .eq('doc_tipo', docTipo)
          .eq('cedula_numero', cleanCedula)
          .maybeSingle();
        if (dupDoc && dupDoc.id !== currentId) {
          throw new Error(`Ya existe un cliente con documento ${docTipo}-${cleanCedula}.`);
        }
      }

      if (telefonoDb) {
        const { data: dupTel } = await supabase
          .from('users')
          .select('id')
          .eq('role', 'cliente')
          .eq('telefono_personal', telefonoDb)
          .maybeSingle();
        if (dupTel && dupTel.id !== currentId) {
          throw new Error('Ya existe un cliente con ese número de teléfono.');
        }
      }

      if (!editing && cleanEmail) {
        const { data: dupEmail } = await supabase
          .from('users')
          .select('id')
          .eq('email', cleanEmail)
          .maybeSingle();
        if (dupEmail) {
          throw new Error('Ya existe un usuario con ese correo electrónico.');
        }
      }



      let userId = currentId;
      
      if (cedulaFile) {
        const isValid = validateDoc(cedulaFile);
        if (!isValid) { setSubmitting(false); return; }
      }

      let finalCedulaUrl = cedulaUrl;
      if (cedulaFile) {
        const ext = cedulaFile.name.split('.').pop();
        const cleanEmailEscaped = cleanEmail.replace(/[^a-zA-Z0-9]/g, '_');
        const p = `cedulas/cedula_${cleanEmailEscaped}_${Date.now()}.${ext}`;
        finalCedulaUrl = await uploadPrivateDoc(cedulaFile, p);
      }

      if (!userId) {
        // Crear el auth.user vía edge function (channel='none' no envía nada).
        const { data, error } = await supabase.functions.invoke('send-magic-link', {
          body: {
            email: cleanEmail,
            channel: 'none',
            profile: {
              full_name: cleanName,
              cedula_numero: cleanCedula || null,
              telefono_personal: telefonoDb,
            },
          },
        });
        if (error || (data as any)?.error) {
          throw new Error((data as any)?.error ?? error?.message ?? 'No se pudo crear el cliente.');
        }
        // Obtener el id del user recién creado.
        const { data: u } = await supabase
          .from('users')
          .select('id')
          .eq('email', cleanEmail)
          .maybeSingle();
        if (!u?.id) throw new Error('El cliente se creó pero no se pudo leer su id (¿RLS?).');
        userId = u.id;

        // Guardar doc_tipo y cedula_url
        await supabase.from('users').update({ 
          doc_tipo: docTipo,
          cedula_url: finalCedulaUrl || null
        }).eq('id', userId);
      } else {
        // Editar: UPDATE directo en public.users.
        const { error } = await supabase
          .from('users')
          .update({
            full_name: cleanName,
            doc_tipo: docTipo,
            cedula_numero: cleanCedula || null,
            cedula_url: finalCedulaUrl || null,
            telefono_personal: telefonoDb,
          })
          .eq('id', userId);
        if (error) throw error;
      }

      // Reconciliar vínculos de tienda.
      if (!userId) throw new Error('No se pudo determinar el id del cliente.');
      const resolvedUserId: string = userId;
      const current = new Set<string>(
        (storesByClient[resolvedUserId] ?? []).map((s: StoreLite) => s.id),
      );
      const picked = new Set<string>(pickedStoreIds);

      const toLink: string[] = [...picked].filter(id => !current.has(id));
      const toUnlink: string[] = [...current].filter(id => !picked.has(id));

      for (const storeId of toLink) {
        const { error } = await supabase.rpc('admin_link_store_user', {
          p_email: cleanEmail,
          p_store_id: storeId,
          p_full_name: cleanName,
          p_cedula_numero: cleanCedula || null,
          p_telefono_personal: telefonoDb,
        });
        if (error) throw error;
      }
      for (const storeId of toUnlink) {
        const { error } = await supabase.rpc('admin_unlink_store_user', {
          p_user_id: resolvedUserId,
          p_store_id: storeId,
        });
        if (error) throw error;
      }

      await fetchAll();
      resetForm();
    } catch (err: any) {
      setFormError(err.message || 'Error al guardar.');
      setSubmitting(false);
    }
  };

  // Envío de magic link desde la fila de cada cliente en la tabla. Reusa la
  // edge function send-magic-link. Se confirma con el admin antes de invocarla
  // para evitar disparos accidentales. Las confirmaciones y el resultado se
  // muestran en un modal de la app (no se usa confirm/alert del navegador).
  const [sendingLinkFor, setSendingLinkFor] = useState<{ id: string; channel: 'whatsapp' | 'email' } | null>(null);

  type LinkDialog =
    | { kind: 'confirm'; channel: 'whatsapp' | 'email'; client: ClientRow }
    | { kind: 'result'; tone: 'success' | 'error'; title: string; message: string };
  const [linkDialog, setLinkDialog] = useState<LinkDialog | null>(null);

  const openSendDialog = (channel: 'whatsapp' | 'email', c: ClientRow) => {
    if (channel === 'whatsapp' && !c.telefono_personal) {
      setLinkDialog({
        kind: 'result',
        tone: 'error',
        title: 'Sin teléfono registrado',
        message: 'Este cliente no tiene teléfono. Edítalo y agrega un número antes de enviar el enlace por WhatsApp.',
      });
      return;
    }
    setLinkDialog({ kind: 'confirm', channel, client: c });
  };

  const confirmSendLink = async () => {
    if (!linkDialog || linkDialog.kind !== 'confirm') return;
    const { channel, client: c } = linkDialog;
    const tel = c.telefono_personal ?? '';

    setSendingLinkFor({ id: c.id, channel });
    setLinkDialog(null);

    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const { data, error } = await supabase.functions.invoke('send-magic-link', {
      body: {
        email: c.email,
        phone: channel === 'whatsapp' ? tel : undefined,
        channel,
        redirectTo: `${origin}/auth/callback`,
        profile: {
          full_name: c.full_name || null,
          cedula_numero: c.cedula_numero || null,
          telefono_personal: tel || null,
        },
      },
    });
    setSendingLinkFor(null);

    if (error || (data as any)?.error) {
      // No exponemos data.error / error.message: pueden contener referencias
      // internas (URL de la edge function, IDs, etc.).
      setLinkDialog({
        kind: 'result',
        tone: 'error',
        title: channel === 'whatsapp' ? 'No se pudo enviar por WhatsApp' : 'No se pudo enviar por correo',
        message: 'Intenta nuevamente en unos minutos. Si persiste, contacta al equipo técnico.',
      });
      return;
    }
    setLinkDialog({
      kind: 'result',
      tone: 'success',
      title: 'Enlace enviado',
      message: channel === 'whatsapp'
        ? `Se envió el enlace por WhatsApp a ${tel}.`
        : `Se envió el enlace de acceso al correo ${c.email}.`,
    });
  };

  // ────────────────────────────────────────────────────────────────────────
  // Envío de magic link desde el formulario de edición.
  // El botón de correo está temporalmente deshabilitado (ver más abajo en el
  // JSX); por ahora solo se conserva el flujo para WhatsApp si se reactivara.
  // ────────────────────────────────────────────────────────────────────────
  // const sendLink = async (channel: 'email' | 'whatsapp') => {
  //   if (!editing) {
  //     setInvite({ state: 'error', msg: 'Guarda el cliente antes de enviar el enlace.' });
  //     return;
  //   }
  //   if (channel === 'whatsapp' && !telefono.trim()) {
  //     setInvite({ state: 'error', msg: 'Necesitas un teléfono para WhatsApp.' });
  //     return;
  //   }
  //   setInvite({ state: 'sending', msg: '' });
  //   const origin = typeof window !== 'undefined' ? window.location.origin : '';
  //   const cleanTel = telefono.trim();
  //   const { data, error } = await supabase.functions.invoke('send-magic-link', {
  //     body: {
  //       email: editing.email,
  //       phone: channel === 'whatsapp' ? cleanTel : undefined,
  //       channel,
  //       redirectTo: `${origin}/auth/callback`,
  //       profile: {
  //         full_name: fullName.trim() || null,
  //         cedula_numero: cedula || null,
  //         telefono_personal: cleanTel ? phoneForDb(cleanTel) : null,
  //       },
  //     },
  //   });
  //   if (error || (data as any)?.error) {
  //     setInvite({ state: 'error', msg: 'No se pudo enviar el enlace.' });
  //     return;
  //   }
  //   setInvite({
  //     state: 'sent',
  //     msg: channel === 'whatsapp'
  //       ? `Enviado por WhatsApp a ${cleanTel}`
  //       : `Correo enviado a ${editing.email}`,
  //   });
  // };

  // Filtro sencillo
  const filtered = useMemo(() => {
    if (!search.trim()) return clients;
    const q = search.toLowerCase().trim();
    return clients.filter(c =>
      (c.full_name ?? '').toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.cedula_numero ?? '').toLowerCase().includes(q) ||
      (c.telefono_personal ?? '').toLowerCase().includes(q)
    );
  }, [clients, search]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Portal</p>
          <h2 className="text-2xl font-bold text-white">Clientes</h2>
          <p className="text-white/40 text-xs mt-1">
            Identidad y acceso al portal. Vincula tiendas y envía enlaces de invitación.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            disabled={refreshing}
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? 'Actualizando…' : 'Actualizar'}
          </button>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 text-sm font-medium bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 rounded-lg px-4 py-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
            Nuevo cliente
          </button>
        </div>
      </div>

      <div className="relative">
        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, correo, documento o teléfono…"
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {clients.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">Aún no hay clientes registrados</p>
          <p className="text-white/15 text-xs mt-1">Crea el primero para enviarle un enlace de acceso</p>
        </div>
      ) : (
        <>
          {/* Tabla — visible en pantallas medianas y grandes */}
          <div className="hidden md:block bg-[#111] border border-white/5 rounded-xl overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Cliente</th>
                  <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Correo (login)</th>
                  <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Documento</th>
                  <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Teléfono</th>
                  <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Tiendas</th>
                  <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] group">
                    <td className="px-5 py-3.5">
                      <button
                        type="button"
                        onClick={() => setDetailClient(c)}
                        title="Ver información del cliente"
                        className="text-white/85 hover:text-pink-400 transition-colors text-left font-medium"
                      >
                        {c.full_name || <span className="text-white/30 italic">Sin nombre</span>}
                      </button>
                    </td>
                    <td className="px-5 py-3.5 text-white/60 text-xs font-mono">{c.email}</td>
                    <td className="px-5 py-3.5 text-white/50 text-xs font-mono">{c.cedula_numero ? `${c.doc_tipo || 'V'}-${c.cedula_numero}` : '—'}</td>
                    <td className="px-5 py-3.5 text-white/50 text-xs">{phoneForDisplay(c.telefono_personal)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex gap-1 flex-wrap max-w-[200px]">
                        {(storesByClient[c.id] ?? []).map(s => (
                          <span key={s.id} className="text-[10px] bg-cyan-500/10 text-cyan-300 px-2 py-0.5 rounded">
                            {s.name}
                          </span>
                        ))}
                        {(storesByClient[c.id] ?? []).length === 0 && (
                          <span className="text-[10px] text-white/30 italic">sin tiendas</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openSendDialog('whatsapp', c)}
                          disabled={!!sendingLinkFor || !c.telefono_personal}
                          title={c.telefono_personal ? 'Enviar enlace por WhatsApp' : 'Sin teléfono registrado'}
                          className="p-1.5 rounded-md text-white/30 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/30"
                        >
                          {sendingLinkFor?.id === c.id && sendingLinkFor.channel === 'whatsapp' ? (
                            <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 21l1.65-3.8a9 9 0 113.4 3.39L3 21M9 10a.5.5 0 11.998-.001A.5.5 0 019 10m3 0a.5.5 0 11.998-.001A.5.5 0 0112 10m3 0a.5.5 0 11.998-.001A.5.5 0 0115 10" /></svg>
                          )}
                        </button>
                        <button
                          onClick={() => openSendDialog('email', c)}
                          disabled={!!sendingLinkFor}
                          title="Enviar enlace por correo"
                          className="p-1.5 rounded-md text-white/30 hover:text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/30"
                        >
                          {sendingLinkFor?.id === c.id && sendingLinkFor.channel === 'email' ? (
                            <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                          )}
                        </button>
                        <button
                          onClick={() => openEdit(c)}
                          title="Editar"
                          className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        </button>
                        <button
                          onClick={() => handleDeleteClient(c)}
                          title="Eliminar"
                          className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-white/30 text-sm">
                      No hay coincidencias con la búsqueda.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Cards — visibles solo en móvil */}
          <div className="flex flex-col gap-3 md:hidden">
            {filtered.length === 0 ? (
              <p className="text-center text-white/30 text-sm py-8">No hay coincidencias con la búsqueda.</p>
            ) : filtered.map(c => (
              <div key={c.id} className="bg-[#111] border border-white/5 rounded-xl p-4 space-y-3">
                {/* Header: nombre + acciones */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setDetailClient(c)}
                      title="Ver información del cliente"
                      className="text-sm font-medium text-white/90 hover:text-pink-400 transition-colors truncate text-left block max-w-full"
                    >
                      {c.full_name || <span className="italic text-white/30">Sin nombre</span>}
                    </button>
                    <p className="text-xs text-white/40 font-mono truncate mt-0.5">{c.email}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openSendDialog('whatsapp', c)}
                      disabled={!!sendingLinkFor || !c.telefono_personal}
                      title={c.telefono_personal ? 'Enviar enlace por WhatsApp' : 'Sin teléfono registrado'}
                      className="p-2 rounded-lg text-white/30 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {sendingLinkFor?.id === c.id && sendingLinkFor.channel === 'whatsapp' ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 21l1.65-3.8a9 9 0 113.4 3.39L3 21M9 10a.5.5 0 11.998-.001A.5.5 0 019 10m3 0a.5.5 0 11.998-.001A.5.5 0 0112 10m3 0a.5.5 0 11.998-.001A.5.5 0 0115 10" /></svg>
                      )}
                    </button>
                    <button
                      onClick={() => openSendDialog('email', c)}
                      disabled={!!sendingLinkFor}
                      title="Enviar enlace por correo"
                      className="p-2 rounded-lg text-white/30 hover:text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {sendingLinkFor?.id === c.id && sendingLinkFor.channel === 'email' ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                      )}
                    </button>
                    <button
                      onClick={() => openEdit(c)}
                      title="Editar"
                      className="p-2 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                    <button
                      onClick={() => handleDeleteClient(c)}
                      title="Eliminar"
                      className="p-2 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                </div>

                {/* Detalles */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/5 pt-3">
                  <div>
                    <p className="text-[10px] text-white/30 uppercase tracking-wider mb-0.5">Documento</p>
                    <p className="text-xs text-white/60 font-mono">
                      {c.cedula_numero ? `${c.doc_tipo || 'V'}-${c.cedula_numero}` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/30 uppercase tracking-wider mb-0.5">Teléfono</p>
                    <p className="text-xs text-white/60">{phoneForDisplay(c.telefono_personal)}</p>
                  </div>
                </div>

                {/* Tiendas */}
                <div className="border-t border-white/5 pt-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1.5">Tiendas</p>
                  <div className="flex gap-1 flex-wrap">
                    {(storesByClient[c.id] ?? []).map(s => (
                      <span key={s.id} className="text-[10px] bg-cyan-500/10 text-cyan-300 px-2 py-0.5 rounded">
                        {s.name}
                      </span>
                    ))}
                    {(storesByClient[c.id] ?? []).length === 0 && (
                      <span className="text-[10px] text-white/30 italic">sin tiendas</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">
                {editing ? 'Editar cliente' : 'Nuevo cliente'}
              </h3>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="space-y-5">
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Correo (login del portal) <span className="text-pink-400">*</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={MAX_LEN.email}
                    disabled={!!editing}
                    autoFocus={!editing}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors disabled:opacity-60"
                    placeholder="cliente@correo.com"
                  />
                  {editing && (
                    <p className="text-[10px] text-white/30 mt-1">
                      El correo de login no se puede cambiar. Para reasignar, crea un cliente nuevo.
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Nombre completo <span className="text-pink-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    maxLength={MAX_LEN.fullName}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: María Pérez"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Documento de identidad</label>
                    <div className="flex gap-0">
                      <select
                        value={docTipo}
                        onChange={(e) => setDocTipo(e.target.value as 'V' | 'E')}
                        className="bg-[#0A0A0A] border border-white/10 border-r-0 rounded-l-lg px-2 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors appearance-none cursor-pointer"
                      >
                        <option value="V">V</option>
                        <option value="E">E</option>
                      </select>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={cedula}
                        onChange={(e) => {
                          const v = e.target.value.replace(/\D/g, '');
                          setCedula(v);
                        }}
                        maxLength={MAX_LEN.cedula}
                        className="flex-1 bg-[#0A0A0A] border border-white/10 rounded-r-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                        placeholder="12345678"
                      />
                    </div>
                    <p className="text-[10px] text-white/30 mt-1">Solo números. Debe ser único.</p>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Teléfono</label>
                    <input
                      type="tel"
                      value={telefono}
                      onChange={(e) => setTelefono(e.target.value)}
                      maxLength={MAX_LEN.telefono}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="+58 4141234567"
                    />
                    <p className="text-[10px] text-white/30 mt-1">Incluir +código de país. Debe ser único.</p>
                  </div>
                </div>
                
                <div className="mt-4">
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Documento adjunto (PDF/JPG/PNG)</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      accept=".pdf,image/jpeg,image/png"
                      onChange={(e) => setCedulaFile(e.target.files?.[0] || null)}
                      className="flex-1 bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-pink-500/10 file:text-pink-400 hover:file:bg-pink-500/20"
                    />
                    {cedulaUrl && (
                      <>
                        <button
                          type="button"
                          onClick={() => openPrivateDoc(cedulaUrl)}
                          className="px-3 py-2 bg-white/5 hover:bg-white/10 text-white/70 text-xs rounded-lg transition-colors whitespace-nowrap"
                        >
                          Ver actual
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPrivateDoc(cedulaUrl, `cedula${fileExt(cedulaUrl)}`)}
                          className="px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs rounded-lg transition-colors whitespace-nowrap"
                        >
                          Descargar
                        </button>
                      </>
                    )}
                  </div>
                </div>



              </div>

              {/* Tiendas vinculadas — siempre disponible, pero OPCIONAL.
                  • Al crear: se puede vincular ahora o dejarlo para después.
                  • Al editar: se reconcilian los vínculos (link/unlink).
                  • Una tienda también puede existir sin cliente vinculado. */}
              <div className="border-t border-white/5 pt-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
                    Tiendas vinculadas
                    <span className="ml-2 text-white/25 normal-case tracking-normal font-normal">(opcional)</span>
                  </p>
                  <span className="text-[10px] text-white/40 font-mono">
                    {pickedStoreIds.length}/{stores.length}
                  </span>
                </div>

                <p className="text-[11px] text-white/40 bg-cyan-500/[0.06] border border-cyan-500/20 rounded-lg p-2.5 leading-relaxed">
                  {editing
                    ? 'Marca o desmarca las tiendas que pertenecen a este cliente. Los cambios se guardan al confirmar.'
                    : 'Puedes vincular tiendas ahora o dejarlo para después: el cliente se crea igual sin tiendas. Una tienda también puede existir sin cliente vinculado.'}
                </p>

                {stores.length === 0 ? (
                  <p className="text-[11px] text-white/40 bg-white/[0.02] border border-white/5 rounded p-3">
                    No hay tiendas creadas todavía. Crea el cliente y vincúlale tiendas
                    más tarde, o créalas en{' '}
                    <a href="/panel/tiendas" className="text-cyan-400 hover:text-cyan-300 underline">Tiendas</a>.
                  </p>
                ) : (
                  <>
                    <div className="relative">
                      <svg className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                      <input
                        type="text"
                        value={storeSearch}
                        onChange={(e) => setStoreSearch(e.target.value)}
                        placeholder="Buscar tienda…"
                        className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-pink-500/50 transition-colors"
                      />
                    </div>
                    <div className="max-h-48 overflow-y-auto bg-[#0A0A0A] border border-white/10 rounded-lg p-2 space-y-0.5">
                      {stores
                        .filter(s => !storeSearch.trim() || s.name.toLowerCase().includes(storeSearch.trim().toLowerCase()))
                        .map(s => {
                        const checked = pickedStoreIds.includes(s.id);
                        return (
                          <label
                            key={s.id}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm transition-colors ${
                              checked ? 'bg-cyan-500/10 text-cyan-200' : 'text-white/70 hover:bg-white/[0.04]'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                setPickedStoreIds(prev =>
                                  e.target.checked
                                    ? [...prev, s.id]
                                    : prev.filter(id => id !== s.id)
                                );
                              }}
                              className="accent-cyan-500"
                            />
                            {s.name}
                          </label>
                        );
                      })}
                      {stores.filter(s => !storeSearch.trim() || s.name.toLowerCase().includes(storeSearch.trim().toLowerCase())).length === 0 && (
                        <p className="text-[10px] text-white/30 text-center py-2">Sin resultados para "{storeSearch}"</p>
                      )}
                    </div>
                  </>
                )}
                <p className="text-[10px] text-white/30">
                  Cada tienda solo puede tener un dueño. Si la asignas a este cliente y ya estaba
                  vinculada a otro, ese vínculo se reemplaza al guardar.
                </p>
              </div>

              {/*
                Bloque de "Enviar enlace de acceso" movido fuera del form:
                  • El envío por WhatsApp ahora se hace desde la tabla de
                    clientes (acción por fila) con un confirm() previo.
                  • El envío por correo queda comentado — aún no se va a usar.

                {editing && (
                  <div className="border-t border-white/5 pt-5 space-y-3">
                    <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
                      Enviar enlace de acceso
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => sendLink('email')}
                        disabled={invite.state === 'sending'}
                        className="text-xs font-medium bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
                      >
                        {invite.state === 'sending' ? 'Enviando…' : 'Enviar por correo'}
                      </button>
                    </div>
                    {invite.msg && (
                      <p className={`text-[10px] ${invite.state === 'sent' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {invite.msg}
                      </p>
                    )}
                  </div>
                )}
              */}

              {formError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs p-3 rounded-lg">
                  {formError}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={resetForm}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={submitting}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Guardando…' : (editing ? 'Guardar cambios' : 'Crear cliente')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {detailClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDetailClient(null)} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-lg shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-5">
              <div className="min-w-0">
                <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-1">Cliente</p>
                <h3 className="text-lg font-bold text-white truncate">
                  {detailClient.full_name || <span className="text-white/30 italic font-normal">Sin nombre</span>}
                </h3>
                <p className="text-xs text-white/40 font-mono truncate mt-0.5">{detailClient.email}</p>
              </div>
              <button onClick={() => setDetailClient(null)} className="text-white/30 hover:text-white/60 transition-colors shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Documento</p>
                <p className="text-sm text-white/70 font-mono">
                  {detailClient.cedula_numero ? `${detailClient.doc_tipo || 'V'}-${detailClient.cedula_numero}` : '—'}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Teléfono</p>
                <p className="text-sm text-white/70">{phoneForDisplay(detailClient.telefono_personal)}</p>
              </div>
            </div>

            {detailClient.cedula_url && (
              <div className="mt-4">
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1.5">Documento adjunto</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openPrivateDoc(detailClient.cedula_url!)}
                    className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/70 text-xs rounded-lg transition-colors"
                  >
                    Ver
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadPrivateDoc(detailClient.cedula_url!, `cedula${fileExt(detailClient.cedula_url!)}`)}
                    className="px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs rounded-lg transition-colors"
                  >
                    Descargar
                  </button>
                </div>
              </div>
            )}

            <div className="mt-4 border-t border-white/5 pt-4">
              <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1.5">Tiendas vinculadas</p>
              <div className="flex gap-1 flex-wrap">
                {(storesByClient[detailClient.id] ?? []).map(s => (
                  <span key={s.id} className="text-[11px] bg-cyan-500/10 text-cyan-300 px-2 py-0.5 rounded">
                    {s.name}
                  </span>
                ))}
                {(storesByClient[detailClient.id] ?? []).length === 0 && (
                  <span className="text-[11px] text-white/30 italic">Sin tiendas vinculadas</span>
                )}
              </div>
            </div>

            <div className="flex gap-2 pt-5 mt-5 border-t border-white/5">
              <button
                type="button"
                onClick={() => setDetailClient(null)}
                className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={() => { const c = detailClient; setDetailClient(null); openEdit(c); }}
                className="flex-1 px-5 py-2.5 text-sm font-medium bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 border border-pink-500/30 rounded-lg transition-colors"
              >
                Editar
              </button>
            </div>
          </div>
        </div>
      )}

      {linkDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setLinkDialog(null)}
          />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            {linkDialog.kind === 'confirm' ? (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                    linkDialog.channel === 'whatsapp'
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-sky-500/15 text-sky-400'
                  }`}>
                    {linkDialog.channel === 'whatsapp' ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 21l1.65-3.8a9 9 0 113.4 3.39L3 21M9 10a.5.5 0 11.998-.001A.5.5 0 019 10m3 0a.5.5 0 11.998-.001A.5.5 0 0112 10m3 0a.5.5 0 11.998-.001A.5.5 0 0115 10" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold text-white">
                    {linkDialog.channel === 'whatsapp' ? 'Enviar enlace por WhatsApp' : 'Enviar enlace por correo'}
                  </h3>
                </div>
                <p className="text-xs text-white/60 leading-relaxed mb-1">
                  ¿Enviar el enlace de acceso a{' '}
                  <span className="text-white/90 font-medium">{linkDialog.client.full_name || linkDialog.client.email}</span>?
                </p>
                <p className="text-[11px] text-white/40 font-mono mb-5">
                  {linkDialog.channel === 'whatsapp'
                    ? linkDialog.client.telefono_personal
                    : linkDialog.client.email}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLinkDialog(null)}
                    className="flex-1 px-4 py-2 text-sm text-white/50 hover:text-white/80 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={confirmSendLink}
                    className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                      linkDialog.channel === 'whatsapp'
                        ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border-emerald-500/30'
                        : 'bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border-sky-500/30'
                    }`}
                  >
                    Enviar
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                    linkDialog.tone === 'success'
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-red-500/15 text-red-400'
                  }`}>
                    {linkDialog.tone === 'success' ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold text-white">{linkDialog.title}</h3>
                </div>
                <p className="text-xs text-white/60 leading-relaxed mb-5">{linkDialog.message}</p>
                <button
                  type="button"
                  onClick={() => setLinkDialog(null)}
                  className="w-full px-4 py-2 text-sm font-medium bg-white/5 hover:bg-white/10 text-white/80 rounded-lg transition-colors"
                >
                  Entendido
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
