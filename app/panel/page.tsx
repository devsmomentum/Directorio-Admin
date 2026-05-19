import { redirect } from 'next/navigation';

// /panel no es una página: es la raíz del shell admin. Redirigimos a /panel/inicio
// (la home del panel) para que cualquier link a /panel siga funcionando.
export default function PanelIndex() {
  redirect('/panel/inicio');
}
