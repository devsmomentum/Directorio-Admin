import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DOMParser,
  type Element,
} from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Configuration ───────────────────────────────────────────────────────────

const BCV_URL = "https://www.bcv.org.ve/";

// Proxies CORS para el scraping directo a bcv.org.ve. Son inestables (rate
// limits, 400/403, downtime). Sólo se usan como último recurso si las APIs
// REST que ya re-publican la tasa BCV están todas caídas.
const PROXIES = [
  { name: "corsproxy.io",  base: "https://corsproxy.io/?",                 encode: false },
  { name: "allorigins",    base: "https://api.allorigins.win/raw?url=",    encode: true  },
  { name: "thingproxy",    base: "https://thingproxy.freeboard.io/fetch/", encode: false },
  { name: "codetabs",      base: "https://api.codetabs.com/v1/proxy?quest=", encode: true },
];

const MAX_GLOBAL_RETRIES = 2;
const FETCH_TIMEOUT_MS   = 12_000;
const MIN_VALID_RATE     = 1.0;
const MAX_VALID_RATE     = 1000.0;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch con timeout abortable individual. */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/html;q=0.9, */*;q=0.5",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(id);
  }
}

function validateRate(rate: number): void {
  if (!Number.isFinite(rate)) throw new Error(`Rate is not finite: ${rate}`);
  if (rate <= 0) throw new Error(`Rate must be positive, got: ${rate}`);
  if (rate < MIN_VALID_RATE || rate > MAX_VALID_RATE) {
    throw new Error(`Rate ${rate} is outside valid range [${MIN_VALID_RATE}, ${MAX_VALID_RATE}]`);
  }
}

// ─── Fuentes de tasa BCV ─────────────────────────────────────────────────────
//
// Cada fuente devuelve { rate, sourceName } o lanza. Las APIs JSON son mucho
// más estables que el scraping directo a bcv.org.ve, así que van primero.

type RateResult = { rate: number; sourceName: string };

async function fetchFromDolarApi(): Promise<RateResult> {
  // https://ve.dolarapi.com/v1/dolares/oficial → { promedio: number, ... }
  const res = await fetchWithTimeout("https://ve.dolarapi.com/v1/dolares/oficial");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const rate = Number(json?.promedio ?? json?.venta ?? json?.compra);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`dolarapi sin tasa válida (got ${JSON.stringify(json).slice(0, 200)})`);
  return { rate, sourceName: "ve.dolarapi.com" };
}

async function fetchFromPyDolar(): Promise<RateResult> {
  // https://pydolarvenezuela-api.vercel.app/api/v1/dollar?page=bcv
  // → { monitors: { usd: { price: number, ... } } }
  const res = await fetchWithTimeout("https://pydolarvenezuela-api.vercel.app/api/v1/dollar?page=bcv");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const rate = Number(json?.monitors?.usd?.price);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`pydolar sin tasa válida (got ${JSON.stringify(json).slice(0, 200)})`);
  return { rate, sourceName: "pydolarvenezuela" };
}

async function fetchFromExchangeRateHost(): Promise<RateResult> {
  // https://api.exchangerate.host/latest?base=USD&symbols=VES — tasa pública
  // del mercado. NO es la oficial del BCV, pero sirve como sanity-check si
  // todas las APIs venezolanas caen. Se acepta sólo como TERCIARIA con un
  // warning, idealmente nunca debería ganar.
  const res = await fetchWithTimeout("https://api.exchangerate.host/latest?base=USD&symbols=VES");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const rate = Number(json?.rates?.VES);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`exchangerate.host sin tasa válida`);
  return { rate, sourceName: "exchangerate.host (no oficial)" };
}

// ─── Fallback: scraping directo a bcv.org.ve vía proxies CORS ────────────────

async function fetchBcvHtmlWithFallback(): Promise<string> {
  let lastError: Error | null = null;
  for (const proxy of PROXIES) {
    try {
      const targetUrl = proxy.encode
        ? `${proxy.base}${encodeURIComponent(BCV_URL)}`
        : `${proxy.base}${BCV_URL}`;
      console.log(`[update-rate] Trying Proxy: ${proxy.name}...`);

      const response = await fetchWithTimeout(targetUrl, {}, FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const text = await response.text();
      if (!text || text.length < 500) throw new Error("Response too short (likely proxy error page)");
      if (!text.includes("Banco Central") && !text.includes("Dólar") && !text.includes("dolar")) {
        throw new Error("Content does not look like BCV page");
      }

      console.log(`[update-rate] ✅ Proxy Success: ${proxy.name}`);
      return text;
    } catch (error) {
      console.warn(`[update-rate] ⚠️ Proxy Failed (${proxy.name}): ${(error as Error).message}`);
      lastError = error as Error;
    }
  }
  throw new Error(`All proxies failed. Last error: ${lastError?.message}`);
}

function parseUsdRate(html: string): number {
  const document = new DOMParser().parseFromString(html, "text/html");
  if (!document) throw new Error("Failed to parse HTML document");

  const dolarElement = document.querySelector("#dolar") as Element | null;
  if (dolarElement) {
    const rate = extractRateFromText(dolarElement.textContent);
    if (rate) return rate;
  }

  const strongTags = document.querySelectorAll("strong");
  for (const node of strongTags) {
    const strong = node as Element;
    const text = strong.textContent || "";
    if (text.includes("USD") || text.includes("Dólar") || text.includes("Bs")) {
      let rate = extractRateFromText(text);
      if (rate) return rate;
      if (strong.parentElement) {
        rate = extractRateFromText(strong.parentElement.textContent);
        if (rate) return rate;
      }
    }
  }

  const bodyText = document.body?.textContent || "";
  const usdIndex = bodyText.indexOf("USD");
  if (usdIndex !== -1) {
    const snippet = bodyText.substring(usdIndex, usdIndex + 50);
    const rate = extractRateFromText(snippet);
    if (rate) return rate;
  }

  throw new Error("Could not find USD exchange rate in BCV page DOM.");
}

function extractRateFromText(text: string | null): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[^\d,.]/g, " ").trim();
  const tokens = cleaned.split(/\s+/);
  for (const token of tokens) {
    if (token.length > 3 && (token.includes(",") || token.includes("."))) {
      let numStr = token;
      if (numStr.includes(",") && numStr.includes(".")) {
        if (numStr.lastIndexOf(",") > numStr.lastIndexOf(".")) {
          numStr = numStr.replace(/\./g, "").replace(",", ".");
        } else {
          numStr = numStr.replace(/,/g, "");
        }
      } else if (numStr.includes(",")) {
        numStr = numStr.replace(",", ".");
      }
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 0 && val < 10000) return val;
    }
  }
  return null;
}

async function fetchFromBcvScraping(): Promise<RateResult> {
  const html = await fetchBcvHtmlWithFallback();
  const rate = parseUsdRate(html);
  return { rate, sourceName: "bcv_scraper" };
}

// ─── Orquestador ─────────────────────────────────────────────────────────────

const SOURCES: { name: string; fetch: () => Promise<RateResult> }[] = [
  { name: "dolarapi",         fetch: fetchFromDolarApi },
  { name: "pydolar",          fetch: fetchFromPyDolar },
  { name: "bcv_scraping",     fetch: fetchFromBcvScraping },
  { name: "exchangerate_host", fetch: fetchFromExchangeRateHost },
];

async function getBcvRate(): Promise<RateResult> {
  const errors: string[] = [];
  for (const src of SOURCES) {
    try {
      console.log(`[update-rate] Trying source: ${src.name}…`);
      const result = await src.fetch();
      validateRate(result.rate);
      console.log(`[update-rate] ✅ ${src.name} → ${result.rate}`);
      return result;
    } catch (error) {
      const msg = (error as Error).message;
      console.warn(`[update-rate] ⚠️ ${src.name} failed: ${msg}`);
      errors.push(`${src.name}: ${msg}`);
    }
  }
  throw new Error(`All sources failed → ${errors.join(" | ")}`);
}

// ─── Main Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const startTime = Date.now();
  let lastError: Error | null = null;
  let lastSource: string | null = null;
  let newRate: number | null = null;

  for (let attempt = 1; attempt <= MAX_GLOBAL_RETRIES; attempt++) {
    try {
      console.log(`[update-rate] Global Attempt ${attempt}/${MAX_GLOBAL_RETRIES}…`);
      const result = await getBcvRate();
      newRate = result.rate;
      lastSource = result.sourceName;
      break;
    } catch (error) {
      lastError = error as Error;
      console.error(`[update-rate] Attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < MAX_GLOBAL_RETRIES) await sleep(2000);
    }
  }

  if (newRate == null) {
    const elapsed = Date.now() - startTime;
    const errorMsg = lastError?.message ?? "Unknown error";
    await supabaseAdmin.from("exchange_rate_history").insert({
      rate: null,
      previous_rate: null,
      source: "bcv_error",
      error_message: errorMsg,
      scraped_at: new Date().toISOString(),
    });
    return new Response(
      JSON.stringify({ success: false, error: errorMsg, elapsed_ms: elapsed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 502 },
    );
  }

  // Persistencia
  const { data: currentConfig } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", "bcv_exchange_rate")
    .maybeSingle();
  const oldRate = currentConfig ? parseFloat(currentConfig.value) : null;

  const { error: updateError } = await supabaseAdmin
    .from("app_config")
    .update({
      value: newRate,
      updated_at: new Date().toISOString(),
      updated_by: null,
    })
    .eq("key", "bcv_exchange_rate");

  if (updateError) {
    return new Response(
      JSON.stringify({ success: false, error: `DB update failed: ${updateError.message}` }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }

  await supabaseAdmin.from("exchange_rate_history").insert({
    rate: newRate,
    previous_rate: oldRate,
    source: lastSource ?? "unknown",
    scraped_at: new Date().toISOString(),
  });

  const elapsed = Date.now() - startTime;
  return new Response(
    JSON.stringify({
      success: true,
      old_rate: oldRate,
      new_rate: newRate,
      source: lastSource,
      elapsed_ms: elapsed,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
