'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

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
  cedula_numero: string | null;
  telefono_personal: string | null;
  correo_personal: string | null;
  created_at: string;
};

type StoreLite = { id: string; name: string };

export default function ClientesPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [stores, setStores] = useState<StoreLite[]>([]);
  const [storesByClient, setStoresByClient] = useState<Record<string, StoreLite[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  // form state
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ClientRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [cedula, setCedula] = useState('');
  const [telefono, setTelefono] = useState('');
  const [correoPersonal, setCorreoPersonal] = useState('');
  const [pickedStoreIds, setPickedStoreIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ state: 'idle' | 'sending' | 'sent' | 'error'; msg: string }>({ state: 'idle', msg: '' });

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setRefreshing(true);
    const [clientsRes, storesRes, linksRes] = await Promise.all([
      supabase
        .from('users')
        .select('id, email, full_name, cedula_numero, telefono_personal, correo_personal, created_at')
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
    setFullName(''); setCedula(''); setTelefono(''); setCorreoPersonal('');
    setPickedStoreIds([]);
    setFormError(null); setInvite({ state: 'idle', msg: '' });
    setShowForm(true);
  };

  const openEdit = (c: ClientRow) => {
    setEditing(c);
    setEmail(c.email);
    setFullName(c.full_name ?? '');
    setCedula(c.cedula_numero ?? '');
    setTelefono(c.telefono_personal ?? '');
    setCorreoPersonal(c.correo_personal ?? '');
    setPickedStoreIds((storesByClient[c.id] ?? []).map(s => s.id));
    setFormError(null); setInvite({ state: 'idle', msg: '' });
    setShowForm(true);
  };

  const resetForm = () => {
    setShowForm(false);
    setEditing(null);
    setSubmitting(false);
  };

  // Crea o actualiza al cliente. Pasos:
  //   1) Si NO existe en public.users con este email, llama a la edge function
  //      send-magic-link (channel='none', profile={...}) que crea el auth.user
  //      e inserta el perfil. La función es idempotente; si ya existía solo
  //      actualiza el perfil.
  //   2) Si existe (editando), actualiza directamente public.users.
  //   3) Reconcilia user_stores: vincula los store_ids elegidos y desvincula
  //      los que estaban antes y ya no están.
  const handleSave = async () => {
    setFormError(null);
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = fullName.trim();
    if (!cleanEmail) return setFormError('El correo es obligatorio.');
    if (!cleanName) return setFormError('El nombre es obligatorio.');

    setSubmitting(true);

    let userId = editing?.id ?? null;

    try {
      if (!userId) {
        // Crear el auth.user vía edge function (channel='none' no envía nada).
        const { data, error } = await supabase.functions.invoke('send-magic-link', {
          body: {
            email: cleanEmail,
            channel: 'none',
            profile: {
              full_name: cleanName,
              cedula_numero: cedula || null,
              telefono_personal: telefono || null,
              correo_personal: correoPersonal || null,
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
      } else {
        // Editar: UPDATE directo en public.users. Las policies admin_write
        // y el trigger guard_users_self_update preservan role/email.
        const { error } = await supabase
          .from('users')
          .update({
            full_name: cleanName,
            cedula_numero: cedula || null,
            telefono_personal: telefono || null,
            correo_personal: correoPersonal || null,
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
          p_cedula_numero: cedula || null,
          p_telefono_personal: telefono || null,
          p_correo_personal: correoPersonal || null,
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

  // Envío de magic link al cliente que está siendo editado. Reusa la edge
  // function send-magic-link con el canal correspondiente.
  const sendLink = async (channel: 'email' | 'whatsapp') => {
    if (!editing) {
      setInvite({ state: 'error', msg: 'Guarda el cliente antes de enviar el enlace.' });
      return;
    }
    if (channel === 'whatsapp' && !telefono.trim()) {
      setInvite({ state: 'error', msg: 'Necesitas un teléfono para WhatsApp.' });
      return;
    }
    setInvite({ state: 'sending', msg: '' });
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const { data, error } = await supabase.functions.invoke('send-magic-link', {
      body: {
        email: editing.email,
        phone: channel === 'whatsapp' ? telefono.trim() : undefined,
        channel,
        redirectTo: `${origin}/auth/callback`,
        profile: {
          full_name: fullName.trim() || null,
          cedula_numero: cedula || null,
          telefono_personal: telefono || null,
          correo_personal: correoPersonal || null,
        },
      },
    });
    if (error || (data as any)?.error) {
      setInvite({ state: 'error', msg: (data as any)?.error ?? error?.message ?? 'No se pudo enviar.' });
      return;
    }
    setInvite({
      state: 'sent',
      msg: channel === 'whatsapp'
        ? `Enviado por WhatsApp a ${telefono.trim()}`
        : `Correo enviado a ${editing.email}`,
    });
  };

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
          placeholder="Buscar por nombre, correo, cédula o teléfono…"
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {clients.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">Aún no hay clientes registrados</p>
          <p className="text-white/15 text-xs mt-1">Crea el primero para enviarle un enlace de acceso</p>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Cliente</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Correo (login)</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Cédula</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Teléfono</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium">Tiendas</th>
                <th className="px-5 py-3 text-[10px] text-white/30 uppercase tracking-wider font-medium text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="px-5 py-3.5 text-white/85">
                    {c.full_name || <span className="text-white/30 italic">Sin nombre</span>}
                  </td>
                  <td className="px-5 py-3.5 text-white/60 text-xs font-mono">{c.email}</td>
                  <td className="px-5 py-3.5 text-white/50 text-xs font-mono">{c.cedula_numero || '—'}</td>
                  <td className="px-5 py-3.5 text-white/50 text-xs">{c.telefono_personal || '—'}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex gap-1 flex-wrap max-w-[280px]">
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
                    <button
                      onClick={() => openEdit(c)}
                      className="text-xs text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-md px-3 py-1.5 transition-colors"
                    >
                      Editar
                    </button>
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
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Ej: María Pérez"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Cédula</label>
                    <input
                      type="text"
                      value={cedula}
                      onChange={(e) => setCedula(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="V-12345678"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Teléfono</label>
                    <input
                      type="tel"
                      value={telefono}
                      onChange={(e) => setTelefono(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="+58 4XX-XXXXXXX"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                    Correo personal (alternativo)
                  </label>
                  <input
                    type="email"
                    value={correoPersonal}
                    onChange={(e) => setCorreoPersonal(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                    placeholder="Si difiere del correo de login"
                  />
                </div>
              </div>

              {/* Tiendas vinculadas */}
              <div className="border-t border-white/5 pt-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
                    Tiendas vinculadas
                  </p>
                  <span className="text-[10px] text-white/40 font-mono">
                    {pickedStoreIds.length}/{stores.length}
                  </span>
                </div>

                {stores.length === 0 ? (
                  <p className="text-[11px] text-white/40 bg-white/[0.02] border border-white/5 rounded p-3">
                    No hay tiendas creadas todavía.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto bg-[#0A0A0A] border border-white/10 rounded-lg p-2 space-y-0.5">
                    {stores.map(s => {
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
                  </div>
                )}
                <p className="text-[10px] text-white/30">
                  Cada tienda solo puede tener un dueño. Si la asignas a este cliente y ya estaba
                  vinculada a otro, ese vínculo se reemplaza al guardar.
                </p>
              </div>

              {/* Envío de links — solo en edición (necesitamos auth.user creado) */}
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
                    <button
                      type="button"
                      onClick={() => sendLink('whatsapp')}
                      disabled={invite.state === 'sending'}
                      className="text-xs font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
                    >
                      {invite.state === 'sending' ? 'Enviando…' : 'Enviar por WhatsApp'}
                    </button>
                  </div>
                  {invite.msg && (
                    <p className={`text-[10px] ${invite.state === 'sent' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {invite.msg}
                    </p>
                  )}
                </div>
              )}

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
    </div>
  );
}
