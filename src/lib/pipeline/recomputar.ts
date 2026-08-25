/**
 * Recompute de una obra: de las entidades guardadas al cómputo y a la bandeja.
 *
 * `computarObra()` es puro y no sabe de la base; acá está la otra mitad, que es
 * la delicada: **sincronizar** su salida con lo que ya está escrito, sin pisar
 * el trabajo del arquitecto y sin reabrir lo que él ya cerró.
 *
 * Tres reglas gobiernan todo el archivo:
 *
 *  1. **La clave manda.** `computo_items.clave_item` y `hallazgos.clave` son
 *     estables por obra: sincronizar es un upsert por clave, nunca un
 *     "borrar todo y volver a insertar" (eso rompería ids, links y auditoría).
 *  2. **Lo humano es intocable.** Un ítem con `editado_por` seteado es del
 *     arquitecto: no se actualiza, no se anula, y su clave tampoco se duplica
 *     con una versión de agente.
 *  3. **Nada se borra.** El ítem que ya no se emite pasa a `anulado`; el
 *     hallazgo abierto que ya no aplica pasa a `descartado` con respuesta
 *     automática. Los `respondido`/`descartado` no se reabren jamás.
 *
 * Toda mutación se audita con actor `agente` (CLAUDE.md §4) — incluida la
 * desvinculación de un ítem cuya entidad desapareció, que es la única que toca
 * una fila del arquitecto.
 *
 * ## Sin transacción, y qué queda expuesto por eso
 *
 * `recomputarObra` **no** envuelve sus escrituras en `db.transaction()`:
 * `registrarAuditoria()` resuelve su handle con `getDb()` y no con el `db` que
 * se le pasa, así que las auditorías escribirían desde afuera de la transacción
 * y sobre PGlite —una sola conexión— eso se traba. Es un trade-off deliberado,
 * no un olvido.
 *
 * **Riesgo residual (leer antes de construir sobre `computo_items` o
 * `hallazgos`):** si el proceso muere en el medio, la sincronización queda a
 * mitad de camino — ítems actualizados y hallazgos no, o parte de los ítems
 * anulados y parte no. Nada rompe la integridad referencial, pero el cómputo
 * puede no ser el que corresponde a las entidades guardadas hasta el próximo
 * recompute exitoso. Tres consecuencias para quien lee estas tablas:
 *
 *  - `recomputarObra` es idempotente y barata: **volver a correrla es la
 *    reparación**, y `procesarLamina` la corre después de cada lámina.
 *  - Un fallo del recompute no invalida el análisis de la lámina: queda
 *    `analizada` con su `error_detalle` y una auditoría `recomputo_fallido`
 *    (ver `procesarLamina`), que es la señal de "esta obra quedó a medio
 *    sincronizar".
 *  - Una fila de `computo_items` con `entidad_id` en `null` no es un bug: puede
 *    ser un ítem del arquitecto cuya entidad desapareció de la lámina.
 *
 * Cuando el deploy corra sobre Postgres real (pool de conexiones), lo correcto
 * es pasar el handle de la transacción también a la auditoría y envolver todo.
 */
import { eq, inArray } from 'drizzle-orm';

import { getDb, type Db } from '@/db/client';
import {
  computoItems,
  entidades,
  hallazgos,
  obras,
  type ComputoItem,
  type Hallazgo,
  type NuevoComputoItem,
  type NuevoHallazgo,
} from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { computarObra, type EntidadPersistida } from '@/lib/computo/engine';
import { esClaveDelMotor } from '@/lib/pipeline/claves';
import type { BBox, HallazgoDetectado, ItemComputo } from '@/types/domain';

/** Nombre del actor de todas las escrituras del pipeline en `auditoria`. */
export const ACTOR_PIPELINE = 'pipeline';

/** Respuesta con la que el recompute cierra un hallazgo que dejó de aplicar. */
export const RESPUESTA_AUTO_RESUELTO = { auto: 'resuelto por recomputo' } as const;

export class ObraInexistenteError extends Error {
  constructor(readonly obraId: string) {
    super(`No existe la obra ${obraId}.`);
    this.name = 'ObraInexistenteError';
  }
}

