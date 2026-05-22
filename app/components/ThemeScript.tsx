// Server component: inyecta un <script> bloqueante en el <head> que aplica
// el tema antes de la hidratación. Evita el "flash" de tema incorrecto.
// Lee localStorage ("millennium.theme") o, si no hay, prefers-color-scheme.
export function ThemeScript() {
  const code = `(function(){try{var k='millennium.theme';var s=localStorage.getItem(k);var t=s||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
