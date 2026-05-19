'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useClienteStore } from '../store-context';

export default function ClienteCuentaPage() {
  const { stores, selectedStore: store, refreshStores } = useClienteStore();
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // Campos editables de la tienda seleccionada
  const [storeDescription, setStoreDescription] = useState('');

  const [fullName, setFullName] = useState('');
  const [telefonoPersonal, setTelefonoPersonal] = useState('');

  const fetchUser = async () => {
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) { setLoading(false); return; }
    const { data: u } = await supabase.from('users').select('*').eq('id', authUser.id).maybeSingle();
    setUser(u);
    if (u) {
      setFullName(u.full_name || '');
      setTelefonoPersonal(u.telefono_personal || '');
    }
    setLoading(false);
  };

  useEffect(() => { fetchUser(); }, []);

  useEffect(() => {
    if (store) {
      setStoreDescription(store.description || '');
    }
  }, [store]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    try {
      if (store) {
        const { error: sErr } = await supabase.from('stores').update({
          description: storeDescription,
        }).eq('id', store.id);
        if (sErr) throw sErr;
        await refreshStores();
      }

      if (user) {
        const { error: uErr } = await supabase.from('users').update({
          full_name: fullName,
          telefono_personal: telefonoPersonal || null,
        }).eq('id', user.id);
        if (uErr) throw uErr;
      }

      setFeedback({ type: 'ok', msg: 'Cambios guardados correctamente.' });
      fetchUser();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Error al guardar.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Mi cuenta</p>
        <h2 className="text-2xl font-bold text-white">Mis Tiendas</h2>
        <p className="text-white/50 text-sm mt-2">
          Tienes <span className="text-cyan-300 font-semibold">{stores.length}</span> tienda{stores.length !== 1 ? 's' : ''} vinculada{stores.length !== 1 ? 's' : ''}.
          Cambia la tienda activa en el sidebar para editar otra.
        </p>
      </div>

      {/* Lista resumida de todas las tiendas */}
      {stores.length > 1 && (
        <section className="bg-[#111] border border-white/5 rounded-xl p-4">
          <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-3">
            Todas tus tiendas
          </p>
          <div className="space-y-2">
            {stores.map(s => (
              <div
                key={s.id}
                className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                  s.id === store?.id ? 'bg-cyan-500/10 border border-cyan-500/30' : 'bg-white/[0.02] border border-white/5'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm text-white/80 font-medium truncate">{s.name}</p>
                  <p className="text-[10px] text-white/40 font-mono">
                    {s.floor_level} · {s.local_number} · {s.plan_type || 'Sin plan'}
                  </p>
                </div>
                {s.id === store?.id && (
                  <span className="text-[10px] text-cyan-300 font-semibold">EDITANDO</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {feedback && (
        <div className={`rounded-lg p-3 text-sm border ${
          feedback.type === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {feedback.msg}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Datos de la tienda activa */}
        {store ? (
          <section className="bg-[#111] border border-white/5 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-white">
              {store.name} <span className="text-white/30 text-xs font-normal">(tienda activa)</span>
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <Readonly label="Nombre" value={store.name} />
              <Readonly label="RIF" value={store.rif || '—'} />
              <Readonly label="Categoría" value={store.categories?.name || '—'} />
              <Readonly label="Plan asignado" value={store.plan_type || 'Sin plan'} />
              <Readonly label="Piso" value={store.floor_level || '—'} />
              <Readonly label="Local" value={store.local_number || '—'} />
              <Readonly label="Contrato vence" value={store.contract_expiry_date || '—'} />
              <Readonly label="Estado contrato"
                value={store.contract_expiry_date
                  ? (store.contract_expiry_date < new Date().toISOString().split('T')[0] ? 'Vencido' : 'Vigente')
                  : '—'}
              />
            </div>

            <div className="border-t border-white/5 pt-4 space-y-3">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
                Editables por ti
              </p>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripción</label>
                <textarea
                  value={storeDescription} onChange={(e) => setStoreDescription(e.target.value)}
                  rows={2}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50 resize-none"
                />
              </div>
            </div>
          </section>
        ) : (
          <section className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-5 text-amber-300 text-sm">
            Tu cuenta aún no está vinculada a ninguna tienda del directorio.
          </section>
        )}

        {/* Datos personales */}
        {user && (
          <section className="bg-[#111] border border-white/5 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-white">Mis Datos (Persona Natural)</h3>
            <p className="text-[11px] text-white/40">
              Estos datos son compartidos para todas tus tiendas — son tuyos como persona.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <Readonly label="Email del portal (login)" value={user.email} />
              <Readonly label="Cédula" value={user.cedula_numero || '—'} />
            </div>

            <div className="border-t border-white/5 pt-4 space-y-3">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium">
                Editables por ti
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre completo</label>
                  <input
                    type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Teléfono personal</label>
                  <input
                    type="tel" value={telefonoPersonal} onChange={(e) => setTelefonoPersonal(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="flex justify-end">
          <button
            type="submit" disabled={saving}
            className="px-6 py-2.5 text-sm font-medium bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 border border-cyan-500/30 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Readonly({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium mb-1">{label}</p>
      <p className="text-white/70 text-sm font-mono">{value}</p>
    </div>
  );
}
