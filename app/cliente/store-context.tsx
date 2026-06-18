'use client';

import { createContext, useContext } from 'react';

export type StoreRole = 'owner' | 'seller' | 'advertiser';

export type ClienteStore = {
  id: string;
  name: string;
  /** Rol del usuario actual EN ESTA tienda. Define qué puede hacer/ver. */
  store_role: StoreRole;
  plan_type: string | null;
  floor_level: string | null;
  local_number: string | null;
  rif: string | null;
  contract_expiry_date: string | null;
  flash_coupon_plan: string | null;
  flash_coupon_expiry_date: string | null;
  /** Tienda aliada: campañas + cupones flash sin pagar plan, con cap definido por el admin. */
  is_ally: boolean;
  /** Tope de campañas activas para la tienda aliada (lo fija el admin). */
  ally_campaign_limit: number;
  /** Si el aliado puede publicar cupones flash. */
  ally_flash_enabled: boolean;
  description?: string | null;
  categories?: { id: string; name: string; icon: string } | null;
};

export type ClienteStoreCtx = {
  stores: ClienteStore[];
  selectedStore: ClienteStore | null;
  setSelectedStoreId: (id: string) => void;
  refreshStores: () => Promise<void>;
  /** Notificaciones sin leer de la tienda activa (alimenta el badge del sidebar). */
  unreadNotifications: number;
  /** Re-consulta el conteo de no-leídas. Llamar tras marcar como leído para que
   *  el badge baje al instante en vez de esperar al sondeo de 30s. */
  refreshUnread: () => Promise<void>;
};

export const ClienteStoreContext = createContext<ClienteStoreCtx | null>(null);

export function useClienteStore(): ClienteStoreCtx {
  const ctx = useContext(ClienteStoreContext);
  if (!ctx) throw new Error('useClienteStore debe usarse dentro de <ClienteStoreContext.Provider>');
  return ctx;
}
