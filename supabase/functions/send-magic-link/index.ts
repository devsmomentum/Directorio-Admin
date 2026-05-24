// Supabase Edge Function — Send Magic Link (Email | WhatsApp)
//
// Permite que el admin del panel genere un magic link server-side y lo
// despache por WhatsApp (SuperAPI) o por correo (Supabase mailer).
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
//   5. Si channel='whatsapp' → POST a SuperAPI con el action_link.
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
//
// Los campos de `profile` se persisten en public.users con UPDATE/COALESCE: si
// llegan con valor, se escriben; si llegan vacíos o nulos, se conserva lo que ya
// había. Esto permite que al pulsar "Enviar por WhatsApp"/"Enviar por correo"
// quede guardado el nombre, cédula y teléfono del cliente sin esperar al submit
// del formulario de tienda.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

// SuperAPI — https://v4.iasuperapi.com/api/v1/send-message
//   supabase secrets set SUPERAPI_TOKEN=...    (obligatorio)
//   supabase secrets set SUPERAPI_CLIENT=...   (opcional, lo deduce el token)
//   supabase secrets set SUPERAPI_URL=...      (opcional override)
const SUPERAPI_URL    = Deno.env.get('SUPERAPI_URL')    ?? 'https://v4.iasuperapi.com'
const SUPERAPI_TOKEN  = Deno.env.get('SUPERAPI_TOKEN')  ?? ''
const SUPERAPI_CLIENT = Deno.env.get('SUPERAPI_CLIENT') ?? ''

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
  console.log('[send-magic-link] env check', {
    has_url: !!SUPABASE_URL,
    has_anon: !!SUPABASE_ANON_KEY,
    has_service: !!SUPABASE_SERVICE_ROLE_KEY,
  })
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: userRes, error: userErr } = await userClient.auth.getUser()
  console.log('[send-magic-link] getUser ->', { id: userRes?.user?.id, err: userErr?.message })
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
  console.log('[send-magic-link] role lookup ->', { role: callerRow?.role, err: callerErr?.message })

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
  const redirectTo = body.redirectTo ?? `${getOrigin(req)}/auth/callback`
  const profile    = body.profile ?? {}

  if (!email) return respond({ error: 'email es requerido' }, 400)
  if (channel !== 'email' && channel !== 'whatsapp' && channel !== 'none') {
    return respond({ error: 'channel debe ser email | whatsapp | none' }, 400)
  }
  if (channel === 'whatsapp' && !phoneRaw) {
    return respond({ error: 'phone es requerido para canal whatsapp' }, 400)
  }

  // 3. Crear auth.user si no existe (idempotente).
  // Buscamos en public.users (espejo poblado por el trigger handle_new_auth_user).
  // Si no aparece, intentamos createUser; si Supabase responde "already registered"
  // lo ignoramos — el trigger se encarga del espejo.
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
  // El trigger handle_new_auth_user espeja la fila en public.users con role='cliente'.

  // 3.5 Persistir datos personales del cliente en public.users.
  // Sólo escribimos campos no-vacíos; los vacíos los descartamos para no pisar
  // valores ya existentes con NULL. (Equivalente a COALESCE del lado SQL.)
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

  // channel='none' → sólo queríamos el auth.user creado (y datos persistidos)
  // para luego vincular store↔user desde admin_link_store_user. No generamos
  // link ni enviamos nada.
  if (channel === 'none') {
    return respond({ ok: true, channel: 'none', email, user_created: userCreated })
  }

  // 4. Despachar por canal elegido.
  //
  // Para 'email' usamos signInWithOtp en lugar de generateLink: generateLink
  // sólo PRODUCE el link (se usa cuando vamos a despacharlo nosotros, p.ej.
  // por WhatsApp) — NO dispara el mailer integrado de Supabase. signInWithOtp
  // sí encola y envía el correo a través del SMTP configurado en el proyecto.

  if (channel === 'email') {
    console.log('[send-magic-link] step4 (email): signInWithOtp', { email, redirectTo })
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    })
    const { error: otpErr } = await anon.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        // shouldCreateUser=false: el usuario ya existe en auth (lo creamos en
        // el paso 3 si hacía falta). Esto evita que Supabase intente recrearlo
        // y nos garantiza que se envía el flujo de "magic link" y no de signup.
        shouldCreateUser: false,
      },
    })
    console.log('[send-magic-link] signInWithOtp ->', { err: otpErr?.message })
    if (otpErr) {
      return respond({ error: `signInWithOtp: ${otpErr.message}` }, 500)
    }
    return respond({ ok: true, channel: 'email', email })
  }

  // channel === 'whatsapp' → generamos el link para inyectarlo en el mensaje.
  // NOTA: usamos type:'magiclink' (no 'invite') porque magiclink admite
  // re-invocación para un usuario ya existente — necesario si el admin re-
  // envía el link a un cliente que aún no completó onboarding. El callback
  // /auth/callback decide si lleva a /bienvenida (cuando user_metadata.
  // password_set ≠ true) o directo al panel según el rol.
  console.log('[send-magic-link] step4 (whatsapp): generateLink', { email, redirectTo })
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  })
  console.log('[send-magic-link] generateLink ->', { has_link: !!linkData?.properties?.action_link, err: linkErr?.message })

  if (linkErr || !linkData?.properties?.action_link) {
    return respond({ error: `generateLink: ${linkErr?.message ?? 'sin action_link'}` }, 500)
  }

  const actionLink = linkData.properties.action_link

  // 5. Enviar por WhatsApp (SuperAPI).
    console.log('[send-magic-link] step5: whatsapp branch', {
      has_token: !!SUPERAPI_TOKEN,
      has_client: !!SUPERAPI_CLIENT,
      url: SUPERAPI_URL,
    })
    if (!SUPERAPI_TOKEN) {
      return respond({
        error: 'SuperAPI no configurado (falta SUPERAPI_TOKEN)',
        action_link: actionLink,
      }, 500)
    }

    // WhatsApp Web hace prefetch de los links para mostrar preview, lo cual
    // CONSUME el magic-link single-use de Supabase y deja al usuario con un
    // "expired" cuando hace click. Solución: envolver el action_link en una
    // página propia (/abrir) que requiere JavaScript + click humano para
    // seguir al action_link real. Los bots de preview no ejecutan JS, así
    // que no tocan el endpoint de Supabase.
    // Derivamos el origin del redirectTo (más confiable que getOrigin(req),
    // que depende del header Origin/Referer del SDK).
    let appOrigin = ''
    try { appOrigin = new URL(redirectTo).origin } catch { appOrigin = getOrigin(req) }
    const safeLink = appOrigin
      ? `${appOrigin}/abrir?next=${encodeURIComponent(actionLink)}`
      : actionLink

    const chatId = toChatId(phoneRaw)
    const message =
      `Bienvenido a Millennium Mall.\n` +
      `Abre este enlace en tu teléfono para activar tu cuenta y definir tu contraseña ` +
      `(expira en 1 hora):\n${safeLink}\n\n` +
      `Si no fuiste tú quien lo solicitó, ignora este mensaje.`

    const payload: Record<string, unknown> = { chatId, message }
    if (SUPERAPI_CLIENT) payload.client = SUPERAPI_CLIENT

    console.log('[send-magic-link] step6: POST to SuperAPI', { chatId, url: `${SUPERAPI_URL}/api/v1/send-message` })
    const waRes = await fetch(`${SUPERAPI_URL.replace(/\/$/, '')}/api/v1/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPERAPI_TOKEN}`,
      },
      body: JSON.stringify(payload),
    })

    const waJson: any = await waRes.json().catch(() => ({}))
    console.log('[send-magic-link] SuperAPI ->', { status: waRes.status, ok: waRes.ok, body: waJson })
    if (!waRes.ok || waJson?.error === true) {
      return respond({
        error: `SuperAPI ${waRes.status}: ${waJson?.message ?? 'envío fallido'}`,
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

// SuperAPI espera el chatId en formato "<E.164 sin '+'>@c.us".
// Ej.: "0414-123-4567" o "+58 414 123 4567" → "584141234567@c.us"
function toChatId(raw: string): string {
  let digits = raw.replace(/\D+/g, '')
  // 0XXX… venezolano → 58 + resto sin el 0
  if (digits.startsWith('0') && digits.length === 11) digits = `58${digits.slice(1)}`
  // 4XXXXXXXXX (10 dígitos sin código de país) → asumir Venezuela
  else if (digits.length === 10 && digits.startsWith('4')) digits = `58${digits}`
  return `${digits}@c.us`
}
