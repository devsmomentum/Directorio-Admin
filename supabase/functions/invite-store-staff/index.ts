// Supabase Edge Function — Invite Store Staff (Email | WhatsApp)
//
// Autoservicio del DUEÑO de una tienda para invitar STAFF acotado:
//   · seller     (vendedor)  → solo canje de cupones.
//   · advertiser (publicista)→ solo publicidad (cupones + campañas).
//
// Es una variante con alcance reducido de `send-magic-link` (que es solo-admin).
// NO se toca aquella para no ampliar su superficie.
//
// Auth model:
//   - verify_jwt = true (config.toml) → Supabase valida el JWT del caller.
//   - Autorización propia: el caller debe ser DUEÑO (store_role='owner') de la
//     tienda destino. NO confiamos en ningún rol que venga en el body.
//   - El rol asignable se limita a seller|advertiser (nunca admin/owner). El
//     vínculo se escribe vía el RPC owner_set_store_staff (SECURITY DEFINER),
//     que vuelve a validar todo del lado del servidor (defensa en profundidad).
//
// Body:
//   { email: string,
//     store_id: string (uuid),
//     store_role: 'seller' | 'advertiser',
//     channel: 'email' | 'whatsapp',
//     phone?: string,            // requerido si channel='whatsapp'
//     redirectTo?: string,
//     profile?: { full_name?, cedula_numero?, telefono_personal? } }
//
// Email:  Resend. Requiere secrets: RESEND_API_KEY, RESEND_FROM
// WhatsApp: Green API. Requiere secrets: GREEN_API_ID_INSTANCE, GREEN_API_TOKEN_INSTANCE

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

const GREEN_API_ID_INSTANCE    = Deno.env.get('GREEN_API_ID_INSTANCE')    ?? ''
const GREEN_API_TOKEN_INSTANCE = Deno.env.get('GREEN_API_TOKEN_INSTANCE') ?? ''

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
const RESEND_FROM    = Deno.env.get('RESEND_FROM')    ?? 'Mall Hub <noreply@morna.tech>'

