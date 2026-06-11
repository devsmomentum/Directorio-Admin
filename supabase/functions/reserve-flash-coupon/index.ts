// Edge Function: reserve-flash-coupon
// ---------------------------------------------------------------------------
// FLUJO NUEVO (reserva web -> redención en tienda).
// La invoca la web pública /cupon/[couponId]. NO toca el stock: crea una
// reserva 'PENDIENTE' (vía RPC reserve_flash_coupon) y envía al USUARIO un
// correo con un QR de redención que codifica el redemption_token. El CLIENTE
// escanea ese QR en la tienda y, solo entonces, el RPC redeem_coupon baja el
// stock y marca la reserva como 'CANJEADO'.
//
// Variables de entorno (supabase secrets set):
//   RESEND_API_KEY, RESEND_FROM (mismas que send-contract-expiry-reminders)
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase en runtime.
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface ReserveRequest {
  coupon_id?: string;
  nombre?: string;
  cedula?: string;
  telefono?: string;
  email?: string;
}

interface ReserveRpcRow {
  lead_id: string;
  redemption_token: string;
  status: string;
  coupon_code: string | null;
  coupon_title: string;
  coupon_image_url: string | null;
  coupon_discount_percent: number;
  store_id: string;
  store_name: string | null;
  end_date: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// QR como imagen externa: los clientes de correo no ejecutan JS ni libs,
// así que un <img> a un generador es la vía robusta. Codifica el token de
// redención que el CLIENTE escaneará en la tienda.
function qrImageUrl(token: string): string {
  const data = encodeURIComponent(token);
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${data}`;
}

function buildEmail(input: {
  nombre: string;
  couponTitle: string;
  storeName: string | null;
  endDate: string | null;
  token: string;
}): { subject: string; html: string; text: string } {
  const expiry = input.endDate
    ? new Date(input.endDate).toLocaleString("es-VE", {
        dateStyle: "full",
        timeStyle: "short",
      })
    : "tiempo limitado";

  const safeName = escapeHtml(input.nombre);
  const safeTitle = escapeHtml(input.couponTitle);
  const safeStore = escapeHtml(input.storeName ?? "la tienda");
  const qr = qrImageUrl(input.token);

  const subject = `🎟️ Tu QR de canje: ${input.couponTitle}`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px;background:#fff;color:#111">
      <h1 style="color:#e53935;margin:0 0 8px">¡Hola ${safeName}!</h1>
      <p style="font-size:16px;line-height:1.5">
        Tu cupón <strong>${safeTitle}</strong> quedó <strong>reservado</strong>.
        Muestra este código QR en <strong>${safeStore}</strong> para canjearlo.
      </p>
      <div style="margin:24px 0;padding:20px;border:2px dashed #e53935;border-radius:12px;text-align:center">
        <img src="${qr}" alt="QR de redención" width="240" height="240"
             style="display:block;margin:0 auto 12px;width:240px;height:240px" />
        <div style="font-size:11px;letter-spacing:2px;color:#666">CÓDIGO DE CANJE</div>
        <div style="font-size:18px;font-weight:800;letter-spacing:2px;color:#e53935;margin-top:6px;word-break:break-all">
          ${escapeHtml(input.token)}
        </div>
      </div>
      <p style="font-size:14px;color:#444">
        ⏰ <strong>Vence:</strong> ${escapeHtml(expiry)}<br/>
        ⚠️ <strong>El stock es limitado.</strong> La reserva no garantiza el cupón:
        se canjea por orden de llegada mientras quede inventario. ¡Ve rápido a la tienda!
      </p>
      <p style="font-size:12px;color:#888;margin-top:32px">
        Si el QR no carga, dicta el CÓDIGO DE CANJE al personal de la tienda.
      </p>
    </div>
  `;

  const text = [
    `Hola ${input.nombre},`,
    ``,
    `Tu cupón "${input.couponTitle}" quedó reservado en ${input.storeName ?? "la tienda"}.`,
    ``,
    `Código de canje: ${input.token}`,
    `(Muestra el QR del correo o dicta este código en la tienda.)`,
    `Vence: ${expiry}`,
    ``,
    `El stock es limitado y se canjea por orden de llegada. ¡Ve rápido!`,
  ].join("\n");

  return { subject, html, text };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  let payload: ReserveRequest;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const couponId = payload.coupon_id?.trim() ?? "";
  const nombre = payload.nombre?.trim() ?? "";
  const cedula = payload.cedula?.trim() ?? "";
  const telefono = payload.telefono?.trim() ?? "";
  const email = payload.email?.trim().toLowerCase() ?? "";

  if (!couponId || !nombre || !cedula || !telefono || !email) {
    return jsonResponse(400, { error: "missing_fields" });
  }
  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: "invalid_email" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // 1) RPC: crea la reserva PENDIENTE (sin tocar stock) y devuelve el token.
  const { data, error } = await supabase.rpc("reserve_flash_coupon", {
    p_coupon_id: couponId,
    p_nombre: nombre,
    p_cedula: cedula,
    p_telefono: telefono,
    p_email: email,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("COUPON_UNAVAILABLE")) {
      return jsonResponse(409, { error: "coupon_unavailable" });
    }
    if (msg.includes("LEAD_DUPLICATE")) {
      return jsonResponse(409, { error: "lead_duplicate" });
    }
    console.error("[reserve-flash-coupon] RPC error:", error);
    return jsonResponse(500, { error: "rpc_failed" });
  }

  const row: ReserveRpcRow | undefined = Array.isArray(data) ? data[0] : data;
  if (!row) {
    console.error("[reserve-flash-coupon] RPC returned empty result");
    return jsonResponse(500, { error: "rpc_empty" });
  }

  // 2) Envío del QR vía Resend (misma infraestructura que el resto del
  //    proyecto). Si falla, NO revertimos la reserva: el lead ya quedó
  //    registrado y el negocio puede reenviar el correo.
  const { subject, html, text } = buildEmail({
    nombre,
    couponTitle: row.coupon_title,
    storeName: row.store_name,
    endDate: row.end_date,
    token: row.redemption_token,
  });

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const resendFrom =
    Deno.env.get("RESEND_FROM") ?? "Millennium Mall <noreply@morna.tech>";

  if (!resendApiKey) {
    console.error("[reserve-flash-coupon] RESEND_API_KEY missing");
    return jsonResponse(500, {
      error: "email_misconfigured",
      lead_id: row.lead_id,
    });
  }

  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: resendFrom, to: [email], subject, html, text }),
  });

  if (!sendRes.ok) {
    const errBody = await sendRes.text().catch(() => "");
    console.error(
      `[reserve-flash-coupon] Resend ${sendRes.status}: ${errBody || sendRes.statusText}`,
    );
    return jsonResponse(502, {
      error: "email_send_failed",
      lead_id: row.lead_id,
    });
  }

  // 3) Marca la reserva como notificada (best-effort).
  const { error: updateError } = await supabase
    .from("coupon_leads")
    .update({ email_sent_at: new Date().toISOString() })
    .eq("id", row.lead_id);
  if (updateError) {
    console.warn("[reserve-flash-coupon] no se pudo marcar email_sent_at:", updateError);
  }

  return jsonResponse(200, {
    ok: true,
    lead_id: row.lead_id,
    status: row.status,
  });
});
