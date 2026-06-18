'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import Pagination, { usePagination } from '../../components/Pagination';
import { PLAN_COLOR_PARTS as PLAN_COLORS, DEFAULT_PLAN_COLOR as DEFAULT_COLOR } from '../../../lib/plans';
import { toast } from '../../components/toast';
import { confirmDialog } from '../../components/confirm-dialog';

// Planes that apply to stores and/or coupons - managed in the store_plans table
// Falls back to inline editable plan definitions if no dedicated table exists

export default function PlanesCRUD() {
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  // Form fields
  const [planName, setPlanName] = useState('');
  const [planKey, setPlanKey] = useState('');
  const [description, setDescription] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  const [priceUsd, setPriceUsd] = useState('');
  const [appliesTo, setAppliesTo] = useState<string[]>(['stores']);
  const [features, setFeatures] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [displayOrder, setDisplayOrder] = useState('0');

  // Reglas del directorio (loop de 3 min / 12 slots)
  const [maxBrands, setMaxBrands] = useState('');          // vacío = ilimitado
  const [videoSeconds, setVideoSeconds] = useState('15');
  const [priorityLevel, setPriorityLevel] = useState('99');
  const [loopEligible, setLoopEligible] = useState(false);
  const [hasFixedBanner, setHasFixedBanner] = useState(false);

  // Reglas de cupones Flash
  const [couponStockCap, setCouponStockCap] = useState('20');

  useEffect(() => {
    fetchPlans();
  }, []);

  const fetchPlans = async () => {
    setRefreshing(true);
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .order('display_order', { ascending: true })
      .limit(200);

    if (data) setPlans(data);
    if (error) {
      // Table might not exist yet — show empty state gracefully
      console.warn('plans table not found:', error.message);
    }
    setLoading(false);
    setRefreshing(false);
  };

  const resetForm = () => {
    setEditingId(null);
    setPlanName('');
    setPlanKey('');
    setDescription('');
    setDurationDays('30');
    setPriceUsd('');
    setAppliesTo(['stores']);
    setFeatures('');
    setIsActive(true);
    setDisplayOrder('0');
    setMaxBrands('');
    setVideoSeconds('15');
    setPriorityLevel('99');
    setLoopEligible(false);
    setHasFixedBanner(false);
    setCouponStockCap('20');
    setShowForm(false);
  };

  const handleEdit = (plan: any) => {
    setEditingId(plan.id);
    setPlanName(plan.name || '');
    setPlanKey(plan.plan_key || '');
    setDescription(plan.description || '');
    setDurationDays(String(plan.duration_days ?? 30));
    setPriceUsd(String(plan.price_usd ?? ''));
    setAppliesTo(plan.applies_to || ['stores']);
    setFeatures((plan.features || []).join('\n'));
    setIsActive(plan.is_active ?? true);
    setDisplayOrder(String(plan.display_order ?? 0));
    setMaxBrands(plan.max_brands != null ? String(plan.max_brands) : '');
    setVideoSeconds(String(plan.video_seconds ?? 15));
    setPriorityLevel(String(plan.priority_level ?? 99));
    setLoopEligible(plan.loop_eligible ?? false);
    setHasFixedBanner(plan.has_fixed_banner ?? false);
    setCouponStockCap(String(plan.coupon_stock_cap ?? 20));
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planName || !planKey) {
      toast.error('El nombre y la clave del plan son obligatorios.');
      return;
    }
    setSubmitting(true);

    const payload = {
      name: planName,
      plan_key: planKey.toUpperCase().replace(/\s+/g, '_'),
      description,
      duration_days: parseInt(durationDays) || 30,
      price_usd: priceUsd ? parseFloat(priceUsd) : null,
      applies_to: appliesTo,
      features: features.split('\n').map(f => f.trim()).filter(Boolean),
      is_active: isActive,
      display_order: parseInt(displayOrder) || 0,
      max_brands: maxBrands === '' ? null : parseInt(maxBrands),
      video_seconds: parseInt(videoSeconds) || 0,
      priority_level: parseInt(priorityLevel) || 99,
      loop_eligible: loopEligible,
      has_fixed_banner: hasFixedBanner,
      coupon_stock_cap: parseInt(couponStockCap) || 20,
    };

    try {
      if (editingId) {
        // No se reescribe plan_key en un plan existente: es la llave que vincula
        // tiendas, campañas, cupones y solicitudes (no hay FK que haga cascada).
        const { plan_key, ...updatePayload } = payload;
        const { error } = await supabase
          .from('plans')
          .update({ ...updatePayload, updated_at: new Date().toISOString() })
          .eq('id', editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('plans').insert([payload]);
        if (error) throw error;
      }
      resetForm();
      fetchPlans();
      toast.success(editingId ? 'Plan actualizado.' : 'Plan creado.');
    } catch (error: any) {
      toast.error('Error: ' + error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({ title: 'Eliminar plan', message: 'Las tiendas o cupones que lo usen quedarán sin plan asignado.', confirmLabel: 'Eliminar', tone: 'danger' });
    if (!ok) return;
    const { error } = await supabase.from('plans').delete().eq('id', id);
    if (error) { toast.error('No se pudo eliminar: ' + error.message); return; }
    fetchPlans();
    toast.success('Plan eliminado.');
  };

  const handleToggleActive = async (id: string, current: boolean) => {
    const { error } = await supabase.from('plans').update({ is_active: !current }).eq('id', id);
    if (error) { toast.error('Error: ' + error.message); return; }
    setPlans(prev => prev.map(p => p.id === id ? { ...p, is_active: !current } : p));
  };

  const toggleAppliesTo = (value: string) => {
    setAppliesTo(prev =>
      prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]
    );
  };

  const filtered = useMemo(() => {
    if (!search) return plans;
    const q = search.toLowerCase();
    return plans.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.plan_key || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    );
  }, [plans, search]);
  const pg = usePagination(filtered);

  const color = (key: string) => PLAN_COLORS[key] || DEFAULT_COLOR;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">Configuración</p>
          <h2 className="text-2xl font-bold text-white">Planes</h2>
          <p className="text-white/30 text-xs mt-1">Planes que se pueden asignar a tiendas, cupones y campañas publicitarias</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchPlans}
            disabled={refreshing}
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-2 text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white rounded-lg px-4 py-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
            Nuevo plan
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre o clave..."
          className="w-full bg-[#111] border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/10 transition-colors"
        />
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {editingId ? 'Editar plan' : 'Nuevo plan'}
                </h3>
                <p className="text-white/30 text-xs mt-0.5">Define las condiciones del plan</p>
              </div>
              <button onClick={resetForm} className="text-white/30 hover:text-white/60 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre del plan</label>
                  <input
                    type="text"
                    required
                    value={planName}
                    onChange={(e) => setPlanName(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                    placeholder="Ej: Plan Oro"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Clave (código)</label>
                  <input
                    type="text"
                    required
                    value={planKey}
                    onChange={(e) => setPlanKey(e.target.value.toUpperCase().replace(/\s+/g, '_'))}
                    disabled={!!editingId}
                    title={editingId ? 'La clave no se puede cambiar en un plan existente' : undefined}
                    className={`w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-purple-500/50 transition-colors ${editingId ? 'opacity-50 cursor-not-allowed' : ''}`}
                    placeholder="Ej: ORO"
                  />
                  <p className="text-[10px] text-white/20 mt-1">
                    {editingId
                      ? 'La clave no se puede cambiar: vincula tiendas, campañas y cupones existentes.'
                      : 'Solo mayúsculas y guiones bajos'}
                  </p>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripción</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                  placeholder="Breve descripción del plan..."
                />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Duración (días)</label>
                  <input
                    type="number"
                    min="1"
                    value={durationDays}
                    onChange={(e) => setDurationDays(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                    placeholder="30"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Precio ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={priceUsd}
                    onChange={(e) => setPriceUsd(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Orden visual</label>
                  <input
                    type="number"
                    min="0"
                    value={displayOrder}
                    onChange={(e) => setDisplayOrder(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                    placeholder="0"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-2">Aplica a</label>
                <div className="flex gap-2">
                  {[
                    { value: 'stores', label: 'Tiendas' },
                    { value: 'coupons', label: 'Cupones' },
                    { value: 'campaigns', label: 'Campañas' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleAppliesTo(opt.value)}
                      className={`flex-1 py-2 text-xs font-medium rounded-lg border transition-colors ${
                        appliesTo.includes(opt.value)
                          ? 'bg-purple-500/20 text-purple-400 border-purple-500/40'
                          : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* ── Reglas de Cupones Flash ── */}
              {(planKey.includes('FLASH') || appliesTo.includes('coupons')) && (
                <div className="bg-pink-500/[0.04] border border-pink-500/15 rounded-lg p-3 space-y-3">
                  <p className="text-[10px] text-pink-300/60 uppercase tracking-widest font-medium">Reglas de Cupones Flash</p>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Tope de stock total</label>
                    <input
                      type="number" min="1" max="500" value={couponStockCap}
                      onChange={(e) => setCouponStockCap(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50 transition-colors"
                      placeholder="20"
                    />
                    <p className="text-[10px] text-white/20 mt-1">Máx. de unidades de stock (disponible + canjeado) por tienda. Default 20.</p>
                  </div>
                </div>
              )}

              {/* ── Reglas del loop (Directorios) ── */}
              <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3 space-y-3">
                <p className="text-[10px] text-white/40 uppercase tracking-widest font-medium">Reglas del loop (Directorios)</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Máx. marcas</label>
                    <input
                      type="number" min="0" value={maxBrands}
                      onChange={(e) => setMaxBrands(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                      placeholder="∞"
                    />
                    <p className="text-[10px] text-white/20 mt-1">Vacío = ilimitado</p>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Video (seg)</label>
                    <input
                      type="number" min="0" max="120" value={videoSeconds}
                      onChange={(e) => setVideoSeconds(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                      placeholder="15"
                    />
                    <p className="text-[10px] text-white/20 mt-1">Default de las campañas · 0 = sin video</p>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Prioridad</label>
                    <input
                      type="number" min="1" value={priorityLevel}
                      onChange={(e) => setPriorityLevel(e.target.value)}
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                      placeholder="99"
                    />
                    <p className="text-[10px] text-white/20 mt-1">1 = mayor</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setLoopEligible(!loopEligible)}
                    className={`flex items-center justify-between py-2 px-3 text-xs font-medium rounded-lg border transition-colors ${
                      loopEligible
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-white/5 text-white/40 border-white/10'
                    }`}
                  >
                    <span>Aparece en loop</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${loopEligible ? 'bg-emerald-400' : 'bg-white/20'}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setHasFixedBanner(!hasFixedBanner)}
                    className={`flex items-center justify-between py-2 px-3 text-xs font-medium rounded-lg border transition-colors ${
                      hasFixedBanner
                        ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
                        : 'bg-white/5 text-white/40 border-white/10'
                    }`}
                  >
                    <span>Banner fijo</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${hasFixedBanner ? 'bg-cyan-400' : 'bg-white/20'}`} />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Beneficios / Features <span className="normal-case tracking-normal">(uno por línea)</span>
                </label>
                <textarea
                  value={features}
                  onChange={(e) => setFeatures(e.target.value)}
                  rows={3}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors resize-none"
                  placeholder={"Aparición cada 90 segundos\nIncluye video hasta 30s\nSoporte prioritario"}
                />
              </div>
              <div className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2.5">
                <label className="text-[11px] text-white/40 uppercase tracking-wider flex-1">Activo</label>
                <button
                  type="button"
                  onClick={() => setIsActive(!isActive)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${isActive ? 'bg-purple-500/40' : 'bg-white/10'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={resetForm}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 px-5 py-2.5 text-sm font-medium bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 border border-purple-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear plan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cards or Table */}
      {plans.length === 0 ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <svg className="w-10 h-10 text-white/10 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
          <p className="text-white/30 text-sm">No hay planes definidos</p>
          <p className="text-white/15 text-xs mt-1">Crea un plan para asignarlo a tiendas o cupones</p>
          <p className="text-white/10 text-xs mt-3">
            Nota: si ves este mensaje, asegúrate de crear la tabla <code className="font-mono">plans</code> en Supabase
          </p>
        </div>
      ) : (
        <>
          {/* Plan cards grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((plan) => {
              const c = color(plan.plan_key);
              return (
                <div
                  key={plan.id}
                  className={`relative bg-[#111] border ${c.border} rounded-xl p-5 group hover:bg-white/[0.02] transition-colors`}
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wider ${c.badge}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                        {plan.plan_key}
                      </span>
                      <h3 className="text-white font-semibold text-sm mt-2">{plan.name}</h3>
                      {plan.description && (
                        <p className="text-white/30 text-xs mt-0.5">{plan.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                      <button
                        onClick={() => handleEdit(plan)}
                        className="p-1.5 rounded-md text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDelete(plan.id)}
                        className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-4 mb-3 flex-wrap">
                    <div>
                      <p className="text-[10px] text-white/30 uppercase tracking-wider">Duración</p>
                      <p className="text-white/70 text-xs font-mono mt-0.5">{plan.duration_days}d</p>
                    </div>
                    {plan.price_usd != null && (
                      <div>
                        <p className="text-[10px] text-white/30 uppercase tracking-wider">Precio</p>
                        <p className="text-emerald-400 text-xs font-mono mt-0.5">${Number(plan.price_usd).toFixed(2)}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] text-white/30 uppercase tracking-wider">Máx</p>
                      <p className="text-white/70 text-xs font-mono mt-0.5">
                        {plan.max_brands != null ? `${plan.max_brands} marcas` : '∞'}
                      </p>
                    </div>
                    {plan.video_seconds > 0 && (
                      <div>
                        <p className="text-[10px] text-white/30 uppercase tracking-wider">Video</p>
                        <p className="text-white/70 text-xs font-mono mt-0.5">{plan.video_seconds}s</p>
                      </div>
                    )}
                  </div>

                  {/* Loop / banner badges */}
                  <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                    {plan.loop_eligible && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400">
                        <span className="w-1 h-1 rounded-full bg-emerald-400" /> En loop
                      </span>
                    )}
                    {plan.has_fixed_banner && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-400">
                        <span className="w-1 h-1 rounded-full bg-cyan-400" /> Banner fijo
                      </span>
                    )}
                    {plan.priority_level != null && plan.priority_level < 99 && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-white/5 text-white/50 font-mono">
                        P{plan.priority_level}
                      </span>
                    )}
                    <span className="inline-flex items-center text-[10px] text-white/30 px-1">
                      {(plan.applies_to || []).join(' · ')}
                    </span>
                  </div>

                  {/* Features */}
                  {plan.features && plan.features.length > 0 && (
                    <ul className="space-y-1 mb-3">
                      {plan.features.slice(0, 3).map((f: string, i: number) => (
                        <li key={i} className="flex items-center gap-1.5 text-[11px] text-white/40">
                          <svg className="w-3 h-3 text-emerald-500/60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          {f}
                        </li>
                      ))}
                      {plan.features.length > 3 && (
                        <li className="text-[11px] text-white/20">+{plan.features.length - 3} más...</li>
                      )}
                    </ul>
                  )}

                  {/* Status toggle */}
                  <button
                    onClick={() => handleToggleActive(plan.id, plan.is_active)}
                    className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-md transition-colors ${
                      plan.is_active
                        ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
                        : 'text-white/30 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${plan.is_active ? 'bg-emerald-500' : 'bg-white/20'}`} />
                    {plan.is_active ? 'Activo' : 'Inactivo'}
                  </button>
                </div>
              );
            })}
          </div>

          {pg.totalPages > 1 && (
            <Pagination
              page={pg.page}
              totalPages={pg.totalPages}
              total={pg.total}
              perPage={pg.perPage}
              label="planes"
              onPageChange={pg.setPage}
              onPerPageChange={pg.changePerPage}
            />
          )}
        </>
      )}
    </div>
  );
}
