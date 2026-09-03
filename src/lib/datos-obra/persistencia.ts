/**
 * El núcleo que deshace un **dato de obra que escribió el sistema** (§5.2, §5.4).
 *
 * ## Por qué existe
 *
 * El cruce del expediente escribe hechos que valen para **toda la obra**: la
 * altura de local que el corte acota una vez, el nivel de un piso. Las
 * plantillas se sirven de ellos por la cadena de respaldo, así que un solo dato
 * mal leído —2,06 donde el corte dice 2,60— corre los m² de seco, pintura,
 * gruesa y demolición de ese nivel entero, con el badge `deducido` puesto y sin
 * un botón que lo deshaga. Una **deducción** auto-validada, que toca UN
 * elemento, se rechazaba con un click desde la primera versión de la solapa.
 * El radio de daño estaba invertido: lo que más rompía era lo único que no se
 * podía revertir.
 *
 * ## Por qué esto NO vive en el archivo `'use server'`
 *
 * Mismo motivo que `src/lib/deduccion/persistencia.ts`: en un `'use server'`
 * **todo export es un endpoint HTTP** invocable con el payload que se le
 * antoje al cliente. Esta función borra una fila y recalcula la obra, y recibe
 * la obra y el actor como parámetros; expuesta como endpoint, cualquiera
 * borraría datos de una obra ajena firmando con el rol que quisiera. Acá vive
 * el núcleo —obra y actor explícitos, testeable contra una base en memoria— y
 * en `src/app/obras/[obraId]/bandeja/actions.ts` vive el envoltorio `*Action`,
 * que saca el actor de la sesión y la obra de `requireObra()`.
 *
 * ## Las cuatro reglas
 *
 * 1. **Solo lo que escribió el sistema.** `definido_por IS NULL` es la línea:
 *    un dato que cargó una persona respondiendo la consulta no se "rechaza",
 *    se corrige contestando de nuevo. Es la misma línea que el cruce no cruza
 *    al escribir (`aplicarDatosDeObra`).
 * 2. **Rechazar es borrar la fila, no marcarla.** `datos_obra` no tiene estado:
 *    la clave es única por obra y el recompute lee lo que hay. Sin la fila, la
 *    cadena de respaldo vuelve a no encontrar el hecho y `sincronizarHallazgos`
 *    reabre **la misma** consulta agrupada (`dato_obra.<clave>`) para todas las
 *    entidades que lo esperaban. Esa consulta contestada escribe la fila con
 *    `definido_por` seteado, y ahí el cruce ya no la pisa: el circuito cierra.
 *    Mientras eso no pase, **un análisis nuevo puede volver a leerlo**, y está
 *    bien que así sea: el rechazo dice "esto está mal", no "no lo mires más".
 * 3. **Aislamiento (RNF-4):** la fila se busca siempre con `obra_id` en el
 *    `where`. Un dato de otra obra no existe, y da el mismo error que uno
 *    inventado: no se filtra existencia.
 * 4. **Rol y auditoría.** Es de `colaborador` para arriba (RF-1201) y deja su
 *    fila en `auditoria` con el valor que se fue, para que el rastro sirva.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { datosObra } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import {
  RolInsuficienteError,
  requireRolCore,
  type ActorDeduccion,
  type ResultadoAccion,
} from '@/lib/deduccion/persistencia';
import { recomputarObra } from '@/lib/pipeline/recomputar';

/** La acción con la que queda registrado en la auditoría del estudio. */
export const ACCION_DATO_RECHAZADO = 'dato_obra_rechazado';

const zUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Identificador inválido.');

const zEntrada = z.object({ obraId: zUuid, datoId: zUuid });

export interface EntradaDatoObra {
  obraId: string;
  datoId: string;
}

/** Uno solo para "no está" y "no es tuyo": la existencia no se filtra. */
export const NO_ENCONTRADO = 'No encontré ese dato de obra en esta obra.';

/**
 * Un dato que cargó una persona no se deshace por acá: se vuelve a contestar la
 * consulta con el número correcto, que es lo que la bandeja ya sabe hacer.
 */
export const ES_TUYO =
  'Ese dato lo cargó alguien del estudio, no el sistema. Para cambiarlo, respondé de nuevo la consulta en «Preguntas».';

/**
 * Saca de la obra un dato que escribió el sistema y recalcula.
 *
 * Devuelve `{ ok: false }` con un mensaje para mostrar, nunca lanza por un
 * problema de datos: lo llama una pantalla.
 */
export async function rechazarDatoDeObra(
  entrada: EntradaDatoObra,
  actor: ActorDeduccion,
): Promise<ResultadoAccion> {
  const parseo = zEntrada.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? 'No pude leer el dato de obra.' };
  }

  try {
    requireRolCore(actor.rol, 'colaborador');
  } catch (error) {
    if (error instanceof RolInsuficienteError) return { ok: false, error: error.message };
    throw error;
  }

  const db = await getDb();
  const [dato] = await db
    .select()
    .from(datosObra)
    .where(and(eq(datosObra.id, parseo.data.datoId), eq(datosObra.obraId, parseo.data.obraId)));

  if (!dato) return { ok: false, error: NO_ENCONTRADO };
  if (dato.definidoPor !== null) return { ok: false, error: ES_TUYO };

  await db.delete(datosObra).where(eq(datosObra.id, dato.id));

  await registrarAuditoria({
    obraId: dato.obraId,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: ACCION_DATO_RECHAZADO,
    targetRef: `datos_obra:${dato.clave}`,
    diff: {
      valor: { antes: dato.valorJson.valor, despues: null },
      origen: dato.origen,
      confianza: dato.confianza,
      fuentes: dato.fuentesJson.map((fuente) => fuente.laminaId),
    },
  });

  // El recompute es lo que reabre la consulta: sin él la obra queda computada
  // con un hecho que ya no está, y la pregunta no vuelve hasta la próxima
  // corrida por otro motivo.
  await recomputarObra(dato.obraId, { db });
  return { ok: true };
}
