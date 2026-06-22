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
// WhatsApp: Green API. Requiere secrets:
//   GREEN_API_ID_INSTANCE    — ID de la instancia
//   GREEN_API_TOKEN_INSTANCE — Token de la instancia

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

const GREEN_API_ID_INSTANCE    = Deno.env.get('GREEN_API_ID_INSTANCE')    ?? ''
const GREEN_API_TOKEN_INSTANCE = Deno.env.get('GREEN_API_TOKEN_INSTANCE') ?? ''

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
  //    (El RPC owner_set_store_staff lo revalida; esto evita crear el
  //     auth.user antes de saber si el caller tiene derecho.)
  const { data: ownerLink, error: ownerErr } = await admin
    .from('user_stores')
    .select('user_id')
    .eq('user_id', callerId)
    .eq('store_id', storeId)
    .eq('store_role', 'owner')
    .maybeSingle()
  if (ownerErr) return respond({ error: `auth check: ${ownerErr.message}` }, 500)
  if (!ownerLink) return respond({ error: 'Solo el dueño de la tienda puede invitar staff' }, 403)

  const appOrigin  = PUBLIC_APP_URL || originFromBody(body.redirectTo) || getOrigin(req)
  const redirectTo = appOrigin ? `${appOrigin}/auth/callback` : (body.redirectTo ?? '')

  // 4. Crear el auth.user si no existe (idempotente). El trigger
  //    handle_new_auth_user espeja la fila en public.users con role='cliente'.
  const { data: lookup } = await admin.from('users').select('id').eq('email', email).maybeSingle()
  let userCreated = false
  if (!lookup?.id) {
    const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true })
    if (createErr && !/already registered|exists/i.test(createErr.message)) {
      return respond({ error: `No se pudo crear el usuario: ${createErr.message}` }, 500)
    }
    userCreated = !createErr
  }

  // 5. Vincular con el rol vía RPC (bajo el JWT del dueño → user_owns_store OK).
  //    El RPC revalida: dueño, rol∈{seller,advertiser}, no-admin, no pisa owner.
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

  // 6. Despachar el magic link por el canal elegido (igual que send-magic-link).
  if (channel === 'email') {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
    const { error: otpErr } = await anon.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
    })
    if (otpErr) return respond({ error: `signInWithOtp: ${otpErr.message}`, user_created: userCreated }, 500)
    return respond({ ok: true, channel: 'email', email, store_role: storeRole })
  }

  // channel === 'whatsapp'
  const { data: linkData, error: genErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email, options: { redirectTo },
  })
  if (genErr || !linkData?.properties?.action_link) {
    return respond({ error: `generateLink: ${genErr?.message ?? 'sin action_link'}` }, 500)
  }
  const actionLink = linkData.properties.action_link
  if (!GREEN_API_ID_INSTANCE || !GREEN_API_TOKEN_INSTANCE) {
    return respond({ error: 'Green API no configurado (faltan credenciales)', action_link: actionLink }, 500)
  }
  // Envolver en /abrir para que el prefetch de WhatsApp no consuma el link single-use.
  const safeLink = appOrigin ? `${appOrigin}/abrir?next=${encodeURIComponent(actionLink)}` : actionLink
  const chatId = toChatId(phoneRaw)
  const roleLabel = storeRole === 'seller' ? 'vendedor' : 'publicista'
  const message =
    `Te invitaron como ${roleLabel} en una tienda de Mall Hub.\n` +
    `Abre este enlace en tu teléfono para activar tu cuenta y definir tu contraseña ` +
    `(expira en 1 hora):\n${safeLink}\n\n` +
    `Si no esperabas esto, ignora este mensaje.`

  const waUrl = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN_INSTANCE}`
  const waRes = await fetch(waUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message }),
  })
  const waJson: any = await waRes.json().catch(() => ({}))
  if (!waRes.ok || !waJson?.idMessage) {
    return respond({ error: `Green API ${waRes.status}: ${waJson?.message ?? 'envío fallido o número inválido'}`, action_link: actionLink }, 502)
  }
  return respond({ ok: true, channel: 'whatsapp', chatId, email, store_role: storeRole })
}

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
