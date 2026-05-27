import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";

  // Guard: solo aceptamos llamadas con Service Role (cron / admin). El edge
  // queda detrás de gateway pero esto evita disparos accidentales por anon.
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== serviceRoleKey) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 },
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

  const startTime = Date.now();
  const { data, error } = await supabaseAdmin.rpc("deactivate_expired_flash_coupons");

  if (error) {
    console.error(`[deactivate-expired-coupons] RPC failed: ${error.message}`);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }

  const elapsed = Date.now() - startTime;
  const deactivated = typeof data === "number" ? data : Number(data ?? 0);

  console.log(`[deactivate-expired-coupons] ok deactivated=${deactivated} elapsed_ms=${elapsed}`);
  return new Response(
    JSON.stringify({ success: true, deactivated, elapsed_ms: elapsed }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
