/**
 * `GET /api/obras/[obraId]/memoria` — baja la **memoria de obra** (§27) como
 * markdown.
 *
 * Es el documento que cuenta el expediente entero: qué documentación se
 * analizó, qué hechos valen para toda la obra, qué elementos se leyeron y en
 * qué lámina, qué relaciones los sostienen, qué se contradice, qué falta y qué
 * números salieron de medir el dibujo en vez de una cota. La memoria de
 * deducciones (RF-505, `/deducciones/memoria`) sigue existiendo y es más
 * angosta: cuenta quién validó qué y cuándo.
 *
 * El middleware NO cubre `/api/*` (ver el `matcher` en `src/middleware.ts`): el
 * handler valida por su cuenta con `requireObraApi`, la misma regla de
 * aislamiento (RNF-4) que usan las páginas, traducida a 401 y 404 en JSON.
 *
 * **Qué entra al documento lo decide `armarEntradaMemoria`**, que es el único
 * armador del estado de la obra: la misma entrada la usa la fase de cruce del
 * pipeline para el texto que lee el modelo. Dos lecturas distintas de la misma
 * cosa terminan siempre igual — el día que discrepan, nadie sabe cuál miente.
 *
 * Este archivo solo exporta `GET` y `dynamic` (CLAUDE.md §9).
 */
import { fechaIso, slugObra } from '@/lib/export/xlsx';
import { armarEntradaMemoria } from '@/lib/memoria/armar';
import { renderMemoriaMd } from '@/lib/memoria/render';
import { requireObraApi, responder } from '@/lib/pipeline/http';

/** Lee la base y depende de la cookie de sesión: nunca se prerenderiza. */
export const dynamic = 'force-dynamic';

const MIME_MARKDOWN = 'text/markdown; charset=utf-8';

type Params = { params: Promise<{ obraId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { obraId } = await params;
    const { db, obra } = await requireObraApi(obraId);

    const entrada = await armarEntradaMemoria(db, obra);
    const archivo = `memoria-de-obra-${slugObra(obra.nombre) || 'obra'}-${fechaIso(new Date())}.md`;

    return new Response(renderMemoriaMd(entrada), {
      headers: {
        'content-type': MIME_MARKDOWN,
        'content-disposition': `attachment; filename="${archivo}"`,
        // Cada recompute reescribe la obra: que no quede un documento cacheado.
        'cache-control': 'no-store',
      },
    });
  });
}
