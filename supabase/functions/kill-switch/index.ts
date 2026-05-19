// Supabase Edge Function — Smart Kill-Switch
// Se ejecuta automáticamente a las 00:05 VET vía pg_cron.
// También puede invocarse manualmente desde el dashboard admin.
//
// Lógica:
//   1. Busca campañas donde end_date < hoy AND payment_status != 'paid' AND is_active = true
//   2. Las marca como is_active=false, payment_status='overdue', suspended_at=now()
//   3. Crea una notificación en admin_notifications por cada campaña suspendida
//   4. (TODO Fase 2 completa) Enviar notificación WhatsApp/Email al cliente via SuperAPI

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

Deno.serve(async (req: Request) => {
  // Solo acepta POST
  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405)
  }

  // Verificar identidad del llamador con el header x-cron-secret
  const incomingSecret = req.headers.get('x-cron-secret') ?? ''
  if (CRON_SECRET && incomingSecret !== CRON_SECRET) {
    return respond({ error: 'Unauthorized' }, 401)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const today = new Date().toISOString().split('T')[0]

  // 1. Detectar campañas vencidas sin pago que aún están activas
  const { data: candidates, error: fetchErr } = await supabase
    .from('ad_campaigns')
    .select(`
      id,
      brand_name,
      end_date,
      store_id,
      stores (
        name
      )
    `)
    .lt('end_date', today)
    .neq('payment_status', 'paid')
    .eq('is_active', true)

  if (fetchErr) {
    console.error('[kill-switch] fetch error:', fetchErr.message)
    return respond({ error: fetchErr.message }, 500)
  }

  if (!candidates || candidates.length === 0) {
    console.log('[kill-switch] No overdue campaigns today:', today)
    return respond({ message: 'No overdue campaigns', suspended: 0 })
  }

  console.log(`[kill-switch] Found ${candidates.length} overdue campaign(s):`, candidates.map(c => c.brand_name))

  // 2. Aplicar Kill-Switch en batch
  const ids = candidates.map((c) => c.id)
  const { error: updateErr } = await supabase
    .from('ad_campaigns')
    .update({
      is_active: false,
      payment_status: 'overdue',
      suspended_at: new Date().toISOString(),
    })
    .in('id', ids)

  if (updateErr) {
    console.error('[kill-switch] update error:', updateErr.message)
    return respond({ error: updateErr.message }, 500)
  }

  // 3. Crear notificaciones en el panel admin (una por campaña)
  const notifications = candidates.map((c: any) => ({
    type: 'error',
    title: 'Campaña suspendida por impago',
    message: `"${c.brand_name}"${c.stores?.name ? ` (${c.stores.name})` : ''} fue suspendida automáticamente. Venció el ${c.end_date} sin registro de pago.`,
    metadata: {
      campaign_id: c.id,
      store_name: c.stores?.name ?? null,
      end_date: c.end_date,
    },
    // unique_key evita duplicados si el cron corre más de una vez el mismo día
    unique_key: `kill_switch_${c.id}_${today}`,
  }))

  const { error: notifErr } = await supabase
    .from('admin_notifications')
    .insert(notifications)
    .select()

  // ON CONFLICT (unique_key) es manejado por la restricción UNIQUE de la tabla
  if (notifErr && !notifErr.message.includes('unique')) {
    console.warn('[kill-switch] notification insert warning:', notifErr.message)
  }

  // 4. TODO: SuperAPI — enviar WhatsApp/Email al cliente
  // for (const c of candidates) {
  //   if (c.stores?.contact_phone) {
  //     await sendWhatsApp(c.stores.contact_phone, c.brand_name)
  //   }
  // }

  const result = {
    message: 'Kill-Switch applied successfully',
    date: today,
    suspended: candidates.length,
    campaigns: candidates.map((c: any) => ({
      id: c.id,
      brand_name: c.brand_name,
      store: c.stores?.name ?? null,
      end_date: c.end_date,
    })),
  }

  console.log('[kill-switch] Done:', JSON.stringify(result))
  return respond(result)
})

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
