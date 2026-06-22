'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useState, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { supabase } from '../../../lib/supabase';
import { confirmDialog } from '../../components/confirm-dialog';

interface Store { id: string; name: string; local_number: string; node_id: string | null; }
interface Kiosk { id: string; name: string; location: string; node_id: string | null; }
interface Bathroom { id: string; name: string; floor_level: number; local_number: string | null; node_id: string | null; }
interface MapNode { id: string; x: number; y: number; node_type: string; floor_level: number; }
interface Polygon { id: string; name: string; color: string; points: Pt[]; floor_level: number; store_id?: string; }
interface Route { id: string; name: string; color: string; points: Pt[]; floor_level: number; origin_type?: string; origin_id?: string; dest_type?: string; dest_id?: string; }
type Pt = { x: number; y: number };

const FLOORS = [5, 4, 3, 2, 1];
const FLOOR_LABELS: Record<number, string> = { 5: 'C4', 4: 'C3', 3: 'C2', 2: 'C1', 1: 'RG' };
const FLOOR_DB: Record<number, string> = FLOOR_LABELS;

const KIOSK_COLOR = '#a855f7';
const BATHROOM_COLOR = '#06b6d4';

type Tool = 'pan' | 'node' | 'polygon' | 'route' | 'select' | 'bathroom';