const PUBLIC_APP_URL = 'https://mallhub.morna.tech'.replace(/\/$/, '')

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req)
  } catch (err) {
    console.error('[invite-store-staff] UNCAUGHT', err instanceof Error ? err.stack : String(err))
    return respond({ error: `Uncaught: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }
})

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return respond({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return respond({ error: 'Missing bearer token' }, 401)

  // 1. Identificar al caller.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: userRes, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userRes?.user) return respond({ error: 'Invalid session' }, 401)
  const callerId = userRes.user.id

  // 2. Parsear y validar body.
  type ProfilePatch = { full_name?: string | null; cedula_numero?: string | null; telefono_personal?: string | null }
  let body: {
    email?: string; store_id?: string; store_role?: string
    channel?: string; phone?: string; redirectTo?: string; profile?: ProfilePatch
  }
  try { body = await req.json() } catch { return respond({ error: 'Invalid JSON body' }, 400) }

  const email     = (body.email ?? '').trim().toLowerCase()
  const storeId   = (body.store_id ?? '').trim()
  const storeRole = (body.store_role ?? '').trim()
  const phoneRaw  = (body.phone ?? '').trim()
  const channel   = (body.channel ?? 'email').toLowerCase()
  const profile   = body.profile ?? {}

  if (!email)   return respond({ error: 'email es requerido' }, 400)
  if (!storeId) return respond({ error: 'store_id es requerido' }, 400)
  if (storeRole !== 'seller' && storeRole !== 'advertiser') {
    return respond({ error: 'store_role debe ser seller | advertiser' }, 400)
  }
  if (channel !== 'email' && channel !== 'whatsapp') {
    return respond({ error: 'channel debe ser email | whatsapp' }, 400)
  }
  if (channel === 'whatsapp' && !phoneRaw) {
    return respond({ error: 'phone es requerido para canal whatsapp' }, 400)
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  // 3. Autorización: el caller debe ser DUEÑO de la tienda destino.
  const { data: ownerLink, error: ownerErr } = await admin
    .from('user_stores')
    .select('user_id')
    .eq('user_id', callerId)
    .eq('store_id', storeId)
    .eq('store_role', 'owner')
    .maybeSingle()
  if (ownerErr) return respond({ error: `auth check: ${ownerErr.message}` }, 500)
  if (!ownerLink) return respond({ error: 'Solo el dueño de la tienda puede invitar staff' }, 403)

  // 4. Obtener nombre de la tienda (para personalizar mensajes).
  const { data: storeRow } = await admin
    .from('stores')
    .select('name')
    .eq('id', storeId)
    .maybeSingle()
  const storeName = (storeRow as { name?: string } | null)?.name ?? 'tu tienda'

  const appOrigin  = PUBLIC_APP_URL || originFromBody(body.redirectTo) || getOrigin(req)
  const redirectTo = appOrigin ? `${appOrigin}/auth/callback` : (body.redirectTo ?? '')

  // 5. Crear el auth.user si no existe (idempotente).
  const { data: lookup } = await admin.from('users').select('id').eq('email', email).maybeSingle()
  let userCreated = false
  if (!lookup?.id) {
    const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true })
    if (createErr && !/already registered|exists/i.test(createErr.message)) {
      return respond({ error: `No se pudo crear el usuario: ${createErr.message}` }, 500)
    }
    userCreated = !createErr
  }

  // 6. Vincular con el rol vía RPC (bajo el JWT del dueño).
  const { data: linkedId, error: linkErr } = await userClient.rpc('owner_set_store_staff', {
    p_email: email,
    p_store_id: storeId,
    p_store_role: storeRole,
    p_full_name: (profile.full_name ?? '')?.toString().trim() || null,
    p_cedula_numero: (profile.cedula_numero ?? '')?.toString().trim() || null,
    p_telefono_personal: (profile.telefono_personal ?? '')?.toString().trim() || null,
  })
  if (linkErr) return respond({ error: `No se pudo vincular el staff: ${linkErr.message}` }, 403)
  if (!linkedId) return respond({ error: 'No se encontró el usuario recién creado. Reintenta.' }, 500)

  // 7. Generar el magic link (usado por ambos canales).
  const { data: linkData, error: genErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email, options: { redirectTo },
  })
  if (genErr || !linkData?.properties?.action_link) {
    return respond({ error: `generateLink: ${genErr?.message ?? 'sin action_link'}` }, 500)
  }
  const actionLink = linkData.properties.action_link

  // 8. Envolver en /abrir para que el prefetch de WhatsApp/clientes de correo
  //    no consuman el link single-use.
  const safeLink = appOrigin
    ? `${appOrigin}/abrir?next=${encodeURIComponent(actionLink)}`
    : actionLink

  // 9. Despachar por canal.
  if (channel === 'email') {
    if (!RESEND_API_KEY) {
      return respond({ error: 'Resend no configurado (falta RESEND_API_KEY)', action_link: actionLink }, 500)
    }
    const { subject, html, text } = buildInviteEmail(storeRole, storeName, safeLink)
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [email], subject, html, text }),
    })
    if (!res.ok) {
      const body2 = await res.text()
      return respond({ error: `Resend ${res.status}: ${body2}`, action_link: actionLink }, 502)
    }
    return respond({ ok: true, channel: 'email', email, store_role: storeRole, user_created: userCreated })
  }

  // channel === 'whatsapp'
  if (!GREEN_API_ID_INSTANCE || !GREEN_API_TOKEN_INSTANCE) {
    return respond({ error: 'Green API no configurado (faltan credenciales)', action_link: actionLink }, 500)
  }

  // Validar estado de la instancia antes de enviar.
  const stateUrl = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/getStateInstance/${GREEN_API_TOKEN_INSTANCE}`
  console.log('[invite-store-staff] GET stateInstance from Green API')
  const stateRes = await fetch(stateUrl).catch((e) => {
    console.error('[invite-store-staff] error fetching stateInstance', e)
    return null
  })
  if (stateRes && stateRes.ok) {
    const stateJson = await stateRes.json().catch(() => ({}))
    console.log('[invite-store-staff] Green API stateInstance ->', stateJson)
    if (stateJson?.stateInstance !== 'authorized') {
      return respond({
        error: `La instancia de Green API no está activa (estado: ${stateJson?.stateInstance ?? 'desconocido'}). Por favor, escanea el código QR en la consola de Green API.`,
        action_link: actionLink,
      }, 400)
    }
  }

  const chatId  = toChatId(phoneRaw)
  const message = buildWhatsAppMessage(storeRole, storeName, safeLink)

  const waUrl = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN_INSTANCE}`
  const waRes = await fetch(waUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message }),
  })
  const waJson: any = await waRes.json().catch(() => ({}))
  if (!waRes.ok || !waJson?.idMessage) {
    return respond({
      error: `Green API ${waRes.status}: ${waJson?.message ?? 'envío fallido o número inválido'}`,
      action_link: actionLink,
    }, 502)
  }
  return respond({ ok: true, channel: 'whatsapp', chatId, email, store_role: storeRole, user_created: userCreated })
}

// ─── Templates por rol ──────────────────────────────────────────────────────

type InviteContent = { subject: string; html: string; text: string }

function buildInviteEmail(role: string, storeName: string, link: string): InviteContent {
  const isSeller = role === 'seller'

  const subject = isSeller
    ? `Eres vendedor en ${storeName} · Mall Hub`
    : `Eres publicista en ${storeName} · Mall Hub`

  const roleLabel   = isSeller ? 'Vendedor'  : 'Publicista'
  const roleBadge   = isSeller ? 'VENDEDOR'  : 'PUBLICISTA'
  const roleDesc    = isSeller
    ? `Con este acceso podrás canjear los cupones de tus clientes desde la sección <strong style="color:#c8b8f0;">Candidatos</strong>.`
    : `Con este acceso podrás gestionar la publicidad de la tienda: cupones y campañas.`
  const roleDescTxt = isSeller
    ? `Con este acceso podrás canjear los cupones de tus clientes desde la sección Candidatos.`
    : `Con este acceso podrás gestionar la publicidad de la tienda: cupones y campañas.`
  const step3 = isSeller
    ? `<strong style="color:#ffffff;">Canjea cupones</strong> en tiempo real desde Candidatos.`
    : `<strong style="color:#ffffff;">Gestiona cupones y campañas</strong> de la tienda.`
  const previewText = isSeller
    ? `${storeName} te invitó como vendedor en Mall Hub. Activa tu cuenta.`
    : `${storeName} te invitó como publicista en Mall Hub. Activa tu cuenta.`

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="dark only" />
<title>${esc(subject)}</title>
<!--[if mso]><style>body,table,td,a{font-family:Arial,Helvetica,sans-serif!important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#0a0814;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#ffffff;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(previewText)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0814;">
    <tr><td align="center" style="padding:32px 16px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
        style="width:600px;max-width:600px;background:#130f22;border:1px solid rgba(216,180,254,0.14);border-radius:16px;overflow:hidden;">

        <!-- Barra superior de acento -->
        <tr>
          <td style="height:3px;background:linear-gradient(90deg,#44abe1 0%,#a733be 100%);line-height:3px;font-size:0;">&nbsp;</td>
        </tr>

        <!-- Header / brand -->
        <tr><td style="padding:28px 32px 8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:middle;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <!-- Logo tile -->
                    <td width="38" height="38" align="center" valign="middle"
                      style="width:38px;height:38px;background:linear-gradient(135deg,#44abe1 0%,#a733be 100%);border-radius:10px;">
                      <span style="font-size:17px;font-weight:900;color:#ffffff;line-height:38px;font-family:Arial,sans-serif;">M</span>
                    </td>
                    <td style="width:12px;">&nbsp;</td>
                    <td valign="middle">
                      <div style="font-size:14px;font-weight:800;letter-spacing:2.5px;color:#c8b8f0;line-height:1;">MALL HUB</div>
                      <div style="margin-top:3px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(200,184,240,0.45);line-height:1;">Plataforma de comerciantes</div>
                    </td>
                  </tr>
                </table>
              </td>
              <td align="right" style="vertical-align:middle;">
                <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(167,51,190,0.15);border:1px solid rgba(167,51,190,0.35);color:#d580f0;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;">${roleBadge}</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Hero -->
        <tr><td style="padding:24px 32px 8px 32px;">
          <p style="margin:0 0 6px 0;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:rgba(200,184,240,0.40);">Invitación de equipo</p>
          <h1 style="margin:0;font-size:26px;line-height:32px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;">
            Tu acceso como <span style="background:linear-gradient(90deg,#44abe1,#a733be);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${esc(roleLabel)}</span>
          </h1>
          <p style="margin:14px 0 0 0;font-size:14px;line-height:22px;color:rgba(200,184,240,0.75);">
            <strong style="color:#ffffff;">${esc(storeName)}</strong> te invitó a su equipo en Mall Hub. ${roleDesc}
          </p>
        </td></tr>

        <!-- CTA card -->
        <tr><td style="padding:24px 32px 8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="background:#1e1635;border:1px solid rgba(167,51,190,0.25);border-radius:14px;">
            <tr><td style="padding:22px 22px 18px 22px;">
              <p style="margin:0 0 4px 0;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:rgba(200,184,240,0.55);">Enlace de activación</p>
              <p style="margin:0 0 16px 0;font-size:13px;line-height:20px;color:rgba(200,184,240,0.60);">
                Pulsa el botón para activar tu cuenta. El enlace es de un solo uso y expira en
                <strong style="color:#ffffff;">24 horas</strong>.
              </p>
              <!-- Botón bulletproof -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#a733be" style="border-radius:10px;background:#a733be;">
                    <a href="${link}" target="_blank"
                      style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:700;color:#ffffff;background:#a733be;border-radius:10px;text-decoration:none;letter-spacing:0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                      Activar mi cuenta →
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:14px 0 0 0;font-size:11px;line-height:17px;color:rgba(200,184,240,0.35);">
                ¿No funciona el botón? Copia y pega este enlace en tu navegador:
              </p>
              <p style="margin:5px 0 0 0;word-break:break-all;">
                <a href="${link}" style="color:#7eb8e8;font-size:11px;line-height:16px;">${link}</a>
              </p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Info tiles -->
        <tr><td style="padding:20px 32px 8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="50%" style="padding-right:6px;vertical-align:top;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                  style="background:#1a1432;border:1px solid rgba(216,180,254,0.08);border-radius:10px;">
                  <tr><td style="padding:13px 14px;">
                    <p style="margin:0 0 5px 0;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(200,184,240,0.35);">Tienda</p>
                    <p style="margin:0;font-size:13px;line-height:18px;color:#ffffff;word-break:break-all;">${esc(storeName)}</p>
                  </td></tr>
                </table>
              </td>
              <td width="50%" style="padding-left:6px;vertical-align:top;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                  style="background:#1a1432;border:1px solid rgba(216,180,254,0.08);border-radius:10px;">
                  <tr><td style="padding:13px 14px;">
                    <p style="margin:0 0 5px 0;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(200,184,240,0.35);">Validez</p>
                    <p style="margin:0;font-size:13px;line-height:18px;color:#ffffff;">
                      <span style="color:#c084fc;">●</span> 24 horas · un solo uso
                    </p>
                  </td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Pasos -->
        <tr><td style="padding:22px 32px 8px 32px;">
          <p style="margin:0 0 12px 0;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:rgba(200,184,240,0.35);">Qué sigue</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="28" valign="top" style="padding-top:1px;">
                <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;background:rgba(167,51,190,0.20);color:#d580f0;border-radius:999px;font-size:11px;font-weight:700;">1</span>
              </td>
              <td valign="top" style="padding-bottom:10px;">
                <p style="margin:0;font-size:13px;line-height:20px;color:rgba(200,184,240,0.80);">
                  <strong style="color:#ffffff;">Activa tu cuenta</strong> con el botón de arriba.
                </p>
              </td>
            </tr>
            <tr>
              <td width="28" valign="top" style="padding-top:1px;">
                <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;background:rgba(167,51,190,0.20);color:#d580f0;border-radius:999px;font-size:11px;font-weight:700;">2</span>
              </td>
              <td valign="top" style="padding-bottom:10px;">
                <p style="margin:0;font-size:13px;line-height:20px;color:rgba(200,184,240,0.80);">
                  <strong style="color:#ffffff;">Define tu contraseña</strong> y completa tu perfil.
                </p>
              </td>
            </tr>
            <tr>
              <td width="28" valign="top" style="padding-top:1px;">
                <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;background:rgba(167,51,190,0.20);color:#d580f0;border-radius:999px;font-size:11px;font-weight:700;">3</span>
              </td>
              <td valign="top">
                <p style="margin:0;font-size:13px;line-height:20px;color:rgba(200,184,240,0.80);">
                  ${step3}
                </p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Aviso seguridad -->
        <tr><td style="padding:18px 32px 24px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="background:rgba(251,191,36,0.05);border:1px solid rgba(251,191,36,0.18);border-radius:10px;">
            <tr><td style="padding:12px 14px;">
              <p style="margin:0;font-size:12px;line-height:18px;color:#fde68a;">
                <strong style="color:#fcd34d;">¿No esperabas esta invitación?</strong>
                <span style="color:rgba(253,230,138,0.80);"> Ignora este correo. Tu cuenta no se activará si no abres el enlace.</span>
              </p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:0 32px;">
          <div style="height:1px;background:rgba(216,180,254,0.08);line-height:1px;font-size:0;">&nbsp;</div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 32px 26px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td>
                <p style="margin:0;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;font-weight:700;color:rgba(200,184,240,0.40);">Mall Hub</p>
                <p style="margin:3px 0 0 0;font-size:11px;line-height:16px;color:rgba(200,184,240,0.30);">Plataforma de comerciantes</p>
              </td>
              <td align="right">
                <p style="margin:0;font-size:10px;letter-spacing:1px;color:rgba(200,184,240,0.25);">© 2026</p>
              </td>
            </tr>
          </table>
        </td></tr>

      </table>

      <!-- Pie externo -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td align="center" style="padding:14px 16px 0 16px;">
          <p style="margin:0;font-size:10px;line-height:16px;color:rgba(200,184,240,0.25);">
            Este correo fue enviado a <span style="color:rgba(200,184,240,0.45);">${esc(storeName)}</span> porque el dueño de la tienda te invitó.
          </p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`

  const text = `${subject}\n\n${storeName} te invitó como ${roleLabel.toLowerCase()} en Mall Hub. ${roleDescTxt}\n\nActiva tu cuenta:\n${link}\n\nEste enlace expira en 24 horas. Si no esperabas esta invitación, ignora este mensaje.\n\n— Mall Hub`

  return { subject, html, text }
}

function buildWhatsAppMessage(role: string, storeName: string, link: string): string {
  if (role === 'seller') {
    return (
      `*Mall Hub* — Te invitaron como *vendedor* en *${storeName}*.\n\n` +
      `Con este acceso podrás canjear los cupones de los candidatos desde la sección *Candidatos*.\n\n` +
      `Abre este enlace para activar tu cuenta y definir tu contraseña ` +
      `(expira en 24 horas):\n${link}\n\n` +
      `Si no esperabas esto, ignora este mensaje.`
    )
  }
  return (
    `*Mall Hub* — Te invitaron como *publicista* en *${storeName}*.\n\n` +
    `Con este acceso podrás gestionar la publicidad de la tienda: cupones y campañas.\n\n` +
    `Abre este enlace para activar tu cuenta y definir tu contraseña ` +
    `(expira en 24 horas):\n${link}\n\n` +
    `Si no esperabas esto, ignora este mensaje.`
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function getOrigin(req: Request): string {
  const origin = req.headers.get('origin')
  if (origin) return origin
  const referer = req.headers.get('referer')
  if (referer) { try { return new URL(referer).origin } catch { /* ignore */ } }
  return ''
}

function originFromBody(redirectTo?: string): string {
  if (redirectTo) { try { return new URL(redirectTo).origin } catch { /* ignore */ } }
  return ''
}

function toChatId(raw: string): string {
  let digits = raw.replace(/\D+/g, '')
  if (digits.startsWith('0') && digits.length === 11) digits = `58${digits.slice(1)}`
  else if (digits.length === 10 && digits.startsWith('4')) digits = `58${digits}`
  return `${digits}@c.us`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
