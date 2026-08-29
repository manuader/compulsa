/**
 * De la base a la `EntradaMemoria`: el único armador del estado de la obra.
 *
 * Las dos memorias —la compacta que lee el cruce y el `.md` que baja el
 * arquitecto— salen de la misma `EntradaMemoria` (ver `compacta.ts`), y esto es
 * lo que la llena. Vivía adentro del route handler de `/memoria`, que era el
 * único que la necesitaba; con la fase de cruce apareció el segundo consumidor,
 * y dos lecturas distintas de la misma cosa terminan siempre igual: el día que
 * discrepan, nadie sabe cuál de las dos miente.
 *
 * ## Qué entra
 *
 * - **Láminas**: todas, en orden de página. Una lámina bloqueada o con error
 *   también es documentación analizada, y su estado es justamente lo que hay
 *   que ver.
 * - **Entidades**: todas las de la obra, en orden de creación.
 * - **Datos de obra**: los hechos que valen para toda la obra, por clave.
 * - **Deducciones**: todas, con su estado. Una propuesta sin decidir es parte
 *   de lo que el sistema entendió, aunque todavía no haya escrito nada. (La
 *   memoria compacta se queda solo con las validadas; esa decisión es suya.)
 * - **Hallazgos**: solo los `abierto`. Uno respondido ya no es lo que falta.
 *
 * El orden de cada lista es estable y explícito: la memoria compacta viaja a un
 * prompt, y dos corridas idénticas tienen que producir el mismo texto.
 */
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { datosObra, deducciones, entidades, hallazgos, laminas } from '@/db/schema';
import type { EntradaMemoria } from '@/lib/memoria/compacta';
import { comoEntidadPersistida } from '@/lib/pipeline/recomputar';
import type { TipoObra } from '@/types/domain';

/** Lo mínimo que hay que saber de la obra: el resto sale de sus tablas. */
export interface ObraDeMemoria {
  id: string;
  nombre: string;
  tipo: TipoObra;
}

export async function armarEntradaMemoria(
  db: Db,
  obra: ObraDeMemoria,
): Promise<EntradaMemoria> {
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

  // Cómo se cita una lámina en el documento: por código, y por id si el rótulo
  // no dejó ninguno (`refDeLamina` hace lo mismo del otro lado).
  const codigos = new Map(planos.map((plano) => [plano.id, plano.codigo ?? plano.id]));

  return {
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
      // La lámina donde se leyó el dato, no la de la entidad: es la que hay que
      // abrir para verificarlo.
      laminaCodigo: laminaDeLaDeduccion(deduccion.fuentesJson, entidad?.laminaId, codigos),
    })),
    hallazgosAbiertos: huecos,
  };
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