export interface ResumenRecompute {
  itemsInsertados: number;
  itemsActualizados: number;
  itemsAnulados: number;
  hallazgosInsertados: number;
  hallazgosActualizados: number;
  hallazgosDescartados: number;
}

function resumenVacio(): ResumenRecompute {
  return {
    itemsInsertados: 0,
    itemsActualizados: 0,
    itemsAnulados: 0,
    hallazgosInsertados: 0,
    hallazgosActualizados: 0,
    hallazgosDescartados: 0,
  };
}

/** Comparación estructural de un jsonb (mismo productor ⇒ mismo orden de claves). */
function igualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------------------------------------------------------------------------
// Entidades guardadas → entrada del motor
// ---------------------------------------------------------------------------

const BBOX_VACIO: BBox = [0, 0, 0, 0];

/**
 * La tabla `entidades` no tiene columna `bbox`: el bbox vive en la primera
 * fuente (P1 — la entidad y su provenance son el mismo dato). El pipeline nunca
 * guarda una entidad sin fuente, así que el default es defensa, no un caso real.
 */
export function comoEntidadPersistida(fila: typeof entidades.$inferSelect): EntidadPersistida {
  return {
    id: fila.id,
    laminaId: fila.laminaId,
    tipo: fila.tipo,
    nombre: fila.nombre,
    bbox: fila.fuentesJson[0]?.bbox ?? BBOX_VACIO,
    confianza: fila.confianza,
    estadoReforma: fila.estadoReforma,
    atributos: fila.atributosJson,
  };
}

// ---------------------------------------------------------------------------
// Ítems de cómputo
// ---------------------------------------------------------------------------

function valoresDeItem(obraId: string, item: ItemComputo): Omit<NuevoComputoItem, 'id'> {
  return {
    obraId,
    rubro: item.rubro,
    entidadId: item.entidadRef ?? null,
    claveItem: item.claveItem,
    descripcion: item.descripcion,
    unidad: item.unidad,
    cantNeta: item.cantNeta,
    desperdicioPct: item.desperdicioPct,
    cantCompra: item.cantCompra,
    presentacion: item.presentacion,
    origen: item.origen,
    fuentesJson: item.fuentes,
    confianza: item.confianza,
    estado: 'activo',
  };
}

/** Qué cambió entre la fila guardada y el ítem recién computado. */
function diferenciasDeItem(fila: ComputoItem, item: ItemComputo): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {};
  const comparar = (campo: string, antes: unknown, despues: unknown): void => {
    if (!igualJson(antes, despues)) diff[campo] = { antes, despues };
  };

  comparar('rubro', fila.rubro, item.rubro);
  comparar('descripcion', fila.descripcion, item.descripcion);
  comparar('unidad', fila.unidad, item.unidad);
  comparar('cantNeta', fila.cantNeta, item.cantNeta);
  comparar('desperdicioPct', fila.desperdicioPct, item.desperdicioPct);
  comparar('cantCompra', fila.cantCompra, item.cantCompra);
  comparar('presentacion', fila.presentacion, item.presentacion);
  comparar('origen', fila.origen, item.origen);
  comparar('confianza', fila.confianza, item.confianza);
  comparar('estado', fila.estado, 'activo');
  comparar('entidadId', fila.entidadId, item.entidadRef ?? null);
  comparar('fuentes', fila.fuentesJson, item.fuentes);

  return Object.keys(diff).length > 0 ? diff : null;
}

