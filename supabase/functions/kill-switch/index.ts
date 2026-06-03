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

  // Nulificar plan_type en tiendas con contrato vencido, PERO solo si la tienda
  // no tiene "planificado otro contrato": una solicitud aprobada (no flash) cuyo
  // contrato siga vigente (expires_at >= hoy). Debe quedar equivalente al guard
  // de la función SQL apply_kill_switch() (ver migración 20260603120000): sin él,
  // se nulificaría el plan de tiendas con una renovación agendada aún sin activar.
  const FLASH_PLAN_KEYS = ['FLASH_COUPON_DIARIO', 'FLASH_COUPON_SEMANAL']

  // Tiendas candidatas: contrato vencido y con plan activo.
  const { data: expiredStores, error: expiredErr } = await supabase
    .from('stores')
    .select('id')
    .not('contract_expiry_date', 'is', null)
    .lt('contract_expiry_date', today)
    .not('plan_type', 'is', null)

  if (expiredErr) {
    console.error('[kill-switch] expired stores fetch error:', expiredErr.message)
  } else if (expiredStores && expiredStores.length > 0) {
    // Tiendas con renovación agendada vigente → NO se nulifican.
    const { data: pendingReqs, error: pendingErr } = await supabase
      .from('plan_requests')
      .select('store_id, plan_key')
      .eq('status', 'approved')
      .not('expires_at', 'is', null)
      .gte('expires_at', today)

    if (pendingErr) {
      console.error('[kill-switch] pending requests fetch error:', pendingErr.message)
    } else {
      const protectedStores = new Set(
        (pendingReqs ?? [])
          .filter((r: any) => !FLASH_PLAN_KEYS.includes(r.plan_key))
          .map((r: any) => r.store_id),
      )

      const toNullify = expiredStores
        .map((s: any) => s.id)
        .filter((id: string) => !protectedStores.has(id))

      if (toNullify.length > 0) {
        const { error: planErr } = await supabase
          .from('stores')
          .update({ plan_type: null })
          .in('id', toNullify)

        if (planErr) {
          console.error('[kill-switch] plan nullify error:', planErr.message)
        } else {
          console.log(`[kill-switch] plan_type nullified for ${toNullify.length} store(s)`)
        }
      }
    }
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
