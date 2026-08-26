/**
 * Configuración de la obra: los datos que se editan y la zona de riesgo.
 *
 * Server Component: acá se resuelve la pertenencia (RNF-4) y se lee la obra; la
 * parte interactiva —el formulario y los diálogos de confirmación— vive en
 * `ui.tsx`.
 */
import type { Metadata } from 'next';

import { requireObra } from '@/lib/auth/guards';

import { ConfiguracionObra } from './ui';

// El layout de la obra pone el template: queda «Configuración · Casa Belgrano ·
// Compulsa».
export const metadata: Metadata = { title: 'Configuración' };

export default async function ConfigPage({ params }: { params: Promise<{ obraId: string }> }) {
  const { obraId } = await params;
  // El layout ya lo hizo, pero la página no puede depender de eso: nunca se
  // consulta una obra por id sin pasar por `requireObra` (src/app/CLAUDE.md §3).
  const obra = await requireObra(obraId);

  return (
    <ConfiguracionObra
      obra={{
        id: obra.id,
        nombre: obra.nombre,
        zona: obra.zona,
        tipo: obra.tipo,
        moneda: obra.moneda,
        estado: obra.estado,
      }}
    />
  );
}