export default function MapaEditorPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const bgFileRef = useRef<HTMLInputElement>(null);
  const [hasBgImage, setHasBgImage] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const [loadingMap, setLoadingMap] = useState(true);
  const [loadingBg, setLoadingBg] = useState(false);

  const [selectedFloor, setSelectedFloor] = useState(2);
  const [stores, setStores] = useState<Store[]>([]);
  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [polygons, setPolygons] = useState<Polygon[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);

  const [bathrooms, setBathrooms] = useState<Bathroom[]>([]);

  const [tool, setTool] = useState<Tool>('pan');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedPolyId, setSelectedPolyId] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  // Polygon draw
  const [drawingPoly, setDrawingPoly] = useState<Pt[]>([]);
  const [polyNameModal, setPolyNameModal] = useState(false);
  const [polyName, setPolyName] = useState('');
  const [polyColor, setPolyColor] = useState('#4466ff');
  const [polyStoreId, setPolyStoreId] = useState('');
  const [polyStoreSearch, setPolyStoreSearch] = useState('');
  const [polyStoreDropdown, setPolyStoreDropdown] = useState(false);
  const [savingPoly, setSavingPoly] = useState(false);

  // Route draw
  const [drawingRoute, setDrawingRoute] = useState<Pt[]>([]);
  const [routeModal, setRouteModal] = useState(false);
  const [routeName, setRouteName] = useState('');
  const [routeColor, setRouteColor] = useState('#22d3ee');
  const [routeOriginSearch, setRouteOriginSearch] = useState('');
  const [routeOriginId, setRouteOriginId] = useState('');
  const [routeOriginType, setRouteOriginType] = useState('');
  const [routeOriginDropdown, setRouteOriginDropdown] = useState(false);
  const [routeDestSearch, setRouteDestSearch] = useState('');
  const [routeDestId, setRouteDestId] = useState('');
  const [routeDestType, setRouteDestType] = useState('');
  const [routeDestDropdown, setRouteDestDropdown] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  const [showRoutesPanel, setShowRoutesPanel] = useState(true);

  // Bathroom modal
  const [showBathroomModal, setShowBathroomModal] = useState(false);
  const [bathroomModalMode, setBathroomModalMode] = useState<'create' | 'edit'>('create');
  const [bathroomName, setBathroomName] = useState('');
  const [bathroomLocalNumber, setBathroomLocalNumber] = useState('');
  const [isSavingBathroom, setIsSavingBathroom] = useState(false);

  // Node (kiosk) modal
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [pendingCoords, setPendingCoords] = useState<Pt | null>(null);
  const [selectedKioskId, setSelectedKioskId] = useState('');
  const [kioskSearch, setKioskSearch] = useState('');
  const [kioskDropdown, setKioskDropdown] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Walker animation
  const walkerPos = useRef<Pt | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  const [toastMsg, setToastMsg] = useState('');
  const cam = useRef({ x: 0, y: 0, zoom: 1 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const camStart = useRef({ x: 0, y: 0 });
  const mouseWorld = useRef<Pt>({ x: 0, y: 0 });
  const [zoomLabel, setZoomLabel] = useState('100%');

  // Refs for canvas
  const nodesRef = useRef(nodes); const storesRef = useRef(stores); const kiosksRef = useRef(kiosks); const bathroomsRef = useRef(bathrooms);
  const toolRef = useRef(tool); const selectedNodeIdRef = useRef(selectedNodeId);
  const hoveredNodeIdRef = useRef(hoveredNodeId);
  const drawingPolyRef = useRef(drawingPoly); const polygonsRef = useRef(polygons);
  const drawingRouteRef = useRef(drawingRoute); const routesRef = useRef(routes);
  const selectedPolyIdRef = useRef(selectedPolyId); const selectedRouteIdRef = useRef(selectedRouteId);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { storesRef.current = stores; }, [stores]);
  useEffect(() => { kiosksRef.current = kiosks; }, [kiosks]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);
  useEffect(() => { hoveredNodeIdRef.current = hoveredNodeId; }, [hoveredNodeId]);
  useEffect(() => { drawingPolyRef.current = drawingPoly; }, [drawingPoly]);
  useEffect(() => { polygonsRef.current = polygons; }, [polygons]);
  useEffect(() => { drawingRouteRef.current = drawingRoute; }, [drawingRoute]);
  useEffect(() => { routesRef.current = routes; }, [routes]);
  useEffect(() => { selectedPolyIdRef.current = selectedPolyId; }, [selectedPolyId]);
  useEffect(() => { selectedRouteIdRef.current = selectedRouteId; }, [selectedRouteId]);
  useEffect(() => { bathroomsRef.current = bathrooms; }, [bathrooms]);

  const showToast = useCallback((msg: string) => { setToastMsg(msg); setTimeout(() => setToastMsg(''), 2500); }, []);
  const screenToWorld = useCallback((sx: number, sy: number): Pt => ({ x: (sx - cam.current.x) / cam.current.zoom, y: (sy - cam.current.y) / cam.current.zoom }), []);

  const findNodeAt = useCallback((wx: number, wy: number, threshold = 20): MapNode | null => {
    const t = threshold / cam.current.zoom;
    for (let i = nodesRef.current.length - 1; i >= 0; i--) { const n = nodesRef.current[i]; if (Math.hypot(n.x - wx, n.y - wy) < t) return n; }
    return null;
  }, []);
  const findPolyAt = useCallback((wx: number, wy: number): Polygon | null => {
    for (let i = polygonsRef.current.length - 1; i >= 0; i--) { if (pointInPoly(wx, wy, polygonsRef.current[i].points)) return polygonsRef.current[i]; }
    return null;
  }, []);
  const findRouteAt = useCallback((wx: number, wy: number): Route | null => {
    const t = 12 / cam.current.zoom;
    for (let i = routesRef.current.length - 1; i >= 0; i--) { if (pointNearPath(wx, wy, routesRef.current[i].points, t)) return routesRef.current[i]; }
    return null;
  }, []);

  // ── Draw ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current; const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(cam.current.x, cam.current.y);
    ctx.scale(cam.current.zoom, cam.current.zoom);

    const bg = bgImageRef.current;
    if (bg && bg.complete && bg.naturalWidth > 0) {
      ctx.globalAlpha = 0.65; ctx.drawImage(bg, 0, 0); ctx.globalAlpha = 1;
    } else {
      const step = 100; ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
      const x0 = Math.floor(-cam.current.x / cam.current.zoom / step) * step - step;
      const y0 = Math.floor(-cam.current.y / cam.current.zoom / step) * step - step;
      for (let x = x0; x < x0 + w / cam.current.zoom + step * 2; x += step) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h / cam.current.zoom + step * 2); ctx.stroke(); }
      for (let y = y0; y < y0 + h / cam.current.zoom + step * 2; y += step) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w / cam.current.zoom + step * 2, y); ctx.stroke(); }
    }

    const z = cam.current.zoom;
    const cn = nodesRef.current;
    const selNodeId = selectedNodeIdRef.current, hovId = hoveredNodeIdRef.current;
    const selPolyId = selectedPolyIdRef.current, selRouteId = selectedRouteIdRef.current;

    // Polygons
    polygonsRef.current.forEach(poly => {
      if (poly.points.length < 3) return;
      const isSel = poly.id === selPolyId;
      ctx.beginPath(); ctx.moveTo(poly.points[0].x, poly.points[0].y);
      for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(poly.color, isSel ? 0.35 : 0.15); ctx.fill();
      ctx.strokeStyle = isSel ? '#fff' : poly.color; ctx.lineWidth = (isSel ? 2.5 : 1.5) / z; ctx.stroke();
      if (poly.name && z > 0.3) { const c = centroid(poly.points); ctx.font = `${Math.max(10, 13 / z)}px system-ui`; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(poly.name, c.x, c.y); }
      if (isSel) poly.points.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 4 / z, 0, Math.PI * 2); ctx.fillStyle = poly.color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / z; ctx.stroke(); });
    });

    // Drawing polygon preview
    const dp = drawingPolyRef.current;
    if (dp.length > 0) {
      ctx.beginPath(); ctx.moveTo(dp[0].x, dp[0].y);
      for (let i = 1; i < dp.length; i++) ctx.lineTo(dp[i].x, dp[i].y);
      ctx.lineTo(mouseWorld.current.x, mouseWorld.current.y);
      ctx.strokeStyle = '#6688ff'; ctx.lineWidth = 1.5 / z; ctx.setLineDash([5 / z, 3 / z]); ctx.stroke(); ctx.setLineDash([]);
      dp.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 4 / z, 0, Math.PI * 2); ctx.fillStyle = '#6688ff'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 / z; ctx.stroke(); });
    }

    // Routes
    routesRef.current.forEach(route => {
      if (route.points.length < 2) return;
      const isSel = route.id === selRouteId;
      ctx.beginPath(); ctx.moveTo(route.points[0].x, route.points[0].y);
      for (let i = 1; i < route.points.length; i++) ctx.lineTo(route.points[i].x, route.points[i].y);
      ctx.strokeStyle = isSel ? '#fff' : route.color; ctx.lineWidth = (isSel ? 3.5 : 2.5) / z;
      ctx.setLineDash([8 / z, 6 / z]); ctx.stroke(); ctx.setLineDash([]);
      // Start/End markers
      const first = route.points[0], last = route.points[route.points.length - 1];
      drawMarker(ctx, first.x, first.y, '#22c55e', 'A', z);
      drawMarker(ctx, last.x, last.y, '#ef4444', 'B', z);
      // Label
      if (route.name && z > 0.3 && route.points.length >= 2) {
        const mid = route.points[Math.floor(route.points.length / 2)];
        ctx.font = `${Math.max(10, 11 / z)}px system-ui`; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.textAlign = 'center';
        ctx.fillText(route.name, mid.x, mid.y - 12 / z);
      }
      // Vertices when selected
      if (isSel) route.points.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3 / z, 0, Math.PI * 2); ctx.fillStyle = route.color; ctx.fill(); });
    });

    // Drawing route preview
    const dr = drawingRouteRef.current;
    if (dr.length > 0) {
      ctx.beginPath(); ctx.moveTo(dr[0].x, dr[0].y);
      for (let i = 1; i < dr.length; i++) ctx.lineTo(dr[i].x, dr[i].y);
      ctx.lineTo(mouseWorld.current.x, mouseWorld.current.y);
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2 / z; ctx.stroke();
      dr.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3 / z, 0, Math.PI * 2); ctx.fillStyle = '#22d3ee'; ctx.fill(); });
      if (dr.length > 0) drawMarker(ctx, dr[0].x, dr[0].y, '#22c55e', 'A', z);
    }

    // Nodes (kiosks + bathrooms)
    cn.forEach(node => {
      const bathMatch = bathroomsRef.current.find(b => b.node_id === node.id);
      const isBathroom = !!bathMatch;
      const nodeColor = isBathroom ? BATHROOM_COLOR : KIOSK_COLOR;
      const r = node.id === selNodeId ? 10 / z : node.id === hovId ? 8 / z : 6 / z;
      if (node.id === selNodeId) { ctx.beginPath(); ctx.arc(node.x, node.y, r + 4 / z, 0, Math.PI * 2); ctx.fillStyle = hexToRgba(nodeColor, 0.2); ctx.fill(); }
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor; ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 2 / z; ctx.stroke();
      const label = isBathroom ? (bathMatch?.name || 'Baño') : (kiosksRef.current.find(k => k.node_id === node.id)?.name || '');
      if (label && z > 0.4) { ctx.font = `${Math.max(10, 12 / z)}px system-ui`; ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(label, node.x, node.y + r + 4 / z); }
    });

    // Walker
    const wp = walkerPos.current;
    if (wp) { ctx.beginPath(); ctx.arc(wp.x, wp.y, 10 / z, 0, Math.PI * 2); ctx.fillStyle = '#22d3ee'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 / z; ctx.stroke(); }

    ctx.restore();
  }, []);

  const resize = useCallback(() => { const c = canvasRef.current, w = wrapRef.current; if (!c || !w) return; c.width = w.clientWidth; c.height = w.clientHeight; draw(); }, [draw]);

  // ── Fetch ──
  const fetchData = useCallback(async () => {
    setLoadingMap(true);
    try {
      const [storesRes, kiosksRes, nodesRes] = await Promise.all([
        supabase.from('stores').select('id, name, local_number, node_id').eq('floor_level', FLOOR_DB[selectedFloor]),
        supabase.from('kiosks').select('id, name, location, node_id'),
        supabase.from('map_nodes').select('*').eq('floor_level', selectedFloor),
      ]);
      if (storesRes.data) setStores(storesRes.data);
      if (kiosksRes.data) setKiosks(kiosksRes.data);
      if (nodesRes.data) setNodes(nodesRes.data);

      // Tablas opcionales (pueden no existir aun)
      const polysRes = await supabase.from('map_polygons').select('*').eq('floor_level', selectedFloor);
      setPolygons(polysRes.data || []);

      const routesRes = await supabase.from('map_routes').select('*').eq('floor_level', selectedFloor);
      setRoutes(routesRes.data || []);

      const bathroomsRes = await supabase.from('bathrooms').select('*').eq('floor_level', selectedFloor);
      setBathrooms(bathroomsRes.data || []);
    } catch (err: any) {
      // Las tablas opcionales (map_polygons/map_routes/bathrooms) pueden no
      // existir aún; aun así dejamos rastro para no perder fallos reales (red,
      // permisos, tablas core).
      console.error('Error al cargar datos del mapa:', err?.message ?? err);
    }
    setLoadingMap(false);
  }, [selectedFloor]);

  // ── Bg image ──
  const loadBgFromUrl = useCallback((url: string) => {
    setLoadingBg(true);
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { bgImageRef.current = img; setHasBgImage(true); setLoadingBg(false); const c = canvasRef.current; if (c) { cam.current.zoom = Math.min(c.width / img.width, c.height / img.height) * 0.9; cam.current.x = (c.width - img.width * cam.current.zoom) / 2; cam.current.y = (c.height - img.height * cam.current.zoom) / 2; setZoomLabel(Math.round(cam.current.zoom * 100) + '%'); } draw(); };
    img.onerror = () => { bgImageRef.current = null; setHasBgImage(false); setLoadingBg(false); draw(); };
    img.src = url;
  }, [draw]);

  useEffect(() => {
    bgImageRef.current = null; setHasBgImage(false);
    const fk = FLOOR_LABELS[selectedFloor].toLowerCase();
    const filePath = `plano_${fk}.png`;
    // Check if file exists before trying to load
    supabase.storage.from('mapas').list('', { search: filePath }).then(({ data: files }) => {
      const exists = files?.some(f => f.name === filePath);
      if (exists) {
        const { data } = supabase.storage.from('mapas').getPublicUrl(filePath);
        if (data?.publicUrl) loadBgFromUrl(data.publicUrl + '?t=' + Date.now());
      } else {
        cam.current = { x: 0, y: 0, zoom: 1 }; setZoomLabel('100%'); draw();
      }
    });
  }, [selectedFloor, loadBgFromUrl, draw]);
  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { draw(); }, [nodes, polygons, routes, bathrooms, selectedNodeId, hoveredNodeId, drawingPoly, drawingRoute, selectedPolyId, selectedRouteId, draw]);
  useEffect(() => { resize(); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, [resize]);

  const handleUploadBg = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return; setUploadingBg(true);
    try { const fp = `plano_${FLOOR_LABELS[selectedFloor].toLowerCase()}.png`; const { error } = await supabase.storage.from('mapas').upload(fp, file, { upsert: true, cacheControl: '0' }); if (error) throw error; const { data } = supabase.storage.from('mapas').getPublicUrl(fp); if (data?.publicUrl) loadBgFromUrl(data.publicUrl + '?t=' + Date.now()); showToast('Plano actualizado'); } catch (err: any) { showToast('Error: ' + err.message); }
    finally { setUploadingBg(false); if (bgFileRef.current) bgFileRef.current.value = ''; }
  };
  const handleRemoveBg = async () => { if (!(await confirmDialog({ title: 'Quitar imagen de fondo', confirmLabel: 'Quitar', tone: 'danger' }))) return; await supabase.storage.from('mapas').remove([`plano_${FLOOR_LABELS[selectedFloor].toLowerCase()}.png`]); bgImageRef.current = null; setHasBgImage(false); cam.current = { x: 0, y: 0, zoom: 1 }; setZoomLabel('100%'); draw(); showToast('Plano eliminado'); };

  // ── Canvas events ──
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;

    const onMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const w = screenToWorld(sx, sy);

      if (e.button === 1 || (e.button === 0 && e.ctrlKey) || toolRef.current === 'pan') {
        isPanning.current = true; panStart.current = { x: e.clientX, y: e.clientY }; camStart.current = { x: cam.current.x, y: cam.current.y };
        canvas.style.cursor = 'grabbing'; return;
      }
      if (toolRef.current === 'node') {
        setPendingCoords({ x: Math.round(w.x), y: Math.round(w.y) }); setModalMode('create'); setSelectedKioskId(''); setKioskSearch(''); setKioskDropdown(false); setShowModal(true); return;
      }
      if (toolRef.current === 'bathroom') {
        setPendingCoords({ x: Math.round(w.x), y: Math.round(w.y) }); setBathroomModalMode('create'); setBathroomName(''); setBathroomLocalNumber(''); setShowBathroomModal(true); return;
      }
      if (toolRef.current === 'polygon') { setDrawingPoly(prev => [...prev, { x: Math.round(w.x), y: Math.round(w.y) }]); return; }
      if (toolRef.current === 'route') { setDrawingRoute(prev => [...prev, { x: Math.round(w.x), y: Math.round(w.y) }]); return; }
      if (toolRef.current === 'select') {
        const node = findNodeAt(w.x, w.y);
        if (node) { setSelectedNodeId(node.id); setSelectedPolyId(null); setSelectedRouteId(null); return; }
        const route = findRouteAt(w.x, w.y);
        if (route) { setSelectedRouteId(route.id); setSelectedNodeId(null); setSelectedPolyId(null); return; }
        const poly = findPolyAt(w.x, w.y);
        if (poly) { setSelectedPolyId(poly.id); setSelectedNodeId(null); setSelectedRouteId(null); return; }
        setSelectedNodeId(null); setSelectedPolyId(null); setSelectedRouteId(null);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseWorld.current = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      if (isPanning.current) { cam.current.x = camStart.current.x + (e.clientX - panStart.current.x); cam.current.y = camStart.current.y + (e.clientY - panStart.current.y); draw(); return; }
      if ((toolRef.current === 'polygon' && drawingPolyRef.current.length > 0) || (toolRef.current === 'route' && drawingRouteRef.current.length > 0)) draw();
      const node = findNodeAt(mouseWorld.current.x, mouseWorld.current.y);
      setHoveredNodeId(node?.id || null);
      if (toolRef.current === 'pan') canvas.style.cursor = 'grab';
      else if (toolRef.current === 'node' || toolRef.current === 'polygon' || toolRef.current === 'route') canvas.style.cursor = 'crosshair';
      else if (node) canvas.style.cursor = 'pointer';
      else canvas.style.cursor = 'default';
    };

    const onMouseUp = () => { if (isPanning.current) { isPanning.current = false; canvas.style.cursor = toolRef.current === 'pan' ? 'grab' : 'default'; } };

    const onDblClick = () => {
      if (toolRef.current === 'polygon' && drawingPolyRef.current.length >= 3) {
        setDrawingPoly(prev => prev.slice(0, -1));
        setPolyName(''); setPolyStoreId(''); setPolyStoreSearch(''); setPolyColor('#4466ff'); setPolyNameModal(true);
      }
      if (toolRef.current === 'route' && drawingRouteRef.current.length >= 2) {
        setDrawingRoute(prev => prev.slice(0, -1));
        setRouteName(''); setRouteColor('#22d3ee'); setRouteOriginSearch(''); setRouteOriginId(''); setRouteOriginType(''); setRouteOriginDropdown(false); setRouteDestSearch(''); setRouteDestId(''); setRouteDestType(''); setRouteDestDropdown(false); setRouteModal(true);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); const rect = canvas.getBoundingClientRect(); const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const old = cam.current.zoom; cam.current.zoom = Math.min(10, Math.max(0.1, old * (1 - e.deltaY * 0.001)));
      cam.current.x = sx - (sx - cam.current.x) * (cam.current.zoom / old); cam.current.y = sy - (sy - cam.current.y) * (cam.current.zoom / old);
      setZoomLabel(Math.round(cam.current.zoom * 100) + '%'); draw();
    };

    canvas.addEventListener('mousedown', onMouseDown); canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp); canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => { canvas.removeEventListener('mousedown', onMouseDown); canvas.removeEventListener('mousemove', onMouseMove); canvas.removeEventListener('mouseup', onMouseUp); canvas.removeEventListener('dblclick', onDblClick); canvas.removeEventListener('wheel', onWheel); };
  }, [draw, screenToWorld, findNodeAt, findPolyAt, findRouteAt, showToast, fetchData]);

  // ── Keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showModal || polyNameModal || routeModal || showBathroomModal) return;
      if (e.key === '1') setTool('pan'); if (e.key === '2') setTool('node'); if (e.key === '3') setTool('polygon'); if (e.key === '4') setTool('route'); if (e.key === '5') setTool('select'); if (e.key === '6') setTool('bathroom');
      if (e.key === 'Escape') { setDrawingPoly([]); setDrawingRoute([]); setSelectedNodeId(null); setSelectedPolyId(null); setSelectedRouteId(null); walkerPos.current = null; }
      if (e.key === 'Enter') {
        if (toolRef.current === 'polygon' && drawingPolyRef.current.length >= 3) { setPolyName(''); setPolyStoreId(''); setPolyStoreSearch(''); setPolyColor('#4466ff'); setPolyNameModal(true); }
        if (toolRef.current === 'route' && drawingRouteRef.current.length >= 2) { setRouteName(''); setRouteColor('#22d3ee'); setRouteOriginSearch(''); setRouteOriginId(''); setRouteOriginType(''); setRouteDestSearch(''); setRouteDestId(''); setRouteDestType(''); setRouteModal(true); }
      }
      if (e.key === 'Delete') {
        if (selectedNodeIdRef.current) {
          if (bathroomsRef.current.find(b => b.node_id === selectedNodeIdRef.current)) handleDeleteBathroomNode(selectedNodeIdRef.current);
          else handleDeleteNode(selectedNodeIdRef.current);
        }
        else if (selectedPolyIdRef.current) handleDeletePoly(selectedPolyIdRef.current);
        else if (selectedRouteIdRef.current) handleDeleteRoute(selectedRouteIdRef.current);
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [showModal, polyNameModal, routeModal, showBathroomModal]);

  // ── CRUD: Nodes ──
  const handleSaveNode = async () => { if (!pendingCoords) return; setIsSaving(true); try { const { data: ins, error } = await supabase.from('map_nodes').insert({ x: pendingCoords.x, y: pendingCoords.y, floor_level: selectedFloor, node_type: 'kiosk' }).select().single(); if (error) throw error; if (selectedKioskId && ins) await supabase.from('kiosks').update({ node_id: ins.id }).eq('id', selectedKioskId); setShowModal(false); showToast('Kiosco colocado'); fetchData(); } catch (err: any) { showToast('Error: ' + err.message); } finally { setIsSaving(false); } };
  const handleUpdateNode = async () => { if (!selectedNodeId) return; setIsSaving(true); try { await supabase.from('kiosks').update({ node_id: null }).eq('node_id', selectedNodeId); if (selectedKioskId) await supabase.from('kiosks').update({ node_id: selectedNodeId }).eq('id', selectedKioskId); setShowModal(false); showToast('Kiosco actualizado'); fetchData(); } catch (err: any) { showToast('Error: ' + err.message); } finally { setIsSaving(false); } };
  const handleDeleteNode = async (id: string) => { if (!(await confirmDialog({ title: 'Eliminar kiosco del mapa', confirmLabel: 'Eliminar', tone: 'danger' }))) return; await supabase.from('kiosks').update({ node_id: null }).eq('node_id', id); await supabase.from('map_nodes').delete().eq('id', id); setSelectedNodeId(null); setShowModal(false); showToast('Kiosco eliminado'); fetchData(); };
  const openEditModal = () => { const node = nodes.find(n => n.id === selectedNodeId); if (!node) return; setModalMode('edit'); setPendingCoords({ x: node.x, y: node.y }); const k = kiosks.find(k => k.node_id === node.id); setSelectedKioskId(k?.id || ''); setKioskSearch(k?.name || ''); setKioskDropdown(false); setShowModal(true); };

  // ── CRUD: Bathrooms ──
  const handleSaveBathroom = async () => { if (!pendingCoords) return; setIsSavingBathroom(true); try { const { data: ins, error } = await supabase.from('map_nodes').insert({ x: pendingCoords.x, y: pendingCoords.y, floor_level: selectedFloor, node_type: 'bathroom' }).select().single(); if (error) throw error; if (ins) { const { error: bErr } = await supabase.from('bathrooms').insert({ name: bathroomName || 'Baño', floor_level: selectedFloor, local_number: bathroomLocalNumber || null, node_id: ins.id }); if (bErr) throw bErr; } setShowBathroomModal(false); showToast('Baño colocado'); fetchData(); } catch (err: any) { showToast('Error: ' + err.message); } finally { setIsSavingBathroom(false); } };
  const handleUpdateBathroom = async () => { if (!selectedNodeId) return; setIsSavingBathroom(true); try { const bath = bathroomsRef.current.find(b => b.node_id === selectedNodeId); if (bath) { await supabase.from('bathrooms').update({ name: bathroomName, local_number: bathroomLocalNumber || null }).eq('id', bath.id); } setShowBathroomModal(false); showToast('Baño actualizado'); fetchData(); } catch (err: any) { showToast('Error: ' + err.message); } finally { setIsSavingBathroom(false); } };
  const handleDeleteBathroomNode = async (nodeId: string) => { if (!(await confirmDialog({ title: 'Eliminar baño del mapa', confirmLabel: 'Eliminar', tone: 'danger' }))) return; const bath = bathroomsRef.current.find(b => b.node_id === nodeId); if (bath) await supabase.from('bathrooms').delete().eq('id', bath.id); await supabase.from('map_nodes').delete().eq('id', nodeId); setSelectedNodeId(null); setShowBathroomModal(false); showToast('Baño eliminado'); fetchData(); };
  const openEditBathroomModal = () => { const node = nodes.find(n => n.id === selectedNodeId); if (!node) return; setBathroomModalMode('edit'); setPendingCoords({ x: node.x, y: node.y }); const bath = bathrooms.find(b => b.node_id === node.id); setBathroomName(bath?.name || ''); setBathroomLocalNumber(bath?.local_number || ''); setShowBathroomModal(true); };

  // ── CRUD: Polygons ──
  const handleSavePoly = async () => { if (drawingPoly.length < 3 || savingPoly) return; setSavingPoly(true); try { await supabase.from('map_polygons').insert({ name: polyName || 'Sin nombre', color: polyColor, points: drawingPoly, floor_level: selectedFloor, store_id: polyStoreId || null }); setDrawingPoly([]); setPolyNameModal(false); showToast('Area creada'); fetchData(); } catch { showToast('Error: crea la tabla map_polygons en Supabase'); setPolyNameModal(false); } finally { setSavingPoly(false); } };
  const handleDeletePoly = async (id: string) => { if (!(await confirmDialog({ title: 'Eliminar área', confirmLabel: 'Eliminar', tone: 'danger' }))) return; await supabase.from('map_polygons').delete().eq('id', id); setSelectedPolyId(null); showToast('Area eliminada'); fetchData(); };

  // ── CRUD: Routes ──
  const handleSaveRoute = async () => { if (drawingRoute.length < 2 || savingRoute) return; setSavingRoute(true); try { await supabase.from('map_routes').insert({ name: routeName || 'Sin nombre', color: routeColor, points: drawingRoute, floor_level: selectedFloor, origin_type: routeOriginType || null, origin_id: routeOriginId || null, dest_type: routeDestType || null, dest_id: routeDestId || null }); setDrawingRoute([]); setRouteModal(false); showToast('Ruta creada'); fetchData(); } catch { showToast('Error: crea la tabla map_routes en Supabase'); setRouteModal(false); } finally { setSavingRoute(false); } };
  const handleDeleteRoute = async (id: string) => { if (!(await confirmDialog({ title: 'Eliminar ruta', confirmLabel: 'Eliminar', tone: 'danger' }))) return; await supabase.from('map_routes').delete().eq('id', id); setSelectedRouteId(null); showToast('Ruta eliminada'); fetchData(); };

  // ── Animate walker ──
  const doAnimate = (route: Route) => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    setIsAnimating(true);
    const segs: { fx: number; fy: number; tx: number; ty: number; dist: number }[] = [];
    let total = 0;
    for (let i = 1; i < route.points.length; i++) { const d = Math.hypot(route.points[i].x - route.points[i - 1].x, route.points[i].y - route.points[i - 1].y); segs.push({ fx: route.points[i - 1].x, fy: route.points[i - 1].y, tx: route.points[i].x, ty: route.points[i].y, dist: d }); total += d; }
    let traveled = 0;
    const step = () => {
      traveled += 0.5; if (traveled >= total) { walkerPos.current = null; setIsAnimating(false); draw(); showToast('Ruta completada'); return; }
      let acc = 0;
      for (const s of segs) { if (acc + s.dist >= traveled) { const t = (traveled - acc) / s.dist; walkerPos.current = { x: s.fx + (s.tx - s.fx) * t, y: s.fy + (s.ty - s.fy) * t }; break; } acc += s.dist; }
      draw(); animFrameRef.current = requestAnimationFrame(step);
    };
    animFrameRef.current = requestAnimationFrame(step);
  };
  const animateWalkerById = (id: string) => { const route = routesRef.current.find(r => r.id === id); if (route && route.points.length >= 2) doAnimate(route); };
  const animateWalker = () => { const route = routes.find(r => r.id === selectedRouteId); if (route && route.points.length >= 2) doAnimate(route); };

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const selectedPoly = polygons.find(p => p.id === selectedPolyId);
  const selectedRoute = routes.find(r => r.id === selectedRouteId);

  const TOOLS: { key: Tool; label: string; sc: string; icon: ReactNode }[] = [
    { key: 'pan', label: 'Mover', sc: '1', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" /> },
    { key: 'node', label: 'Kiosco', sc: '2', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /> },
    { key: 'bathroom', label: 'Baño', sc: '6', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /> },
    { key: 'polygon', label: 'Area', sc: '3', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /> },
    { key: 'route', label: 'Ruta', sc: '4', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /> },
    { key: 'select', label: 'Seleccionar', sc: '5', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" /> },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-2 border-b border-white/5 bg-[#0A0A0A] shrink-0">
        <div className="flex items-center gap-1">
          <div className="flex gap-0.5 bg-white/5 rounded-md p-0.5 mr-3">
            {FLOORS.map(f => (<button key={f} onClick={() => setSelectedFloor(f)} className={`px-3 py-1 text-[11px] font-medium rounded transition-all ${selectedFloor === f ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/50'}`}>{FLOOR_LABELS[f]}</button>))}
          </div>
          <div className="w-px h-5 bg-white/10 mx-1" />
          {TOOLS.map(t => (
            <button key={t.key} onClick={() => { setTool(t.key); if (t.key !== 'polygon') setDrawingPoly([]); if (t.key !== 'route') setDrawingRoute([]); }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-md transition-all ${tool === t.key ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/50 hover:bg-white/5'}`}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">{t.icon}</svg>{t.label}<span className="text-white/15 text-[9px]">{t.sc}</span>
            </button>
          ))}
          <div className="w-px h-5 bg-white/10 mx-1" />
          <input ref={bgFileRef} type="file" accept="image/*" onChange={handleUploadBg} className="hidden" />
          <button onClick={() => bgFileRef.current?.click()} disabled={uploadingBg} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-white/30 hover:text-white/50 hover:bg-white/5 rounded-md transition-colors disabled:opacity-50">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            {uploadingBg ? 'Subiendo...' : hasBgImage ? 'Cambiar plano' : 'Cargar plano'}
          </button>
          {hasBgImage && <button onClick={handleRemoveBg} className="flex items-center gap-1 px-2 py-1.5 text-[11px] text-red-400/40 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>Quitar</button>}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: KIOSK_COLOR }} /><span className="text-[9px] text-white/20">Kiosco</span></div>
            <div className="flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: BATHROOM_COLOR }} /><span className="text-[9px] text-white/20">Baño</span></div>
            <div className="flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full bg-blue-500" /><span className="text-[9px] text-white/20">Area</span></div>
            <div className="flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full bg-cyan-400" /><span className="text-[9px] text-white/20">Ruta</span></div>
          </div>
          <span className="text-[10px] text-white/15 font-mono">{zoomLabel}</span>
        </div>
      </div>

      {/* Canvas + panels */}
      <div className="flex flex-1 overflow-hidden">
        <div ref={wrapRef} className="flex-1 relative bg-[#1e1e2a] overflow-hidden">
          <canvas ref={canvasRef} className="absolute inset-0" />
          {(loadingMap || loadingBg) && <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#1e1e2a]/80 backdrop-blur-sm pointer-events-none"><PageSpinner /><span className="text-[11px] text-white/30">{loadingBg ? 'Cargando plano...' : 'Cargando elementos...'}</span></div>}
          {toastMsg && <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white/10 backdrop-blur-sm text-white text-xs px-3 py-1.5 rounded-lg pointer-events-none z-20">{toastMsg}</div>}
          {tool === 'node' && <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[11px] px-3 py-1.5 rounded-lg z-20">Clic para colocar un kiosco</div>}
          {tool === 'bathroom' && <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[11px] px-3 py-1.5 rounded-lg z-20">Clic para colocar un baño — Piso: {FLOOR_LABELS[selectedFloor]}</div>}
          {tool === 'polygon' && <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[11px] px-3 py-1.5 rounded-lg z-20">{drawingPoly.length === 0 ? 'Clic para dibujar un area' : `${drawingPoly.length} puntos — Doble-clic o Enter para cerrar`}</div>}
          {tool === 'route' && <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[11px] px-3 py-1.5 rounded-lg z-20">{drawingRoute.length === 0 ? 'Clic para trazar una ruta punto a punto' : `${drawingRoute.length} puntos — Doble-clic o Enter para terminar`}</div>}
        </div>

        {/* Side panel: Kiosk node */}
        {selectedNode && tool === 'select' && !bathrooms.find(b => b.node_id === selectedNode.id) && (
          <div className="w-56 bg-[#111] border-l border-white/5 p-4 space-y-4 shrink-0">
            <div><p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Kiosco</p><div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full" style={{ backgroundColor: KIOSK_COLOR }} /><span className="text-sm text-white font-medium">{kiosks.find(k => k.node_id === selectedNode.id)?.name || 'Sin vincular'}</span></div></div>
            <div className="space-y-1"><p className="text-[10px] text-white/20 font-mono">x:{selectedNode.x} y:{selectedNode.y}</p><p className="text-[10px] text-white/20 font-mono">Piso: {FLOOR_LABELS[selectedNode.floor_level]}</p></div>
            <div className="space-y-2 pt-2 border-t border-white/5">
              <button onClick={openEditModal} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-white/50 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors">Editar</button>
              <button onClick={() => handleDeleteNode(selectedNode.id)} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-red-400/50 hover:text-red-400 bg-red-500/5 hover:bg-red-500/10 rounded-lg transition-colors">Eliminar</button>
            </div>
          </div>
        )}
        {/* Side panel: Bathroom node */}
        {selectedNode && tool === 'select' && (() => { const bath = bathrooms.find(b => b.node_id === selectedNode.id); if (!bath) return null; return (
          <div className="w-56 bg-[#111] border-l border-white/5 p-4 space-y-4 shrink-0">
            <div><p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Baño</p><div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full" style={{ backgroundColor: BATHROOM_COLOR }} /><span className="text-sm text-white font-medium">{bath.name}</span></div></div>
            {bath.local_number && <p className="text-[10px] text-white/30">Local: {bath.local_number}</p>}
            <div className="space-y-1"><p className="text-[10px] text-white/20 font-mono">x:{selectedNode.x} y:{selectedNode.y}</p><p className="text-[10px] text-white/20 font-mono">Piso: {FLOOR_LABELS[selectedNode.floor_level]}</p></div>
            <div className="space-y-2 pt-2 border-t border-white/5">
              <button onClick={openEditBathroomModal} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-white/50 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors">Editar</button>
              <button onClick={() => handleDeleteBathroomNode(selectedNode.id)} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-red-400/50 hover:text-red-400 bg-red-500/5 hover:bg-red-500/10 rounded-lg transition-colors">Eliminar</button>
            </div>
          </div>
        ); })()}
        {/* Side panel: Polygon */}
        {selectedPoly && tool === 'select' && (
          <div className="w-56 bg-[#111] border-l border-white/5 p-4 space-y-4 shrink-0">
            <div><p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Area</p><div className="flex items-center gap-2"><div className="w-3 h-3 rounded" style={{ backgroundColor: selectedPoly.color }} /><span className="text-sm text-white font-medium">{selectedPoly.name}</span></div></div>
            <p className="text-[10px] text-white/20">{selectedPoly.points.length} vertices</p>
            <button onClick={() => handleDeletePoly(selectedPoly.id)} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-red-400/50 hover:text-red-400 bg-red-500/5 hover:bg-red-500/10 rounded-lg transition-colors">Eliminar area</button>
          </div>
        )}
        {/* Side panel: Route */}
        {/* Routes panel */}
        {showRoutesPanel && routes.length > 0 && (
          <div className="w-60 bg-[#111] border-l border-white/5 shrink-0 flex flex-col">
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium">Rutas — {FLOOR_LABELS[selectedFloor]}</p>
              <span className="text-[10px] text-white/15">{routes.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {routes.map(route => {
                const isSel = route.id === selectedRouteId;
                const originName = getEntityName(route.origin_type, route.origin_id, stores, kiosks);
                const destName = getEntityName(route.dest_type, route.dest_id, stores, kiosks);
                return (
                  <div key={route.id}
                    onClick={() => { setSelectedRouteId(isSel ? null : route.id); setSelectedNodeId(null); setSelectedPolyId(null); }}
                    className={`px-4 py-3 border-b border-white/[0.03] cursor-pointer transition-colors ${isSel ? 'bg-white/5' : 'hover:bg-white/[0.02]'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: route.color }} />
                      <span className="text-xs text-white font-medium truncate flex-1">{route.name}</span>
                      <span className="text-[10px] text-white/15">{route.points.length}pts</span>
                    </div>
                    {(originName || destName) && (
                      <div className="flex items-center gap-1 text-[10px] text-white/20 mb-2.5 ml-4">
                        {originName && <span className="text-emerald-400/60">{originName}</span>}
                        {originName && destName && <span>→</span>}
                        {destName && <span className="text-red-400/60">{destName}</span>}
                      </div>
                    )}
                    <div className="flex items-center gap-2 ml-4">
                      <button onClick={(e) => { e.stopPropagation(); setSelectedRouteId(route.id); setTimeout(animateWalkerById.bind(null, route.id), 50); }} disabled={isAnimating}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 rounded-md transition-colors disabled:opacity-30">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /></svg>
                        Play
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteRoute(route.id); }}
                        className="flex items-center gap-1 px-2 py-1.5 text-[10px] text-white/20 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        Eliminar
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Node modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between mb-5"><h3 className="text-sm font-semibold text-white">{modalMode === 'edit' ? 'Editar kiosco' : 'Colocar kiosco'} <span className="text-white/20 font-normal">— {FLOOR_LABELS[selectedFloor]}</span></h3><div className="flex items-center gap-2">{pendingCoords && <span className="text-[10px] text-white/20 font-mono">{pendingCoords.x}, {pendingCoords.y}</span>}<button onClick={() => setShowModal(false)} className="text-white/30 hover:text-white/60"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg></button></div></div>
            <div className="space-y-4">
              <div className="relative">
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vincular kiosco</label>
                <div className="relative">
                  <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input type="text" autoFocus value={kioskSearch} onChange={e => { setKioskSearch(e.target.value); setKioskDropdown(true); if (!e.target.value) setSelectedKioskId(''); }} onFocus={() => setKioskDropdown(true)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-9 pr-8 py-2.5 text-sm text-white focus:outline-none focus:border-white/20" placeholder="Buscar kiosco..." />
                  {selectedKioskId && <button type="button" onClick={() => { setSelectedKioskId(''); setKioskSearch(''); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg></button>}
                </div>
                {kioskDropdown && !selectedKioskId && <div className="absolute z-10 mt-1 w-full bg-[#0A0A0A] border border-white/10 rounded-lg shadow-xl max-h-40 overflow-y-auto">{kiosks.filter(k => !kioskSearch || k.name.toLowerCase().includes(kioskSearch.toLowerCase())).length === 0 ? <div className="px-3 py-2.5 text-xs text-white/20">Sin resultados</div> : kiosks.filter(k => !kioskSearch || k.name.toLowerCase().includes(kioskSearch.toLowerCase())).map(k => (<button key={k.id} type="button" onClick={() => { setSelectedKioskId(k.id); setKioskSearch(k.name); setKioskDropdown(false); }} className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5">{k.name}</button>))}</div>}
              </div>
              <div className="flex gap-2 pt-2">
                {modalMode === 'edit' && <button onClick={() => selectedNodeId && handleDeleteNode(selectedNodeId)} disabled={isSaving} className="px-3 py-2.5 text-sm text-red-400 bg-red-500/10 rounded-lg disabled:opacity-50">Eliminar</button>}
                <button onClick={() => setShowModal(false)} className="flex-1 px-4 py-2.5 text-sm text-white/40 bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
                <button onClick={modalMode === 'edit' ? handleUpdateNode : handleSaveNode} disabled={isSaving} className="flex-1 px-5 py-2.5 text-sm font-medium bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 border border-purple-500/30 rounded-lg disabled:opacity-50">{isSaving ? 'Guardando...' : 'Guardar'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bathroom modal */}
      {showBathroomModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowBathroomModal(false)} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">{bathroomModalMode === 'edit' ? 'Editar baño' : 'Colocar baño'} <span className="text-white/20 font-normal">— {FLOOR_LABELS[selectedFloor]}</span></h3>
              <div className="flex items-center gap-2">{pendingCoords && <span className="text-[10px] text-white/20 font-mono">{pendingCoords.x}, {pendingCoords.y}</span>}<button onClick={() => setShowBathroomModal(false)} className="text-white/30 hover:text-white/60"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg></button></div>
            </div>
            <div className="space-y-4">
              <div><label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre</label><input type="text" autoFocus value={bathroomName} onChange={e => setBathroomName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') bathroomModalMode === 'edit' ? handleUpdateBathroom() : handleSaveBathroom(); }} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/40" placeholder="Ej: Baño Planta Baja" /></div>
              <div><label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Local (opcional)</label><input type="text" value={bathroomLocalNumber} onChange={e => setBathroomLocalNumber(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500/40" placeholder="Ej: L-42" /></div>
              <div className="flex gap-2 pt-2">
                {bathroomModalMode === 'edit' && <button onClick={() => selectedNodeId && handleDeleteBathroomNode(selectedNodeId)} disabled={isSavingBathroom} className="px-3 py-2.5 text-sm text-red-400 bg-red-500/10 rounded-lg disabled:opacity-50">Eliminar</button>}
                <button onClick={() => setShowBathroomModal(false)} className="flex-1 px-4 py-2.5 text-sm text-white/40 bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
                <button onClick={bathroomModalMode === 'edit' ? handleUpdateBathroom : handleSaveBathroom} disabled={isSavingBathroom} className="flex-1 px-5 py-2.5 text-sm font-medium bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/30 rounded-lg disabled:opacity-50">{isSavingBathroom ? 'Guardando...' : 'Guardar'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Polygon name modal */}
      {polyNameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { setPolyNameModal(false); setDrawingPoly([]); }} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-sm font-semibold text-white mb-4">Nombrar area</h3>
            <div className="space-y-4">
              <div className="relative">
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Vincular tienda (opcional)</label>
                <div className="relative">
                  <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input type="text" autoFocus value={polyStoreSearch} onChange={e => { setPolyStoreSearch(e.target.value); setPolyStoreDropdown(true); if (!e.target.value) { setPolyStoreId(''); setPolyName(''); } }} onFocus={() => setPolyStoreDropdown(true)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-9 pr-8 py-2.5 text-sm text-white focus:outline-none focus:border-white/20" placeholder="Buscar tienda..." />
                  {polyStoreId && <button type="button" onClick={() => { setPolyStoreId(''); setPolyStoreSearch(''); setPolyName(''); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg></button>}
                </div>
                {polyStoreDropdown && !polyStoreId && <div className="absolute z-10 mt-1 w-full bg-[#0A0A0A] border border-white/10 rounded-lg shadow-xl max-h-40 overflow-y-auto">{stores.filter(s => !polyStoreSearch || s.name.toLowerCase().includes(polyStoreSearch.toLowerCase())).length === 0 ? <div className="px-3 py-2.5 text-xs text-white/20">Sin resultados</div> : stores.filter(s => !polyStoreSearch || s.name.toLowerCase().includes(polyStoreSearch.toLowerCase())).map(s => (<button key={s.id} type="button" onClick={() => { setPolyStoreId(s.id); setPolyStoreSearch(s.name); setPolyName(s.name); setPolyStoreDropdown(false); }} className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5">{s.name}</button>))}</div>}
              </div>
              <div><label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre</label><input type="text" value={polyName} onChange={e => setPolyName(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-white/20" placeholder="Ej: Zona de comida" onKeyDown={e => { if (e.key === 'Enter') handleSavePoly(); }} /></div>
              <div><label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Color</label><input type="color" value={polyColor} onChange={e => setPolyColor(e.target.value)} className="w-10 h-8 rounded border border-white/10 bg-transparent cursor-pointer" /></div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setPolyNameModal(false); setDrawingPoly([]); }} className="flex-1 px-4 py-2.5 text-sm text-white/40 bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
                <button onClick={handleSavePoly} disabled={savingPoly} className="flex-1 px-5 py-2.5 text-sm font-medium bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/30 rounded-lg disabled:opacity-50">{savingPoly ? 'Guardando...' : 'Guardar area'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Route modal */}
      {routeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { setRouteModal(false); setDrawingRoute([]); }} />
          <div className="relative bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-semibold text-white mb-4">Configurar ruta <span className="text-white/20 font-normal">— {drawingRoute.length} puntos</span></h3>
            <div className="space-y-4">
              <div><label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Nombre</label><input type="text" autoFocus value={routeName} onChange={e => setRouteName(e.target.value)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-white/20" placeholder="Ej: Ruta Kiosco 1 a Nike" onKeyDown={e => { if (e.key === 'Enter') handleSaveRoute(); }} /></div>
              <div><label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Color</label><input type="color" value={routeColor} onChange={e => setRouteColor(e.target.value)} className="w-10 h-8 rounded border border-white/10 bg-transparent cursor-pointer" /></div>

              {/* Origin (A) — autocomplete for stores + kiosks */}
              <div className="relative">
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Punto A — Origen <span className="text-emerald-400/50">(tienda o kiosco)</span></label>
                <div className="relative">
                  <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input type="text" value={routeOriginSearch} onChange={e => { setRouteOriginSearch(e.target.value); setRouteOriginDropdown(true); if (!e.target.value) { setRouteOriginId(''); setRouteOriginType(''); } }} onFocus={() => setRouteOriginDropdown(true)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-9 pr-8 py-2.5 text-sm text-white focus:outline-none focus:border-white/20" placeholder="Buscar tienda o kiosco..." />
                  {routeOriginId && <button type="button" onClick={() => { setRouteOriginId(''); setRouteOriginType(''); setRouteOriginSearch(''); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg></button>}
                </div>
                {routeOriginDropdown && !routeOriginId && (
                  <div className="absolute z-10 mt-1 w-full bg-[#0A0A0A] border border-white/10 rounded-lg shadow-xl max-h-40 overflow-y-auto">
                    {(() => { const q = routeOriginSearch.toLowerCase(); const fs = stores.filter(s => !q || s.name.toLowerCase().includes(q)); const fk = kiosks.filter(k => !q || k.name.toLowerCase().includes(q)); return fs.length === 0 && fk.length === 0 ? <div className="px-3 py-2.5 text-xs text-white/20">Sin resultados</div> : (<>{fk.map(k => <button key={'k-' + k.id} type="button" onClick={() => { setRouteOriginId(k.id); setRouteOriginType('kiosk'); setRouteOriginSearch(k.name); setRouteOriginDropdown(false); }} className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-purple-500 shrink-0" />{k.name}</button>)}{fs.map(s => <button key={'s-' + s.id} type="button" onClick={() => { setRouteOriginId(s.id); setRouteOriginType('store'); setRouteOriginSearch(s.name); setRouteOriginDropdown(false); }} className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-pink-500 shrink-0" />{s.name}</button>)}</>); })()}
                  </div>
                )}
              </div>

              {/* Destination (B) — autocomplete for stores + kiosks */}
              <div className="relative">
                <label className="block text-[11px] text-white/40 uppercase tracking-wider mb-1.5">Punto B — Destino <span className="text-red-400/50">(tienda o kiosco)</span></label>
                <div className="relative">
                  <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input type="text" value={routeDestSearch} onChange={e => { setRouteDestSearch(e.target.value); setRouteDestDropdown(true); if (!e.target.value) { setRouteDestId(''); setRouteDestType(''); } }} onFocus={() => setRouteDestDropdown(true)} className="w-full bg-[#0A0A0A] border border-white/10 rounded-lg pl-9 pr-8 py-2.5 text-sm text-white focus:outline-none focus:border-white/20" placeholder="Buscar tienda o kiosco..." />
                  {routeDestId && <button type="button" onClick={() => { setRouteDestId(''); setRouteDestType(''); setRouteDestSearch(''); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg></button>}
                </div>
                {routeDestDropdown && !routeDestId && (
                  <div className="absolute z-10 mt-1 w-full bg-[#0A0A0A] border border-white/10 rounded-lg shadow-xl max-h-40 overflow-y-auto">
                    {(() => { const q = routeDestSearch.toLowerCase(); const fs = stores.filter(s => !q || s.name.toLowerCase().includes(q)); const fk = kiosks.filter(k => !q || k.name.toLowerCase().includes(q)); return fs.length === 0 && fk.length === 0 ? <div className="px-3 py-2.5 text-xs text-white/20">Sin resultados</div> : (<>{fk.map(k => <button key={'k-' + k.id} type="button" onClick={() => { setRouteDestId(k.id); setRouteDestType('kiosk'); setRouteDestSearch(k.name); setRouteDestDropdown(false); }} className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-purple-500 shrink-0" />{k.name}</button>)}{fs.map(s => <button key={'s-' + s.id} type="button" onClick={() => { setRouteDestId(s.id); setRouteDestType('store'); setRouteDestSearch(s.name); setRouteDestDropdown(false); }} className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-pink-500 shrink-0" />{s.name}</button>)}</>); })()}
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <button onClick={() => { setRouteModal(false); setDrawingRoute([]); }} className="flex-1 px-4 py-2.5 text-sm text-white/40 bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
                <button onClick={handleSaveRoute} disabled={savingRoute} className="flex-1 px-5 py-2.5 text-sm font-medium bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/30 rounded-lg disabled:opacity-50">{savingRoute ? 'Guardando...' : 'Guardar ruta'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──
function getEntityName(type?: string, id?: string, stores?: Store[], kiosks?: Kiosk[]): string {
  if (!type || !id) return '';
  if (type === 'store') { const s = (stores || []).find(s => s.id === id); return s ? s.name : ''; }
  if (type === 'kiosk') { const k = (kiosks || []).find(k => k.id === id); return k ? k.name : ''; }
  return '';
}
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; if (l2 === 0) return Math.hypot(px - ax, py - ay); let t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
function pointInPoly(px: number, py: number, pts: Pt[]): boolean { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { if (((pts[i].y > py) !== (pts[j].y > py)) && (px < (pts[j].x - pts[i].x) * (py - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x)) inside = !inside; } return inside; }
function pointNearPath(px: number, py: number, pts: Pt[], threshold: number): boolean { for (let i = 1; i < pts.length; i++) { if (distToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) < threshold) return true; } return false; }
function centroid(pts: Pt[]): Pt { let x = 0, y = 0; pts.forEach(p => { x += p.x; y += p.y; }); return { x: x / pts.length, y: y / pts.length }; }
function hexToRgba(hex: string, a: number): string { return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`; }
function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string, z: number) { const r = 12 / z; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 / z; ctx.stroke(); ctx.font = `bold ${Math.max(9, 10 / z)}px sans-serif`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, x, y); }
