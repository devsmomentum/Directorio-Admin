'use client';

import { PageSpinner, Spinner } from '@/app/components/PageSpinner';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// Página principal: Redirecciona al login (si no hay sesión) o al dashboard
// correspondiente (según su rol) si ya está autenticado.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      
      const { data: u } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();
      
      router.replace(u?.role === 'admin' ? '/panel' : '/cliente/dashboard');
    })();
  }, [router]);

  return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center">
      <PageSpinner />
    </div>
  );
}
