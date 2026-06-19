// Supabase Edge Function — Send Contract Expiry Reminders
//
// Envía recordatorios por correo a los clientes cuando el plan de su tienda
// (stores.contract_expiry_date) está por vencer. Dispara en T-5, T-3, T-1
// y T-0 días (el día mismo del vencimiento).
//
// Cada email incluye además la advertencia de que, si el contrato vence y no
// se renueva, el cliente pierde el derecho de readquirir ese plan si otro
// cliente lo compra primero.
//
// Auth: lo llama pg_cron con header `x-cron-secret` (mismo patrón que
// kill-switch). verify_jwt=false en config.toml.
//
// Idempotencia: tabla `plan_expiry_reminders_log` con UNIQUE (store_id,
// days_remaining, sent_date). Si el job se vuelve a disparar el mismo día,
// no reenvía. La RPC `enqueue_contract_expiry_reminders` resuelve los
// candidatos y devuelve solo los que aún no se han notificado hoy.
//
// Email: Resend (https://resend.com). Requiere secrets:
//   RESEND_API_KEY      — API key
//   RESEND_FROM         — remitente verificado ("Mall Hub <noreply@…>")
//   CRON_SECRET         — clave compartida con pg_cron
//   PUBLIC_APP_URL      — base del portal del cliente (link "Renovar plan")

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET               = Deno.env.get('CRON_SECRET') ?? ''
const RESEND_API_KEY            = Deno.env.get('RESEND_API_KEY') ?? ''
const RESEND_FROM               = Deno.env.get('RESEND_FROM')    ?? 'Mall Hub <noreply@morna.tech>'
const PUBLIC_APP_URL            = (Deno.env.get('PUBLIC_APP_URL') ?? 'https://mallhub.morna.tech').replace(/\/$/, '')

type Candidate = {
  store_id: string
  store_name: string
  plan_type: string | null
  contract_expiry_date: string   // YYYY-MM-DD
  days_remaining: number         // 5 | 3 | 1 | 0
  recipient_email: string
  recipient_name: string | null
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

  if (!RESEND_API_KEY) {
    return respond({ error: 'RESEND_API_KEY no configurado' }, 500)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  // La RPC resuelve qué tiendas tocan hoy (T-5/-3/-1/-0) y descarta las que
  // ya tienen entrada en el log para hoy con ese days_remaining.
  const { data: candidates, error: rpcErr } = await supabase
    .rpc('enqueue_contract_expiry_reminders')

  if (rpcErr) {
    console.error('[send-contract-expiry-reminders] RPC error:', rpcErr.message)
    return respond({ error: rpcErr.message }, 500)
  }

  const list = (candidates ?? []) as Candidate[]
  if (list.length === 0) {
    console.log('[send-contract-expiry-reminders] nothing to send today')
    return respond({ ok: true, sent: 0, failed: 0 })
  }

  let sent = 0
  let failed = 0
  const failures: Array<{ store_id: string; error: string }> = []

  for (const c of list) {
    try {
      await sendEmail(c)

      const { error: logErr } = await supabase
        .from('plan_expiry_reminders_log')
        .insert({
          store_id:       c.store_id,
          days_remaining: c.days_remaining,
          recipient:      c.recipient_email,
          expiry_date:    c.contract_expiry_date,
        })
      if (logErr) {
        // No reabortamos el envío — solo lo dejamos en el log de la function.
        console.warn(`[send-contract-expiry-reminders] log insert failed for ${c.store_id}: ${logErr.message}`)
      }
      sent++
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      failures.push({ store_id: c.store_id, error: msg })
      console.error(`[send-contract-expiry-reminders] send failed store=${c.store_id}: ${msg}`)
    }
  }

  console.log(`[send-contract-expiry-reminders] done sent=${sent} failed=${failed}`)
  return respond({ ok: true, sent, failed, failures })
})

