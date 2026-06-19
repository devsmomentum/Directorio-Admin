'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';
import { confirmDialog } from '../../components/confirm-dialog';

// Marcas aliadas: tiendas que publican campañas + cupones flash SIN pagar plan,
// con un tope de campañas activas que fija el admin. Además pueden recibir un
// % de los ingresos globales que se refleja en Finanzas (cascada de reparto).
// El tope efectivo por aliado = min(ally_campaign_limit, slots_libres_del_loop).

type RevenueBase = 'gross' | 'net';

type Store = {
  id: string;
  name: string;
  plan_type: string | null;
  is_ally: boolean;
  ally_campaign_limit: number;
  ally_flash_enabled: boolean;
  ally_revenue_pct: number;
  ally_revenue_base: RevenueBase;
  ally_since: string | null;
};

type Share = { id: string; store_id: string; pct: number; base: RevenueBase; effective_from: string; effective_to: string | null };
type Draft = { limit: string; flash: boolean; pct: string; base: RevenueBase; from: string };

const todayStr = () => new Date().toISOString().split('T')[0];

export default function AliadosPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [shares, setShares] = useState<Record<string, Share[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [search, setSearch] = useState('');
  const [modalSearch, setModalSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // Loop capacity: tamaño = suma de plans.max_brands donde loop_eligible = true.
  const [loopMaxSlots, setLoopMaxSlots] = useState<number>(32);
  // Campañas activas por tienda (store_id → count).
  const [activeByStore, setActiveByStore] = useState<Record<string, number>>({});

  const fetchData = async () => {
    setLoading(true);
    const today = todayStr();
    const [{ data, error }, { data: shareData }, { data: plansData }, { data: campsData }] = await Promise.all([
      supabase
        .from('stores')
        .select('id, name, plan_type, is_ally, ally_campaign_limit, ally_flash_enabled, ally_revenue_pct, ally_revenue_base, ally_since')
        .order('name'),
      supabase
        .from('ally_revenue_shares')
        .select('id, store_id, pct, base, effective_from, effective_to')
        .order('effective_from', { ascending: false }),
      supabase
        .from('plans')
        .select('max_brands')
        .eq('loop_eligible', true)
        .not('max_brands', 'is', null),
      supabase
        .from('ad_campaigns')
        .select('store_id')
        .eq('is_active', true)
        .or(`end_date.is.null,end_date.gte.${today}`),
    ]);

    if (error) setFeedback({ type: 'err', msg: error.message });
    setStores((data as Store[]) || []);

    const byStore: Record<string, Share[]> = {};
    for (const sh of (shareData as Share[]) || []) {
      (byStore[sh.store_id] ??= []).push(sh);
    }
    setShares(byStore);

    if (plansData) {
      const total = (plansData as { max_brands: number }[]).reduce((s, p) => s + (p.max_brands ?? 0), 0);
      if (total > 0) setLoopMaxSlots(total);
    }

    if (campsData) {
      const counts: Record<string, number> = {};
      for (const c of campsData as { store_id: string }[]) {
        counts[c.store_id] = (counts[c.store_id] || 0) + 1;
      }
      setActiveByStore(counts);
    }

    setLoading(false);
  };

  const openShareOf = (storeId: string) => (shares[storeId] || []).find(x => x.effective_to === null) || null;

  useEffect(() => { fetchData(); }, []);

  const allies = useMemo(
    () => stores.filter(s => s.is_ally && s.name.toLowerCase().includes(search.toLowerCase())),
    [stores, search]
  );
  const nonAllies = useMemo(
    () => stores.filter(s => !s.is_ally && s.name.toLowerCase().includes(modalSearch.toLowerCase())),
    [stores, modalSearch],
  );

  // Slots usados por campañas activas de TODOS (pagos + aliados).
  const totalSlotsUsed = useMemo(
    () => Object.values(activeByStore).reduce((s, v) => s + v, 0),
    [activeByStore],
  );
  const freeSlots = Math.max(0, loopMaxSlots - totalSlotsUsed);

  const draftFor = (s: Store): Draft => {
    if (drafts[s.id]) return drafts[s.id];
    const open = openShareOf(s.id);
    return {
      limit: String(s.ally_campaign_limit ?? 1),
      flash: !!s.ally_flash_enabled,
      pct: String(open?.pct ?? s.ally_revenue_pct ?? 0),
      base: open?.base ?? s.ally_revenue_base ?? 'net',
      from: todayStr(),
    };
  };

  const setDraft = (id: string, patch: Partial<Draft>) => {
    const s = stores.find(x => x.id === id)!;
    const base = draftFor(s);
    setDrafts(prev => ({ ...prev, [id]: { ...base, ...prev[id], ...patch } }));
  };

  const pctSums = useMemo(() => {
    let gross = 0, net = 0;
    for (const s of allies) {
      const d = draftFor(s);
      const pct = parseFloat(d.pct);
      if (isNaN(pct)) continue;
      if (d.base === 'gross') gross += pct; else net += pct;
    }
    return { gross, net };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allies, drafts]);

  const promoteToAlly = async (s: Store) => {
    setSavingId(s.id);
    setFeedback(null);
    const { error } = await supabase
      .from('stores')
      .update({ is_ally: true, ally_since: new Date().toISOString(), ally_campaign_limit: 1, ally_flash_enabled: true, ally_revenue_pct: 0, ally_revenue_base: 'net' })
      .eq('id', s.id);
    setSavingId(null);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({ action_type: 'ACTIVAR', entity_type: 'aliado', entity_id: s.id, entity_name: s.name });
    setFeedback({ type: 'ok', msg: `"${s.name}" ahora es marca aliada.` });
    setAddOpen(false);
    fetchData();
  };

  const revokeAlly = async (s: Store) => {
    const ok = await confirmDialog({ title: `Quitar estatus de aliado a "${s.name}"`, message: 'Dejará de poder publicar campañas/cupones gratis y no recibirá % de ingresos a partir de hoy. El historial se conserva.', confirmLabel: 'Quitar', tone: 'danger' });
    if (!ok) return;
    setSavingId(s.id);
    setFeedback(null);
    const { error } = await supabase
      .from('stores')
      .update({ is_ally: false, ally_revenue_pct: 0 })
      .eq('id', s.id);
    if (!error) {
      await supabase
        .from('ally_revenue_shares')
        .update({ effective_to: todayStr() })
        .eq('store_id', s.id)
        .is('effective_to', null);
    }
    setSavingId(null);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await logAdminAction({ action_type: 'DESACTIVAR', entity_type: 'aliado', entity_id: s.id, entity_name: s.name });
    setDrafts(prev => { const n = { ...prev }; delete n[s.id]; return n; });
    setFeedback({ type: 'ok', msg: `"${s.name}" ya no es aliado (vigente hasta hoy).` });
    fetchData();
  };

  const saveAlly = async (s: Store) => {
    const d = draftFor(s);
    const limit = parseInt(d.limit, 10);
    const pct = parseFloat(d.pct);
    if (isNaN(limit) || limit < 1) { setFeedback({ type: 'err', msg: 'El límite de campañas debe ser ≥ 1.' }); return; }
    if (isNaN(pct) || pct < 0 || pct > 100) { setFeedback({ type: 'err', msg: 'El % de ingresos debe estar entre 0 y 100.' }); return; }
    if (!d.from) { setFeedback({ type: 'err', msg: 'Indica desde qué fecha rige el porcentaje.' }); return; }

    // Slots efectivamente disponibles para este aliado:
    // los que ya están usando (sus campañas activas) + los libres del loop.
    const allyActive = activeByStore[s.id] || 0;
    const effectiveMax = allyActive + freeSlots;
    if (limit > effectiveMax) {
      setFeedback({
        type: 'err',
        msg: `El límite (${limit}) supera los slots disponibles en el loop. Máximo posible ahora: ${effectiveMax} (${allyActive} que ya usa + ${freeSlots} libres).`,
      });
      return;
    }

    setSavingId(s.id);
    setFeedback(null);

    const { error } = await supabase
      .from('stores')
      .update({ ally_campaign_limit: limit, ally_flash_enabled: d.flash, ally_revenue_pct: pct, ally_revenue_base: d.base })
      .eq('id', s.id);
    if (error) { setSavingId(null); setFeedback({ type: 'err', msg: error.message }); return; }

    const open = openShareOf(s.id);
    const changed = !open || Number(open.pct) !== pct || open.base !== d.base;
    let shareErr: string | null = null;
    if (changed) {
      if (open && open.effective_from >= d.from) {
        const { error: e } = await supabase
          .from('ally_revenue_shares')
          .update({ pct, base: d.base, effective_from: d.from })
          .eq('id', open.id);
        shareErr = e?.message ?? null;
      } else {
        if (open) {
          const { error: e1 } = await supabase
            .from('ally_revenue_shares')
            .update({ effective_to: d.from })
            .eq('id', open.id);
          if (e1) shareErr = e1.message;
        }
        if (!shareErr) {
          const { error: e2 } = await supabase
            .from('ally_revenue_shares')
            .insert({ store_id: s.id, pct, base: d.base, effective_from: d.from });
          shareErr = e2?.message ?? null;
        }
      }
    }
    setSavingId(null);
    if (shareErr) { setFeedback({ type: 'err', msg: shareErr }); fetchData(); return; }

    await logAdminAction({
      action_type: 'EDITAR', entity_type: 'aliado', entity_id: s.id, entity_name: s.name,
      details: { ally_campaign_limit: limit, ally_flash_enabled: d.flash, ally_revenue_pct: pct, ally_revenue_base: d.base, effective_from: d.from },
    });
    setDrafts(prev => { const n = { ...prev }; delete n[s.id]; return n; });
    setFeedback({ type: 'ok', msg: changed ? `Aliado "${s.name}" actualizado. El nuevo % rige desde ${d.from}.` : `Aliado "${s.name}" actualizado.` });
    fetchData();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <PageSpinner />
      </div>
    );
  }

  const loopPct = loopMaxSlots > 0 ? Math.min(totalSlotsUsed / loopMaxSlots, 1) : 0;
  const loopFull = freeSlots === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Administración</p>
          <h2 className="text-2xl font-bold text-white">Marcas Aliadas</h2>
          <p className="text-white/50 text-sm mt-2 max-w-2xl">
            Las marcas aliadas publican campañas y cupones flash sin pagar plan. El límite por aliado
            no puede superar los slots libres del loop publicitario.
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="shrink-0 text-sm font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 rounded-lg px-4 py-2.5 transition-colors self-start"
        >
          + Marcar tienda como aliada
        </button>
      </div>

      {feedback && (
        <div className={`rounded-lg p-3 text-sm border ${feedback.type === 'ok'
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>{feedback.msg}</div>
      )}

      <div className="relative">
        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar aliado por nombre o id comercial..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Resumen general */}
      <div className="bg-[#111] border border-white/5 rounded-xl p-4 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <p className="text-[10px] text-white/30 uppercase tracking-wider">Aliados activos</p>
          <p className="text-xl font-bold text-emerald-400">{allies.length}</p>
        </div>
        <div>
          <p className="text-[10px] text-white/30 uppercase tracking-wider">% sobre el bruto</p>
          <p className="text-xl font-bold text-purple-300">{pctSums.gross.toFixed(2)}%</p>
        </div>
        <div>
          <p className="text-[10px] text-white/30 uppercase tracking-wider">% sobre lo demás</p>
          <p className="text-xl font-bold text-emerald-400">{pctSums.net.toFixed(2)}%</p>
        </div>

        {/* Separador vertical */}
        <div className="hidden sm:block w-px h-10 bg-white/8" />

        {/* Loop slots */}
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] text-white/30 uppercase tracking-wider">Slots del loop</p>
            <p className={`text-[11px] font-mono font-semibold ${loopFull ? 'text-red-400' : freeSlots <= 3 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {freeSlots} libres
            </p>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${loopFull ? 'bg-red-500' : loopPct >= 0.75 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${Math.round(loopPct * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1">
            <p className="text-[10px] text-white/25 font-mono">{totalSlotsUsed}/{loopMaxSlots} ocupados</p>
            {loopFull && (
              <p className="text-[10px] text-red-400">Loop lleno · los aliados no pueden activar campañas</p>
            )}
          </div>
        </div>

        {pctSums.gross > 100 && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-1.5 w-full">
            ⚠ Los % sobre el bruto suman {pctSums.gross.toFixed(0)}% (&gt;100%): no quedaría nada para repartir.
          </p>
        )}
        {pctSums.net > 100 && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-1.5 w-full">
            ⚠ Los % sobre lo demás suman {pctSums.net.toFixed(0)}% (&gt;100%).
          </p>
        )}
      </div>

      {/* Lista de aliados */}
      {allies.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-10 text-center">
          <p className="text-white/30 text-sm">Aún no hay marcas aliadas.</p>
          <button onClick={() => setAddOpen(true)} className="mt-3 text-xs text-emerald-400/70 hover:text-emerald-300 transition-colors">
            + Marcar la primera tienda como aliada
          </button>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  {['Tienda', 'Campañas (activas / máx)', 'Cupones flash', '% de ingresos', 'Base del %', 'Rige desde', ''].map(h => (
                    <th key={h} className="text-[11px] text-white/25 uppercase tracking-wider font-medium px-5 py-3 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {allies.map(s => {
                  const d = draftFor(s);
                  const dirty = !!drafts[s.id];
                  const hist = shares[s.id] || [];
                  const isOpen = expanded === s.id;
                  const allyActive = activeByStore[s.id] || 0;
                  const draftLimit = parseInt(d.limit, 10) || 0;
                  // Slots que este aliado podría usar como máximo dado el loop.
                  const effectiveMax = allyActive + freeSlots;
                  const limitExceedsLoop = draftLimit > effectiveMax;
                  const atCapacity = allyActive >= draftLimit;

                  return (
                    <Fragment key={s.id}>
                    <tr className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-3">
                        <p className="text-sm text-white/80 font-medium">{s.name}</p>
                        {s.plan_type && <p className="text-[10px] text-white/30 mt-0.5">también plan {s.plan_type}</p>}
                      </td>

                      {/* Campañas activas vs límite */}
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          {/* Indicador de uso actual */}
                          <div className="text-right w-8">
                            <p className={`text-sm font-mono font-semibold ${atCapacity ? 'text-amber-400' : 'text-white/60'}`}>
                              {allyActive}
                            </p>
                            <p className="text-[9px] text-white/25">activas</p>
                          </div>
                          <span className="text-white/20 text-xs">/</span>
                          {/* Input del límite */}
                          <div>
                            <input
                              type="number" min={1} max={effectiveMax}
                              value={d.limit}
                              onChange={e => setDraft(s.id, { limit: e.target.value })}
                              className={`w-20 text-sm bg-[#0a0a0a] border rounded-lg px-3 py-1.5 focus:outline-none transition-colors ${
                                limitExceedsLoop
                                  ? 'border-red-500/50 text-red-400 focus:border-red-500'
                                  : 'border-white/10 text-white/80 focus:border-emerald-500'
                              }`}
                            />
                            {limitExceedsLoop && (
                              <p className="text-[9px] text-red-400 mt-0.5">máx {effectiveMax}</p>
                            )}
                          </div>
                        </div>
                        {/* Mini barra de uso */}
                        {draftLimit > 0 && (
                          <div className="mt-1.5 h-1 bg-white/5 rounded-full overflow-hidden w-full max-w-[80px]">
                            <div
                              className={`h-full rounded-full ${atCapacity ? 'bg-amber-500' : 'bg-emerald-500/60'}`}
                              style={{ width: `${Math.min((allyActive / draftLimit) * 100, 100)}%` }}
                            />
                          </div>
                        )}
                      </td>

                      <td className="px-5 py-3">
                        <button
                          onClick={() => setDraft(s.id, { flash: !d.flash })}
                          className={`text-[11px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${d.flash
                            ? 'bg-pink-500/15 border-pink-500/40 text-pink-200'
                            : 'bg-white/5 border-white/10 text-white/40'}`}
                        >
                          {d.flash ? 'Habilitado' : 'Deshabilitado'}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number" min={0} max={100} step="0.01" value={d.pct}
                            onChange={e => setDraft(s.id, { pct: e.target.value })}
                            className="w-24 text-sm bg-[#0a0a0a] border border-white/10 text-white/80 rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500"
                          />
                          <span className="text-white/30 text-xs">%</span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <select
                          value={d.base}
                          onChange={e => setDraft(s.id, { base: e.target.value as RevenueBase })}
                          className="text-sm bg-[#0a0a0a] border border-white/10 text-white/80 rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500"
                        >
                          <option value="gross">Sobre el bruto</option>
                          <option value="net">Sobre el neto</option>
                        </select>
                      </td>
                      <td className="px-5 py-3">
                        <input
                          type="date" value={d.from}
                          onChange={e => setDraft(s.id, { from: e.target.value })}
                          title="Fecha desde la que rige el % (al cambiar % o base)"
                          className="text-xs bg-[#0a0a0a] border border-white/10 text-white/70 rounded-lg px-2 py-1.5 focus:outline-none focus:border-emerald-500"
                        />
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => saveAlly(s)}
                            disabled={savingId === s.id || !dirty}
                            className="text-xs font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            {savingId === s.id ? 'Guardando…' : 'Guardar'}
                          </button>
                          {hist.length > 0 && (
                            <button
                              onClick={() => setExpanded(isOpen ? null : s.id)}
                              className="text-xs text-white/40 hover:text-white/70 transition-colors"
                            >
                              {isOpen ? 'Ocultar' : `Historial (${hist.length})`}
                            </button>
                          )}
                          <button
                            onClick={() => revokeAlly(s)}
                            disabled={savingId === s.id}
                            className="text-xs text-white/30 hover:text-red-400 transition-colors disabled:opacity-30"
                          >
                            Quitar
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-black/30">
                        <td colSpan={7} className="px-5 py-3">
                          <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
                            Historial de porcentajes · alta como aliado: {s.ally_since ? s.ally_since.split('T')[0] : '—'}
                          </p>
                          <div className="space-y-1">
                            {hist.map(h => (
                              <div key={h.id} className="flex items-center gap-3 text-xs text-white/60">
                                <span className="font-mono text-white/40 w-44">
                                  {h.effective_from} → {h.effective_to ?? 'vigente'}
                                </span>
                                <span className="font-semibold text-emerald-300">{Number(h.pct)}%</span>
                                <span className="text-white/40">
                                  {h.base === 'gross' ? 'sobre el bruto' : 'sobre lo demás'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal: marcar tienda como aliada */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setAddOpen(false)} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">Marcar tienda como aliada</h3>
                {loopFull && (
                  <p className="text-[11px] text-amber-400 mt-0.5">El loop está lleno ({totalSlotsUsed}/{loopMaxSlots}). El aliado quedará con límite 1 pero no podrá activar campañas hasta que se libere un slot.</p>
                )}
              </div>
              <button onClick={() => setAddOpen(false)} className="text-white/40 hover:text-white/80 ml-4 shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-5 space-y-3">
              <input
                autoFocus value={modalSearch} onChange={e => setModalSearch(e.target.value)}
                placeholder="Buscar tienda…"
                className="w-full text-sm bg-[#0a0a0a] border border-white/10 text-white/80 rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500"
              />
              <div className="max-h-72 overflow-y-auto space-y-1">
                {nonAllies.length === 0 ? (
                  <p className="text-white/30 text-xs text-center py-6">Sin tiendas que coincidan.</p>
                ) : nonAllies.map(s => (
                  <button
                    key={s.id} onClick={() => promoteToAlly(s)} disabled={savingId === s.id}
                    className="w-full flex items-center justify-between text-left bg-[#0a0a0a] border border-white/10 hover:border-emerald-500/40 hover:bg-emerald-500/[0.04] rounded-lg px-3 py-2.5 transition-colors disabled:opacity-40"
                  >
                    <span className="text-sm text-white/80">{s.name}</span>
                    <span className="text-[10px] text-emerald-300/70">+ aliado</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
