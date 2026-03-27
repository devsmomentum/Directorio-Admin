'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function DashboardPage() {
  const [kiosks, setKiosks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchKiosks();
  }, []);

  const fetchKiosks = async () => {
    const { data, error } = await supabase
      .from('kiosks')
      .select('*')
      .order('created_at', { ascending: false });

    if (data) setKiosks(data);
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white">Monitoreo de Hardware</h2>
        <p className="text-white/50 mt-2">Estado en tiempo real de los Kioscos Sunmi</p>
      </div>

      {loading ? (
        <div className="text-white/50 animate-pulse">Cargando estado de máquinas...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {kiosks.map((kiosk) => (
            <div key={kiosk.id} className="bg-[#111111] border border-white/10 rounded-2xl p-6 relative overflow-hidden">
              {/* Luz de estado (Verde = Online, Rojo = Offline) */}
              <div className={`absolute top-0 left-0 w-1 h-full ${kiosk.status === 'online' ? 'bg-green-500' : 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]'}`} />
              
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-bold text-lg">{kiosk.location_name || 'Kiosco sin nombre'}</h3>
                  <p className="text-xs text-white/50 font-mono mt-1">MAC: {kiosk.mac_address}</p>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-bold ${kiosk.status === 'online' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                  {kiosk.status.toUpperCase()}
                </span>
              </div>

              <div className="space-y-3 mt-6">
                <div className="flex justify-between items-center text-sm border-t border-white/5 pt-3">
                  <span className="text-white/50">Impresora</span>
                  <span className={kiosk.paper_level === 'ok' ? 'text-green-400' : 'text-orange-400'}>
                    {kiosk.paper_level === 'ok' ? 'Con Papel' : 'Revisar Papel'}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm border-t border-white/5 pt-3">
                  <span className="text-white/50">Último Ping</span>
                  <span className="text-white/70">
                    {kiosk.last_ping ? new Date(kiosk.last_ping).toLocaleTimeString() : 'Nunca'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}