async function sincronizarItems(
  db: Db,
  obraId: string,
  items: readonly ItemComputo[],
  resumen: ResumenRecompute,
): Promise<void> {
  const existentes = await db.select().from(computoItems).where(eq(computoItems.obraId, obraId));

  const deAgente = new Map<string, ComputoItem>();
  const deHumano = new Set<string>();
  for (const fila of existentes) {
    if (fila.editadoPor === null) deAgente.set(fila.claveItem, fila);
    else deHumano.add(fila.claveItem);
  }

  const emitidas = new Set<string>();

  for (const item of items) {
    emitidas.add(item.claveItem);

    // Regla 2: si el arquitecto ya tiene su versión de esta clave, la suya vale.
    // Ni la pisamos ni insertamos una segunda fila con la misma clave.
    if (deHumano.has(item.claveItem)) continue;

    const previo = deAgente.get(item.claveItem);
    if (!previo) {
      await db.insert(computoItems).values(valoresDeItem(obraId, item));
      resumen.itemsInsertados += 1;
      await auditar(obraId, 'computo_item_creado', `computo_items:${item.claveItem}`, {
        cantNeta: item.cantNeta,
        cantCompra: item.cantCompra,
      });
      continue;
    }

    const diff = diferenciasDeItem(previo, item);
    if (!diff) continue; // idempotencia: nada cambió, no se escribe ni se audita

    await db
      .update(computoItems)
      .set({ ...valoresDeItem(obraId, item), updatedAt: new Date() })
      .where(eq(computoItems.id, previo.id));
    resumen.itemsActualizados += 1;
    await auditar(obraId, 'computo_item_actualizado', `computo_items:${item.claveItem}`, diff);
  }

  for (const [clave, fila] of deAgente) {
    if (emitidas.has(clave) || fila.estado === 'anulado') continue;
    await db
      .update(computoItems)
      .set({ estado: 'anulado', updatedAt: new Date() })
      .where(eq(computoItems.id, fila.id));
    resumen.itemsAnulados += 1;
    await auditar(obraId, 'computo_item_anulado', `computo_items:${clave}`, {
      motivo: 'El recompute ya no emite este ítem.',
    });
  }
}

// ---------------------------------------------------------------------------
// Hallazgos
// ---------------------------------------------------------------------------

function valoresDeHallazgo(obraId: string, h: HallazgoDetectado): Omit<NuevoHallazgo, 'id'> {
  return {
    obraId,
    clave: h.clave,
    tipo: h.tipo,
    rubro: h.rubro,
    descripcion: h.descripcion,
    checklistItem: h.checklistItem ?? null,
    laminasJson: h.fuentes,
    targetRef: h.targetRef ?? null,
    bloqueante: h.bloqueante,
  };
}

function diferenciasDeHallazgo(
  fila: Hallazgo,
  h: HallazgoDetectado,
): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {};
  const comparar = (campo: string, antes: unknown, despues: unknown): void => {
    if (!igualJson(antes, despues)) diff[campo] = { antes, despues };
  };

  comparar('tipo', fila.tipo, h.tipo);
  comparar('rubro', fila.rubro, h.rubro);
  comparar('descripcion', fila.descripcion, h.descripcion);
  comparar('checklistItem', fila.checklistItem, h.checklistItem ?? null);
  comparar('bloqueante', fila.bloqueante, h.bloqueante);
  comparar('laminas', fila.laminasJson, h.fuentes);
  comparar('targetRef', fila.targetRef, h.targetRef ?? null);

  return Object.keys(diff).length > 0 ? diff : null;
}

async function sincronizarHallazgos(
  db: Db,
  obraId: string,
  detectados: readonly HallazgoDetectado[],
  resumen: ResumenRecompute,
): Promise<void> {
  const existentes = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
  const porClave = new Map(existentes.map((h) => [h.clave, h]));
  const emitidas = new Set<string>();

  for (const detectado of detectados) {
    emitidas.add(detectado.clave);
    const previo = porClave.get(detectado.clave);

    if (!previo) {
      await db.insert(hallazgos).values(valoresDeHallazgo(obraId, detectado));
      resumen.hallazgosInsertados += 1;
      await auditar(obraId, 'hallazgo_abierto', `hallazgos:${detectado.clave}`, {
        tipo: detectado.tipo,
        bloqueante: detectado.bloqueante,
      });
      continue;
    }

    // Regla 3: lo que el arquitecto respondió o descartó no se reabre ni se
    // reescribe — su respuesta es la última palabra sobre esa clave.
    if (previo.estado !== 'abierto') continue;

    const diff = diferenciasDeHallazgo(previo, detectado);
    if (!diff) continue;

    await db
      .update(hallazgos)
      .set(valoresDeHallazgo(obraId, detectado))
      .where(eq(hallazgos.id, previo.id));
    resumen.hallazgosActualizados += 1;
    await auditar(obraId, 'hallazgo_actualizado', `hallazgos:${detectado.clave}`, diff);
  }

  for (const fila of existentes) {
    if (fila.estado !== 'abierto') continue;
    if (emitidas.has(fila.clave)) continue;
    // Las claves del pipeline (bloqueo por escala) no las administra el motor.
    if (!esClaveDelMotor(fila.clave)) continue;

    await db
      .update(hallazgos)
      .set({ estado: 'descartado', respuestaJson: { ...RESPUESTA_AUTO_RESUELTO } })
      .where(eq(hallazgos.id, fila.id));
    resumen.hallazgosDescartados += 1;
    await auditar(obraId, 'hallazgo_descartado', `hallazgos:${fila.clave}`, {
      ...RESPUESTA_AUTO_RESUELTO,
    });
  }
}

