'use client';

import { useEffect, useMemo, useState, ChangeEvent } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';
import { removePublicidadFile } from '../../../lib/storage';
import { validateKioskVideo } from '../../../lib/videoValidation';
import { useClienteStore } from '../store-context';
import K2BannerPreview from '../../components/K2BannerPreview';
import K2CampaignPreview from '../../components/K2CampaignPreview';

const PLAN_LABELS: Record<string, string> = {
  DIAMANTE: 'Diamante',
  ORO: 'Oro',
  IA_PERFORMANCE: 'IA Performance',
  FLASH_COUPON_DIARIO: 'Cupones Flash · Diario',
  FLASH_COUPON_SEMANAL: 'Cupones Flash · Semanal',
  PUBLI_PROMO_DIARIO: 'Publi Promo · Diario',
  PUBLI_PROMO_SEMANAL: 'Publi Promo · Semanal',
};

const PLAN_COLORS: Record<string, string> = {
  DIAMANTE: 'text-cyan-300 bg-cyan-500/10',
  ORO: 'text-amber-300 bg-amber-500/10',
  IA_PERFORMANCE: 'text-purple-300 bg-purple-500/10',
  FLASH_COUPON_DIARIO: 'text-pink-300 bg-pink-500/10',
  FLASH_COUPON_SEMANAL: 'text-pink-300 bg-pink-500/10',
  PUBLI_PROMO_DIARIO: 'text-blue-300 bg-blue-500/10',
  PUBLI_PROMO_SEMANAL: 'text-blue-300 bg-blue-500/10',
};

const FLASH_PLANS = new Set(['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL']);

