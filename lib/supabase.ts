import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // detectSessionInUrl=false: NUESTRO callback (/auth/callback) procesa el
    // code/tokens explícitamente. Si lo dejamos en true, el SDK consume el
    // token al cargar cualquier página, y cuando el callback intenta procesarlo
    // Supabase responde "already used / expired" — exactamente el síntoma
    // reportado de "el magic link expiró".
    detectSessionInUrl: false,
  },
  global: {
    // Desactivar la caché agresiva de Next.js para evitar que guarde
    // respuestas anónimas (arreglos vacíos) antes de que la sesión se inicialice
    fetch: (url, options) => fetch(url, { ...options, cache: 'no-store' })
  }
});