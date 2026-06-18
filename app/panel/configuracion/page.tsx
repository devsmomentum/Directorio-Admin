'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';

interface ConfigEntry {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
}

interface LoopPlan {
  id: string;
  plan_key: string;
  name: string;
  max_brands: number | null;
}

interface AllyRow {
  id: string;
  name: string;
  ally_campaign_limit: number;
}

interface ActiveCampaign {
  id: string;
  store_id: string | null;
  plan_type: string;
  end_date: string | null;
}

// Metadatos para claves de app_config. Añadir una entrada aquí + una fila en
// la BD es todo lo que hace falta para exponer una nueva configuración.
const CONFIG_META: Record<string, {
  label: string;
  section: string;
  hint: string;
  type: 'number' | 'text';
  min?: number;
  max?: number;
  unit?: string;
  warning?: (v: number | string) => string | null;
  preview?: (v: number | string) => { label: string; value: string }[];
}> = {
  // Añadir aquí nuevas claves de app_config cuando sea necesario.
};

function groupBySection(entries: ConfigEntry[]) {
  const sections: Record<string, ConfigEntry[]> = {};
  for (const e of entries) {
    const meta = CONFIG_META[e.key];
    if (!meta) continue;
    const section = meta.section;
    if (!sections[section]) sections[section] = [];
    sections[section].push(e);
  }
  return sections;
}