const APPROVAL_CHIP: Record<string, { label: string; cls: string }> = {
  pending:  { label: 'EN REVISIÓN', cls: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
  approved: { label: 'APROBADA',    cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' },
  rejected: { label: 'RECHAZADA',   cls: 'text-red-300 bg-red-500/15 border-red-500/30' },
};
const CAMPAIGN_CAPABLE = new Set(['DIAMANTE', 'ORO', 'PUBLI_PROMO_DIARIO', 'PUBLI_PROMO_SEMANAL']);

const FLASH_GALLERY_MAX = 20;
// Tope de inventario de cupones por tienda: la SUMA de amount_available de los
// cupones vigentes (no rechazados, no vencidos) no puede pasar de 20. La barrera
// real es el trigger guard_coupons_owner_insert/update; esto es solo UX.
const COUPON_STOCK_CAP = 20;
const FLASH_PERIOD_LIMITS: Record<string, { max: number; windowDays: number; label: string }> = {
  FLASH_COUPON_DIARIO: { max: 10, windowDays: 1, label: 'día' },
  FLASH_COUPON_SEMANAL: { max: 30, windowDays: 5, label: 'semana (5 días)' },
};

const CAMPAIGN_DURATION_SECONDS = 15;

// Lectura tolerante de los agregados diarios (mismo criterio que el dashboard):
// las filas previas a la migración 034 solo traen `count`; las nuevas traen
// impressions_valid (vistas >= 5 s) y full_views (vistas completas).
const validOf = (d: any) => (d.impressions_valid ?? d.count) || 0;
const fullOf = (d: any) => d.full_views || 0;
// Resta días a una fecha 'YYYY-MM-DD' en UTC (comparaciones por string del agregado).
const dayMinus = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
};

type FilterKind = 'all' | 'coupons' | 'campaigns' | 'banners';
type FormKind = null | 'pick' | 'coupon' | 'campaign' | 'banner';

export default function ClientePromocionesPage() {
  const { selectedStore: store } = useClienteStore();
  // Las métricas de campañas solo las ve el dueño de la tienda (no vendedores/anunciantes).
  const isOwner = store?.store_role === 'owner';
  const [coupons, setCoupons] = useState<any[]>([]);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [banners, setBanners] = useState<any[]>([]);
  // Agregados diarios de impresiones por campaña (solo dueño). Campaña cuya
  // tarjeta de métricas está abierta en el modal de solo lectura.
  const [impressions, setImpressions] = useState<any[]>([]);
  const [metricsFor, setMetricsFor] = useState<any | null>(null);
  const [flashBrandIds, setFlashBrandIds] = useState<Set<string>>(new Set());
  const [couponLeadsMap, setCouponLeadsMap] = useState<Record<string, number>>({});
  const [couponRedeemedMap, setCouponRedeemedMap] = useState<Record<string, number>>({});
  const [flashPlanStockCap, setFlashPlanStockCap] = useState<number>(COUPON_STOCK_CAP);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [filter, setFilter] = useState<FilterKind>('all');

  const [form, setForm] = useState<FormKind>(null);

  // Coupon form state — todo cupón es Flash (sólo tiendas con addon activo pueden crear).
  const [cEditingId, setCEditingId] = useState<string | null>(null);
  const [cTitle, setCTitle] = useState('');
  const [cCategory, setCCategory] = useState('');
  const [cDiscount, setCDiscount] = useState<string>('');
  const [cStock, setCStock] = useState<string>('');
  const [cImageFile, setCImageFile] = useState<File | null>(null);
  const [cImageUrl, setCImageUrl] = useState('');
  const [cStartDate, setCStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [cEndDate, setCEndDate] = useState('');

  // Campaign form state
  const [aEditingId, setAEditingId] = useState<string | null>(null);
  const [aBrandName, setABrandName] = useState('');
  const [aDescription, setADescription] = useState('');
  const [aMediaFile, setAMediaFile] = useState<File | null>(null);
  const [aMediaUrl, setAMediaUrl] = useState('');
  const [aMediaType, setAMediaType] = useState<'image' | 'video'>('video');
  const [aStartDate, setAStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [aEndDate, setAEndDate] = useState('');
  const [aIsActive, setAIsActive] = useState(true);
  // Si el video de campaña debe reproducirse con audio en el kiosco.
  const [aAudioEnabled, setAAudioEnabled] = useState(false);

  // Banner form state
  const [bEditingId, setBEditingId] = useState<string | null>(null);
  const [bUiPosition, setBUiPosition] = useState<string>('home_hero');
  const [bSlotPosition, setBSlotPosition] = useState<string>('1');
  const [bMediaFile, setBMediaFile] = useState<File | null>(null);
  const [bMediaUrl, setBMediaUrl] = useState<string>('');
  const [bMediaType, setBMediaType] = useState<'image' | 'video'>('image');
  const [bStartDate, setBStartDate] = useState<string>('');
  const [bEndDate, setBEndDate] = useState<string>('');
  const [bPreviewPosition, setBPreviewPosition] = useState<'top' | 'bottom'>('top');

  const [submitting, setSubmitting] = useState(false);

  // Capacidad del loop en slots = suma de plans.max_brands donde loop_eligible = true.
  const [loopMaxSlots, setLoopMaxSlots] = useState<number>(32);
  const [loopSlotsUsed, setLoopSlotsUsed] = useState<number>(0);

  // Modal de conflicto: una empresa solo puede tener UNA campaña activa a la vez.
  const [conflict, setConflict] = useState<{ active: any; step: 'choose' | 'queue-dates' } | null>(null);
  const [qStartDate, setQStartDate] = useState('');
  const [qEndDate, setQEndDate] = useState('');

  // Modal de reactivación: reactivar una campaña VENCIDA exige un nuevo rango de
  // fechas (no re-aprobación; eso solo lo dispara cambiar video o texto).
  const [reactivate, setReactivate] = useState<any | null>(null);
  const [rStartDate, setRStartDate] = useState('');
  const [rEndDate, setREndDate] = useState('');

  // Modal de confirmación in-app (reemplaza window.confirm para acciones destructivas).
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    tone: 'danger' | 'warning';
    onConfirm: () => void;
  } | null>(null);

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const planActive = !!store?.plan_type
    && (!store.contract_expiry_date || store.contract_expiry_date >= today);
  const flashActive = !!store?.flash_coupon_plan
    && (!store.flash_coupon_expiry_date || store.flash_coupon_expiry_date >= today);

  // Tienda aliada: campañas + cupones flash sin pagar plan. El estatus es
  // permanente (no usa contract_expiry_date) y el cap de campañas lo fija el
  // admin (ally_campaign_limit). La barrera real es RLS + triggers.
  const isAlly = !!store?.is_ally;
  const allyFlash = isAlly && !!store?.ally_flash_enabled;
  const allyCampaignLimit = isAlly ? Math.max(1, store?.ally_campaign_limit ?? 1) : 1;

  const canFlashCoupon = allyFlash || flashActive;
  const canCampaign = isAlly || (planActive && !!store?.plan_type && CAMPAIGN_CAPABLE.has(store.plan_type));
  const canBanner = planActive && store?.plan_type === 'DIAMANTE';
  const canCreateCoupon = canFlashCoupon;

  // Aliado sin addon flash de pago usa la semántica generosa (SEMANAL).
  const couponPlanType = useMemo(
    () => store?.flash_coupon_plan || (allyFlash ? 'FLASH_COUPON_SEMANAL' : ''),
    [store, allyFlash],
  );

  const fetchData = async () => {
    if (!store) { setLoading(false); return; }
    setLoading(true);
    const [mineCoupons, gallery, mineCampaigns, mineBanners, flashPlan, storeLeads, loopPlans, loopUsage] = await Promise.all([
      supabase.from('coupons').select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('coupons').select('store_id, plan_type, amount_available, end_date')
        .in('plan_type', ['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL'])
        .gt('amount_available', 0)
        .gte('end_date', new Date().toISOString()),
      supabase.from('ad_campaigns').select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('banners').select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(200),
      store.flash_coupon_plan
        ? supabase.from('plans').select('coupon_stock_cap').eq('plan_key', store.flash_coupon_plan).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('coupon_leads').select('coupon_id, status').eq('store_id', store.id),
      supabase.from('plans').select('max_brands').eq('loop_eligible', true).not('max_brands', 'is', null),
      supabase.from('ad_campaigns').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ]);
    if (loopPlans.data) {
      const total = (loopPlans.data as { max_brands: number }[]).reduce((s, p) => s + (p.max_brands ?? 0), 0);
      if (total > 0) setLoopMaxSlots(total);
    }
    if (loopUsage.count !== null) setLoopSlotsUsed(loopUsage.count);
    const camps = mineCampaigns.data || [];
    const leadsRaw = storeLeads.data || [];
    // Mapa coupon_id → total de leads (para sumar al stock disponible en el cap)
    const leadsMap: Record<string, number> = {};
    // Mapa coupon_id → cantidad realmente canjeada
    const redeemedMap: Record<string, number> = {};
    for (const l of leadsRaw) {
      if (l.coupon_id) {
        leadsMap[l.coupon_id] = (leadsMap[l.coupon_id] || 0) + 1;
        if (l.status === 'CANJEADO') {
          redeemedMap[l.coupon_id] = (redeemedMap[l.coupon_id] || 0) + 1;
        }
      }
    }
    setCoupons(mineCoupons.data || []);
    setCouponLeadsMap(leadsMap);
    setCouponRedeemedMap(redeemedMap);
    setFlashBrandIds(new Set((gallery.data || []).map((c: any) => c.store_id).filter(Boolean)));
    setCampaigns(camps);
    setBanners(mineBanners.data || []);
    const planCap = (flashPlan as any)?.data?.coupon_stock_cap;
    setFlashPlanStockCap(planCap ?? COUPON_STOCK_CAP);

    // Métricas de visualización por campaña: solo el dueño las ve. Leemos el
    // agregado diario (RLS lo deja leer; filtramos por nuestras campañas) y lo
    // procesamos en cliente para Hoy / 7 d / 30 d / total + desglose por kiosco.
    if (isOwner && camps.length) {
      const { data: imp } = await supabase.from('ad_impressions_daily')
        .select('campaign_id, kiosk_id, day, count, impressions_valid, full_views')
        .in('campaign_id', camps.map((c: any) => c.id));
      setImpressions(imp || []);
    } else {
      setImpressions([]);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store?.id]);

  const flashIssuedInWindow = (flavor: string): number => {
    const limit = FLASH_PERIOD_LIMITS[flavor];
    if (!limit) return 0;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (limit.windowDays - 1));
    return coupons.filter(c =>
      c.id !== cEditingId &&
      c.plan_type === flavor &&
      new Date(c.start_date) >= start
    ).length;
  };

  const resetCouponForm = () => {
    setCEditingId(null);
    setCTitle(''); setCCategory('');
    setCDiscount(''); setCStock('');
    setCImageFile(null); setCImageUrl('');
    setCStartDate(today); setCEndDate('');
  };
  const resetCampaignForm = () => {
    setAEditingId(null);
    setABrandName(''); setADescription('');
    setAMediaFile(null); setAMediaUrl(''); setAMediaType('video');
    setAStartDate(today); setAEndDate('');
    setAIsActive(true);
    setAAudioEnabled(false);
  };
  const openCreateBanner = () => {
    resetBannerForm();
    setForm('banner');
  };

  const openEditBanner = (b: any) => {
    setBEditingId(b.id);
    setBUiPosition(b.ui_position);
    setBSlotPosition(String(b.slot_position || '1'));
    setBMediaUrl(b.media_url);
    setBMediaType(b.media_type);
    setBStartDate(b.start_date ? b.start_date.split('T')[0] : today);
    setBEndDate(b.end_date ? b.end_date.split('T')[0] : (store?.contract_expiry_date || ''));
    setForm('banner');
  };

  const resetBannerForm = () => {
    setBEditingId(null);
    setBUiPosition('home_hero');
    setBSlotPosition('1');
    setBMediaFile(null);
    setBMediaUrl('');
    setBMediaType('image');
    setBStartDate(today);
    setBEndDate(store?.contract_expiry_date || '');
  };

  const closeForm = () => {
    if (submitting) return;
    setForm(null);
    resetCouponForm();
    resetCampaignForm();
    resetBannerForm();
  };

  const openCreateCoupon = () => {
    if (!canFlashCoupon) {
      setFeedback({ type: 'err', msg: 'Necesitas el plan Cupones Flash activo para crear cupones.' });
      return;
    }
    resetCouponForm();
    setForm('coupon');
  };
  const openCreateCampaign = () => {
    resetCampaignForm();
    setForm('campaign');
  };

  const openEditCoupon = (c: any) => {
    setCEditingId(c.id);
    setCTitle(c.title || '');
    setCCategory(c.category || '');
    setCDiscount(c.discount_percent != null ? String(c.discount_percent) : '');
    setCStock(c.amount_available != null ? String(c.amount_available) : '');
    setCImageFile(null);
    setCImageUrl(c.image_url || '');
    setCStartDate((c.start_date || today).split('T')[0]);
    setCEndDate((c.end_date || '').split('T')[0]);
    setForm('coupon');
  };
  const openEditCampaign = (c: any) => {
    setAEditingId(c.id);
    setABrandName(c.brand_name || '');
    setADescription(c.description || '');
    setAMediaUrl(c.media_url || '');
    setAMediaType((c.media_type as 'image' | 'video') || 'video');
    setAStartDate(c.start_date || today);
    setAEndDate(c.end_date || '');
    setAMediaFile(null);
    setAIsActive(!!c.is_active);
    setAAudioEnabled(!!c.audio_enabled);
    setForm('campaign');
  };

  const handleImage = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 500 * 1024) { alert('La imagen debe pesar menos de 500 KB.'); e.target.value = ''; return; }
    setCImageFile(f);
    setCImageUrl(URL.createObjectURL(f));
  };
  const handleMedia = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const isVideo = f.type.startsWith('video/');
    const limitBytes = isVideo ? 120 * 1024 * 1024 : 50 * 1024 * 1024;
    if (f.size > limitBytes) {
      alert(`El archivo debe pesar menos de ${isVideo ? '120 MB' : '50 MB'}.`);
      e.target.value = '';
      return;
    }
    // Los videos 4K / HEVC / Level alto no los levanta el decoder del kiosco K2:
    // los bloqueamos aquí para que el cliente no descubra el fallo en el equipo.
    if (f.type.startsWith('video/')) {
      const check = await validateKioskVideo(f);
      if (!check.ok) { alert(check.message); e.target.value = ''; return; }
    }
    setAMediaFile(f);
    setAMediaType(f.type.startsWith('video/') ? 'video' : 'image');
    setAMediaUrl(URL.createObjectURL(f));
  };

  const submitCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    if (!canFlashCoupon) {
      setFeedback({ type: 'err', msg: 'Necesitas el plan Cupones Flash activo para publicar cupones.' });
      return;
    }
    const planType = couponPlanType;
    if (!planType) {
      setFeedback({ type: 'err', msg: 'No se detecta tu addon Flash. Recarga la página.' });
      return;
    }
    if (!cEndDate) { setFeedback({ type: 'err', msg: 'Indica la fecha de vencimiento.' }); return; }
    const planExpiry = store.flash_coupon_expiry_date;
    if (planExpiry && cEndDate > planExpiry) {
      setFeedback({
        type: 'err',
        msg: `El cupón no puede vencer después de tu plan Cupones Flash (${planExpiry}).`,
      });
      return;
    }
    const discountNum = parseFloat(cDiscount);
    if (!cDiscount || isNaN(discountNum) || discountNum <= 0 || discountNum > 100) {
      setFeedback({ type: 'err', msg: 'Ingresa un descuento entre 1 y 100%.' });
      return;
    }
    const stockNum = parseInt(cStock, 10);
    if (!cStock || isNaN(stockNum) || stockNum <= 0) {
      setFeedback({ type: 'err', msg: 'Ingresa un stock mayor a 0.' });
      return;
    }
    // Tope de inventario por tienda: disponible + canjeados no puede pasar de
    // flashPlanStockCap. Excluimos el cupón en edición para no contarlo dos veces.
    // (El trigger del servidor es la barrera definitiva.)
    const usedExcludingThis = coupons
      .filter(c => c.id !== cEditingId
        && FLASH_PLANS.has(c.plan_type)
        && c.approval_status !== 'rejected'
        && (!c.end_date || c.end_date >= new Date().toISOString()))
      .reduce((s, c) => s + (Number(c.amount_available) || 0) + (couponLeadsMap[c.id] || 0), 0);
    if (usedExcludingThis + stockNum > flashPlanStockCap) {
      const left = Math.max(0, flashPlanStockCap - usedExcludingThis);
      setFeedback({
        type: 'err',
        msg: `Superas el tope de ${flashPlanStockCap} cupones de tu tienda. Ya tienes ${usedExcludingThis} en stock vigente (incluye canjeados); puedes publicar hasta ${left} más.`,
      });
      return;
    }

    const isNewBrand = !flashBrandIds.has(store.id);
    if (isNewBrand && !cEditingId && flashBrandIds.size >= FLASH_GALLERY_MAX) {
      setFeedback({ type: 'err', msg: `Galería Flash llena (${flashBrandIds.size}/${FLASH_GALLERY_MAX} cupones).` });
      return;
    }
    const limit = FLASH_PERIOD_LIMITS[planType];
    if (limit) {
      const issued = flashIssuedInWindow(planType);
      if (issued >= limit.max) {
        setFeedback({ type: 'err', msg: `Ya lanzaste ${issued}/${limit.max} cupones en este ${limit.label}.` });
        return;
      }
    }

    setSubmitting(true); setFeedback(null);
    try {
      const previousImageUrl = cEditingId
        ? coupons.find(c => c.id === cEditingId)?.image_url ?? null
        : null;

      let finalImageUrl = cImageUrl;
      if (cImageFile) {
        const ext = cImageFile.name.split('.').pop();
        const path = `coupons/cupon_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('publicidad').upload(path, cImageFile, { upsert: true });
        if (upErr) throw upErr;
        finalImageUrl = supabase.storage.from('publicidad').getPublicUrl(path).data.publicUrl;
      }

      if (cEditingId) {
        const { error } = await supabase.from('coupons')
          .update({
            title: cTitle, plan_type: planType, category: cCategory,
            discount_percent: discountNum, amount_available: stockNum,
            image_url: finalImageUrl || null,
            start_date: new Date(cStartDate).toISOString(),
            end_date: new Date(cEndDate).toISOString(),
          })
          .eq('id', cEditingId);
        if (error) throw error;
        if (cImageFile && previousImageUrl && previousImageUrl !== finalImageUrl) {
          await removePublicidadFile(previousImageUrl);
        }
        setFeedback({ type: 'ok', msg: 'Cupón actualizado. Quedó en revisión por el administrador antes de volver a aparecer en el K2.' });
      } else {
        const code = `CUPON-${(store.name || 'STORE').substring(0, 3).toUpperCase()}-${Date.now().toString().slice(7)}`;
        // Declaración explícita: este flujo siempre va a revisión. El trigger
        // también lo fuerza para dueños reales (defense-in-depth); aquí lo
        // declaramos para cubrir el caso del admin que sube desde el portal
        // cliente sin estar vinculado a user_stores.
        const { error } = await supabase.from('coupons').insert([{
          store_id: store.id,
          title: cTitle, plan_type: planType, category: cCategory,
          discount_percent: discountNum, amount_available: stockNum,
          image_url: finalImageUrl || null,
          start_date: new Date(cStartDate).toISOString(),
          end_date: new Date(cEndDate).toISOString(),
          code,
          approval_status: 'pending',
          is_active: false,
        }]);
        if (error) throw error;
        setFeedback({ type: 'ok', msg: 'Cupón enviado a revisión. Aparecerá en el K2 cuando el administrador lo apruebe.' });
      }
      closeForm();
      fetchData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Error al guardar.' });
    } finally {
      setSubmitting(false);
    }
  };

  const findActiveCampaign = () =>
    campaigns.find(c =>
      c.id !== aEditingId &&
      c.is_active &&
      (!c.end_date || c.end_date >= today)
    );

  const submitCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    if (!canCampaign) { setFeedback({ type: 'err', msg: 'Tu plan no permite campañas.' }); return; }
    if (!aBrandName.trim()) { setFeedback({ type: 'err', msg: 'Indica el nombre de la campaña.' }); return; }
    if (!aEditingId && !aMediaFile) { setFeedback({ type: 'err', msg: 'Sube el archivo (video o imagen).' }); return; }
    if (store.contract_expiry_date) {
      if (!aEndDate) {
        setFeedback({ type: 'err', msg: 'Indica la fecha de fin de la campaña.' });
        return;
      }
      if (aEndDate > store.contract_expiry_date) {
        setFeedback({ type: 'err', msg: `La campaña no puede pasar de la vigencia de tu plan (${store.contract_expiry_date}).` });
        return;
      }
    }
    // Reactivar (dejar activa) una campaña con la fecha de fin ya vencida no la
    // pondría en el loop. Exigimos un fin futuro al reactivarla desde edición.
    if (aIsActive && aEndDate && aEndDate < today) {
      setFeedback({ type: 'err', msg: 'El rango de fechas ya venció. Indica una fecha de fin futura para reactivar la campaña.' });
      return;
    }

    // Aliados: bloquear si el loop está lleno (todos los slots ocupados).
    if (isAlly && !aEditingId) {
      if (loopSlotsUsed >= loopMaxSlots) {
        setFeedback({
          type: 'err',
          msg: `El loop publicitario está lleno (${loopSlotsUsed}/${loopMaxSlots} slots ocupados). Tu campaña quedará pendiente hasta que el administrador libere un slot.`,
        });
        return;
      }
    }

    // Tope de campañas activas: 1 para tiendas normales, ally_campaign_limit
    // para aliados. Si ya se alcanzó el tope, abrimos el modal de elección.
    if (!aEditingId) {
      const activeCount = campaigns.filter(
        c => c.is_active && (!c.end_date || c.end_date >= today),
      ).length;
      if (activeCount >= allyCampaignLimit) {
        const active = findActiveCampaign();
        if (active) {
          setConflict({ active, step: 'choose' });
          return;
        }
      }
    }

    await persistCampaign('normal');
  };

  const persistCampaign = async (
    mode: 'normal' | 'replace' | 'queue',
    activeConflict?: any,
  ) => {
    if (!store) return;
    setSubmitting(true); setFeedback(null);
    try {
      const previousMediaUrl = aEditingId
        ? campaigns.find(c => c.id === aEditingId)?.media_url ?? null
        : null;

      let finalMediaUrl = aMediaUrl;
      let finalMediaType = aMediaType;
      if (aMediaFile) {
        const ext = aMediaFile.name.split('.').pop();
        const path = `campaigns/camp_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('publicidad').upload(path, aMediaFile, { upsert: true });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from('publicidad').getPublicUrl(path);
        finalMediaUrl = data.publicUrl;
        finalMediaType = aMediaFile.type.startsWith('video/') ? 'video' : 'image';
      }

      if (aEditingId) {
        // Incluimos is_active. El trigger guard_campaigns_owner_update
        // valida que la transición sea legal (siempre TRUE->FALSE, y
        // FALSE->TRUE sólo si plan vigente y sin otra activa).
        const { data: updated, error } = await supabase.from('ad_campaigns')
          .update({
            brand_name: aBrandName, description: aDescription,
            media_url: finalMediaUrl, media_type: finalMediaType,
            duration_seconds: CAMPAIGN_DURATION_SECONDS,
            start_date: aStartDate, end_date: aEndDate || null,
            is_active: aIsActive,
            // El audio solo aplica a video; una imagen nunca suena.
            audio_enabled: finalMediaType === 'video' ? aAudioEnabled : false,
          })
          .eq('id', aEditingId)
          .select('id, is_active, approval_status')
          .single();
        if (error) throw error;
        // El trigger decide el destino al editar una campaña:
        //  • Si cambió el CONTENIDO importante (media o texto), la manda de
        //    vuelta a 'pending' y la desactiva (is_active=false) hasta que el
        //    admin la apruebe. Eso NO es un fallo de activación: es el flujo de
        //    re-revisión. Editar una campaña activa NO debe obligar a pausarla
        //    primero — simplemente queda en revisión.
        //  • Si solo se tocó is_active/audio/fechas, sigue 'approved'.
        const wentToReview = updated?.approval_status === 'pending';
        // Solo es un error real cuando la campaña NO fue a revisión y aun así
        // el guard revirtió is_active: p.ej. reactivar una pausada chocando con
        // el tope de activas o con el plan vencido.
        if (!wentToReview && updated && updated.is_active !== aIsActive) {
          throw new Error(
            aIsActive
              ? (planActive || isAlly
                  ? `No se pudo activar la campaña: alcanzaste el tope de ${allyCampaignLimit} campaña(s) activa(s). Pausa una primero.`
                  : 'No se pudo activar la campaña: tu plan está vencido. Renueva para volver a activar campañas.')
              : 'No se pudo desactivar la campaña. Revisa permisos.'
          );
        }
        if (aMediaFile && previousMediaUrl && previousMediaUrl !== finalMediaUrl) {
          await removePublicidadFile(previousMediaUrl);
        }
        setFeedback({
          type: 'ok',
          msg: wentToReview
            ? 'Campaña actualizada. Como cambiaste su contenido, quedó en revisión por el administrador antes de volver al loop.'
            : 'Campaña actualizada.',
        });
      } else {
        // Si reemplazamos: desactivar TODAS las activas de la tienda primero.
        // Una tienda puede tener >1 activa (p.ej. creada desde admin), así que
        // filtramos por store_id + is_active en lugar de un id puntual, y
        // verificamos con .select() que la RLS no haya bloqueado el update.
        if (mode === 'replace') {
          // Pedimos is_active de vuelta: hay un trigger guard en la BD que puede
          // revertir cambios prohibidos sin lanzar error. Si el row vuelve con
          // is_active=true, el guard nos bloqueó (admin/sistema controla activación).
          const { data: deactivated, error: deactErr } = await supabase
            .from('ad_campaigns')
            .update({ is_active: false })
            .eq('store_id', store.id)
            .eq('is_active', true)
            .select('id, is_active');
          if (deactErr) throw deactErr;
          if (!deactivated || deactivated.length === 0) {
            throw new Error('No se pudo desactivar la campaña actual. Revisa permisos o intenta de nuevo.');
          }
          const stillActive = deactivated.filter(r => r.is_active);
          if (stillActive.length > 0) {
            throw new Error(
              'La base de datos no permitió desactivar la campaña actual ' +
              '(trigger de seguridad). Pide a un administrador que aplique ' +
              'la migración actualizada de guard_campaigns_owner_update.'
            );
          }
        }

        // Si encolamos: la nueva usa el rango elegido por el usuario.
        // En todos los modos, la nueva campaña entra a revisión: aunque la
        // anterior se haya desactivado o no exista, la nueva no se publica
        // hasta que el admin la apruebe.
        let startDate = aStartDate;
        let endDate: string | null = aEndDate || null;
        if (mode === 'queue') {
          startDate = qStartDate;
          endDate = qEndDate || null;
        }

        // Declaración explícita del flujo: pending + inactivo. Cubre el caso
        // del admin que sube desde el portal cliente sin estar en user_stores.
        const { error } = await supabase.from('ad_campaigns').insert([{
          brand_name: aBrandName,
          description: aDescription,
          media_url: finalMediaUrl,
          media_type: finalMediaType,
          duration_seconds: CAMPAIGN_DURATION_SECONDS,
          start_date: startDate,
          end_date: endDate,
          // El aliado no tiene plan_type pago; sus campañas suenan como Oro.
          plan_type: store.plan_type ?? (isAlly ? 'ORO' : null),
          store_id: store.id,
          is_active: false,
          approval_status: 'pending',
          // El audio solo aplica a video; una imagen nunca suena.
          audio_enabled: finalMediaType === 'video' ? aAudioEnabled : false,
        }]);
        if (error) throw error;

        if (mode === 'replace') {
          setFeedback({ type: 'ok', msg: 'Campaña anterior desactivada. La nueva queda en revisión por el administrador y entrará al loop al aprobarse.' });
        } else if (mode === 'queue') {
          setFeedback({
            type: 'ok',
            msg: `Campaña programada del ${qStartDate} al ${qEndDate || '—'}. Queda en revisión por el administrador.`,
          });
        } else {
          setFeedback({ type: 'ok', msg: 'Campaña enviada a revisión. Entrará al loop cuando el administrador la apruebe.' });
        }
      }
      setConflict(null);
      closeForm();
      fetchData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Error al guardar.' });
    } finally {
      setSubmitting(false);
    }
  };

  const deleteCoupon = async (c: any) => {
    if (!confirm(`Eliminar el cupón "${c.title}"?`)) return;
    const { error } = await supabase.from('coupons').delete().eq('id', c.id);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await removePublicidadFile(c.image_url);
    setFeedback({ type: 'ok', msg: 'Cupón eliminado.' });
    fetchData();
  };
  const deleteCampaign = async (c: any) => {
    if (!confirm(`Eliminar la campaña "${c.brand_name}"?`)) return;
    const { error } = await supabase.from('ad_campaigns').delete().eq('id', c.id);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await removePublicidadFile(c.media_url);
    setFeedback({ type: 'ok', msg: 'Campaña eliminada.' });
    fetchData();
  };

  // Pausa/reactiva una campaña SIN re-enviarla a revisión. Clave: el update
  // toca ÚNICAMENTE is_active. Como no cambia contenido (media, fechas, etc.),
  // el trigger guard_campaigns_owner_update conserva approval_status='approved'
  // y la campaña vuelve directo al loop. Reactivar desde "Editar" reenviaba
  // todos los campos del formulario y podía disparar el guard de contenido
  // (p.ej. duration_seconds o start_date normalizados) mandándola a 'pending'.
  const toggleCampaignActive = async (c: any, next: boolean) => {
    if (next && !planActive) {
      setFeedback({ type: 'err', msg: 'Tu plan está vencido — renueva para volver a activar campañas.' });
      return;
    }
    // Reactivar una campaña ya vencida (end_date pasada) no tiene sentido con su
    // rango viejo: no sonaría en el loop. Pedimos un nuevo rango de fechas. Esto
    // NO la manda a revisión (solo cambiar video/texto lo hace).
    if (next && c.end_date && c.end_date < today) {
      setRStartDate(today);
      setREndDate('');
      setReactivate(c);
      return;
    }
    setFeedback(null);
    // Pedimos el row de vuelta: el guard puede revertir la transición sin
    // lanzar error (plan vencido / ya hay otra activa). Si is_active no quedó
    // como pedimos, el guard nos bloqueó.
    const { data: updated, error } = await supabase.from('ad_campaigns')
      .update({ is_active: next })
      .eq('id', c.id)
      .select('id, is_active, approval_status')
      .single();
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    if (!updated) {
      setFeedback({ type: 'err', msg: 'No se encontró la campaña o no tienes permiso para cambiarla.' });
      return;
    }
    if (updated.is_active !== next) {
      setFeedback({
        type: 'err',
        msg: next
          ? (planActive
              ? 'No se pudo reactivar: ya tienes otra campaña activa en el loop. Pausa la otra primero.'
              : 'No se pudo reactivar: tu plan está vencido. Renueva para volver a activar campañas.')
          : 'No se pudo pausar la campaña. Revisa permisos.',
      });
      fetchData();
      return;
    }
    setFeedback({
      type: 'ok',
      msg: next
        ? 'Campaña reactivada — volvió al loop sin pasar de nuevo por revisión.'
        : 'Campaña pausada. Se liberó tu slot en el loop.',
    });
    fetchData();
  };

  // Reactiva una campaña vencida con un rango de fechas NUEVO. Toca solo fechas +
  // is_active (nunca media/texto), así el trigger guard_campaigns_owner_update
  // conserva approval_status='approved' y vuelve al loop sin revisión del admin.
  const reactivateWithDates = async () => {
    if (!reactivate || !store) return;
    if (!rEndDate) { setFeedback({ type: 'err', msg: 'Indica la nueva fecha de fin de la campaña.' }); return; }
    if (rStartDate && rEndDate < rStartDate) { setFeedback({ type: 'err', msg: 'La fecha de fin no puede ser anterior al inicio.' }); return; }
    if (rEndDate < today) { setFeedback({ type: 'err', msg: 'La fecha de fin debe ser futura para que la campaña vuelva al loop.' }); return; }
    if (store.contract_expiry_date && rEndDate > store.contract_expiry_date) {
      setFeedback({ type: 'err', msg: `La campaña no puede pasar de la vigencia de tu plan (${store.contract_expiry_date}).` });
      return;
    }
    setSubmitting(true); setFeedback(null);
    const { data: updated, error } = await supabase.from('ad_campaigns')
      .update({ start_date: rStartDate || today, end_date: rEndDate, is_active: true })
      .eq('id', reactivate.id)
      .select('id, is_active, approval_status')
      .single();
    setSubmitting(false);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    if (!updated || !updated.is_active) {
      setFeedback({
        type: 'err',
        msg: planActive
          ? 'No se pudo reactivar: ya tienes otra campaña activa en el loop. Pausa la otra primero.'
          : 'No se pudo reactivar: tu plan está vencido. Renueva para volver a activar campañas.',
      });
      setReactivate(null);
      fetchData();
      return;
    }
    setFeedback({ type: 'ok', msg: 'Campaña reactivada con su nuevo rango de fechas — volvió al loop sin pasar de nuevo por revisión.' });
    setReactivate(null);
    fetchData();
  };

  const handleBannerFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    if (file.size > 100 * 1024 * 1024) {
      alert('El archivo debe pesar menos de 100 MB.');
      e.target.value = ''; return;
    }
    if (isVideo) {
      const check = await validateKioskVideo(file);
      if (!check.ok) { alert(check.message); e.target.value = ''; return; }
    }
    setBMediaFile(file);
    setBMediaType(isVideo ? 'video' : 'image');
    setBMediaUrl(URL.createObjectURL(file));
  };

  const handleSaveBanner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    if (!bEditingId && !bMediaFile) { setFeedback({ type: 'err', msg: 'Sube un archivo para el banner.' }); return; }
    if (!bEndDate) { setFeedback({ type: 'err', msg: 'Indica la fecha de fin del banner.' }); return; }
    if (store.contract_expiry_date && bEndDate > store.contract_expiry_date) {
      setFeedback({ type: 'err', msg: `El banner no puede pasar de la vigencia de tu plan (${store.contract_expiry_date}).` });
      return;
    }

    setSubmitting(true); setFeedback(null);
    try {
      const previousMediaUrl = bEditingId
        ? banners.find(b => b.id === bEditingId)?.media_url ?? null
        : null;

      let finalMediaUrl = bMediaUrl;
      let finalMediaType = bMediaType;
      if (bMediaFile) {
        const ext = bMediaFile.name.split('.').pop();
        const path = `slots/banner_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('publicidad').upload(path, bMediaFile, { upsert: true });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from('publicidad').getPublicUrl(path);
        finalMediaUrl = data.publicUrl;
        finalMediaType = bMediaFile.type.startsWith('video/') ? 'video' : 'image';
      }

      // El slot/posición lo asigna el admin; el cliente solo envía el contenido y las fechas.
      // En creación se mantiene el valor por defecto; en edición se preserva el valor que asignó el admin.
      const payload: any = {
        ui_position: bUiPosition,
        slot_position: Number(bSlotPosition) || null,
        media_url: finalMediaUrl,
        media_type: finalMediaType,
        start_date: bStartDate ? new Date(bStartDate).toISOString() : null,
        end_date: new Date(bEndDate).toISOString(),
        store_id: store.id,
      };

      if (bEditingId) {
        const { data: updated, error } = await supabase.from('banners')
          .update(payload)
          .eq('id', bEditingId)
          .select('id, is_active, approval_status')
          .single();
        if (error) throw error;

        if (bMediaFile && previousMediaUrl && previousMediaUrl !== finalMediaUrl) {
          await removePublicidadFile(previousMediaUrl);
        }

        const wentToReview = updated?.approval_status === 'pending';
        setFeedback({
          type: 'ok',
          msg: wentToReview
            ? 'Banner actualizado. Como cambiaste el archivo, quedó en revisión por el administrador.'
            : 'Banner actualizado.',
        });
      } else {
        payload.is_active = false;
        payload.approval_status = 'pending';
        const { error } = await supabase.from('banners').insert([payload]);
        if (error) throw error;

        setFeedback({ type: 'ok', msg: 'Banner enviado a revisión. El administrador asignará el slot y lo publicará al aprobarlo.' });
      }

      closeForm();
      fetchData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Error al guardar el banner.' });
    } finally {
      setSubmitting(false);
    }
  };

  const deleteBanner = async (b: any) => {
    if (!confirm(`¿Eliminar el banner de la posición "${b.ui_position}"?`)) return;
    const { error } = await supabase.from('banners').delete().eq('id', b.id);
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    await removePublicidadFile(b.media_url);
    setFeedback({ type: 'ok', msg: 'Banner eliminado.' });
    fetchData();
  };

  const toggleBannerActive = async (b: any, next: boolean) => {
    if (next && !planActive) {
      setFeedback({ type: 'err', msg: 'Tu plan está vencido — renueva para volver a activar banners.' });
      return;
    }
    setFeedback(null);
    const { data: updated, error } = await supabase.from('banners')
      .update({ is_active: next })
      .eq('id', b.id)
      .select('id, is_active, approval_status')
      .single();
    if (error) { setFeedback({ type: 'err', msg: error.message }); return; }
    if (!updated) {
      setFeedback({ type: 'err', msg: 'No se encontró el banner o no tienes permiso para cambiarlo.' });
      return;
    }
    if (updated.is_active !== next) {
      setFeedback({
        type: 'err',
        msg: next
          ? 'No se pudo reactivar: tu plan venció o el banner no está aprobado.'
          : 'No se pudo pausar el banner. Revisa permisos.',
      });
      fetchData();
      return;
    }
    setFeedback({
      type: 'ok',
      msg: next ? 'Banner reactivado.' : 'Banner pausado.',
    });
    fetchData();
  };

  if (!store) {
    return (
      <div className="max-w-2xl mx-auto mt-20 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-8 text-center text-amber-300">
        Selecciona una tienda en el sidebar para ver tus promociones.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const noCapability = !canCreateCoupon && !canCampaign && !canBanner;

  const items: Array<{ kind: 'coupon' | 'campaign' | 'banner'; data: any; created: string }> = [
    ...coupons.map(c => ({ kind: 'coupon' as const, data: c, created: c.created_at })),
    ...campaigns.map(c => ({ kind: 'campaign' as const, data: c, created: c.created_at })),
    ...banners.map(b => ({ kind: 'banner' as const, data: b, created: b.created_at })),
  ].sort((a, b) => (b.created || '').localeCompare(a.created || ''));

  const sortedCampaigns = [...campaigns].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '')
  );
  const sortedCoupons = [...coupons].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '')
  );
  const sortedBanners = [...banners].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '')
  );
  const showCampaigns = filter === 'all' || filter === 'campaigns';
  const showCoupons = filter === 'all' || filter === 'coupons';
  const showBanners = filter === 'all' || filter === 'banners';
  const nothingVisible =
    (showCampaigns ? sortedCampaigns.length : 0) +
    (showCoupons ? sortedCoupons.length : 0) +
    (showBanners ? sortedBanners.length : 0) === 0;

  const flashCount = coupons.filter(c => FLASH_PLANS.has(c.plan_type)
    && c.amount_available > 0
    && (!c.end_date || c.end_date >= new Date().toISOString())).length;

  // Inventario consumido: disponible + canjeados (coupon_leads). Mismo criterio
  // que el trigger: excluye rechazados y vencidos.
  const nowIsoStock = new Date().toISOString();
  const couponStockUsed = coupons
    .filter(c => FLASH_PLANS.has(c.plan_type)
      && c.approval_status !== 'rejected'
      && (!c.end_date || c.end_date >= nowIsoStock))
    .reduce((s, c) => s + (Number(c.amount_available) || 0) + (couponLeadsMap[c.id] || 0), 0);
  const couponStockRemaining = Math.max(0, flashPlanStockCap - couponStockUsed);

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase mb-1">
            Promociones · {store.name}
          </p>
          <h2 className="text-2xl font-bold text-white">Cupones y Campañas</h2>
          <p className="text-white/50 text-sm mt-2">
            Administra cupones de descuento y campañas publicitarias de tu tienda desde un solo lugar.
          </p>
        </div>
        <button
          onClick={() => setForm('pick')}
          disabled={noCapability}
          className="shrink-0 text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg px-4 py-2.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed self-start"
        >
          + Nueva promoción
        </button>
      </div>

      {noCapability && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2.5">
          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="text-xs text-amber-200/90 leading-relaxed flex-1">
            <p>Tu tienda no tiene un plan activo que permita cupones ni campañas. Los cupones requieren el plan Cupones Flash.</p>
            <Link href="/cliente/planes" className="inline-block mt-1 text-amber-300 underline">
              Ver catálogo de planes →
            </Link>
          </div>
        </div>
      )}

      {isAlly && (() => {
        const loopFull = loopSlotsUsed >= loopMaxSlots;
        const loopPct = loopMaxSlots > 0 ? Math.min(loopSlotsUsed / loopMaxSlots, 1) : 0;
        const loopNearFull = !loopFull && loopPct >= 0.8;
        const freeSlots = Math.max(0, loopMaxSlots - loopSlotsUsed);
        const activeCampaigns = campaigns.filter(c => c.is_active && (!c.end_date || c.end_date >= today));
        const spotsLeft = Math.max(0, allyCampaignLimit - activeCampaigns.length);

        return (
          <div className={`border rounded-xl p-5 space-y-4 ${
            loopFull
              ? 'bg-red-500/[0.06] border-red-500/25'
              : 'bg-emerald-500/[0.04] border-emerald-500/20'
          }`}>
            {/* Título + badge */}
            <div className="flex items-center gap-2">
              <span className="text-base">🤝</span>
              <div>
                <p className="text-white text-sm font-semibold">Marca Aliada</p>
                <p className="text-white/40 text-xs">Campañas{allyFlash ? ' y cupones flash' : ''} sin costo · acceso permanente</p>
              </div>
            </div>

            {/* Dos métricas clave */}
            <div className="grid grid-cols-2 gap-3">
              {/* Slots de campaña */}
              <div className="bg-white/[0.03] border border-white/8 rounded-lg p-3">
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Mis campañas activas</p>
                <p className="text-white text-lg font-bold font-mono">
                  {activeCampaigns.length}
                  <span className="text-white/30 text-sm font-normal"> / {allyCampaignLimit}</span>
                </p>
                <p className={`text-[11px] mt-0.5 ${spotsLeft === 0 ? 'text-amber-400' : 'text-white/40'}`}>
                  {spotsLeft === 0
                    ? 'Alcanzaste tu límite de campañas activas'
                    : spotsLeft === 1
                    ? 'Puedes activar 1 campaña más'
                    : `Puedes activar ${spotsLeft} campañas más`}
                </p>
              </div>

              {/* Espacio en el loop */}
              <div className={`border rounded-lg p-3 ${loopFull ? 'bg-red-500/8 border-red-500/20' : 'bg-white/[0.03] border-white/8'}`}>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Loop publicitario</p>
                <p className={`text-lg font-bold font-mono ${loopFull ? 'text-red-300' : loopNearFull ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {loopFull ? 'Lleno' : loopNearFull ? 'Casi lleno' : `${freeSlots} libre${freeSlots !== 1 ? 's' : ''}`}
                </p>
                <p className="text-[11px] text-white/40 mt-0.5 font-mono">
                  {loopSlotsUsed}/{loopMaxSlots} slots
                </p>
              </div>
            </div>

            {/* Barra de progreso del loop */}
            <div className="space-y-1.5">
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${loopFull ? 'bg-red-500' : loopNearFull ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  style={{ width: `${loopPct * 100}%` }}
                />
              </div>
              {loopFull && (
                <p className="text-red-300/80 text-xs leading-relaxed">
                  El loop publicitario está lleno. Puedes enviar tu campaña y quedará en revisión; se activará cuando el administrador libere espacio.
                </p>
              )}
              {loopNearFull && !loopFull && (
                <p className="text-amber-300/70 text-xs">
                  El loop está casi lleno. Tu campaña puede activarse mientras haya espacio.
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {(flashActive || allyFlash) && (
        <div className="bg-pink-500/[0.06] border border-pink-500/25 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-pink-200 text-sm font-semibold">
                ⚡ {isAlly ? 'Cupones Flash · Marca Aliada' : `Plan Cupones Flash activo · ${PLAN_LABELS[store!.flash_coupon_plan!]}`}
              </p>
              {!isAlly && store!.flash_coupon_expiry_date && (
                <p className="text-white/50 text-xs mt-0.5">Vence {store!.flash_coupon_expiry_date}.</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-[10px] text-white/40 uppercase">Tus cupones activos</p>
              <p className="text-pink-300 font-mono text-xl font-bold">{flashCount}</p>
              {couponPlanType && FLASH_PERIOD_LIMITS[couponPlanType] && (() => {
                const lim = FLASH_PERIOD_LIMITS[couponPlanType];
                const issued = flashIssuedInWindow(couponPlanType);
                return (
                  <p className="text-[10px] text-white/40">
                    {issued}/{lim.max} por {lim.label}
                  </p>
                );
              })()}
            </div>
          </div>

          {/* Presupuesto de inventario: la SUMA del stock vigente ≤ flashPlanStockCap. */}
          <div className="mt-3 pt-3 border-t border-pink-500/15">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-white/60">Inventario de cupones (stock total)</span>
              <span className="font-mono font-bold text-pink-200">{couponStockUsed}/{flashPlanStockCap}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${couponStockRemaining === 0 ? 'bg-red-400' : 'bg-pink-400'}`}
                style={{ width: `${Math.min(100, (couponStockUsed / flashPlanStockCap) * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-white/50">
              {couponStockRemaining > 0
                ? <>Te quedan <strong className="text-pink-200">{couponStockRemaining}</strong> unidades de stock para publicar (puedes repartirlas en varios cupones).</>
                : <>Alcanzaste el tope de {flashPlanStockCap}. Reduce el stock de un cupón, o espera a que venza/se canjee, para publicar más.</>}
            </p>
          </div>
        </div>
      )}

      {feedback && (
        <div className={`rounded-lg p-3 text-sm border ${feedback.type === 'ok'
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}>{feedback.msg}</div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {(['all', 'coupons', 'campaigns', 'banners'] as FilterKind[]).map(k => {
          const active = filter === k;
          const label = k === 'all' ? `Todos (${items.length})`
            : k === 'coupons' ? `Cupones (${coupons.length})`
              : k === 'campaigns' ? `Campañas (${campaigns.length})`
                : `Banners (${banners.length})`;
          return (
            <button key={k} onClick={() => setFilter(k)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${active
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-100'
                : 'bg-white/[0.03] border-white/10 text-white/60 hover:bg-white/[0.06]'
                }`}>
              {label}
            </button>
          );
        })}
      </div>

      {/* Picker modal */}
      {form === 'pick' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeForm} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">¿Qué quieres crear?</h3>
              <button onClick={closeForm} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                onClick={() => { if (canCreateCoupon) openCreateCoupon(); }}
                disabled={!canCreateCoupon}
                className="text-left bg-[#0A0A0A] border border-white/10 hover:border-cyan-500/40 hover:bg-cyan-500/[0.04] disabled:opacity-40 disabled:cursor-not-allowed rounded-xl p-4 transition-colors"
              >
                <div className="text-2xl mb-2">🎟️</div>
                <p className="text-sm font-semibold text-white">Cupón Flash</p>
                <p className="text-[11px] text-white/50 mt-1 leading-snug">
                  {canCreateCoupon
                    ? 'Descuento con código que rota en la galería pública (1 cupón por tienda).'
                    : 'Requiere el plan Cupones Flash activo.'}
                </p>
              </button>
              <button
                onClick={() => { if (canCampaign) openCreateCampaign(); }}
                disabled={!canCampaign}
                className="text-left bg-[#0A0A0A] border border-white/10 hover:border-cyan-500/40 hover:bg-cyan-500/[0.04] disabled:opacity-40 disabled:cursor-not-allowed rounded-xl p-4 transition-colors"
              >
                <div className="text-2xl mb-2">📺</div>
                <p className="text-sm font-semibold text-white">Campaña</p>
                <p className="text-[11px] text-white/50 mt-1 leading-snug">
                  {canCampaign ? 'Video o imagen que rota en los kioscos según tu plan.' : 'Requiere plan base activo.'}
                </p>
              </button>
              <button
                onClick={() => { if (canBanner) openCreateBanner(); }}
                disabled={!canBanner}
                className="text-left bg-[#0A0A0A] border border-white/10 hover:border-cyan-500/40 hover:bg-cyan-500/[0.04] disabled:opacity-40 disabled:cursor-not-allowed rounded-xl p-4 transition-colors"
              >
                <div className="text-2xl mb-2">🖼️</div>
                <p className="text-sm font-semibold text-white">Banner</p>
                <p className="text-[11px] text-white/50 mt-1 leading-snug">
                  {canBanner ? 'Banner que rota en las pantallas (exclusivo Diamante).' : 'Requiere plan DIAMANTE activo.'}
                </p>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Coupon modal */}
      {form === 'coupon' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeForm} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>🎟️</span>
                {cEditingId ? 'Editar cupón' : 'Nuevo cupón'}
              </h3>
              <button onClick={closeForm} disabled={submitting} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={submitCoupon} className="px-6 py-5 space-y-4">
              <div className="bg-pink-500/[0.06] border border-pink-500/25 rounded-lg p-3 text-[11px] text-pink-100/90 leading-snug">
                ⚡ Cupón Flash · Plan {PLAN_LABELS[couponPlanType] || couponPlanType || '—'}.
                Aparece en la galería pública con rotación 1 cupón por tienda.
              </div>

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Título</label>
                <input type="text" required value={cTitle} onChange={(e) => setCTitle(e.target.value)}
                  placeholder="Ej: 2x1 en bebidas"
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descuento (%)</label>
                  <div className="relative">
                    <input type="number" min={1} max={100} step={1} required
                      value={cDiscount}
                      onChange={(e) => setCDiscount(e.target.value)}
                      placeholder="0"
                      className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-3 pr-8 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 text-sm pointer-events-none">%</span>
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Stock disponible</label>
                  <input type="number" min={1} step={1} required
                    value={cStock}
                    onChange={(e) => setCStock(e.target.value)}
                    placeholder="0"
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input type="date" required value={cStartDate} min={today}
                    max={store!.flash_coupon_expiry_date || undefined}
                    onChange={(e) => setCStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vence</label>
                  <input type="date" required value={cEndDate} min={cStartDate || today}
                    max={store!.flash_coupon_expiry_date || undefined}
                    onChange={(e) => setCEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              {cStartDate && cEndDate && (() => {
                const diffDays = Math.round(
                  (new Date(cEndDate + 'T00:00:00Z').getTime() - new Date(cStartDate + 'T00:00:00Z').getTime()) / 86400000
                );
                const activeDays = Math.max(1, diffDays);
                const endFormatted = new Date(cEndDate + 'T00:00:00Z').toLocaleDateString('es-VE', {
                  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
                });
                return (
                  <div className="bg-pink-500/[0.05] border border-pink-500/15 rounded-lg px-3 py-2 -mt-2">
                    <p className="text-[10px] text-pink-200/80 leading-snug">
                      ⏱ <strong className="text-pink-200">{activeDays} {activeDays === 1 ? 'día' : 'días'} activo{activeDays !== 1 ? 's' : ''}</strong>
                      {diffDays === 0
                        ? ' — inicio y fin el mismo día. Durará todo el día porque el corte automático ya corrió hoy.'
                        : null}
                      {' '}· Se desactiva el <strong className="text-pink-200">{endFormatted}</strong> a las <strong className="text-pink-200">12:05 a.m.</strong> (hora Venezuela).
                    </p>
                  </div>
                );
              })()}
              {store!.flash_coupon_expiry_date && (
                <p className="text-[10px] text-white/40 -mt-2">
                  Tu plan Cupones Flash vence el {store!.flash_coupon_expiry_date}. El cupón no puede pasar de esa fecha.
                </p>
              )}

              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Imagen {cEditingId && <span className="normal-case tracking-normal text-white/30">(vacío = mantener)</span>}
                </label>
                <input type="file" accept="image/*" onChange={handleImage}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-white/10 file:text-white/60" />
                <p className="text-[10px] text-white/20 mt-1">JPG/PNG · Máx 500 KB · Recomendado <span className="text-white/40">1200 × 900 px (4:3)</span>. El kiosco recorta a 4:3 con <code className="text-white/30">cover</code>; mantén el contenido importante centrado.</p>
                {cImageUrl && (
                  <img src={cImageUrl} alt="preview" className="mt-2 w-40 aspect-[4/3] rounded-lg object-cover bg-black" />
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={closeForm} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg">
                  Cancelar
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-50">
                  {submitting ? 'Guardando…' : cEditingId ? 'Guardar cambios' : 'Publicar cupón'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Campaign modal */}
      {form === 'campaign' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeForm} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>📺</span>
                {aEditingId ? 'Editar campaña' : 'Nueva campaña'}
              </h3>
              <button onClick={closeForm} disabled={submitting} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Feedback DENTRO del modal: el banner global vive detrás de este
                overlay (z-50), así que un error al guardar quedaba invisible.
                Aquí el cliente sí ve por qué falló. */}
            {feedback && (
              <div className={`mx-6 mt-4 rounded-lg p-3 text-sm border ${feedback.type === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border-red-500/40 text-red-300'
                }`}>{feedback.msg}</div>
            )}
            <form onSubmit={submitCampaign} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre de la campaña</label>
                <input type="text" required value={aBrandName} onChange={(e) => setABrandName(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Descripción (opcional)</label>
                <textarea value={aDescription} onChange={(e) => setADescription(e.target.value)}
                  rows={2}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50 resize-none" />
              </div>
              <div>
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">
                  Archivo {aEditingId && <span className="normal-case tracking-normal text-white/30">(vacío = mantener)</span>}
                </label>
                <input type="file" accept="video/*,image/*" onChange={handleMedia}
                  className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-[7px] text-sm text-white/50 file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-white/10 file:text-white/60" />
                <p className="text-[10px] text-white/20 mt-1">Video MP4/WebM (máx 120 MB) o imagen JPG/PNG (máx 50 MB) · Recomendado <span className="text-white/40">1080 × 1920 px (9:16 vertical)</span>. El kiosco lo muestra a pantalla completa con <code className="text-white/30">cover</code>.</p>

                {aMediaUrl && (
                  <div className="mt-3 flex items-start gap-3">
                    {/* Mock del kiosco 9:16 a escala (réplica de home_screen.dart).
                        Mismo componente que usa el admin al revisar la solicitud. */}
                    <K2CampaignPreview
                      src={aMediaUrl}
                      type={aMediaType === 'video' ? 'video' : 'image'}
                      brandName={aBrandName}
                      description={aDescription}
                      width={200}
                    />

                    <div className="flex-1 space-y-1.5 text-[11px] text-white/50 leading-snug">
                      <p>
                        Vista previa a escala del kiosco vertical (1080 × 1920) en la pantalla <span className="text-white/70">Home</span>, que es donde se reproduce tu campaña.
                      </p>
                      <p>
                        Sobre tu video se renderizan elementos fijos del kiosco:
                      </p>
                      <ul className="list-disc list-inside text-white/45 space-y-0.5 ml-1">
                        <li><span className="text-white/70">Top-right:</span> logo Millennium (~5% alto).</li>
                        <li><span className="text-white/70">Inferior (~40%):</span> gradiente oscuro + badge, nombre de la marca, descripción, info WiFi/QR, botón <span className="text-white/70">COMENZAR</span> y footer.</li>
                      </ul>
                      <p>
                        Mantén logos / texto / personajes en el <span className="text-white/70">tercio superior central</span> para que no compitan con la UI. El kiosco usa <code className="text-white/40">cover</code>: archivos no 9:16 recortan bordes.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              {aMediaType === 'video' && (
                <button
                  type="button"
                  onClick={() => setAAudioEnabled(v => !v)}
                  className="w-full flex items-center gap-3 bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2.5 text-left hover:border-cyan-500/40 transition-colors"
                >
                  <span className={`shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${aAudioEnabled ? 'bg-cyan-500' : 'bg-white/15'}`}>
                    <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${aAudioEnabled ? 'translate-x-4' : ''}`} />
                  </span>
                  <span className="flex-1">
                    <span className="block text-sm text-white font-medium">
                      {aAudioEnabled ? 'Con audio' : 'Sin audio (mudo)'}
                    </span>
                    <span className="block text-[11px] text-white/45 leading-snug">
                      {aAudioEnabled
                        ? 'El kiosco reproducirá tu video con sonido.'
                        : 'El video se reproduce en silencio. Actívalo si quieres que suene.'}
                    </span>
                  </span>
                  <svg className="w-4 h-4 text-white/40 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {aAudioEnabled
                      ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.536 8.464a5 5 0 010 7.072M19.07 4.93a10 10 0 010 14.142M5 9v6h4l5 5V4L9 9H5z" />
                      : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 9l4 4m0-4l-4 4M5 9v6h4l5 5V4L9 9H5z" />}
                  </svg>
                </button>
              )}
              <div className="bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2.5 flex items-center gap-2">
                <svg className="w-4 h-4 text-white/40 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <p className="text-xs text-white/60">
                  Duración fija: <span className="text-white font-semibold">{CAMPAIGN_DURATION_SECONDS} segundos</span> por reproducción en el loop.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input type="date" required value={aStartDate} min={today} max={store!.contract_expiry_date || undefined}
                    onChange={(e) => setAStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin</label>
                  <input type="date" value={aEndDate} min={aStartDate || today} max={store!.contract_expiry_date || undefined}
                    onChange={(e) => setAEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              {store!.contract_expiry_date && (
                <p className="text-[10px] text-white/40 -mt-2">
                  Tu plan vence el {store!.contract_expiry_date}. La campaña no puede pasar de esa fecha.
                </p>
              )}

              {aEditingId && (() => {
                // Solo ocupa el slot una campaña activa que además siga DENTRO de
                // su ventana (end_date no vencida). Una campaña con is_active=true
                // pero ya vencida NO está sonando en el loop y no debe bloquear la
                // activación de otra — mismo criterio que findActiveCampaign() y que
                // las vistas del kiosco (active_ads_live / kiosk_active_campaigns).
                const hasOtherActive = campaigns.some(c =>
                  c.id !== aEditingId && c.is_active && (!c.end_date || c.end_date >= today)
                );
                const canActivate = planActive && !hasOtherActive;
                const currentlyActive = aIsActive;
                const reasonCantActivate = !planActive
                  ? 'Tu plan está vencido — renueva para volver a activar campañas.'
                  : hasOtherActive
                    ? 'Ya tienes otra campaña activa. Pausa la otra primero.'
                    : null;
                return (
                  <div className={`rounded-lg border p-3 ${
                    currentlyActive
                      ? 'bg-emerald-500/[0.05] border-emerald-500/25'
                      : 'bg-white/[0.03] border-white/10'
                  }`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-semibold ${
                          currentlyActive ? 'text-emerald-200' : 'text-white/70'
                        }`}>
                          {currentlyActive ? 'Campaña activa en el loop' : 'Campaña pausada'}
                        </p>
                        <p className="text-[11px] text-white/50 mt-1 leading-snug">
                          {currentlyActive
                            ? 'Si la pausas se libera tu slot en el loop. Podrás reactivarla mientras tu plan siga vigente y no tengas otra activa.'
                            : reasonCantActivate
                              ?? 'Tu plan está activo y no tienes otra campaña ocupando el slot — puedes activarla ahora.'}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={submitting || (!currentlyActive && !canActivate)}
                        onClick={() => {
                          if (currentlyActive) {
                            setConfirmDialog({
                              title: 'Pausar campaña',
                              message:
                                `¿Pausar "${aBrandName}"? Se liberará tu slot en el loop. ` +
                                `Podrás reactivarla más tarde si tu plan sigue vigente y ` +
                                `no tienes otra campaña activa.`,
                              confirmLabel: 'Sí, pausar',
                              tone: 'warning',
                              onConfirm: () => {
                                setAIsActive(false);
                                setConfirmDialog(null);
                              },
                            });
                          } else {
                            setAIsActive(true);
                          }
                        }}
                        className={`shrink-0 px-3 py-2 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          currentlyActive
                            ? 'bg-white/5 hover:bg-white/10 border-white/15 text-white/70'
                            : 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-200'
                        }`}
                      >
                        {currentlyActive ? 'Pausar' : 'Activar'}
                      </button>
                    </div>
                  </div>
                );
              })()}

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={closeForm} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg">
                  Cancelar
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-50">
                  {submitting ? 'Guardando…' : aEditingId ? 'Guardar cambios' : 'Publicar campaña'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Banner modal */}
      {form === 'banner' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeForm} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>🖼️</span>
                <span>{bEditingId ? 'Editar Banner' : 'Proponer Nuevo Banner'}</span>
              </h3>
              <button onClick={closeForm} disabled={submitting} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <form onSubmit={handleSaveBanner} className="p-6 space-y-4">
              <div className="bg-blue-500/[0.06] border border-blue-500/25 rounded-lg p-3 text-[11px] text-blue-100/90 leading-snug">
                🖼️ Banner exclusivo plan Diamante. El administrador asignará la posición y el slot en pantalla al aprobarlo.
                {bEditingId && bUiPosition && (
                  <span className="block mt-1 text-white/50">
                    Slot asignado: <span className="text-white/80 font-mono">{bUiPosition}{bSlotPosition && bSlotPosition !== '1' ? ` · #${bSlotPosition}` : ''}</span>
                  </span>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-1.5">
                  Archivo {bEditingId && <span className="normal-case tracking-normal text-white/30">(vacío = mantener)</span>}
                </label>
                <input
                  type="file"
                  accept="image/*,video/*"
                  onChange={handleBannerFileChange}
                  className="hidden"
                  id="banner-file-input"
                />
                <label
                  htmlFor="banner-file-input"
                  className="flex flex-col items-center justify-center border-2 border-dashed border-white/10 hover:border-cyan-500/40 hover:bg-white/[0.02] transition-colors rounded-xl p-6 cursor-pointer text-center"
                >
                  <svg className="w-8 h-8 text-white/30 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  <span className="text-xs text-white/60 font-medium">Seleccionar archivo</span>
                  <span className="text-[10px] text-white/40 mt-1">PNG, JPG, GIF, MP4 · Máx 100 MB</span>
                </label>
              </div>

              {bMediaUrl && (
                <div className="flex flex-col items-center gap-3 pt-1">
                  <p className="text-[10px] text-white/40 uppercase tracking-wider font-semibold self-start">
                    Previsualización en K2 Pro
                  </p>
                  <div className="flex items-start gap-4">
                    <K2BannerPreview
                      src={bMediaUrl}
                      type={bMediaType}
                      position={bPreviewPosition}
                      previewWidth={140}
                    />
                    <div className="flex flex-col gap-2 pt-1">
                      <p className="text-[10px] text-white/50 leading-snug">
                        El admin asignará la posición. Previsualiza cómo se vería:
                      </p>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setBPreviewPosition('top')}
                          className={`px-3 py-1 text-[10px] font-semibold rounded-lg border transition-colors ${
                            bPreviewPosition === 'top'
                              ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                              : 'bg-white/5 border-white/10 text-white/40 hover:border-white/20'
                          }`}
                        >
                          ▲ Top
                        </button>
                        <button
                          type="button"
                          onClick={() => setBPreviewPosition('bottom')}
                          className={`px-3 py-1 text-[10px] font-semibold rounded-lg border transition-colors ${
                            bPreviewPosition === 'bottom'
                              ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                              : 'bg-white/5 border-white/10 text-white/40 hover:border-white/20'
                          }`}
                        >
                          ▼ Bottom
                        </button>
                      </div>
                      <p className="text-[9px] text-white/25 leading-snug">
                        Franja de 10% del alto de pantalla.<br />
                        Resolución nativa: 1080 × 192 px.<br />
                        Si tu imagen no es 1080 × 192 (5.625:1) se verá
                        con bordes negros, tal como en este preview.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input
                    type="date"
                    required
                    value={bStartDate}
                    min={today}
                    max={store!.contract_expiry_date || undefined}
                    onChange={(e) => setBStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-1.5">Fin</label>
                  <input
                    type="date"
                    required
                    value={bEndDate}
                    min={bStartDate || today}
                    max={store!.contract_expiry_date || undefined}
                    onChange={(e) => setBEndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>
              {store!.contract_expiry_date && (
                <p className="text-[10px] text-white/40 -mt-2">
                  Tu plan vence el {store!.contract_expiry_date}. El banner no puede pasar de esa fecha.
                </p>
              )}

              <div className="pt-4 border-t border-white/10 flex gap-2">
                <button
                  type="button"
                  onClick={closeForm}
                  disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors disabled:opacity-40"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg hover:opacity-95 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {submitting ? 'Guardando...' : bEditingId ? 'Guardar Cambios' : 'Enviar Propuesta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Conflict modal: solo una campaña activa por empresa */}
      {conflict && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            onClick={() => { if (!submitting) setConflict(null); }}
          />
          <div className="relative bg-[#0E0E0E] border border-amber-500/30 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10">
              <h3 className="text-sm font-semibold text-amber-200 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Ya tienes una campaña activa
              </h3>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-white/70 leading-relaxed">
                Tu tienda <span className="text-white font-semibold">{store.name}</span> solo puede tener una campaña en el loop a la vez.
              </p>
              <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Campaña activa</p>
                <p className="text-sm text-white font-semibold mt-1">{conflict.active.brand_name}</p>
                <p className="text-[11px] text-white/50 mt-0.5">
                  {conflict.active.start_date}
                  {conflict.active.end_date ? ` → ${conflict.active.end_date}` : ' · sin fecha de fin'}
                </p>
              </div>
              {conflict.step === 'choose' && (() => {
                const planExpiry = store.contract_expiry_date || null;
                const minStart = conflict.active.end_date
                  ? (() => {
                      const d = new Date(conflict.active.end_date);
                      d.setUTCDate(d.getUTCDate() + 1);
                      return d.toISOString().split('T')[0];
                    })()
                  : null;
                const planAllowsQueue = !!minStart && (!planExpiry || planExpiry >= minStart);
                const queueDisabledReason = !conflict.active.end_date
                  ? 'La campaña activa no tiene fecha de fin definida.'
                  : !planAllowsQueue
                    ? `Tu plan vence el ${planExpiry} y no deja ventana después de la campaña actual (termina ${conflict.active.end_date}).`
                    : null;
                return (
                  <>
                    <p className="text-xs text-white/50 leading-snug">
                      ¿Qué quieres hacer con tu nueva campaña?
                    </p>

                    <div className="space-y-2">
                      <button
                        type="button"
                        disabled={submitting || !!queueDisabledReason}
                        onClick={() => {
                          setQStartDate(minStart || '');
                          setQEndDate(planExpiry || '');
                          setConflict({ ...conflict, step: 'queue-dates' });
                        }}
                        className="w-full text-left bg-[#0A0A0A] border border-white/10 hover:border-cyan-500/40 hover:bg-cyan-500/[0.05] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg p-3 transition-colors"
                      >
                        <p className="text-sm font-semibold text-cyan-100">
                          Programarla para cuando termine la actual
                        </p>
                        <p className="text-[11px] text-white/50 mt-1 leading-snug">
                          {queueDisabledReason
                            ?? 'Elige el rango de fechas en el siguiente paso. Queda como borrador y se activa desde el listado.'}
                        </p>
                      </button>

                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => {
                        setConfirmDialog({
                          title: 'Desactivar campaña actual',
                          message:
                            `¿Seguro que deseas desactivar "${conflict.active.brand_name}" ` +
                            `y publicar la nueva ahora? La campaña actual saldrá del loop ` +
                            `y la nueva entrará de inmediato. Podrás reactivar la anterior ` +
                            `más tarde si tu plan sigue vigente y no hay otra activa.`,
                          confirmLabel: 'Sí, desactivar y publicar',
                          tone: 'danger',
                          onConfirm: () => {
                            setConfirmDialog(null);
                            persistCampaign('replace', conflict.active);
                          },
                        });
                      }}
                      className="w-full text-left bg-[#0A0A0A] border border-white/10 hover:border-red-500/40 hover:bg-red-500/[0.05] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg p-3 transition-colors"
                    >
                      <p className="text-sm font-semibold text-red-200">
                        Desactivar la actual y publicar la nueva ahora
                      </p>
                      <p className="text-[11px] text-white/50 mt-1 leading-snug">
                        “{conflict.active.brand_name}” se desactivará. Tu nueva campaña entrará al loop de inmediato.
                      </p>
                    </button>
                  </div>

                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setConflict(null)}
                      className="px-4 py-2 text-xs text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg"
                    >
                      Cancelar
                    </button>
                  </div>
                  </>
                );
              })()}

              {conflict.step === 'queue-dates' && (() => {
                const minStart = (() => {
                  const d = new Date(conflict.active.end_date);
                  d.setUTCDate(d.getUTCDate() + 1);
                  return d.toISOString().split('T')[0];
                })();
                const maxEnd = store.contract_expiry_date || undefined;
                // Otras campañas del store cuyo rango también debemos respetar
                // (la activa ya se cubre con minStart; aquí filtramos cualquier
                // borrador/programada futura para que la nueva no se le solape).
                const otherRanges = campaigns
                  .filter(c => c.id !== conflict.active.id && c.start_date)
                  .map(c => ({
                    brand: c.brand_name,
                    start: c.start_date as string,
                    end: (c.end_date as string | null) || null,
                  }));
                const overlapWith = qStartDate && qEndDate
                  ? otherRanges.find(r =>
                      r.start <= qEndDate && (r.end == null || r.end >= qStartDate)
                    )
                  : null;
                const inPlanRange =
                  !!qStartDate &&
                  !!qEndDate &&
                  qStartDate >= minStart &&
                  qEndDate >= qStartDate &&
                  (!maxEnd || qEndDate <= maxEnd);
                const datesValid = inPlanRange && !overlapWith;
                return (
                  <>
                    <p className="text-xs text-white/60 leading-snug">
                      Elige el rango de fechas de la nueva campaña. Debe empezar después de que termine la actual
                      {' '}(<span className="font-mono text-white/80">{conflict.active.end_date}</span>)
                      {maxEnd && <> y caer dentro de tu plan (vence <span className="font-mono text-white/80">{maxEnd}</span>)</>}.
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                        <input
                          type="date"
                          required
                          value={qStartDate}
                          min={minStart}
                          max={maxEnd}
                          onChange={(e) => setQStartDate(e.target.value)}
                          className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin</label>
                        <input
                          type="date"
                          required
                          value={qEndDate}
                          min={qStartDate || minStart}
                          max={maxEnd}
                          onChange={(e) => setQEndDate(e.target.value)}
                          className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-white/40">
                      Ventana disponible: <span className="font-mono text-white/70">{minStart}</span>
                      {maxEnd ? <> → <span className="font-mono text-white/70">{maxEnd}</span></> : ' en adelante'}.
                    </p>
                    {!inPlanRange && (qStartDate || qEndDate) && (
                      <p className="text-[11px] text-amber-300">
                        Revisa el rango: el inicio debe ser igual o posterior a {minStart}
                        {maxEnd ? ` y el fin no puede pasar de ${maxEnd}` : ''}.
                      </p>
                    )}
                    {inPlanRange && overlapWith && (
                      <p className="text-[11px] text-amber-300">
                        Choca con otra campaña tuya
                        {' '}(<span className="text-white/70">{overlapWith.brand}</span>:
                        {' '}<span className="font-mono">{overlapWith.start}</span>
                        {overlapWith.end ? <> → <span className="font-mono">{overlapWith.end}</span></> : ' sin fin'}).
                        Ajusta el rango o elimina esa campaña primero.
                      </p>
                    )}

                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => setConflict({ ...conflict, step: 'choose' })}
                        className="px-4 py-2 text-xs text-white/60 hover:text-white/90 bg-white/5 hover:bg-white/10 rounded-lg"
                      >
                        ← Volver
                      </button>
                      <button
                        type="button"
                        disabled={submitting || !datesValid}
                        onClick={() => persistCampaign('queue', conflict.active)}
                        className="flex-1 px-4 py-2 text-xs font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {submitting ? 'Programando…' : 'Programar campaña'}
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Modal: reactivar campaña vencida con un rango de fechas nuevo */}
      {reactivate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => { if (!submitting) setReactivate(null); }} />
          <div className="relative bg-[#0E0E0E] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Reactivar campaña</h3>
              <button onClick={() => { if (!submitting) setReactivate(null); }} className="text-white/40 hover:text-white/80">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <p className="text-sm text-white font-semibold">{reactivate.brand_name}</p>
                <p className="text-[11px] text-white/50 mt-1 leading-snug">
                  Su rango anterior venció ({reactivate.end_date}). Indica un nuevo rango para volver al loop.
                  No pasa de nuevo por revisión del administrador: solo cambiar el video o el texto requiere aprobación.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Inicio</label>
                  <input type="date" value={rStartDate} min={today}
                    max={store?.contract_expiry_date || undefined}
                    onChange={(e) => setRStartDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Fin</label>
                  <input type="date" value={rEndDate} min={rStartDate || today}
                    max={store?.contract_expiry_date || undefined}
                    onChange={(e) => setREndDate(e.target.value)}
                    className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/50" />
                </div>
              </div>
              {store?.contract_expiry_date && (
                <p className="text-[10px] text-white/40">
                  Tu plan vence el {store.contract_expiry_date}. La campaña no puede pasar de esa fecha.
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setReactivate(null)} disabled={submitting}
                  className="flex-1 px-4 py-2.5 text-sm text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/10 rounded-lg">
                  Cancelar
                </button>
                <button type="button" onClick={reactivateWithDates}
                  disabled={submitting || !rEndDate}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-100 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
                  {submitting ? 'Reactivando…' : 'Reactivar en el loop'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Grids separados por tipo: cada uno conserva su aspect ratio sin que
          CSS Grid estire filas mixtas (cupón 4:3 vs campaña 9:16). */}
      {nothingVisible ? (
        <div className="bg-[#111] border border-white/5 rounded-xl p-12 text-center">
          <p className="text-white/30 text-sm">
            {items.length === 0 ? 'Aún no tienes promociones o banners.' : 'No hay resultados para este filtro.'}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {showCampaigns && sortedCampaigns.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">📺</span>
                  <h3 className="text-sm font-semibold text-white tracking-wide">
                    Campañas
                  </h3>
                  <span className="text-[10px] text-white/40 font-mono bg-white/5 px-1.5 py-0.5 rounded">
                    {sortedCampaigns.length}
                  </span>
                </div>
                <span className="text-[10px] text-white/30">Vertical · 9:16</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {sortedCampaigns.map(c => (
                  <CampaignCard
                    key={`a-${c.id}`}
                    c={c}
                    onEdit={openEditCampaign}
                    onDelete={deleteCampaign}
                    onToggleActive={toggleCampaignActive}
                    onShowMetrics={isOwner ? setMetricsFor : undefined}
                    today={today}
                  />
                ))}
              </div>
            </section>
          )}

          {((showCampaigns && sortedCampaigns.length > 0 && showBanners && sortedBanners.length > 0) ||
            (showCampaigns && sortedCampaigns.length > 0 && showCoupons && sortedCoupons.length > 0)) && (
            <div className="border-t border-white/5" />
          )}

          {showBanners && sortedBanners.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🖼️</span>
                  <h3 className="text-sm font-semibold text-white tracking-wide">
                    Banners
                  </h3>
                  <span className="text-[10px] text-white/40 font-mono bg-white/5 px-1.5 py-0.5 rounded">
                    {sortedBanners.length}
                  </span>
                </div>
                <span className="text-[10px] text-white/30">Vertical · 80:192</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {sortedBanners.map(b => (
                  <BannerCard
                    key={`b-${b.id}`}
                    b={b}
                    onEdit={openEditBanner}
                    onDelete={deleteBanner}
                    onToggleActive={toggleBannerActive}
                    today={today}
                  />
                ))}
              </div>
            </section>
          )}

          {((showBanners && sortedBanners.length > 0 && showCoupons && sortedCoupons.length > 0) ||
            (showCampaigns && sortedCampaigns.length > 0 && !showBanners && showCoupons && sortedCoupons.length > 0)) && (
            <div className="border-t border-white/5" />
          )}

          {showCoupons && sortedCoupons.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🎟️</span>
                  <h3 className="text-sm font-semibold text-white tracking-wide">
                    Cupones
                  </h3>
                  <span className="text-[10px] text-white/40 font-mono bg-white/5 px-1.5 py-0.5 rounded">
                    {sortedCoupons.length}
                  </span>
                </div>
                <span className="text-[10px] text-white/30">Horizontal · 4:3</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {sortedCoupons.map(c => (
                  <CouponCard
                    key={`c-${c.id}`}
                    c={c}
                    onEdit={openEditCoupon}
                    onDelete={deleteCoupon}
                    today={today}
                    redeemedCount={couponRedeemedMap[c.id] || 0}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Métricas de campaña (solo lectura, solo dueño) */}
      {metricsFor && (() => {
        const rows = impressions.filter(d => d.campaign_id === metricsFor.id);
        const d7 = dayMinus(today, 6);
        const d30 = dayMinus(today, 29);
        let valid = 0, full = 0, vToday = 0, v7 = 0, v30 = 0, f30 = 0;
        const byKiosk = new Map<string, { valid: number; full: number }>();
        rows.forEach(r => {
          const v = validOf(r), f = fullOf(r);
          valid += v; full += f;
          if (r.day === today) vToday += v;
          if (r.day >= d7) v7 += v;
          if (r.day >= d30) { v30 += v; f30 += f; }
          if (r.kiosk_id) {
            const cur = byKiosk.get(r.kiosk_id) || { valid: 0, full: 0 };
            cur.valid += v; cur.full += f;
            byKiosk.set(r.kiosk_id, cur);
          }
        });
        const kiosks = Array.from(byKiosk.entries()).sort((a, b) => b[1].valid - a[1].valid);
        const completionRate = valid > 0 ? Math.round((full / valid) * 100) : 0;
        const stat = (label: string, value: number) => (
          <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3">
            <p className="text-[10px] text-white/40 uppercase tracking-wider">{label}</p>
            <p className="text-xl font-bold font-mono text-white mt-0.5">{value.toLocaleString('es-VE')}</p>
          </div>
        );
        return (
          <div className="fixed inset-0 z-[65] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setMetricsFor(null)} />
            <div className="relative bg-[#0E0E0E] border border-cyan-500/30 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span>📊</span>
                  Métricas · {metricsFor.brand_name}
                </h3>
                <button onClick={() => setMetricsFor(null)} className="text-white/40 hover:text-white/80">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="px-6 py-5 space-y-5">
                <p className="text-[11px] text-white/45 leading-snug">
                  Impresiones válidas (el slot se vio al menos 5 s) y visualizaciones completas
                  (el slot de {CAMPAIGN_DURATION_SECONDS} s se reprodujo entero) registradas en los kioscos.
                </p>

                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Impresiones (&gt; 5 s)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {stat('Hoy', vToday)}
                    {stat('Últimos 7 días', v7)}
                    {stat('Últimos 30 días', v30)}
                    {stat('Total', valid)}
                  </div>
                </div>

                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Visualizaciones completas</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider">Últimos 30 días</p>
                      <p className="text-xl font-bold font-mono text-emerald-300 mt-0.5">{f30.toLocaleString('es-VE')}</p>
                    </div>
                    <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider">Total</p>
                      <p className="text-xl font-bold font-mono text-emerald-300 mt-0.5">{full.toLocaleString('es-VE')}</p>
                    </div>
                    <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider">% Completas</p>
                      <p className="text-xl font-bold font-mono text-emerald-300 mt-0.5">{completionRate}%</p>
                    </div>
                    <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider">Kioscos</p>
                      <p className="text-xl font-bold font-mono text-white mt-0.5">{kiosks.length.toLocaleString('es-VE')}</p>
                    </div>
                  </div>
                </div>

                {kiosks.length > 0 && (
                  <div>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest font-medium mb-2">Desglose por kiosco</p>
                    <div className="bg-[#0A0A0A] border border-white/10 rounded-lg overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-white/5 text-white/30 uppercase text-[10px] tracking-wider">
                            <th className="px-3 py-2 font-medium">Kiosco</th>
                            <th className="px-3 py-2 font-medium text-right">Impresiones</th>
                            <th className="px-3 py-2 font-medium text-right">Vistas completas</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kiosks.map(([kioskId, m]) => (
                            <tr key={kioskId} className="border-b border-white/[0.03]">
                              <td className="px-3 py-2 text-white/70 font-mono">{kioskId}</td>
                              <td className="px-3 py-2 text-right font-mono text-white/70">{m.valid.toLocaleString('es-VE')}</td>
                              <td className="px-3 py-2 text-right font-mono text-emerald-400/80">{m.full.toLocaleString('es-VE')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {valid === 0 && (
                  <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4 text-center text-white/30 text-xs">
                    Esta campaña aún no registra impresiones en los kioscos.
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 pt-1">
                  <Link href="/cliente/dashboard" className="text-[11px] text-cyan-400 hover:underline">
                    Ver analíticas completas →
                  </Link>
                  <button
                    onClick={() => setMetricsFor(null)}
                    className="px-4 py-2 text-xs font-semibold text-white/70 bg-white/5 hover:bg-white/10 rounded-lg"
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Confirm dialog in-app (reemplaza window.confirm) */}
      {confirmDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => setConfirmDialog(null)}
          />
          <div className={`relative bg-[#0E0E0E] border rounded-2xl w-full max-w-md shadow-2xl ${
            confirmDialog.tone === 'danger' ? 'border-red-500/40' : 'border-amber-500/40'
          }`}>
            <div className="px-6 py-4 border-b border-white/10 flex items-center gap-2">
              <svg className={`w-5 h-5 shrink-0 ${
                confirmDialog.tone === 'danger' ? 'text-red-300' : 'text-amber-300'
              }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h3 className={`text-sm font-semibold ${
                confirmDialog.tone === 'danger' ? 'text-red-100' : 'text-amber-100'
              }`}>
                {confirmDialog.title}
              </h3>
            </div>
            <div className="px-6 py-5">
              <p className="text-sm text-white/70 leading-relaxed whitespace-pre-line">
                {confirmDialog.message}
              </p>
            </div>
            <div className="px-6 pb-5 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="flex-1 px-4 py-2.5 text-sm text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDialog.onConfirm}
                className={`flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg border transition-colors ${
                  confirmDialog.tone === 'danger'
                    ? 'bg-red-500/20 hover:bg-red-500/30 border-red-500/40 text-red-100'
                    : 'bg-amber-500/20 hover:bg-amber-500/30 border-amber-500/40 text-amber-100'
                }`}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CouponCard({ c, onEdit, onDelete, today, redeemedCount }: { c: any; onEdit: (c: any) => void; onDelete: (c: any) => void; today: string; redeemedCount: number }) {
  const isFlash = FLASH_PLANS.has(c.plan_type);
  const active = c.amount_available > 0 && (!c.end_date || c.end_date >= new Date().toISOString());
  const approval = APPROVAL_CHIP[c.approval_status || 'approved'] || APPROVAL_CHIP.approved;
  return (
    <div className="bg-[#0F0F0F] border border-white/5 rounded-xl overflow-hidden">
      <div className="aspect-[4/3] bg-black flex items-center justify-center relative">
        {c.image_url ? (
          <img src={c.image_url} alt={c.title} className="w-full h-full object-cover" />
        ) : (
          <span className="text-white/20 text-xs">Sin imagen</span>
        )}
        <span className="absolute top-2 left-2 text-[9px] font-bold tracking-wider bg-black/70 text-white border border-white/20 px-1.5 py-0.5 rounded">
          🎟️ CUPÓN
        </span>
        <span className={`absolute top-2 right-2 text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border ${approval.cls}`}>
          {approval.label}
        </span>
      </div>
      <div className="p-4 space-y-1.5">
        {c.approval_status === 'rejected' && (
          <div className="rounded-lg bg-red-500/15 border-2 border-red-500/50 px-3 py-2.5 shadow-[0_0_0_1px_rgba(248,113,113,0.15)]">
            <div className="flex items-center gap-1.5 mb-1">
              <svg className="w-3.5 h-3.5 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-[11px] font-bold tracking-wider text-red-200 uppercase">Rechazado por el administrador</p>
            </div>
            {c.rejection_reason ? (
              <p className="text-[12px] text-red-100 leading-snug">{c.rejection_reason}</p>
            ) : (
              <p className="text-[11px] text-red-300/70 italic">Sin motivo especificado.</p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-white text-sm font-bold truncate">{c.title}</h4>
          {isFlash && (
            <span className="text-[9px] font-bold tracking-wider bg-pink-500/20 text-pink-300 border border-pink-500/40 px-1.5 py-0.5 rounded shrink-0">
              ⚡ FLASH
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
            {PLAN_LABELS[c.plan_type] || c.plan_type}
          </span>
          {!active && (
            <span className="text-[10px] font-mono text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
              AGOTADO/VENCIDO
            </span>
          )}
        </div>
        <p className="text-[11px] text-emerald-300 font-mono font-semibold">
          {Number(c.discount_percent ?? 0)}% OFF · vence {c.end_date?.split('T')[0] || '—'}
        </p>
        <p className="text-[10px] text-white/30 font-mono break-all">{c.code}</p>
        <div className="grid grid-cols-2 gap-2 pt-2 pb-1 border-t border-white/5 text-[11px] font-mono">
          <div>
            <span className="text-white/40 block uppercase text-[9px] tracking-wider">Quedan</span>
            <span className={active ? 'text-emerald-300 font-bold' : 'text-white/30 font-bold'}>
              {c.amount_available} uds.
            </span>
          </div>
          <div>
            <span className="text-white/40 block uppercase text-[9px] tracking-wider">Canjeados</span>
            <span className="text-pink-300 font-bold">
              {redeemedCount} uds.
            </span>
          </div>
        </div>
        <div className="flex gap-1.5 pt-2">
          <button onClick={() => onEdit(c)} className="flex-1 text-[11px] text-white/70 bg-white/5 hover:bg-white/10 rounded-md py-1.5">
            Editar
          </button>
          <button onClick={() => onDelete(c)} className="flex-1 text-[11px] text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-md py-1.5">
            Eliminar
          </button>
        </div>
      </div>
    </div>
  );
}

function CampaignCard({ c, onEdit, onDelete, onToggleActive, onShowMetrics, today }: { c: any; onEdit: (c: any) => void; onDelete: (c: any) => void; onToggleActive: (c: any, next: boolean) => void; onShowMetrics?: (c: any) => void; today: string }) {
  const active = c.is_active && (!c.end_date || c.end_date >= today);
  const approval = APPROVAL_CHIP[c.approval_status || 'approved'] || APPROVAL_CHIP.approved;
  // Solo una campaña aprobada puede pausarse/reactivarse directo (sin volver a
  // revisión). Pendientes/rechazadas no tienen toggle: aún no están aprobadas.
  const isApproved = (c.approval_status || 'approved') === 'approved';
  return (
    <div className="bg-[#0F0F0F] border border-white/5 rounded-xl overflow-hidden">
      <div className="aspect-[9/16] bg-black flex items-center justify-center relative">
        {c.media_type === 'video' && c.media_url ? (
          <video
            key={c.media_url}
            src={c.media_url}
            className="w-full h-full object-cover bg-black"
            muted
            loop
            autoPlay
            playsInline
            controls
            preload="metadata"
          />
        ) : c.media_url ? (
          <img src={c.media_url} alt={c.brand_name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-white/20 text-xs">Sin media</span>
        )}
        <span className="absolute top-2 left-2 text-[9px] font-bold tracking-wider bg-black/70 text-white border border-white/20 px-1.5 py-0.5 rounded">
          📺 CAMPAÑA
        </span>
        <span className={`absolute top-2 right-2 text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border ${approval.cls}`}>
          {approval.label}
        </span>
      </div>
      <div className="p-4 space-y-1.5">
        {c.approval_status === 'rejected' && (
          <div className="rounded-lg bg-red-500/15 border-2 border-red-500/50 px-3 py-2.5 shadow-[0_0_0_1px_rgba(248,113,113,0.15)]">
            <div className="flex items-center gap-1.5 mb-1">
              <svg className="w-3.5 h-3.5 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-[11px] font-bold tracking-wider text-red-200 uppercase">Rechazada por el administrador</p>
            </div>
            {c.rejection_reason ? (
              <p className="text-[12px] text-red-100 leading-snug">{c.rejection_reason}</p>
            ) : (
              <p className="text-[11px] text-red-300/70 italic">Sin motivo especificado.</p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-white text-sm font-bold truncate">{c.brand_name}</h4>
          <span className={`text-[9px] font-semibold px-2 py-0.5 rounded ${active ? 'text-emerald-300 bg-emerald-500/15' : 'text-white/40 bg-white/5'}`}>
            {active ? 'ACTIVA' : 'INACTIVA'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded ${PLAN_COLORS[c.plan_type] || 'text-white/40 bg-white/5'}`}>
            {PLAN_LABELS[c.plan_type] || c.plan_type}
          </span>
          <span className="text-[10px] text-white/30 font-mono">{c.duration_seconds}s</span>
        </div>
        <p className="text-[10px] text-white/40 font-mono">
          {c.start_date}{c.end_date ? ` → ${c.end_date}` : ' · sin fin'}
        </p>
        <div className="flex flex-col gap-1.5 pt-2">
          {onShowMetrics && (
            <button
              onClick={() => onShowMetrics(c)}
              className="w-full text-[11px] font-semibold rounded-md py-1.5 border text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 border-cyan-500/30 flex items-center justify-center gap-1.5"
            >
              📊 Ver métricas
            </button>
          )}
          {isApproved && (
            <button
              onClick={() => onToggleActive(c, !c.is_active)}
              className={`w-full text-[11px] font-semibold rounded-md py-1.5 border ${c.is_active
                ? 'text-white/70 bg-white/5 hover:bg-white/10 border-white/15'
                : 'text-emerald-200 bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40'
                }`}
            >
              {c.is_active ? 'Pausar' : 'Activar (sin re-aprobación)'}
            </button>
          )}
          <div className="flex gap-1.5">
            <button onClick={() => onEdit(c)} className="flex-1 text-[11px] text-white/70 bg-white/5 hover:bg-white/10 rounded-md py-1.5">
              Editar
            </button>
            <button onClick={() => onDelete(c)} className="flex-1 text-[11px] text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-md py-1.5">
              Eliminar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BannerCard({
  b,
  onEdit,
  onDelete,
  onToggleActive,
  today,
}: {
  b: any;
  onEdit: (b: any) => void;
  onDelete: (b: any) => void;
  onToggleActive: (b: any, next: boolean) => void;
  today: string;
}) {
  const active = b.is_active && (!b.end_date || b.end_date >= today);
  const approval = APPROVAL_CHIP[b.approval_status || 'approved'] || APPROVAL_CHIP.approved;
  const isApproved = (b.approval_status || 'approved') === 'approved';

  return (
    <div className="bg-[#0F0F0F] border border-white/5 rounded-xl overflow-hidden">
      <div className="aspect-[80/192] max-h-[300px] bg-black flex items-center justify-center relative">
        {b.media_type === 'video' && b.media_url ? (
          <video
            key={b.media_url}
            src={b.media_url}
            className="w-full h-full object-cover bg-black"
            muted
            loop
            autoPlay
            playsInline
            controls
            preload="metadata"
          />
        ) : b.media_url ? (
          <img src={b.media_url} alt="Banner" className="w-full h-full object-cover" />
        ) : (
          <span className="text-white/20 text-xs">Sin media</span>
        )}
        <span className="absolute top-2 left-2 text-[9px] font-bold tracking-wider bg-black/70 text-white border border-white/20 px-1.5 py-0.5 rounded">
          🖼️ BANNER
        </span>
        <span className={`absolute top-2 right-2 text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border ${approval.cls}`}>
          {approval.label}
        </span>
      </div>
      <div className="p-4 space-y-1.5">
        {b.approval_status === 'rejected' && (
          <div className="rounded-lg bg-red-500/15 border-2 border-red-500/50 px-3 py-2.5 shadow-[0_0_0_1px_rgba(248,113,113,0.15)]">
            <div className="flex items-center gap-1.5 mb-1">
              <svg className="w-3.5 h-3.5 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-[11px] font-bold tracking-wider text-red-200 uppercase">Rechazado por el administrador</p>
            </div>
            {b.rejection_reason ? (
              <p className="text-[12px] text-red-100 leading-snug">{b.rejection_reason}</p>
            ) : (
              <p className="text-[11px] text-red-300/70 italic">Sin motivo especificado.</p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-white text-sm font-bold truncate">Posición: {b.ui_position}</h4>
          <span className={`text-[9px] font-semibold px-2 py-0.5 rounded ${active ? 'text-emerald-300 bg-emerald-500/15' : 'text-white/40 bg-white/5'}`}>
            {active ? 'ACTIVO' : 'INACTIVO'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-white/40 font-mono">{b.slot_position ? `Slot: ${b.slot_position}` : 'Slot: por asignar'}</span>
          <span className="text-[10px] text-white/40 font-mono uppercase">{b.media_type}</span>
        </div>
        <p className="text-[10px] text-white/40 font-mono">
          {b.start_date ? b.start_date.split('T')[0] : 'Inmediato'}{b.end_date ? ` → ${b.end_date.split('T')[0]}` : ' · sin fin'}
        </p>
        <div className="flex flex-col gap-1.5 pt-2">
          {isApproved && (
            <button
              onClick={() => onToggleActive(b, !b.is_active)}
              className={`w-full text-[11px] font-semibold rounded-md py-1.5 border ${b.is_active
                ? 'text-white/70 bg-white/5 hover:bg-white/10 border-white/15'
                : 'text-emerald-200 bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40'
                }`}
            >
              {b.is_active ? 'Pausar' : 'Activar (sin re-aprobación)'}
            </button>
          )}
          <div className="flex gap-1.5">
            <button onClick={() => onEdit(b)} className="flex-1 text-[11px] text-white/70 bg-white/5 hover:bg-white/10 rounded-md py-1.5">
              Editar
            </button>
            <button onClick={() => onDelete(b)} className="flex-1 text-[11px] text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-md py-1.5">
              Eliminar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
