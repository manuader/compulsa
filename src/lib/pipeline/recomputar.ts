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
import { and, eq, inArray } from 'drizzle-orm';

import { getDb, type Db } from '@/db/client';
import {
  computoItems,
  deducciones,
  entidades,
  hallazgos,
  laminas,
  obras,
  type ComputoItem,
  type Deduccion,
  type Hallazgo,
  type NuevaDeduccion,
  type NuevoComputoItem,
  type NuevoHallazgo,
} from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { computarObra, type CamposDeducidos, type EntidadPersistida } from '@/lib/computo/engine';
import { deducir, type DeduccionPropuesta, type LaminaResumen } from '@/lib/deduccion/motor';
import { esClaveDelMotor } from '@/lib/pipeline/claves';
import { igualJson } from '@/lib/pipeline/json';
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
  deduccionesPropuestas: number;
  deduccionesActualizadas: number;
  /** Propuestas que el motor dejó de sostener y se borraron (no son historia). */
  deduccionesRetiradas: number;
}

function resumenVacio(): ResumenRecompute {
  return {
    itemsInsertados: 0,
    itemsActualizados: 0,
    itemsAnulados: 0,
    hallazgosInsertados: 0,
    hallazgosActualizados: 0,
    hallazgosDescartados: 0,
    deduccionesPropuestas: 0,
    deduccionesActualizadas: 0,
    deduccionesRetiradas: 0,
  };
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
// Deducciones (§11 · RF-501)
// ---------------------------------------------------------------------------

/**
 * Clave de una deducción: `(entidad, campo)` — la misma que el UNIQUE de la
 * tabla, con la obra ya fijada por el `where`.
 */
function claveDeDeduccion(fila: { entidadId: string; campo: string }): string {
  return `${fila.entidadId} ${fila.campo}`;
}

function valoresDeDeduccion(
  obraId: string,
  propuesta: DeduccionPropuesta,
): Omit<NuevaDeduccion, 'id' | 'estado' | 'validadoPor'> {
  return {
    obraId,
    entidadId: propuesta.entidadId,
    campo: propuesta.campo,
    regla: propuesta.regla,
    fuentesJson: propuesta.fuentes,
    // `{ [campo]: valor }`: se mergea tal cual en `entidades.atributos_json` al
    // validarla (el contrato de la columna, `src/db/schema.ts`).
    valorJson: { [propuesta.campo]: propuesta.valor },
    confianza: propuesta.confianza,
  };
}

function diferenciasDeDeduccion(
  fila: Deduccion,
  propuesta: DeduccionPropuesta,
): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {};
  const comparar = (campo: string, antes: unknown, despues: unknown): void => {
    if (!igualJson(antes, despues)) diff[campo] = { antes, despues };
  };

  comparar('regla', fila.regla, propuesta.regla);
  comparar('valor', fila.valorJson, { [propuesta.campo]: propuesta.valor });
  comparar('confianza', fila.confianza, propuesta.confianza);
  comparar('fuentes', fila.fuentesJson, propuesta.fuentes);

  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Sincroniza las propuestas del motor con la tabla `deducciones`.
 *
 * Tres reglas, hermanas de las de los hallazgos:
 *
 *  1. **Lo que el arquitecto decidió no se pisa.** Una deducción `validada` o
 *     `rechazada` es una decisión suya: el motor puede seguir proponiendo lo
 *     mismo en cada corrida y no la toca. (Una validada, además, ya no se
 *     propone: el dato está en la entidad y la regla no encuentra el hueco.)
 *  2. **Una propuesta que el motor deja de sostener se borra.** No es historia:
 *     es una sugerencia viva que dejó de tener sustento —cambió la lámina, el
 *     arquitecto cargó el dato a mano—. Dejarla sería ofrecer validar algo que
 *     ya nadie deduce. Lo que sí es historia (validadas y rechazadas) no se
 *     borra nunca acá.
 *  3. **Nada se escribe si nada cambió.** Misma regla y mismo valor ⇒ ni un
 *     `update` ni una línea de auditoría (`igualJson`, no `JSON.stringify`).
 */
async function sincronizarDeducciones(
  db: Db,
  obraId: string,
  propuestas: readonly DeduccionPropuesta[],
  resumen: ResumenRecompute,
): Promise<void> {
  const existentes = await db.select().from(deducciones).where(eq(deducciones.obraId, obraId));
  const porClave = new Map(existentes.map((fila) => [claveDeDeduccion(fila), fila]));
  const emitidas = new Set<string>();

  for (const propuesta of propuestas) {
    const clave = claveDeDeduccion(propuesta);
    if (emitidas.has(clave)) continue; // el motor ya garantiza una por clave
    emitidas.add(clave);

    const previa = porClave.get(clave);
    if (!previa) {
      await db.insert(deducciones).values(valoresDeDeduccion(obraId, propuesta));
      resumen.deduccionesPropuestas += 1;
      await auditar(obraId, 'deduccion_propuesta', `deducciones:${clave.replace(' ', '.')}`, {
        regla: propuesta.regla,
        valor: propuesta.valor,
        confianza: propuesta.confianza,
      });
      continue;
    }

    if (previa.estado !== 'propuesta') continue; // regla 1
    const diff = diferenciasDeDeduccion(previa, propuesta);
    if (!diff) continue; // regla 3

    await db
      .update(deducciones)
      .set(valoresDeDeduccion(obraId, propuesta))
      .where(eq(deducciones.id, previa.id));
    resumen.deduccionesActualizadas += 1;
    await auditar(obraId, 'deduccion_actualizada', `deducciones:${clave.replace(' ', '.')}`, diff);
  }

  for (const fila of existentes) {
    if (fila.estado !== 'propuesta') continue;
    if (emitidas.has(claveDeDeduccion(fila))) continue;

    await db.delete(deducciones).where(eq(deducciones.id, fila.id));
    resumen.deduccionesRetiradas += 1;
    await auditar(obraId, 'deduccion_retirada', `deducciones:${fila.entidadId}.${fila.campo}`, {
      regla: fila.regla,
      valor: fila.valorJson,
      motivo: 'El motor ya no deduce este dato.',
    });
  }
}

/**
 * Las entidades **con las deducciones validadas aplicadas encima**, más el mapa
 * de qué campo salió de dónde.
 *
 * Por qué es una capa y no solo una lectura de `atributos_json`: `validarDeduccion`
 * escribe el dato en la entidad, sí, pero reprocesar la lámina reescribe
 * `atributos_json` con lo que vuelve a leer el provider —y se llevaría puesto el
 * dato validado—. Sin esta capa, un reanálisis dejaría la obra sin el número,
 * sin consulta (el hallazgo ya se cerró) y sin propuesta (la deducción ya está
 * validada y no se vuelve a proponer): un hueco silencioso, justo lo que P4
 * prohíbe. Con la capa, la decisión del arquitecto sobrevive al reanálisis.
 *
 * Tres casos por campo, y el orden es la prioridad del PRD:
 *
 *  - la entidad **no** trae el dato ⇒ vale el de la deducción, y el ítem sale
 *    `deducido`;
 *  - la entidad trae el **mismo** dato (lo escribió `validarDeduccion`) ⇒ ídem;
 *  - la entidad trae **otro** dato ⇒ manda la documentación y la deducción queda
 *    obsoleta: no se aplica y el ítem sale `explicito`. Lo escrito en el plano le
 *    gana siempre a lo deducido.
 */
function aplicarDeduccionesValidadas(
  entidades: readonly EntidadPersistida[],
  filas: readonly Deduccion[],
): { entidades: EntidadPersistida[]; camposDeducidos: CamposDeducidos } {
  const validadas = filas.filter((fila) => fila.estado === 'validada');
  if (validadas.length === 0) return { entidades: [...entidades], camposDeducidos: new Map() };

  const porEntidad = new Map<string, Deduccion[]>();
  for (const fila of validadas) {
    const cola = porEntidad.get(fila.entidadId);
    if (cola) cola.push(fila);
    else porEntidad.set(fila.entidadId, [fila]);
  }

  const camposDeducidos = new Map<string, Set<string>>();
  const conDeducciones = entidades.map((entidad) => {
    const suyas = porEntidad.get(entidad.id);
    if (suyas === undefined) return entidad;

    const atributos = { ...entidad.atributos };
    const campos = new Set<string>();
    for (const fila of suyas) {
      const valor = fila.valorJson[fila.campo];
      if (valor === undefined || valor === null || valor === '') continue;
      const actual = atributos[fila.campo];
      const vacio = actual === undefined || actual === null || actual === '';
      if (!vacio && actual !== valor) continue; // gana la documentación
      atributos[fila.campo] = valor;
      campos.add(fila.campo);
    }

    if (campos.size === 0) return entidad;
    camposDeducidos.set(entidad.id, campos);
    return { ...entidad, atributos };
  });

  return { entidades: conDeducciones, camposDeducidos };
}

/** Las láminas de la obra, con lo único que el motor de deducción mira de ellas. */
function laminasResumen(db: Db, obraId: string): Promise<LaminaResumen[]> {
  return db
    .select({ id: laminas.id, tipo: laminas.tipo, codigo: laminas.codigo })
    .from(laminas)
    .where(eq(laminas.obraId, obraId));
}

/**
 * Borra las deducciones de entidades que están por desaparecer, **en cualquier
 * estado**.
 *
 * `deducciones.entidad_id` es una FK `NOT NULL`: sin esto, reprocesar una lámina
 * que perdió una entidad falla con un error de integridad. Es la contracara de
 * `desvincularItemsDeEntidades`, con una diferencia que hay que tener presente:
 * un ítem editado a mano sobrevive sin su entidad (pierde el link), pero una
 * deducción **es** un dicho sobre una entidad puntual y sin ella no significa
 * nada. Por eso se borra incluso si estaba validada o rechazada, y por eso cada
 * borrado deja su fila completa en `auditoria`: el rastro de RF-505 no se pierde
 * aunque la deducción sí.
 *
 * Devuelve cuántas se borraron.
 */
export async function borrarDeduccionesDeEntidades(
  db: Db,
  obraId: string,
  entidadIds: readonly string[],
): Promise<number> {
  if (entidadIds.length === 0) return 0;
  const ids = [...entidadIds];

  const afectadas = await db
    .select()
    .from(deducciones)
    .where(and(eq(deducciones.obraId, obraId), inArray(deducciones.entidadId, ids)));
  if (afectadas.length === 0) return 0;

  await db
    .delete(deducciones)
    .where(and(eq(deducciones.obraId, obraId), inArray(deducciones.entidadId, ids)));

  for (const fila of afectadas) {
    await auditar(obraId, 'deduccion_borrada', `deducciones:${fila.entidadId}.${fila.campo}`, {
      estado: fila.estado,
      regla: fila.regla,
      valor: fila.valorJson,
      confianza: fila.confianza,
      validadoPor: fila.validadoPor,
      motivo: 'La entidad sobre la que hablaba ya no está en la lámina.',
    });
  }

  return afectadas.length;
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
 * Recalcula la obra entera y sincroniza cómputo, bandeja y deducciones.
 *
 * Es la operación que corre después de cada lámina analizada y después de cada
 * respuesta a un hallazgo: tiene que ser barata de repetir y no dejar rastro si
 * nada cambió (por eso los updates comparan antes de escribir).
 *
 * El orden importa y es este:
 *
 *  1. Se leen las entidades y las deducciones ya decididas, y las **validadas**
 *     se aplican como una capa encima de las entidades
 *     (`aplicarDeduccionesValidadas`): así el dato validado sobrevive a un
 *     reanálisis de la lámina y los ítems que dependen de él salen marcados
 *     `origen: 'deducido'`.
 *  2. `computarObra()` produce cómputo y consultas; `deducir()` produce
 *     propuestas nuevas e inconsistencias.
 *  3. Las inconsistencias del motor de deducción entran a la bandeja por el
 *     mismo camino que el resto de los hallazgos (`deduccion.*` no es un
 *     namespace protegido, ver `claves.ts`): se emiten en esta misma pasada, así
 *     que el conciliador puede abrirlas y cerrarlas solo.
 */
export async function recomputarObra(
  obraId: string,
  deps: { db?: Db } = {},
): Promise<ResumenRecompute> {
  const db = deps.db ?? (await getDb());

  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ObraInexistenteError(obraId);

  const [filas, decididas, planos] = await Promise.all([
    db.select().from(entidades).where(eq(entidades.obraId, obraId)),
    db.select().from(deducciones).where(eq(deducciones.obraId, obraId)),
    laminasResumen(db, obraId),
  ]);

  const { entidades: persistidas, camposDeducidos } = aplicarDeduccionesValidadas(
    filas.map(comoEntidadPersistida),
    decididas,
  );
  const { items, hallazgos: detectados } = computarObra(
    persistidas,
    obra.tipo,
    undefined,
    camposDeducidos,
  );
  // El motor deduce sobre el estado real de conocimiento de la obra: un dato ya
  // validado es un dato, y puede sostener la deducción siguiente.
  const { propuestas, inconsistencias } = deducir(persistidas, planos);

  const resumen = resumenVacio();
  await sincronizarItems(db, obraId, items, resumen);
  await sincronizarHallazgos(db, obraId, [...detectados, ...inconsistencias], resumen);
  await sincronizarDeducciones(db, obraId, propuestas, resumen);

  const huboCambios = Object.values(resumen).some((n) => n > 0);
  if (huboCambios) {
    await auditar(obraId, 'computo_recalculado', `obras:${obraId}`, {
      entidades: filas.length,
      items: items.length,
      hallazgos: detectados.length + inconsistencias.length,
      deducciones: propuestas.length,
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
