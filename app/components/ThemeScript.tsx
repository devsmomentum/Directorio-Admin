// Server component: inyecta un <script> bloqueante en el <head> que aplica
// el tema antes de la hidratación. Evita el "flash" de tema incorrecto.
// Lee localStorage ("millennium.theme"). Por defecto Morna oscuro: si no hay
// preferencia guardada, abrimos en dark (la firma de la marca), no seguimos
// prefers-color-scheme.
export function ThemeScript() {
  const code = `(function(){try{var k='millennium.theme';var s=localStorage.getItem(k);var t=(s==='light'||s==='dark')?s:'dark';document.documentElement.setAttribute('data-theme',t);if(t==='dark')document.documentElement.classList.add('dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');document.documentElement.classList.add('dark');}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
