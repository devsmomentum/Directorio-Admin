'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'millennium.theme';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

function applyTheme(t: Theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', t);
  root.classList.toggle('dark', t === 'dark');
  try { localStorage.setItem(STORAGE_KEY, t); } catch {}
}

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };

  // Aria-label dinámico, evita mismatch SSR pintando un placeholder neutro.
  const label = mounted
    ? theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'
    : 'Cambiar tema';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted transition-colors hover:text-fg hover:border-line-strong ${className}`}
    >
      {/* Sol (visible en dark — significa "cambiar a claro") */}
      <svg
        className={`absolute h-4 w-4 transition-all duration-300 ${mounted && theme === 'dark' ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0'}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="4" />
        <path strokeLinecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      {/* Luna (visible en light) */}
      <svg
        className={`absolute h-4 w-4 transition-all duration-300 ${mounted && theme === 'light' ? 'rotate-0 scale-100 opacity-100' : 'rotate-90 scale-50 opacity-0'}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
