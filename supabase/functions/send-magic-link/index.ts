// Supabase Edge Function — Send Magic Link (Email | WhatsApp)
//
// Permite que el admin del panel genere un magic link server-side y lo
// despache por WhatsApp (Green API) o por correo (Supabase mailer).
//
// Auth model:
//   - verify_jwt = true (ver supabase/config.toml) → Supabase valida el JWT.
//   - Adicionalmente verificamos que el caller tenga role='admin' en public.users.
//
// Flujo:
//   1. Validar admin caller.
//   2. Crear auth.user si no existe (email_confirm=true).
//   3. Si channel='none' → terminar aquí (sólo crear auth.user para luego
//      vincular store ↔ usuario sin enviar nada).
//   4. supabase.auth.admin.generateLink({ type: 'magiclink' }).
//   5. Si channel='whatsapp' → POST a Green API con el action_link.
//      Si channel='email'    → Supabase ya envió el correo al llamar generateLink
//                              con un mailer configurado; fallback: devolvemos el link.
//
// Body esperado:
//   { email: string,
//     phone?: string,
//     channel: 'whatsapp' | 'email' | 'none',
//     redirectTo?: string,
//     profile?: {
//       full_name?: string,
//       cedula_numero?: string,
//       telefono_personal?: string
//     } }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

// Green API — Credenciales provistas por tu empresa
const GREEN_API_ID_INSTANCE    = Deno.env.get('GREEN_API_ID_INSTANCE') ?? ''
const GREEN_API_TOKEN_INSTANCE = Deno.env.get('GREEN_API_TOKEN_INSTANCE') ?? ''

