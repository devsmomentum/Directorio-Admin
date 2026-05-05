import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  global: {
    // Desactivar la caché agresiva de Next.js para evitar que guarde
    // respuestas anónimas (arreglos vacíos) antes de que la sesión se inicialice
    fetch: (url, options) => fetch(url, { ...options, cache: 'no-store' })
  }
});