async function sendEmail(c: Candidate): Promise<void> {
  const subject = subjectFor(c.days_remaining, c.store_name)
  const html    = renderHtml(c)
  const text    = renderText(c)

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    RESEND_FROM,
      to:      [c.recipient_email],
      subject,
      html,
      text,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Resend ${res.status}: ${body || res.statusText}`)
  }
}

function subjectFor(days: number, storeName: string): string {
  if (days === 0) return `Tu plan vence hoy — ${storeName}`
  if (days === 1) return `Tu plan vence mañana — ${storeName}`
  return `Tu plan vence en ${days} días — ${storeName}`
}

function headlineFor(days: number): string {
  if (days === 0) return 'Tu plan vence hoy'
  if (days === 1) return 'Tu plan vence mañana'
  return `Tu plan vence en ${days} días`
}

function renderText(c: Candidate): string {
  const headline = headlineFor(c.days_remaining)
  const planTxt  = c.plan_type ? ` (${c.plan_type})` : ''
  const expiry   = formatDate(c.contract_expiry_date)
  const link     = `${PUBLIC_APP_URL}/cliente/planes`
  return [
    `${headline}.`,
    ``,
    `Hola${c.recipient_name ? ` ${c.recipient_name}` : ''},`,
    ``,
    `El plan de tu tienda "${c.store_name}"${planTxt} vence el ${expiry}.`,
    ``,
    `IMPORTANTE: si tu contrato vence y no lo renuevas a tiempo, perderás el ` +
      `derecho a adquirirlo nuevamente si otro cliente lo compra antes que tú. ` +
      `Los planes son limitados y se asignan por orden de pago.`,
    ``,
    `Renueva ahora: ${link}`,
    ``,
    `— Mall Hub`,
  ].join('\n')
}

function renderHtml(c: Candidate): string {
  const headline = headlineFor(c.days_remaining)
  const planTxt  = c.plan_type ? ` <span style="color:#22d3ee;">(${escapeHtml(c.plan_type)})</span>` : ''
  const expiry   = formatDate(c.contract_expiry_date)
  const link     = `${PUBLIC_APP_URL}/cliente/planes`
  const greeting = c.recipient_name ? `Hola ${escapeHtml(c.recipient_name)},` : 'Hola,'

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(headline)}</title>
</head>
<body style="margin:0;padding:0;background:#050505;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${escapeHtml(headline)} — renueva tu plan en Mall Hub.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050505;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
        style="width:600px;max-width:600px;background:#0A0A0A;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 32px 0 32px;">
          <h1 style="margin:0 0 8px 0;font-size:26px;line-height:32px;color:#ffffff;">
            ${escapeHtml(headline)}
          </h1>
          <p style="margin:0 0 24px 0;font-size:14px;color:rgba(255,255,255,0.6);">
            ${greeting}
          </p>
          <p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#ffffff;">
            El plan de tu tienda <strong>${escapeHtml(c.store_name)}</strong>${planTxt}
            vence el <strong>${escapeHtml(expiry)}</strong>.
          </p>
          <div style="margin:24px 0;padding:16px 20px;background:#1f0a0a;border:1px solid #ef4444;border-radius:12px;">
            <p style="margin:0;font-size:14px;line-height:22px;color:#fecaca;">
              <strong style="color:#ef4444;">Importante:</strong> si tu contrato vence y
              no lo renuevas a tiempo, perderás el derecho a adquirirlo nuevamente si
              otro cliente lo compra antes que tú. Los planes son limitados y se asignan
              por orden de pago.
            </p>
          </div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 32px 0;">
            <tr><td style="border-radius:10px;background:#22d3ee;">
              <a href="${link}" class="btn"
                style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#020617;text-decoration:none;">
                Renovar mi plan
              </a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 32px 32px;">
          <p style="margin:0;font-size:12px;line-height:18px;color:rgba(255,255,255,0.45);">
            Si ya renovaste, ignora este mensaje. Esta notificación se envía a 5, 3 y
            1 día del vencimiento, y el día mismo.
          </p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0 0;font-size:11px;color:rgba(255,255,255,0.35);">
        Mall Hub · ${new Date().getFullYear()}
      </p>
    </td></tr>
  </table>
</body>
</html>`
}

function formatDate(iso: string): string {
  // iso "YYYY-MM-DD" → "DD/MM/YYYY"
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${y}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
