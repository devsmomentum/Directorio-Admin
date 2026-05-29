// Supabase Edge Function — Kill-Switch
// Se ejecuta automáticamente a las 00:05 VET vía pg_cron.
// También puede invocarse manualmente desde el dashboard admin.
//
// Lógica: desactiva una campaña si:
//   · su end_date ya pasó, O
//   · el plan de su tienda venció (stores.contract_expiry_date < hoy)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405)
  }

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

  // 1. Candidatas: activas con end_date pasado O con plan-tienda vencido
  const { data: candidates, error: fetchErr } = await supabase
    .from('ad_campaigns')
    .select(`
      id,
      brand_name,
      end_date,
      store_id,
      stores ( name, contract_expiry_date )
    `)
    .eq('is_active', true)

  if (fetchErr) {
    console.error('[kill-switch] fetch error:', fetchErr.message)
    return respond({ error: fetchErr.message }, 500)
  }

  const toDeactivate = (candidates ?? []).filter((c: any) => {
    const expiredEnd = c.end_date && c.end_date < today
    const expiredPlan = c.stores?.contract_expiry_date && c.stores.contract_expiry_date < today
    return expiredEnd || expiredPlan
  })

  if (toDeactivate.length === 0) {
    console.log('[kill-switch] No campaigns to deactivate today:', today)
    return respond({ message: 'No campaigns to deactivate', deactivated: 0 })
  }

  console.log(`[kill-switch] Deactivating ${toDeactivate.length} campaign(s):`, toDeactivate.map((c: any) => c.brand_name))

  const ids = toDeactivate.map((c: any) => c.id)
  const { error: updateErr } = await supabase
    .from('ad_campaigns')
    .update({ is_active: false })
    .in('id', ids)

  if (updateErr) {
    console.error('[kill-switch] update error:', updateErr.message)
    return respond({ error: updateErr.message }, 500)
  }

  // Nulificar plan_type en tiendas con contrato vencido
  const { error: planErr } = await supabase
    .from('stores')
    .update({ plan_type: null })
    .not('contract_expiry_date', 'is', null)
    .lt('contract_expiry_date', today)
    .not('plan_type', 'is', null)

  if (planErr) {
    console.error('[kill-switch] plan nullify error:', planErr.message)
  }

  const result = {
    message: 'Kill-Switch applied successfully',
    date: today,
    deactivated: toDeactivate.length,
    campaigns: toDeactivate.map((c: any) => ({
      id: c.id,
      brand_name: c.brand_name,
      store: c.stores?.name ?? null,
      end_date: c.end_date,
      plan_expiry: c.stores?.contract_expiry_date ?? null,
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
