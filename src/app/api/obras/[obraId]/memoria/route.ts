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
 * ## Qué entra al documento
 *
 * - **Láminas**: todas, en orden de página. Una lámina bloqueada o con error
 *   también es documentación analizada, y su estado es justamente lo que hay
 *   que ver.
 * - **Deducciones**: todas, con su estado. Una propuesta sin decidir es parte
 *   de lo que el sistema entendió, aunque todavía no haya escrito nada.
 * - **Hallazgos**: solo los `abierto`. Uno respondido ya no es lo que falta.
 *
 * Este archivo solo exporta `GET` y `dynamic` (CLAUDE.md §9). El armado de la
 * `EntradaMemoria` queda privado acá adentro por la misma regla.
 */
import { and, asc, eq } from 'drizzle-orm';

import { datosObra, deducciones, entidades, hallazgos, laminas } from '@/db/schema';
import { fechaIso, slugObra } from '@/lib/export/xlsx';
import type { EntradaMemoria } from '@/lib/memoria/compacta';
import { renderMemoriaMd } from '@/lib/memoria/render';
import { requireObraApi, responder } from '@/lib/pipeline/http';
import { comoEntidadPersistida } from '@/lib/pipeline/recomputar';

/** Lee la base y depende de la cookie de sesión: nunca se prerenderiza. */
export const dynamic = 'force-dynamic';

const MIME_MARKDOWN = 'text/markdown; charset=utf-8';

type Params = { params: Promise<{ obraId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { obraId } = await params;
    const { db, obra } = await requireObraApi(obraId);

    const [planos, elementos, datos, relaciones, huecos] = await Promise.all([
      db
        .select({
          id: laminas.id,
          codigo: laminas.codigo,
          titulo: laminas.titulo,
          tipo: laminas.tipo,
          escala: laminas.escala,
          escalaConfiable: laminas.escalaConfiable,
          estadoAnalisis: laminas.estadoAnalisis,
        })
        .from(laminas)
        .where(eq(laminas.obraId, obra.id))
        .orderBy(asc(laminas.numeroPagina), asc(laminas.id)),
      db
        .select()
        .from(entidades)
        .where(eq(entidades.obraId, obra.id))
        .orderBy(asc(entidades.createdAt), asc(entidades.id)),
      db
        .select()
        .from(datosObra)
        .where(eq(datosObra.obraId, obra.id))
        .orderBy(asc(datosObra.clave)),
      db
        .select({
          deduccion: deducciones,
          // `left join`: una deducción cuya entidad ya no está se sigue contando.
          entidad: { nombre: entidades.nombre, laminaId: entidades.laminaId },
        })
        .from(deducciones)
        .leftJoin(entidades, eq(deducciones.entidadId, entidades.id))
        .where(eq(deducciones.obraId, obra.id))
        .orderBy(asc(deducciones.createdAt), asc(deducciones.id)),
      db
        .select({
          clave: hallazgos.clave,
          tipo: hallazgos.tipo,
          descripcion: hallazgos.descripcion,
          bloqueante: hallazgos.bloqueante,
        })
        .from(hallazgos)
        .where(and(eq(hallazgos.obraId, obra.id), eq(hallazgos.estado, 'abierto')))
        .orderBy(asc(hallazgos.createdAt), asc(hallazgos.id)),
    ]);

    // Cómo se cita una lámina en el documento: por código, y por id si el
    // rótulo no dejó ninguno (`refDeLamina` hace lo mismo del otro lado).
    const codigos = new Map(planos.map((plano) => [plano.id, plano.codigo ?? plano.id]));

    const entrada: EntradaMemoria = {
      obra: { nombre: obra.nombre, tipo: obra.tipo },
      laminas: planos,
      entidades: elementos.map(comoEntidadPersistida),
      datosObra: datos.map((dato) => ({
        clave: dato.clave,
        valor: dato.valorJson.valor,
        ...(dato.valorJson.unidad === undefined ? {} : { unidad: dato.valorJson.unidad }),
        origen: dato.origen,
        fuentes: dato.fuentesJson,
        confianza: dato.confianza,
        ...(dato.metodo === null ? {} : { metodo: dato.metodo }),
      })),
      deducciones: relaciones.map(({ deduccion, entidad }) => ({
        campo: deduccion.campo,
        regla: deduccion.regla,
        confianza: deduccion.confianza,
        estado: deduccion.estado,
        entidadNombre: entidad?.nombre ?? deduccion.entidadId,
        // La lámina donde se leyó el dato, no la de la entidad: es la que hay
        // que abrir para verificarlo.
        laminaCodigo: laminaDeLaDeduccion(deduccion.fuentesJson, entidad?.laminaId, codigos),
      })),
      hallazgosAbiertos: huecos,
    };

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

function laminaDeLaDeduccion(
  fuentes: readonly { laminaId: string }[],
  laminaDeLaEntidad: string | undefined,
  codigos: ReadonlyMap<string, string>,
): string {
  const laminaId = fuentes[0]?.laminaId ?? laminaDeLaEntidad;
  if (laminaId === undefined) return '—';
  return codigos.get(laminaId) ?? laminaId;
}
