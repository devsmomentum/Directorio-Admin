// Supabase Edge Function — Send WhatsApp Contract Expiry Reminders
//
// Envía recordatorios por WhatsApp a los clientes cuando el plan de su tienda
// (stores.contract_expiry_date) está por vencer. Dispara en T-5, T-3, T-1
// y T-0 días (el día mismo del vencimiento).
//
// Complementa send-contract-expiry-reminders (correo). Mismo patrón de
// idempotencia: tabla `plan_whatsapp_reminders_log` con UNIQUE
// (store_id, days_remaining, sent_date). La RPC
// `enqueue_whatsapp_expiry_reminders` devuelve solo los candidatos que aún
// no se han notificado hoy.
//
// Auth: lo llama pg_cron con header `x-cron-secret`. verify_jwt=false.
//
// WhatsApp: Green API (https://green-api.com). Requiere secrets:
//   GREEN_API_ID_INSTANCE     — ID de la instancia provisto por el trabajo
//   GREEN_API_TOKEN_INSTANCE  — Token de la instancia provisto por el trabajo
//   CRON_SECRET               — clave compartida con pg_cron
//   PUBLIC_APP_URL            — base del portal del cliente (link "Renovar plan")

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET               = Deno.env.get('CRON_SECRET') ?? ''
const PUBLIC_APP_URL            = (Deno.env.get('PUBLIC_APP_URL') ?? 'https://mallhub.morna.tech').replace(/\/$/, '')

// Credenciales de Green API
const GREEN_API_ID_INSTANCE    = Deno.env.get('GREEN_API_ID_INSTANCE') ?? ''
const GREEN_API_TOKEN_INSTANCE = Deno.env.get('GREEN_API_TOKEN_INSTANCE') ?? ''

type Candidate = {
  store_id:             string
  store_name:           string
  plan_type:            string | null
  contract_expiry_date: string   // YYYY-MM-DD
  days_remaining:       number   // 5 | 3 | 1 | 0
  recipient_phone:      string
  recipient_name:       string | null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    })
  }
  if (req.method !== 'POST') return respond({ error: 'Method not allowed' }, 405)

  const incoming = req.headers.get('x-cron-secret') ?? ''
  if (CRON_SECRET && incoming !== CRON_SECRET) return respond({ error: 'Unauthorized' }, 401)

  // Validación de llaves de Green API
  if (!GREEN_API_ID_INSTANCE || !GREEN_API_TOKEN_INSTANCE) {
    return respond({ error: 'GREEN_API_ID_INSTANCE o GREEN_API_TOKEN_INSTANCE no configurados' }, 500)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const { data: candidates, error: rpcErr } = await supabase
    .rpc('enqueue_whatsapp_expiry_reminders')

  if (rpcErr) {
    console.error('[send-whatsapp-expiry-reminders] RPC error:', rpcErr.message)
    return respond({ error: rpcErr.message }, 500)
  }

  const list = (candidates ?? []) as Candidate[]
  if (list.length === 0) {
    console.log('[send-whatsapp-expiry-reminders] nothing to send today')
    return respond({ ok: true, sent: 0, failed: 0 })
  }

  let sent = 0
  let failed = 0
  const failures: Array<{ store_id: string; error: string }> = []

  for (const c of list) {
    try {
      await sendWhatsApp(c)

      const { error: logErr } = await supabase
        .from('plan_whatsapp_reminders_log')
        .insert({
          store_id:        c.store_id,
          days_remaining:  c.days_remaining,
          recipient_phone: c.recipient_phone,
          expiry_date:     c.contract_expiry_date,
        })
      if (logErr) {
        console.warn(`[send-whatsapp-expiry-reminders] log insert failed for ${c.store_id}: ${logErr.message}`)
      }
      sent++
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      failures.push({ store_id: c.store_id, error: msg })
      console.error(`[send-whatsapp-expiry-reminders] send failed store=${c.store_id}: ${msg}`)
    }
  }

  console.log(`[send-whatsapp-expiry-reminders] done sent=${sent} failed=${failed}`)
  return respond({ ok: true, sent, failed, failures })
})

async function sendWhatsApp(c: Candidate): Promise<void> {
  const chatId  = toChatId(c.recipient_phone)
  const message = buildMessage(c)

  // Formato de URL de Green API: https://api.green-api.com/waInstance{{idInstance}}/{{method}}/{{apiTokenInstance}}
  const url = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN_INSTANCE}`

  const payload = { chatId, message }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const json: any = await res.json().catch(() => ({}))
  
  // Green API devuelve un "idMessage" si la petición es exitosa. 
  // Si no es un estado 2xx o no viene idMessage, lanzamos un error.
  if (!res.ok || !json?.idMessage) {
    throw new Error(`Green API ${res.status}: ${json?.message ?? 'envío fallido o número no registrado'}`)
  }
}

function buildMessage(c: Candidate): string {
  const greeting = c.recipient_name ? `Hola ${c.recipient_name},` : 'Hola,'
  const planTxt  = c.plan_type ? ` (${c.plan_type})` : ''
  const expiry   = formatDate(c.contract_expiry_date)
  const link     = `${PUBLIC_APP_URL}/cliente/planes`

  const urgency =
    c.days_remaining === 0 ? `vence *hoy*`
    : c.days_remaining === 1 ? `vence *mañana*`
    : `vence en *${c.days_remaining} días* (${expiry})`

  return [
    `🏪 *Mall Hub — Recordatorio de plan*`,
    ``,
    `${greeting}`,
    ``,
    `El plan${planTxt} de tu tienda *${c.store_name}* ${urgency}.`,
    ``,
    `⚠️ *Importante:* si tu contrato vence sin renovar, perderás el derecho a readquirir este plan si otro cliente lo toma antes. Los planes son limitados y se asignan por orden de pago.`,
    ``,
    `👉 Renueva aquí: ${link}`,
    ``,
    `Si ya realizaste la renovación, ignora este mensaje.`,
    `— Mall Hub`,
  ].join('\n')
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${y}`
}

// Green API usa exactamente el mismo formato que SuperAPI: "<E.164 sin '+'>@c.us"
// Ej.: "0414-123-4567" → "584141234567@c.us"
function toChatId(raw: string): string {
  let digits = raw.replace(/\D+/g, '')
  if (digits.startsWith('0') && digits.length === 11) digits = `58${digits.slice(1)}`
  else if (digits.length === 10 && digits.startsWith('4')) digits = `58${digits}`
  return `${digits}@c.us`
}

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}