export default function ConfiguracionPage() {
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  // Slots por plan (loop-eligible plans)
  const [loopPlans, setLoopPlans] = useState<LoopPlan[]>([]);
  const [planDrafts, setPlanDrafts] = useState<Record<string, string>>({});
  const [planSaving, setPlanSaving] = useState<Record<string, boolean>>({});
  const [planSaved, setPlanSaved] = useState<Record<string, boolean>>({});

  // Aliados en el loop
  const [allies, setAllies] = useState<AllyRow[]>([]);
  const [activeCampaigns, setActiveCampaigns] = useState<ActiveCampaign[]>([]);
  const [allyLimitDrafts, setAllyLimitDrafts] = useState<Record<string, string>>({});
  const [allyLimitSaving, setAllyLimitSaving] = useState<Record<string, boolean>>({});
  const [allyLimitSaved, setAllyLimitSaved] = useState<Record<string, boolean>>({});

  const fetchConfig = async () => {
    const [configRes, plansRes, alliesRes, campaignsRes] = await Promise.all([
      supabase.from('app_config').select('*').order('key'),
      supabase
        .from('plans')
        .select('id, plan_key, name, max_brands')
        .eq('loop_eligible', true)
        .eq('is_active', true)
        .order('display_order'),
      supabase
        .from('stores')
        .select('id, name, ally_campaign_limit')
        .eq('is_ally', true)
        .order('name'),
      supabase
        .from('ad_campaigns')
        .select('id, store_id, plan_type, end_date')
        .eq('is_active', true),
    ]);
    if (configRes.data) setEntries(configRes.data as ConfigEntry[]);
    if (plansRes.data) setLoopPlans(plansRes.data as LoopPlan[]);
    if (alliesRes.data) setAllies(alliesRes.data as AllyRow[]);
    if (campaignsRes.data) setActiveCampaigns(campaignsRes.data as ActiveCampaign[]);
    setLoading(false);
  };

  useEffect(() => { fetchConfig(); }, []);

  // Derivados del loop: slots ocupados por planes y aliados
  const loopStats = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const loopKeys = new Set(loopPlans.map(p => p.plan_key));
    const allyIds = new Set(allies.map(a => a.id));

    const live = activeCampaigns.filter(c =>
      loopKeys.has(c.plan_type) &&
      (!c.end_date || c.end_date >= today)
    );

    const planSlots = live.filter(c => !c.store_id || !allyIds.has(c.store_id)).length;
    const allySlots = live.filter(c => c.store_id != null && allyIds.has(c.store_id)).length;
    const totalLoopSlots = loopPlans.reduce((s, p) => s + (p.max_brands ?? 0), 0);
    const freeSlots = Math.max(0, totalLoopSlots - planSlots - allySlots);

    const byStore: Record<string, number> = {};
    for (const c of live) {
      if (c.store_id && allyIds.has(c.store_id)) {
        byStore[c.store_id] = (byStore[c.store_id] || 0) + 1;
      }
    }

    return { planSlots, allySlots, freeSlots, totalLoopSlots, byStore };
  }, [loopPlans, allies, activeCampaigns]);

  const getValue = (key: string) =>
    entries.find(e => e.key === key)?.value ?? '';

  const getUpdatedAt = (key: string) => {
    const ts = entries.find(e => e.key === key)?.updated_at;
    if (!ts) return null;
    return new Date(ts).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const handleSave = async (key: string) => {
    const meta = CONFIG_META[key];
    const raw = drafts[key] ?? getValue(key);
    const value = raw.trim();
    if (!value) return;

    if (meta?.type === 'number') {
      const n = Number(value);
      if (isNaN(n) || (meta.min !== undefined && n < meta.min) || (meta.max !== undefined && n > meta.max)) {
        alert(`Valor inválido. Debe estar entre ${meta.min} y ${meta.max}.`);
        return;
      }
    }

    setSaving(s => ({ ...s, [key]: true }));
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('app_config')
      .upsert({ key, value, description: meta?.hint ?? null, updated_at: now }, { onConflict: 'key' });

    if (error) {
      alert('Error al guardar: ' + error.message);
    } else {
      setEntries(prev => {
        const existing = prev.find(e => e.key === key);
        if (existing) return prev.map(e => e.key === key ? { ...e, value, updated_at: now } : e);
        return [...prev, { key, value, description: meta?.hint ?? null, updated_at: now }];
      });
      setDrafts(d => { const next = { ...d }; delete next[key]; return next; });
      setSaved(s => ({ ...s, [key]: true }));
      setTimeout(() => setSaved(s => ({ ...s, [key]: false })), 2000);
      await logAdminAction({
        action_type: 'EDITAR',
        entity_type: 'configuracion',
        entity_id: key,
        entity_name: meta?.label ?? key,
        details: { key, value },
      });
    }
    setSaving(s => ({ ...s, [key]: false }));
  };

  const handleSavePlanSlots = async (plan: LoopPlan) => {
    const raw = planDrafts[plan.id] ?? (plan.max_brands != null ? String(plan.max_brands) : '');
    const n = parseInt(raw);
    if (isNaN(n) || n < 0 || n > 500) {
      alert('Valor inválido. Debe ser un número entre 0 y 500.');
      return;
    }

    setPlanSaving(s => ({ ...s, [plan.id]: true }));
    const { error } = await supabase
      .from('plans')
      .update({ max_brands: n })
      .eq('id', plan.id);

    if (error) {
      alert('Error al guardar: ' + error.message);
    } else {
      setLoopPlans(prev => prev.map(p => p.id === plan.id ? { ...p, max_brands: n } : p));
      setPlanDrafts(d => { const next = { ...d }; delete next[plan.id]; return next; });
      setPlanSaved(s => ({ ...s, [plan.id]: true }));
      setTimeout(() => setPlanSaved(s => ({ ...s, [plan.id]: false })), 2000);
      await logAdminAction({
        action_type: 'EDITAR',
        entity_type: 'configuracion',
        entity_id: plan.plan_key,
        entity_name: `Slots ${plan.name}`,
        details: { plan_key: plan.plan_key, max_brands: n },
      });
    }
    setPlanSaving(s => ({ ...s, [plan.id]: false }));
  };

  const handleSaveAllyLimit = async (ally: AllyRow) => {
    const raw = allyLimitDrafts[ally.id] ?? String(ally.ally_campaign_limit);
    const n = parseInt(raw);
    if (isNaN(n) || n < 1 || n > 50) {
      alert('Valor inválido. Debe ser un número entre 1 y 50.');
      return;
    }
    setAllyLimitSaving(s => ({ ...s, [ally.id]: true }));
    const { error } = await supabase
      .from('stores')
      .update({ ally_campaign_limit: n })
      .eq('id', ally.id);
    if (error) {
      alert('Error al guardar: ' + error.message);
    } else {
      setAllies(prev => prev.map(a => a.id === ally.id ? { ...a, ally_campaign_limit: n } : a));
      setAllyLimitDrafts(d => { const next = { ...d }; delete next[ally.id]; return next; });
      setAllyLimitSaved(s => ({ ...s, [ally.id]: true }));
      setTimeout(() => setAllyLimitSaved(s => ({ ...s, [ally.id]: false })), 2000);
      await logAdminAction({
        action_type: 'EDITAR',
        entity_type: 'configuracion',
        entity_id: ally.id,
        entity_name: `Límite aliado ${ally.name}`,
        details: { ally_campaign_limit: n },
      });
    }
    setAllyLimitSaving(s => ({ ...s, [ally.id]: false }));
  };

  const isPlanDirty = (plan: LoopPlan) => {
    if (!(plan.id in planDrafts)) return false;
    return planDrafts[plan.id] !== (plan.max_brands != null ? String(plan.max_brands) : '');
  };

  const isAllyLimitDirty = (ally: AllyRow) => {
    if (!(ally.id in allyLimitDrafts)) return false;
    return allyLimitDrafts[ally.id] !== String(ally.ally_campaign_limit);
  };

  const { totalLoopSlots } = loopStats;
  const isDirty = (key: string) => key in drafts && drafts[key] !== getValue(key);
  const sections = groupBySection(entries);
  const hasSections = Object.keys(sections).length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Header */}
      <div>
        <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Sistema</p>
        <h2 className="text-2xl font-bold text-white">Configuración</h2>
        <p className="text-white/30 text-xs mt-1">
          Parámetros globales que controlan el comportamiento del sistema. Los cambios tienen efecto inmediato.
        </p>
      </div>

      {/* Sección: Slots por plan (loop publicitario) */}
      <div>
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3 flex items-center gap-2">
          <span className="h-px flex-1 bg-white/5" />
          Publicidad · Loop
          <span className="h-px flex-1 bg-white/5" />
        </h3>

        <div className="bg-[#111] border border-white/8 rounded-xl overflow-hidden">
          {/* Resumen del loop */}
          <div className="px-5 pt-5 pb-4 border-b border-white/5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-white text-sm font-semibold">Slots por plan</p>
                <p className="text-white/50 text-xs leading-relaxed mt-1 max-w-lg">
                  Cada plan con loop activo ocupa un número fijo de slots en el ciclo publicitario.
                  La suma de todos los slots define el tamaño total del loop.
                  Los aliados ocupan los slots sobrantes según su límite de campañas activas.
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[10px] text-white/30 uppercase tracking-wider">Total del loop</p>
                <p className="text-2xl font-bold text-white mt-0.5">{totalLoopSlots}</p>
                <p className="text-[10px] text-white/30">slots</p>
              </div>
            </div>

            {/* Barra visual del loop */}
            {loopPlans.length > 0 && (
              <div className="mt-4">
                <div className="flex rounded-full overflow-hidden h-2 bg-white/5">
                  {loopPlans.map((plan, i) => {
                    const pct = totalLoopSlots > 0 ? ((plan.max_brands ?? 0) / totalLoopSlots) * 100 : 0;
                    const colors = ['bg-cyan-500', 'bg-amber-500', 'bg-violet-500', 'bg-emerald-500'];
                    return (
                      <div
                        key={plan.id}
                        className={`${colors[i % colors.length]} transition-all`}
                        style={{ width: `${pct}%` }}
                        title={`${plan.name}: ${plan.max_brands} slots`}
                      />
                    );
                  })}
                </div>
                <div className="flex items-center gap-4 mt-2 flex-wrap">
                  {loopPlans.map((plan, i) => {
                    const colors = ['text-cyan-400', 'text-amber-400', 'text-violet-400', 'text-emerald-400'];
                    const dots = ['bg-cyan-500', 'bg-amber-500', 'bg-violet-500', 'bg-emerald-500'];
                    return (
                      <div key={plan.id} className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${dots[i % dots.length]}`} />
                        <span className={`text-[11px] ${colors[i % colors.length]}`}>{plan.name}</span>
                        <span className="text-white/30 text-[11px]">{plan.max_brands ?? 0} slots</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Filas editables por plan */}
          <div className="divide-y divide-white/5">
            {loopPlans.length === 0 && (
              <p className="px-5 py-4 text-white/30 text-xs">
                No hay planes con loop activo configurados. Activa <span className="font-mono">loop_eligible</span> en un plan desde la sección Planes.
              </p>
            )}
            {loopPlans.map(plan => {
              const currentVal = plan.max_brands != null ? String(plan.max_brands) : '';
              const draft = planDrafts[plan.id] ?? currentVal;
              const dirty = isPlanDirty(plan);
              const isSaving = planSaving[plan.id];
              const wasSaved = planSaved[plan.id];
              const draftNum = parseInt(draft) || 0;
              const pct = totalLoopSlots > 0 ? (draftNum / totalLoopSlots) * 100 : 0;

              return (
                <div key={plan.id} className="px-5 py-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium">{plan.name}</p>
                    <p className="text-[11px] font-mono text-white/25">{plan.plan_key}</p>
                  </div>

                  {/* Porcentaje del total */}
                  <div className="hidden sm:block w-24 text-right">
                    <p className="text-[11px] text-white/30">{Math.round(pct)}% del loop</p>
                  </div>

                  {/* Input */}
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      min={0}
                      max={500}
                      value={draft}
                      onChange={e => setPlanDrafts(d => ({ ...d, [plan.id]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleSavePlanSlots(plan); }}
                      className="w-20 bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono text-center focus:outline-none focus:border-orange-500/50 transition-colors"
                    />
                    <span className="text-white/30 text-xs">slots</span>
                  </div>

                  <button
                    onClick={() => handleSavePlanSlots(plan)}
                    disabled={isSaving || (!dirty && !!currentVal)}
                    className={`shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      wasSaved
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : dirty
                        ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30'
                        : 'bg-white/5 text-white/30 border border-white/5 cursor-default'
                    } disabled:opacity-50`}
                  >
                    {isSaving ? 'Guardando…' : wasSaved ? 'Guardado' : 'Guardar'}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Nota sobre duración estimada */}
          {totalLoopSlots > 0 && (
            <div className="px-5 py-3 border-t border-white/5 bg-white/[0.01] flex items-center justify-between flex-wrap gap-2">
              <p className="text-[11px] text-white/30">
                Duración estimada del loop completo:
              </p>
              <div className="flex items-center gap-4">
                <span className="text-[11px] text-white/40 font-mono">
                  Videos 15s → ≈ {Math.round(totalLoopSlots * 15 / 60 * 10) / 10} min
                </span>
                <span className="text-[11px] text-white/40 font-mono">
                  Videos 30s → ≈ {Math.round(totalLoopSlots * 30 / 60 * 10) / 10} min
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sección: Aliados en el loop */}
      <div>
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3 flex items-center gap-2">
          <span className="h-px flex-1 bg-white/5" />
          Publicidad · Aliados
          <span className="h-px flex-1 bg-white/5" />
        </h3>

        <div className="space-y-3">
          {/* Stats de slots: planes / aliados / libres */}
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                label: 'Slots por planes',
                value: loopStats.planSlots,
                of: totalLoopSlots,
                color: 'text-cyan-400',
                bar: 'bg-cyan-500',
              },
              {
                label: 'Slots por aliados',
                value: loopStats.allySlots,
                of: totalLoopSlots,
                color: 'text-violet-400',
                bar: 'bg-violet-500',
              },
              {
                label: 'Slots libres',
                value: loopStats.freeSlots,
                of: totalLoopSlots,
                color: loopStats.freeSlots === 0 ? 'text-red-400' : 'text-emerald-400',
                bar: loopStats.freeSlots === 0 ? 'bg-red-500' : 'bg-emerald-500',
              },
            ].map(stat => {
              const pct = totalLoopSlots > 0 ? (stat.value / totalLoopSlots) * 100 : 0;
              return (
                <div key={stat.label} className="bg-[#111] border border-white/8 rounded-xl px-4 py-4">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">{stat.label}</p>
                  <p className={`text-2xl font-bold font-mono ${stat.color}`}>
                    {stat.value}
                    <span className="text-white/20 text-sm font-normal">/{stat.of}</span>
                  </p>
                  <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${stat.bar}`}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-white/25 font-mono mt-1">{Math.round(pct)}%</p>
                </div>
              );
            })}
          </div>

          {/* Tabla de aliados con límite editable */}
          <div className="bg-[#111] border border-white/8 rounded-xl overflow-hidden">
            <div className="px-5 pt-5 pb-4 border-b border-white/5">
              <p className="text-white text-sm font-semibold">Límite de videos por aliado</p>
              <p className="text-white/50 text-xs leading-relaxed mt-1">
                Número máximo de campañas activas simultáneas que puede tener cada aliado en el loop.
                El sistema bloquea la activación si el loop no tiene slots libres.
              </p>
            </div>

            <div className="divide-y divide-white/5">
              {allies.length === 0 && (
                <p className="px-5 py-4 text-white/30 text-xs">
                  No hay tiendas aliadas registradas aún.
                </p>
              )}
              {allies.map(ally => {
                const active = loopStats.byStore[ally.id] || 0;
                const limit = ally.ally_campaign_limit;
                const draft = allyLimitDrafts[ally.id] ?? String(limit);
                const dirty = isAllyLimitDirty(ally);
                const isSaving = allyLimitSaving[ally.id];
                const wasSaved = allyLimitSaved[ally.id];
                const atCap = active >= limit;

                return (
                  <div key={ally.id} className="px-5 py-4 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{ally.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {/* Videos activos con mini barra */}
                        <span className={`text-[11px] font-mono ${atCap ? 'text-red-400' : 'text-white/40'}`}>
                          {active} activo{active !== 1 ? 's' : ''}
                        </span>
                        <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${atCap ? 'bg-red-500' : 'bg-violet-500'}`}
                            style={{ width: limit > 0 ? `${Math.min((active / limit) * 100, 100)}%` : '0%' }}
                          />
                        </div>
                        <span className="text-white/20 text-[10px] font-mono">/ {limit} límite</span>
                      </div>
                    </div>

                    {/* Chips de estado */}
                    {atCap && active > 0 && (
                      <span className="hidden sm:inline-flex shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
                        Al límite
                      </span>
                    )}

                    {/* Input límite */}
                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={draft}
                        onChange={e => setAllyLimitDrafts(d => ({ ...d, [ally.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') handleSaveAllyLimit(ally); }}
                        className="w-16 bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono text-center focus:outline-none focus:border-orange-500/50 transition-colors"
                      />
                      <span className="text-white/30 text-xs">videos</span>
                    </div>

                    <button
                      onClick={() => handleSaveAllyLimit(ally)}
                      disabled={isSaving || !dirty}
                      className={`shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                        wasSaved
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : dirty
                          ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30'
                          : 'bg-white/5 text-white/30 border border-white/5 cursor-default'
                      } disabled:opacity-50`}
                    >
                      {isSaving ? 'Guardando…' : wasSaved ? 'Guardado' : 'Guardar'}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Totales */}
            {allies.length > 0 && (
              <div className="px-5 py-3 border-t border-white/5 bg-white/[0.01] flex items-center justify-between flex-wrap gap-2">
                <p className="text-[11px] text-white/30">
                  {allies.length} aliado{allies.length !== 1 ? 's' : ''} · {loopStats.allySlots} video{loopStats.allySlots !== 1 ? 's' : ''} activo{loopStats.allySlots !== 1 ? 's' : ''} en el loop
                </p>
                <p className="text-[11px] text-white/20 font-mono">
                  Suma de límites: {allies.reduce((s, a) => s + a.ally_campaign_limit, 0)} slots máx. teórico
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Secciones de app_config (futuras configuraciones) */}
      {hasSections && Object.entries(sections).map(([section, keys]) => (
        <div key={section}>
          <h3 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3 flex items-center gap-2">
            <span className="h-px flex-1 bg-white/5" />
            {section}
            <span className="h-px flex-1 bg-white/5" />
          </h3>

          <div className="space-y-3">
            {keys.map(entry => {
              const meta = CONFIG_META[entry.key];
              if (!meta) return null;
              const currentValue = getValue(entry.key);
              const draft = drafts[entry.key] ?? currentValue;
              const dirty = isDirty(entry.key);
              const isSaving = saving[entry.key];
              const wasSaved = saved[entry.key];
              const warning = meta.warning ? meta.warning(draft) : null;
              const updatedAt = getUpdatedAt(entry.key);

              return (
                <div key={entry.key} className="bg-[#111] border border-white/8 rounded-xl overflow-hidden">
                  <div className="px-5 pt-5 pb-4 space-y-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-white text-sm font-semibold">{meta.label}</p>
                        <p className="text-[11px] font-mono text-white/25 mt-0.5">{entry.key}</p>
                      </div>
                      {updatedAt && (
                        <p className="text-[10px] text-white/20 shrink-0 pt-0.5">Última edición: {updatedAt}</p>
                      )}
                    </div>
                    <p className="text-white/50 text-xs leading-relaxed">{meta.hint}</p>
                  </div>

                  <div className="px-5 pb-5 flex items-end gap-3 flex-wrap">
                    <div className="flex-1 min-w-[140px]">
                      <label className="block text-[10px] text-white/30 uppercase tracking-wider mb-1.5">
                        Valor {meta.unit ? `(${meta.unit})` : ''}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type={meta.type === 'number' ? 'number' : 'text'}
                          min={meta.min}
                          max={meta.max}
                          value={draft}
                          onChange={e => setDrafts(d => ({ ...d, [entry.key]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') handleSave(entry.key); }}
                          className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-orange-500/50 transition-colors"
                        />
                        {meta.unit && (
                          <span className="text-white/30 text-xs shrink-0">{meta.unit}</span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => handleSave(entry.key)}
                      disabled={isSaving || (!dirty && !!currentValue)}
                      className={`shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                        wasSaved
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : dirty
                          ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30'
                          : 'bg-white/5 text-white/30 border border-white/5 cursor-default'
                      } disabled:opacity-50`}
                    >
                      {isSaving ? 'Guardando…' : wasSaved ? 'Guardado' : 'Guardar'}
                    </button>
                  </div>

                  {warning && (
                    <div className="mx-5 mb-5 flex items-start gap-2 bg-amber-500/8 border border-amber-500/20 rounded-lg px-3 py-2.5">
                      <svg className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <p className="text-amber-300 text-[11px] leading-relaxed">{warning}</p>
                    </div>
                  )}

                  {meta.preview && draft && Number(draft) > 0 && (() => {
                    const items = meta.preview(draft);
                    if (!items.length) return null;
                    return (
                      <div className="mx-5 mb-5 bg-white/[0.02] border border-white/5 rounded-lg px-4 py-3">
                        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Equivalencias</p>
                        <div className="space-y-1">
                          {items.map(item => (
                            <div key={item.label} className="flex items-center justify-between text-xs">
                              <span className="text-white/30">{item.label}</span>
                              <span className="text-white/60 font-mono">{item.value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Info footer */}
      <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 flex items-start gap-3">
        <svg className="w-4 h-4 text-white/20 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-white/25 text-xs leading-relaxed">
          Los slots por plan se guardan en <span className="font-mono text-white/40">plans.max_brands</span>. El límite por aliado vive en <span className="font-mono text-white/40">stores.ally_campaign_limit</span>. Todos los cambios quedan registrados en auditoría.
        </p>
      </div>
    </div>
  );
}