// ---------------------------------------------------------------------------

function auditar(
  obraId: string,
  accion: string,
  targetRef: string,
  diff: Record<string, unknown>,
): Promise<void> {
  return registrarAuditoria({
    obraId,
    actorTipo: 'agente',
    actorNombre: ACTOR_PIPELINE,
    accion,
    targetRef,
    diff,
  });
}

/**
 * Recalcula la obra entera y sincroniza cómputo y bandeja.
 *
 * Es la operación que corre después de cada lámina analizada y después de cada
 * respuesta a un hallazgo: tiene que ser barata de repetir y no dejar rastro si
 * nada cambió (por eso los updates comparan antes de escribir).
 */
export async function recomputarObra(
  obraId: string,
  deps: { db?: Db } = {},
): Promise<ResumenRecompute> {
  const db = deps.db ?? (await getDb());

  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ObraInexistenteError(obraId);

  const filas = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
  const { items, hallazgos: detectados } = computarObra(
    filas.map(comoEntidadPersistida),
    obra.tipo,
  );

  const resumen = resumenVacio();
  await sincronizarItems(db, obraId, items, resumen);
  await sincronizarHallazgos(db, obraId, detectados, resumen);

  const huboCambios = Object.values(resumen).some((n) => n > 0);
  if (huboCambios) {
    await auditar(obraId, 'computo_recalculado', `obras:${obraId}`, {
      entidades: filas.length,
      items: items.length,
      hallazgos: detectados.length,
      ...resumen,
    });
  }

  return resumen;
}

/**
 * Suelta el `entidad_id` de los ítems que apuntan a entidades que están por
 * desaparecer. La FK no admite huérfanos y un ítem editado a mano no se puede
 * borrar: pierde el link, no la fila.
 *
 * Es la única mutación del pipeline que le toca una fila al arquitecto —le saca
 * la provenance a un ítem que él editó—, así que cada ítem afectado deja su
 * propia entrada en `auditoria` con el id que perdió y quién era el dueño de la
 * fila. Sin ese rastro, un ítem editado a mano aparecería un día sin entidad y
 * nada podría explicar cuándo ni por qué (CLAUDE.md §4).
 *
 * Devuelve cuántos ítems perdieron el link.
 */
export async function desvincularItemsDeEntidades(
  db: Db,
  obraId: string,
  entidadIds: readonly string[],
): Promise<number> {
  if (entidadIds.length === 0) return 0;
  const ids = [...entidadIds];

  // Se leen antes de escribir: después del update ya no hay de dónde sacar a qué
  // entidad apuntaba cada ítem.
  const afectados = await db.select().from(computoItems).where(inArray(computoItems.entidadId, ids));
  if (afectados.length === 0) return 0;

  await db
    .update(computoItems)
    .set({ entidadId: null, updatedAt: new Date() })
    .where(inArray(computoItems.entidadId, ids));

  for (const item of afectados) {
    await auditar(obraId, 'computo_item_desvinculado', `computo_items:${item.claveItem}`, {
      entidadId: { antes: item.entidadId, despues: null },
      editadoPor: item.editadoPor,
      motivo: 'La entidad que respaldaba este ítem ya no está en la lámina.',
    });
  }

  return afectados.length;
}
