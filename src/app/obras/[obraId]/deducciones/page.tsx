/**
 * `/obras/[obraId]/deducciones` — la bandeja de deducciones, mudada.
 *
 * Desde §5.8 lo que el motor propone y lo que el sistema ya aplicó viven en la
 * solapa **«Para revisar»** de la bandeja, al lado de «Preguntas»: eran dos
 * pantallas separadas que preguntaban lo mismo —«¿esto está bien?»— con dos
 * navegaciones distintas, y la separación se notaba justo cuando importaba, al
 * decidir si un rubro estaba listo.
 *
 * La ruta se queda como redirección y no se borra: está linkeada desde el
 * tablero, desde la planilla y desde cualquier URL que alguien haya guardado. El
 * deep-link por regla (`?regla=cruce`) se conserva — la solapa lo entiende
 * igual, así que un link viejo sigue abriendo exactamente lo que abría.
 *
 * Un `page.tsx` solo exporta el componente por defecto y las opciones de
 * segmento (CLAUDE.md §9): por eso `esRegla` se importa de `../bandeja/revisar`
 * en vez de vivir acá.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { esRegla } from '../bandeja/revisar';

export const metadata: Metadata = { title: 'Para revisar' };

export default async function DeduccionesPage({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ obraId }, query] = await Promise.all([params, searchParams]);

  // La obra no se valida acá: no se lee nada de ella. El guard corre en la
  // pantalla de destino, que es la que consulta la base (RNF-4).
  const crudo = query.regla;
  const pedida = Array.isArray(crudo) ? (crudo[0] ?? null) : (crudo ?? null);
  const destino = `/obras/${encodeURIComponent(obraId)}/bandeja?solapa=revisar`;

  redirect(esRegla(pedida) ? `${destino}&regla=${pedida}` : destino);
}
