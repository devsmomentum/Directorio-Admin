'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';

interface Kiosk { id: string; name: string; status: string; location_name: string; }
interface Campaign { id: string; brand_name: string; plan_type: string; is_active: boolean; }

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  ORO: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  SOCIOS: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  BONO_FLASH: 'text-pink-400 bg-pink-500/10 border-pink-500/30',
};

export default function KioskAssignment() {
  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  // Map: kiosk_id → Set of campaign_ids assigned
  const [assignments, setAssignments] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  // Which kiosk panel is open
  const [openKiosk, setOpenKiosk] = useState<string | null>(null);

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    const [kiosksRes, campsRes, assignRes] = await Promise.all([
      supabase.from('kiosks').select('id, name, status, location_name').order('name'),
      supabase.from('ad_campaigns').select('id, brand_name, plan_type, is_active').order('brand_name'),
      supabase.from('kiosk_campaigns').select('kiosk_id, campaign_id'),
    ]);
    if (kiosksRes.data) setKiosks(kiosksRes.data);
    if (campsRes.data) setCampaigns(campsRes.data);

    // Build assignment map
    const map: Record<string, Set<string>> = {};
    if (assignRes.data) {
      for (const row of assignRes.data) {
        if (!map[row.kiosk_id]) map[row.kiosk_id] = new Set();
        map[row.kiosk_id].add(row.campaign_id);
      }
    }
    setAssignments(map);
    setLoading(false);
  };

  const toggleCampaign = (kioskId: string, campaignId: string) => {
    setAssignments(prev => {
      const next = { ...prev };
      const set = new Set(next[kioskId] || []);
      if (set.has(campaignId)) set.delete(campaignId);
      else set.add(campaignId);
      next[kioskId] = set;
      return next;
    });
  };

  const saveKiosk = async (kioskId: string) => {
    setSaving(kioskId);
    try {
      // Delete all current assignments for this kiosk
      const { error: delErr } = await supabase.from('kiosk_campaigns').delete().eq('kiosk_id', kioskId);
      if (delErr) throw delErr;

      // Insert new ones
      const selected = assignments[kioskId];
      if (selected && selected.size > 0) {
        const rows = Array.from(selected).map(cid => ({ kiosk_id: kioskId, campaign_id: cid }));
        const { error: insErr } = await supabase.from('kiosk_campaigns').insert(rows);
        if (insErr) throw insErr;
      }
      // Close panel after save
      setOpenKiosk(null);
    } catch (e: any) {
      alert('Error: ' + e.message);
    } finally {
      setSaving(null);
    }
  };

  const resetKiosk = async (kioskId: string) => {
    if (!confirm('¿Restablecer a "Todas las campañas" para este kiosco?')) return;
    setSaving(kioskId);
    await supabase.from('kiosk_campaigns').delete().eq('kiosk_id', kioskId);
    setAssignments(prev => { const n = { ...prev }; delete n[kioskId]; return n; });
    setSaving(null);
  };

  if (loading) return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="bg-orange-500/5 border border-orange-500/15 rounded-lg px-4 py-3 flex items-start gap-3">
        <svg className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <div>
          <p className="text-orange-400 text-xs font-medium">Lógica de asignación</p>
          <p className="text-white/40 text-xs mt-0.5">
            Si un kiosco no tiene campañas específicas → muestra <strong className="text-white/60">todas</strong> las activas.
            Si tiene una selección → muestra <strong className="text-white/60">solo esas</strong>.
          </p>
        </div>
      </div>

      {/* Kiosk list */}
      <div className="space-y-2">
        {kiosks.map(k => {
          const assigned = assignments[k.id];
          const hasOverride = assigned && assigned.size > 0;
          const isOpen = openKiosk === k.id;

          return (
            <div key={k.id} className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
              {/* Kiosk row header */}
              <div className="flex items-center gap-4 px-4 py-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${k.status === 'active' ? 'bg-emerald-400' : 'bg-white/20'}`} />
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">{k.name}</p>
                    <p className="text-white/30 text-[10px]">{k.location_name}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {hasOverride ? (
                    <span className="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded-md font-medium">
                      {assigned.size} campaña{assigned.size !== 1 ? 's' : ''} específica{assigned.size !== 1 ? 's' : ''}
                    </span>
                  ) : (
                    <span className="text-[10px] text-white/30 bg-white/5 px-2 py-0.5 rounded-md">
                      Todas las campañas
                    </span>
                  )}

                  {hasOverride && (
                    <button
                      onClick={() => resetKiosk(k.id)}
                      disabled={saving === k.id}
                      title="Restablecer a todas"
                      className="p-1.5 text-white/20 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    </button>
                  )}

                  <button
                    onClick={() => setOpenKiosk(isOpen ? null : k.id)}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      isOpen
                        ? 'bg-white/10 text-white border-white/20'
                        : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white/70'
                    }`}
                  >
                    {isOpen ? 'Cerrar' : 'Configurar'}
                    <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </button>
                </div>
              </div>

              {/* Expanded campaign picker */}
              {isOpen && (
                <div className="border-t border-white/5 px-4 py-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[11px] text-white/40 uppercase tracking-wider">
                      Selecciona las campañas para <span className="text-white/60">{k.name}</span>
                    </p>
                    <p className="text-[10px] text-white/25">Vacío = mostrar todas</p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                    {campaigns.map(c => {
                      const checked = assigned?.has(c.id) ?? false;
                      return (
                        <label
                          key={c.id}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                            checked
                              ? 'bg-orange-500/10 border-orange-500/25'
                              : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.04]'
                          } ${!c.is_active ? 'opacity-40' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCampaign(k.id, c.id)}
                            className="w-3.5 h-3.5 accent-orange-400 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-white text-xs font-medium truncate">{c.brand_name}</p>
                            {!c.is_active && <p className="text-white/25 text-[10px]">pausada</p>}
                          </div>
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${PLAN_COLORS[c.plan_type] || 'text-white/30 border-white/10 bg-white/5'}`}>
                            {c.plan_type}
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setOpenKiosk(null)}
                      className="flex-1 py-2 text-sm bg-white/5 hover:bg-white/10 text-white/40 rounded-lg transition-colors"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => saveKiosk(k.id)}
                      disabled={saving === k.id}
                      className="flex-1 py-2 text-sm bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border border-orange-500/30 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {saving === k.id ? 'Guardando...' : `Guardar para ${k.name}`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