const PUBLIC_APP_URL  = "https://mallhub.morna.tech".replace(/\/$/, '')

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req)
  } catch (err) {
    console.error('[send-magic-link] UNCAUGHT', err instanceof Error ? err.stack : String(err))
    return respond({ error: `Uncaught: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }
})

async function handle(req: Request): Promise<Response> {
  console.log('[send-magic-link] enter', req.method, 'origin=', req.headers.get('origin') ?? '-')
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return respond({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  console.log('[send-magic-link] auth header present?', authHeader.startsWith('Bearer '))
  if (!authHeader.startsWith('Bearer ')) {
    return respond({ error: 'Missing bearer token' }, 401)
  }

  // 1. Validar que el caller es admin
  console.log('[send-magic-link] step1: validating caller')
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: userRes, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userRes?.user) {
    return respond({ error: 'Invalid session' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const { data: callerRow, error: callerErr } = await admin
    .from('users')
    .select('role')
    .eq('id', userRes.user.id)
    .maybeSingle()

  if (callerErr || callerRow?.role !== 'admin') {
    return respond({ error: 'Solo admin puede enviar magic links' }, 403)
  }

  // 2. Parsear body
  type ProfilePatch = {
    full_name?: string | null
    cedula_numero?: string | null
    telefono_personal?: string | null
  }
  let body: {
    email?: string
    phone?: string
    channel?: string
    redirectTo?: string
    profile?: ProfilePatch
  }
  try {
    body = await req.json()
  } catch {
    return respond({ error: 'Invalid JSON body' }, 400)
  }

  const email      = (body.email ?? '').trim().toLowerCase()
  const phoneRaw   = (body.phone ?? '').trim()
  const channel    = (body.channel ?? 'email').toLowerCase()
  
  const fallbackOrigin = (() => {
    if (body.redirectTo) {
      try { return new URL(body.redirectTo).origin } catch { /* ignore */ }
    }
    return getOrigin(req)
  })()
  const appOrigin  = PUBLIC_APP_URL || fallbackOrigin
  const redirectTo = appOrigin ? `${appOrigin}/auth/callback` : (body.redirectTo ?? '')
  const profile    = body.profile ?? {}

  if (!email) return respond({ error: 'email es requerido' }, 400)
  if (channel !== 'email' && channel !== 'whatsapp' && channel !== 'none') {
    return respond({ error: 'channel debe ser email | whatsapp | none' }, 400)
  }
  if (channel === 'whatsapp' && !phoneRaw) {
    return respond({ error: 'phone es requerido para canal whatsapp' }, 400)
  }

  // 3. Crear auth.user si no existe (idempotente).
  const { data: lookup } = await admin
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  let userCreated = false
  if (!lookup?.id) {
    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (createErr && !/already registered|exists/i.test(createErr.message)) {
      return respond({ error: `No se pudo crear el usuario: ${createErr.message}` }, 500)
    }
    userCreated = !createErr
  }

  // 3.5 Persistir datos personales del cliente en public.users.
  const profilePatch: Record<string, string> = {}
  for (const k of ['full_name', 'cedula_numero', 'telefono_personal'] as const) {
    const v = (profile[k] ?? '').toString().trim()
    if (v) profilePatch[k] = v
  }
  if (Object.keys(profilePatch).length > 0) {
    const { error: updErr } = await admin
      .from('users')
      .update(profilePatch)
      .eq('email', email)
    if (updErr) console.warn('[send-magic-link] profile update:', updErr.message)
  }

  if (channel === 'none') {
    return respond({ ok: true, channel: 'none', email, user_created: userCreated })
  }

  // 4. Despachar por canal elegido (Email).
  if (channel === 'email') {
    console.log('[send-magic-link] step4 (email): signInWithOtp', { email, redirectTo })
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    })
    const { error: otpErr } = await anon.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        shouldCreateUser: false,
      },
    })
    if (otpErr) {
      return respond({ error: `signInWithOtp: ${otpErr.message}` }, 500)
    }
    return respond({ ok: true, channel: 'email', email })
  }

  // channel === 'whatsapp' → generamos el link para inyectarlo en el mensaje.
  console.log('[send-magic-link] step4 (whatsapp): generateLink', { email, redirectTo })
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  })

  if (linkErr || !linkData?.properties?.action_link) {
    return respond({ error: `generateLink: ${linkErr?.message ?? 'sin action_link'}` }, 500)
  }

  const actionLink = linkData.properties.action_link

  // 5. Enviar por WhatsApp (Green API).
  console.log('[send-magic-link] step5: whatsapp branch', {
    has_id: !!GREEN_API_ID_INSTANCE,
    has_token: !!GREEN_API_TOKEN_INSTANCE,
  })
  
  if (!GREEN_API_ID_INSTANCE || !GREEN_API_TOKEN_INSTANCE) {
    return respond({
      error: 'Green API no configurado (faltan credenciales)',
      action_link: actionLink,
    }, 500)
  }

  const safeLink = appOrigin
    ? `${appOrigin}/abrir?next=${encodeURIComponent(actionLink)}`
    : actionLink

  const chatId = toChatId(phoneRaw)
  const message =
    `Bienvenido a Mall Hub.\n` +
    `Abre este enlace en tu teléfono para activar tu cuenta y definir tu contraseña ` +
    `:\n${safeLink}\n\n` +
    `Si no fuiste tú quien lo solicitó, ignora este mensaje.`

  const payload = { chatId, message }

  // Estructura de endpoint de Green API
  const url = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN_INSTANCE}`

  console.log('[send-magic-link] step6: POST to Green API', { chatId, url })
  const waRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const waJson: any = await waRes.json().catch(() => ({}))
  console.log('[send-magic-link] Green API ->', { status: waRes.status, ok: waRes.ok, body: waJson })
  
  // Green API responde exitosamente devolviendo un `idMessage`. Si no viene, es un fallo.
  if (!waRes.ok || !waJson?.idMessage) {
    return respond({
      error: `Green API ${waRes.status}: ${waJson?.message ?? 'envío fallido o número inválido'}`,
      action_link: actionLink,
    }, 502)
  }

  return respond({ ok: true, channel: 'whatsapp', chatId, email })
}

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function getOrigin(req: Request): string {
  const origin = req.headers.get('origin')
  if (origin) return origin
  const referer = req.headers.get('referer')
  if (referer) {
    try { return new URL(referer).origin } catch { /* ignore */ }
  }
  return ''
}

// Mismo formato compatible: "<E.164 sin '+'>@c.us"
function toChatId(raw: string): string {
  let digits = raw.replace(/\D+/g, '')
  if (digits.startsWith('0') && digits.length === 11) digits = `58${digits.slice(1)}`
  else if (digits.length === 10 && digits.startsWith('4')) digits = `58${digits}`
  return `${digits}@c.us`
}