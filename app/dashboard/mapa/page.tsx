"use client";

import { useState, useEffect, MouseEvent as ReactMouseEvent } from "react";
import { supabase } from "../../../lib/supabase"; 

interface Store {
  id: string;
  name: string;
  local_number: string;
  node_id: string | null;
}

interface Kiosk {
  id: string;
  name: string;
  location: string;
  node_id: string | null;
}

interface MapNode {
  id: string;
  x: number;
  y: number;
  node_type: string;
  floor_level: number;
}

interface MapEdge {
  id: string;
  node_a_id: string;
  node_b_id: string;
  distance_weight: number;
}

export default function MapaEditorPage() {
  const [selectedFloor, setSelectedFloor] = useState<number>(2);
  const [stores, setStores] = useState<Store[]>([]);
  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [edges, setEdges] = useState<MapEdge[]>([]); 
  
  const [isConnectMode, setIsConnectMode] = useState(false);
  const [firstNodeToConnect, setFirstNodeToConnect] = useState<MapNode | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [pendingCoords, setPendingCoords] = useState<{ x: number; y: number } | null>(null);
  const [newNodeType, setNewNodeType] = useState("store");
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [selectedKioskId, setSelectedKioskId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editingNode, setEditingNode] = useState<MapNode | null>(null);

  // 🚀 SOPORTE PARA LOS 5 PISOS
  const floorImages: Record<number, string> = {
    5: "https://dummyimage.com/2000x2000/1A1A1A/FF007A&text=Plano+Nivel+C4", 
    4: "https://dummyimage.com/2000x2000/1A1A1A/FF007A&text=Plano+Nivel+C3", 
    3: "https://dummyimage.com/2000x2000/1A1A1A/FF007A&text=Plano+Nivel+C2",
    2: "https://dummyimage.com/2000x2000/1A1A1A/FF007A&text=Plano+Nivel+C1",
    1: "https://lrjgocjubpxruobshtoe.supabase.co/storage/v1/object/public/mapas/plano_rg.png",
  };

  useEffect(() => {
    fetchData();
  }, [selectedFloor]);

  const fetchData = async () => {
    // 🚀 MAPEO DE 5 PISOS
    const floorStr = selectedFloor === 5 ? 'C4' : selectedFloor === 4 ? 'C3' : selectedFloor === 3 ? 'C2' : selectedFloor === 2 ? 'C1' : 'RG';
    
    const { data: storesData } = await supabase.from("stores").select("id, name, local_number, node_id").eq("floor_level", floorStr);
    if (storesData) setStores(storesData);

    const { data: kiosksData } = await supabase.from("kiosks").select("id, name, location, node_id");
    if (kiosksData) setKiosks(kiosksData);

    const { data: nodesData } = await supabase.from("map_nodes").select("*").eq("floor_level", selectedFloor);
    if (nodesData) setNodes(nodesData);

    const { data: edgesData } = await supabase.from("map_edges").select("*");
    if (edgesData) setEdges(edgesData);
  };

  const handleConnectNodes = async (secondNode: MapNode) => {
    if (!firstNodeToConnect || firstNodeToConnect.id === secondNode.id) return;

    const dist = Math.sqrt(
      Math.pow(secondNode.x - firstNodeToConnect.x, 2) + Math.pow(secondNode.y - firstNodeToConnect.y, 2)
    );

    const { error } = await supabase.from("map_edges").insert({
      node_a_id: firstNodeToConnect.id,
      node_b_id: secondNode.id,
      distance_weight: Math.round(dist)
    });

    if (!error) {
      setFirstNodeToConnect(secondNode); 
      fetchData();
    }
  };

  // 🚀 LÓGICA 3D: AUTO-CONEXIÓN DE ASCENSORES Y ESCALERAS
  const handleAutoConnectVerticals = async () => {
    if(!confirm("¿Buscar y conectar automáticamente los ascensores y escaleras que estén alineados en diferentes pisos?")) return;
    
    setIsSaving(true);
    try {
      // Traemos todos los nodos que son ascensores o escaleras (de todos los pisos)
      const { data: verticalNodes, error: fetchError } = await supabase
        .from('map_nodes')
        .select('*')
        .in('node_type', ['elevator', 'escalator']);
        
      if (fetchError || !verticalNodes) throw fetchError;

      let connectionsMade = 0;

      // Comparamos todos contra todos
      for (let i = 0; i < verticalNodes.length; i++) {
        for (let j = i + 1; j < verticalNodes.length; j++) {
          const n1 = verticalNodes[i];
          const n2 = verticalNodes[j];

          // Si son de distinto piso, del mismo tipo (ambos ascensores o ambos escaleras)
          if (n1.floor_level !== n2.floor_level && n1.node_type === n2.node_type) {
            // Calculamos si están en la misma posición visual (tolerancia de 150 pixeles)
            const dist = Math.sqrt(Math.pow(n2.x - n1.x, 2) + Math.pow(n2.y - n1.y, 2));
            
            if (dist < 150) {
              // Verificamos que no exista ya la conexión
              const edgeExists = edges.find(e => 
                (e.node_a_id === n1.id && e.node_b_id === n2.id) || 
                (e.node_a_id === n2.id && e.node_b_id === n1.id)
              );

              if (!edgeExists) {
                await supabase.from("map_edges").insert({
                  node_a_id: n1.id,
                  node_b_id: n2.id,
                  distance_weight: 500 // 🚀 Peso alto para que solo se use si es necesario cambiar de piso
                });
                connectionsMade++;
              }
            }
          }
        }
      }
      
      alert(`¡Éxito! Se crearon ${connectionsMade} conexiones verticales (puentes entre pisos).`);
      fetchData();
    } catch (error: any) {
      alert("Error conectando nodos verticales: " + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteEdge = async (id: string) => {
    if (confirm("¿Eliminar este tramo de ruta?")) {
      await supabase.from("map_edges").delete().eq("id", id);
      fetchData();
    }
  };

  const handleMapClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isConnectMode) return; 

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    setPendingCoords({ 
      x: Math.round((clickX / rect.width) * 2000), 
      y: Math.round((clickY / rect.height) * 2000) 
    });
    
    setEditingNode(null);
    setNewNodeType("store");
    setSelectedStoreId("");
    setSelectedKioskId("");
    setShowModal(true);
  };

  const handleNodeClick = (e: ReactMouseEvent<HTMLDivElement>, node: MapNode) => {
    e.stopPropagation();

    if (isConnectMode) {
      if (!firstNodeToConnect) {
        setFirstNodeToConnect(node);
      } else {
        handleConnectNodes(node);
      }
    } else {
      setEditingNode(node);
      setPendingCoords({ x: node.x, y: node.y });
      setNewNodeType(node.node_type);

      if (node.node_type === 'store') {
        const assignedStore = stores.find(s => s.node_id === node.id);
        setSelectedStoreId(assignedStore ? assignedStore.id : "");
      } else if (node.node_type === 'kiosk') {
        const assignedKiosk = kiosks.find(k => k.node_id === node.id);
        setSelectedKioskId(assignedKiosk ? assignedKiosk.id : "");
      }
      setShowModal(true);
    }
  };

  const handleSaveNewNode = async () => {
    if (!pendingCoords) return;
    setIsSaving(true);
    try {
      const { data: insertedNode, error } = await supabase
        .from("map_nodes")
        .insert({
          x: pendingCoords.x,
          y: pendingCoords.y,
          floor_level: selectedFloor,
          node_type: newNodeType,
        })
        .select().single();

      if (error) throw error;

      if (newNodeType === "store" && selectedStoreId && insertedNode) {
        await supabase.from("stores").update({ node_id: insertedNode.id }).eq("id", selectedStoreId);
      }
      if (newNodeType === "kiosk" && selectedKioskId && insertedNode) {
        await supabase.from("kiosks").update({ node_id: insertedNode.id }).eq("id", selectedKioskId);
      }

      closeModalAndRefresh();
    } catch (error: any) {
      alert("Error: " + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateNode = async () => {
    if (!editingNode) return;
    setIsSaving(true);
    try {
      await supabase.from("map_nodes").update({ node_type: newNodeType }).eq("id", editingNode.id);
      await supabase.from("stores").update({ node_id: null }).eq("node_id", editingNode.id);
      await supabase.from("kiosks").update({ node_id: null }).eq("node_id", editingNode.id);

      if (newNodeType === "store" && selectedStoreId) {
        await supabase.from("stores").update({ node_id: editingNode.id }).eq("id", selectedStoreId);
      } else if (newNodeType === "kiosk" && selectedKioskId) {
        await supabase.from("kiosks").update({ node_id: editingNode.id }).eq("id", selectedKioskId);
      }

      closeModalAndRefresh();
    } catch (error: any) {
      alert("Error: " + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteNode = async () => {
    if (!editingNode) return;
    if (!window.confirm("¿Seguro que deseas eliminar este punto?")) return;
    setIsSaving(true);
    try {
      await supabase.from("stores").update({ node_id: null }).eq("node_id", editingNode.id);
      await supabase.from("kiosks").update({ node_id: null }).eq("node_id", editingNode.id);
      await supabase.from("map_nodes").delete().eq("id", editingNode.id);
      closeModalAndRefresh();
    } catch (error: any) {
      alert("Error: " + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const closeModalAndRefresh = () => {
    setShowModal(false);
    setPendingCoords(null);
    setEditingNode(null);
    setFirstNodeToConnect(null);
    fetchData();
  };

  return (
    <div className="p-6 bg-black min-h-screen text-white">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold italic tracking-tighter">MAP ARCHITECT 3D</h1>
          <p className="text-white/40 text-sm">Gestiona nodos y rutas multi-nivel.</p>
        </div>
        
        <div className="flex gap-4">
          {/* 🚀 NUEVO BOTÓN PARA CONECTAR ASCENSORES */}
          <button 
            onClick={handleAutoConnectVerticals}
            disabled={isSaving}
            className="px-6 py-2 rounded-xl font-bold transition-all bg-orange-600 hover:bg-orange-500 flex items-center gap-2"
          >
            <span className="material-icons text-sm">elevator</span>
            UNIR ASCENSORES
          </button>

          <button 
            onClick={() => { setIsConnectMode(!isConnectMode); setFirstNodeToConnect(null); }}
            className={`px-6 py-2 rounded-xl font-bold transition-all border ${
              isConnectMode ? "bg-pink-600 border-pink-400 shadow-[0_0_15px_rgba(236,72,153,0.5)]" : "bg-white/5 border-white/10"
            }`}
          >
            {isConnectMode ? "DIBUJANDO..." : "MODO CONEXIÓN"}
          </button>

          <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
            {/* 🚀 BOTONES DE 5 PISOS */}
            {[5, 4, 3, 2, 1].map(f => (
              <button key={f} onClick={() => setSelectedFloor(f)}
                className={`px-4 py-2 rounded-lg text-xs font-bold ${selectedFloor === f ? "bg-white text-black" : "text-white/40"}`}>
                {f === 1 ? "RG" : `C${f-1}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 relative bg-[#111] rounded-3xl border border-white/10 overflow-hidden">
          <div className="relative w-full aspect-square cursor-crosshair" onClick={handleMapClick}>
            <img src={floorImages[selectedFloor]} alt="Plano" className="w-full h-full object-contain opacity-50" />
            
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 2000 2000">
              <filter id="glow"><feGaussianBlur stdDeviation="6" result="blur"/><feComposite in="SourceGraphic" in2="blur" operator="over"/></filter>
              {edges.map(edge => {
                const nodeA = nodes.find(n => n.id === edge.node_a_id);
                const nodeB = nodes.find(n => n.id === edge.node_b_id);
                // Si la conexión es de otro piso, no la dibujamos aquí para no confundir
                if (!nodeA || !nodeB) return null;
                return (
                  <g key={edge.id} className="cursor-pointer pointer-events-auto" onClick={(e) => { e.stopPropagation(); handleDeleteEdge(edge.id); }}>
                    <line x1={nodeA.x} y1={nodeA.y} x2={nodeB.x} y2={nodeB.y} stroke="#FF007A" strokeWidth="10" strokeOpacity="0.2" filter="url(#glow)" />
                    <line x1={nodeA.x} y1={nodeA.y} x2={nodeB.x} y2={nodeB.y} stroke="#FF007A" strokeWidth="3" />
                  </g>
                );
              })}
            </svg>

            {/* 🚀 CAPA DE NODOS (Con colores nuevos para 3D) */}
            {nodes.map(node => {
              let color = '#22D3EE'; // default hallway
              if(node.node_type === 'store') color = '#FF007A';
              if(node.node_type === 'kiosk') color = '#A855F7';
              if(node.node_type === 'elevator') color = '#ea580c'; // Naranja
              if(node.node_type === 'escalator') color = '#eab308'; // Amarillo

              const isSelected = firstNodeToConnect?.id === node.id;
              return (
                <div key={node.id} onClick={(e) => handleNodeClick(e, node)}
                  className={`absolute w-8 h-8 -ml-4 -mt-4 rounded-full border-4 border-black shadow-xl transition-all z-10 flex items-center justify-center ${isSelected ? "scale-150 ring-4 ring-white animate-pulse" : "hover:scale-125"}`}
                  style={{ top: `${(node.y / 2000) * 100}%`, left: `${(node.x / 2000) * 100}%`, backgroundColor: color }}
                >
                  {/* Iconito interior para diferenciar mejor */}
                  {node.node_type === 'elevator' && <span className="material-icons text-black text-[10px]">elevator</span>}
                  {node.node_type === 'escalator' && <span className="material-icons text-black text-[10px]">escalator</span>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-[#111] p-6 rounded-3xl border border-white/10 h-fit space-y-6">
          <h3 className="font-bold uppercase text-xs tracking-widest text-white/40">Leyenda / Stats</h3>
          <div className="space-y-4">
            <div className="flex justify-between items-end"><span className="text-sm flex items-center gap-2"><div className="w-3 h-3 bg-pink-500 rounded-full"></div> Tiendas</span><span className="text-xl font-bold">{nodes.filter(n => n.node_type === 'store').length}</span></div>
            <div className="flex justify-between items-end"><span className="text-sm flex items-center gap-2"><div className="w-3 h-3 bg-purple-500 rounded-full"></div> Kioscos</span><span className="text-xl font-bold">{nodes.filter(n => n.node_type === 'kiosk').length}</span></div>
            <div className="flex justify-between items-end"><span className="text-sm flex items-center gap-2"><div className="w-3 h-3 bg-cyan-400 rounded-full"></div> Pasillos</span><span className="text-xl font-bold">{nodes.filter(n => n.node_type === 'hallway').length}</span></div>
            <div className="flex justify-between items-end"><span className="text-sm flex items-center gap-2"><div className="w-3 h-3 bg-orange-600 rounded-full"></div> Ascensores</span><span className="text-xl font-bold">{nodes.filter(n => n.node_type === 'elevator').length}</span></div>
            <div className="flex justify-between items-end"><span className="text-sm flex items-center gap-2"><div className="w-3 h-3 bg-yellow-500 rounded-full"></div> Escaleras</span><span className="text-xl font-bold">{nodes.filter(n => n.node_type === 'escalator').length}</span></div>
          </div>
          <div className="pt-6 border-t border-white/5">
            <p className="text-[10px] text-white/30 leading-relaxed uppercase">Instrucciones 3D: Para conectar pisos, pon un "Ascensor" en la misma posición visual en el Nivel 1 y Nivel 2. Luego presiona el botón naranja superior.</p>
          </div>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center z-[100]">
          <div className="bg-[#1A1A1A] border border-white/10 p-8 rounded-3xl w-full max-w-md shadow-2xl">
            <h2 className="text-2xl font-black mb-6 italic">{editingNode ? "EDITAR PUNTO" : "NUEVO PUNTO"}</h2>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Tipo</label>
                <select className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none focus:border-pink-500"
                  value={newNodeType} onChange={e => setNewNodeType(e.target.value)}>
                  <option value="store">Tienda</option>
                  <option value="hallway">Pasillo</option>
                  <option value="kiosk">Kiosco</option>
                  {/* 🚀 NUEVAS OPCIONES DE 3D */}
                  <option value="elevator">Ascensor (Sube/Baja Pisos)</option>
                  <option value="escalator">Escalera Mecánica</option>
                </select>
              </div>

              {newNodeType === "store" && (
                <div>
                  <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Tienda</label>
                  <select className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none"
                    value={selectedStoreId} onChange={e => setSelectedStoreId(e.target.value)}>
                    <option value="">-- Vincular tienda --</option>
                    {stores.map(s => <option key={s.id} value={s.id}>{s.local_number} - {s.name}</option>)}
                  </select>
                </div>
              )}

              {newNodeType === "kiosk" && (
                <div>
                  <label className="text-[10px] font-bold text-white/40 block mb-2 uppercase">Kiosco</label>
                  <select className="w-full bg-black border border-white/10 rounded-xl p-4 text-white outline-none"
                    value={selectedKioskId} onChange={e => setSelectedKioskId(e.target.value)}>
                    <option value="">-- Vincular perfil --</option>
                    {kiosks.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
                  </select>
                </div>
              )}

              <div className="flex gap-3 mt-8">
                {editingNode && (
                  <button onClick={handleDeleteNode} disabled={isSaving} className="flex-1 bg-red-500/10 text-red-500 py-4 rounded-xl font-bold">BORRAR</button>
                )}
                <button onClick={closeModalAndRefresh} className="flex-1 bg-white/5 py-4 rounded-xl font-bold">CANCELAR</button>
                <button onClick={editingNode ? handleUpdateNode : handleSaveNewNode} disabled={isSaving} className="flex-1 bg-pink-600 py-4 rounded-xl font-bold">GUARDAR</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}