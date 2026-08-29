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
  datosObra,
  deducciones,
  entidades,
  hallazgos,
  laminas,
  obras,
  priceIndex,
  type ComputoItem,
  type DatoObra,
  type Deduccion,
  type Hallazgo,
  type NuevaDeduccion,
  type NuevoComputoItem,
  type NuevoHallazgo,
  type Obra,
} from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import {
  computarObraConPlantillas,
  type CamposDeducidos,
  type DatosObraResueltos,
  type EntidadPersistida,
} from '@/lib/computo/engine';
import { fuenteDeEntidad, unirFuentes } from '@/lib/computo/presentacion';
import { redondear2 } from '@/lib/computo/unidades';
import { TITULO_REGLA } from '@/lib/deduccion/memoria';
import {
  deducir,
  describirValor,
  etiquetaCampo,
  UMBRAL_DEDUCCION,
  type DeduccionPropuesta,
  type LaminaResumen,
} from '@/lib/deduccion/motor';
import { hallazgoInconsistencia } from '@/lib/hallazgos/taxonomia';
import { esClaveDelMotor } from '@/lib/pipeline/claves';
import { igualJson } from '@/lib/pipeline/json';
import { listaDelEstudio } from '@/lib/precios/gestion';
import { resolverPrecio, type CorteIndice } from '@/lib/precios/resolver';
// Ciclo con `resumen.ts` (él importa `aplicarDeduccionesValidadas`,
// `comoEntidadPersistida`, `ACTOR_PIPELINE` y `ObraInexistenteError` de acá).
// Es sano: ninguno de los dos usa nada del otro en tiempo de inicialización —
// todo pasa adentro de funciones, que corren mucho después de que los dos
// módulos terminaron de evaluarse. Mismo caso que `deduccion/motor.ts` ↔
// `deduccion/reglas/*`.
import { persistirResumen } from '@/lib/pipeline/resumen';
import { leerConfig } from '@/lib/plataforma/config-estudio';
import { plantillasConConfig } from '@/lib/rubros/overrides';
import type {
  BBox,
  DatoObraResuelto,
  EstadoDeduccion,
  HallazgoDetectado,
  ItemComputo,
  Origen,
  PrecioEstimado,
  ValorPropuesto,
} from '@/types/domain';

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
  /**
   * Deducciones que nacieron **validadas** y se aplicaron en esta misma corrida
   * (`estadoInicialDeduccion`). No pasaron por la bandeja: entraron al cómputo
   * marcadas y reversibles.
   */
  deduccionesAutovalidadas: number;
  deduccionesActualizadas: number;
  /** Propuestas que el motor dejó de sostener y se borraron (no son historia). */
  deduccionesRetiradas: number;
  /** Marcas de "superada por la documentación" puestas **o** levantadas. */
  deduccionesContradichas: number;
  /** Ítems a los que la cascada de precios les cambió el `precio_json`. */
  preciosActualizados: number;
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
    deduccionesAutovalidadas: 0,
    deduccionesActualizadas: 0,
    deduccionesRetiradas: 0,
    deduccionesContradichas: 0,
    preciosActualizados: 0,
  };
}

/** Una deducción validada a la que la documentación le pasó por encima. */
export interface DeduccionSuperada {
  deduccion: Deduccion;
  entidad: EntidadPersistida;
  /** Lo que se validó en su momento. */
  valorDeducido: number | string | boolean;
  /** Lo que dice hoy la lámina, y con lo que se computa. */
  valorDocumentado: number | string | boolean;
}

export interface ResultadoOverlay {
  entidades: EntidadPersistida[];
  camposDeducidos: CamposDeducidos;
  contradichas: DeduccionSuperada[];
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

/**
 * Una fila de `computo_items` leída como si fuera salida del motor.
 *
 * Existe para poder comparar **dos filas** con `diferenciasDeItem`, que compara
 * fila contra ítem computado. Es lo que usa el diff de revisiones
 * (`diffDeRevision` en `procesar.ts`): la foto de antes y la de después son las
 * dos filas de la base, y la lógica de "qué cambió" tiene que ser una sola.
 */
export function comoItemComputo(fila: ComputoItem): ItemComputo {
  return {
    rubro: fila.rubro,
    descripcion: fila.descripcion,
    unidad: fila.unidad,
    cantNeta: fila.cantNeta,
    desperdicioPct: fila.desperdicioPct,
    cantCompra: fila.cantCompra,
    presentacion: fila.presentacion,
    origen: fila.origen,
    fuentes: fila.fuentesJson,
    confianza: fila.confianza,
    claveItem: fila.claveItem,
    ...(fila.entidadId !== null ? { entidadRef: fila.entidadId } : {}),
  };
}

/** Qué cambió entre la fila guardada y el ítem recién computado. */
export function diferenciasDeItem(
  fila: ComputoItem,
  item: ItemComputo,
): Record<string, unknown> | null {
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

/**
 * Qué propuesta queda en la fila tras un recompute.
 *
 * El motor gobierna las propuestas que él mismo produce (`lectura_baja_confianza`
 * y `rotulo`): si deja de emitirlas, se van. Las de `busqueda_dirigida` las
 * escribe otro proceso **por fuera del motor** (`src/lib/pipeline/busqueda.ts`),
 * así que el motor no puede borrarlas por omisión: sin esta regla, el primer
 * recompute después de una búsqueda tiraba todo lo que la búsqueda encontró y el
 * usuario pagaba los créditos dos veces.
 *
 * Cuando el detectado **sí** trae propuesta, esa manda: es información más
 * fresca sobre el mismo campo.
 */
function propuestaMergeada(
  previa: ValorPropuesto | null | undefined,
  h: HallazgoDetectado,
): ValorPropuesto | null {
  if (h.valorPropuesto !== undefined) return h.valorPropuesto;
  if (previa && previa.origen === 'busqueda_dirigida') return previa;
  return null;
}

function valoresDeHallazgo(
  obraId: string,
  h: HallazgoDetectado,
  previa?: Hallazgo,
): Omit<NuevoHallazgo, 'id'> {
  return {
    obraId,
    clave: h.clave,
    tipo: h.tipo,
    rubro: h.rubro,
    descripcion: h.descripcion,
    checklistItem: h.checklistItem ?? null,
    laminasJson: h.fuentes,
    targetRef: h.targetRef ?? null,
    // La otra cosa a la que puede apuntar un hallazgo: un dato de obra en vez
    // de una entidad. Va acá y no en `targetRef` porque responderlo escribe
    // `datos_obra` y el recompute lo propaga a todas las entidades afectadas.
    targetDato: h.targetDato ?? null,
    valorPropuestoJson: propuestaMergeada(previa?.valorPropuestoJson, h),
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
  // Sin esto, el recompute que corrige la lista de entidades afectadas por un
  // dato de obra no vería diff y dejaría la lista vieja escrita para siempre.
  comparar('targetDato', fila.targetDato, h.targetDato ?? null);
  // Contra el merge, no contra `h.valorPropuesto`: si no, una propuesta de la
  // búsqueda dirigida conservada se vería como un diff en cada recompute y
  // dispararía una auditoría fantasma por corrida.
  comparar('valorPropuesto', fila.valorPropuestoJson, propuestaMergeada(fila.valorPropuestoJson, h));

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
      .set(valoresDeHallazgo(obraId, detectado, previo))
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
  return `${fila.entidadId}::${fila.campo}`;
}

/**
 * Con qué estado nace una deducción (§5.4 y §5.5 del diseño).
 *
 * La decisión de producto de esta ola: **lo deducido con fuentes entra al
 * cómputo**, marcado y reversible, en vez de esperar en una bandeja a que
 * alguien apriete un botón. Preguntar por un dato que dos láminas ya dicen es la
 * otra cara de inventarlo — las dos hacen perder el tiempo del arquitecto.
 *
 * La línea es el `UMBRAL_DEDUCCION` de siempre (0,7): arriba nace `validada` con
 * `validado_por = null` —el sistema se hace cargo, y se ve en la bandeja quién
 * validó qué— y abajo nace `propuesta`, como hasta hoy.
 *
 * `medicion_grafica` va por **regla propia y no por umbral**: mide sobre el
 * dibujo con confianza fija 0,5 y aun así entra, porque su honestidad no está en
 * hacer esperar la fila sino en el `origen: 'inferido'` que le deja al ítem
 * (§5.5). El 0,7 gobierna a las deterministas y al cruce.
 *
 * Nada de esto pisa una fila ya decidida: eso lo garantiza
 * `sincronizarDeducciones`, que solo consulta esta función al **insertar**.
 */
export function estadoInicialDeduccion(
  confianza: number,
  regla: Deduccion['regla'],
): EstadoDeduccion {
  if (regla === 'medicion_grafica') return 'validada';
  if (!Number.isFinite(confianza)) return 'propuesta';
  return confianza >= UMBRAL_DEDUCCION ? 'validada' : 'propuesta';
}

/**
 * Una propuesta recién nacida **como si ya fuera una fila validada**, para que
 * `aplicarDeduccionesValidadas` la aplique en la misma corrida.
 *
 * No es una fila de la base: no tiene id todavía (se lo pone el `insert` de
 * `sincronizarDeducciones`, unas líneas después). Vive lo que dura el recompute
 * y existe para una sola cosa: que el ítem que depende del dato salga computado
 * **ahora**, y no en la corrida siguiente. Sin esto, una deducción que nace
 * validada dejaba la planilla exactamente igual que antes hasta que algo más
 * disparara otro recompute.
 */
function comoFilaValidada(obraId: string, propuesta: DeduccionPropuesta): Deduccion {
  return {
    id: `sin-persistir:${propuesta.entidadId}:${propuesta.campo}`,
    ...valoresDeDeduccion(obraId, propuesta),
    estado: 'validada',
    validadoPor: null,
    createdAt: new Date(0),
  };
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
 *  4. **El estado con el que nace lo decide `estadoInicialDeduccion`**, y solo
 *     al insertar. Una deducción determinista con confianza suficiente nace
 *     `validada` y ya se aplicó en el cómputo de esta misma corrida
 *     (`recomputarObra` la pasó por el overlay antes de computar); una fila que
 *     ya existe no cambia de estado por acá, cualquiera sea su estado.
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
      // Regla 4: con qué estado nace lo decide `estadoInicialDeduccion`, y solo
      // acá — una fila que ya existe no cambia de estado por esta vía.
      const estado = estadoInicialDeduccion(propuesta.confianza, propuesta.regla);
      await db
        .insert(deducciones)
        .values({ ...valoresDeDeduccion(obraId, propuesta), estado, validadoPor: null });
      if (estado === 'validada') resumen.deduccionesAutovalidadas += 1;
      else resumen.deduccionesPropuestas += 1;
      await auditar(
        obraId,
        estado === 'validada' ? 'deduccion_autovalidada' : 'deduccion_propuesta',
        `deducciones:${clave.replace('::', '.')}`,
        {
          regla: propuesta.regla,
          valor: propuesta.valor,
          confianza: propuesta.confianza,
          estado,
        },
      );
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
    await auditar(obraId, 'deduccion_actualizada', `deducciones:${clave.replace('::', '.')}`, diff);
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
 * El mapa lleva el origen **campo por campo**, porque no todas las deducciones
 * valen lo mismo: la que se apoya en algo escrito en otra lámina deja el ítem
 * `deducido`, y la medición gráfica —que mide sobre el dibujo, §5.5— lo deja
 * `inferido`. El engine se queda con el peor de los campos que el ítem usó.
 *
 * Tres casos por campo, y el orden es la prioridad del PRD:
 *
 *  - la entidad **no** trae el dato ⇒ vale el de la deducción, y el ítem sale
 *    `deducido` (o `inferido` si se midió);
 *  - la entidad trae el **mismo** dato (lo escribió `validarDeduccion`) ⇒ ídem;
 *  - la entidad trae **otro** dato ⇒ manda la documentación y la deducción queda
 *    obsoleta: no se aplica y el ítem sale `explicito`. Lo escrito en el plano le
 *    gana siempre a lo deducido, **y el conflicto se avisa**: la deducción vuelve
 *    en `contradichas` para que el recompute abra la consulta y la marque
 *    (`sincronizarContradicciones`). Que la documentación gane en silencio sería
 *    dejar una fila `validada` afirmando para siempre un número que ya no es.
 */
export function aplicarDeduccionesValidadas(
  entidades: readonly EntidadPersistida[],
  filas: readonly Deduccion[],
): ResultadoOverlay {
  const validadas = filas.filter((fila) => fila.estado === 'validada');
  if (validadas.length === 0) {
    return { entidades: [...entidades], camposDeducidos: new Map(), contradichas: [] };
  }

  const porEntidad = new Map<string, Deduccion[]>();
  for (const fila of validadas) {
    const cola = porEntidad.get(fila.entidadId);
    if (cola) cola.push(fila);
    else porEntidad.set(fila.entidadId, [fila]);
  }

  const camposDeducidos = new Map<string, Map<string, Origen>>();
  const contradichas: DeduccionSuperada[] = [];
  // Qué tan fuerte es el dato que aporta cada regla: la medición gráfica mide
  // sobre el dibujo (§5.5) y por eso su ítem sale `inferido`, un escalón más
  // débil que el resto, que se apoya en algo escrito en otra lámina.
  const origenDe = (fila: Deduccion): Origen =>
    fila.regla === 'medicion_grafica' ? 'inferido' : 'deducido';
  const conDeducciones = entidades.map((entidad) => {
    const suyas = porEntidad.get(entidad.id);
    if (suyas === undefined) return entidad;

    const atributos = { ...entidad.atributos };
    const campos = new Map<string, Origen>();
    for (const fila of suyas) {
      const valor = fila.valorJson[fila.campo];
      if (valor === undefined || valor === null || valor === '') continue;
      const actual = atributos[fila.campo];
      if (actual === undefined || actual === null || actual === '') {
        atributos[fila.campo] = valor;
        campos.set(fila.campo, origenDe(fila));
        continue;
      }
      if (mismoDato(actual, valor)) {
        // El dato es el mismo: el campo sigue viniendo de la deducción.
        campos.set(fila.campo, origenDe(fila));
        continue;
      }
      // Gana la documentación, pero no en silencio.
      contradichas.push({
        deduccion: fila,
        entidad,
        valorDeducido: valor,
        valorDocumentado: actual,
      });
    }

    if (campos.size === 0) return entidad;
    camposDeducidos.set(entidad.id, campos);
    return { ...entidad, atributos };
  });

  return { entidades: conDeducciones, camposDeducidos, contradichas };
}

/**
 * ¿Son el mismo dato? Con tolerancia **solo para el ruido binario**: los dos
 * lados se redondean a los 2 decimales con los que el motor emite toda cantidad
 * (`redondear2`), que es la precisión con la que se lee una cota. `2,60` y
 * `2,6000000000000005` son el mismo dato; `2,60` y `2,61` **no** lo son y se
 * avisan como contradicción — un centímetro en una carpintería es un premarco
 * que no entra.
 *
 * Un número escrito como texto (`"2,60"`) se compara como número, igual que lo
 * lee `leerNumero()`: el provider a veces devuelve las medidas como string y eso
 * no puede contar como contradicción.
 */
export function mismoDato(a: unknown, b: unknown): boolean {
  const na = comoNumero(a);
  const nb = comoNumero(b);
  if (na !== null && nb !== null) return redondear2(na) === redondear2(nb);
  return a === b;
}

/** Mismo criterio que `leerNumero()` de la taxonomía, sin exigir que sea positivo. */
function comoNumero(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim() !== '') {
    const parseado = Number(valor.replace(',', '.'));
    return Number.isFinite(parseado) ? parseado : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deducciones superadas por la documentación
// ---------------------------------------------------------------------------

/**
 * Marcas que una deducción puede llevar en `valor_json` **además** de su
 * `{ [campo]: valor }`.
 *
 * Van con guion bajo adelante justamente para que no se puedan confundir con un
 * atributo: los atributos del dominio son todos camelCase sin guion (`anchoM`,
 * `superficieM2`). Quien lea `valor_json` tiene que leer **su campo**
 * (`valorJson[campo]`, que es lo que hacen `valorDeDeduccion` y el overlay), no
 * mergear el objeto entero.
 *
 * Por qué acá y no en una columna: la tabla `deducciones` es de P1 y no tiene
 * dónde poner esto; agregar una migración desde una rama paralela es peor
 * negocio que dos claves meta documentadas. Si algún día hay columna, el cambio
 * es reemplazar estas dos constantes y sus dos lectores.
 */
export const MARCA_CONTRADICHA = '_contradicha';
export const MARCA_VALOR_DOCUMENTADO = '_valorDocumentado';

/** `true` si la documentación pasó a decir otra cosa que lo que se validó. */
export function estaContradicha(fila: Pick<Deduccion, 'valorJson'>): boolean {
  return fila.valorJson[MARCA_CONTRADICHA] === true;
}

/** Lo que dice hoy la documentación para el campo de una deducción superada. */
export function valorQueDocumenta(
  fila: Pick<Deduccion, 'valorJson'>,
): number | string | boolean | null {
  return fila.valorJson[MARCA_VALOR_DOCUMENTADO] ?? null;
}

/** El `valor_json` sin las marcas: el `{ [campo]: valor }` limpio. */
function sinMarcas(valorJson: Deduccion['valorJson']): Deduccion['valorJson'] {
  const limpio = { ...valorJson };
  delete limpio[MARCA_CONTRADICHA];
  delete limpio[MARCA_VALOR_DOCUMENTADO];
  return limpio;
}

/** Un valor de atributo, escrito para leer. */
function comoTexto(campo: string, valor: number | string | boolean): string {
  return typeof valor === 'boolean' ? String(valor) : describirValor(campo, valor);
}

/**
 * La consulta que avisa que una deducción validada quedó superada.
 *
 * `inconsistencia` y **no bloqueante**: el cómputo no está mal —usa el dato de la
 * documentación, que es el bueno— pero hay una decisión vieja del arquitecto que
 * ya no se sostiene y alguien tiene que mirarla. La clave es estable por entidad
 * y campo, así que el conciliador la abre una sola vez y **no la reabre** si el
 * arquitecto la descarta (mismo patrón que el resto de la bandeja).
 */
function hallazgoContradiccion(superada: DeduccionSuperada): HallazgoDetectado {
  const { campo, regla } = superada.deduccion;
  const nombre = superada.entidad.nombre;
  const deducido = comoTexto(campo, superada.valorDeducido);
  const documentado = comoTexto(campo, superada.valorDocumentado);

  return hallazgoInconsistencia({
    rubro: null, // es coherencia del expediente, no de un rubro
    clave: `deduccion.contradicha.${nombre}.${campo}`,
    checklistItem: 'deduccion.contradicha',
    descripcion:
      `${etiquetaCampo(campo)} de ${nombre} se validó en ${deducido} por la regla ` +
      `«${TITULO_REGLA[regla]}», pero la documentación ahora dice ${documentado}. ` +
      `Computo con ${documentado}, que es lo que está escrito; la deducción quedó superada. ` +
      'Revisá cuál de los dos vale.',
    fuentes: unirFuentes(superada.deduccion.fuentesJson, [fuenteDeEntidad(superada.entidad)]),
  });
}

/**
 * Pone y saca la marca de "superada por la documentación" sobre las deducciones
 * validadas. Idempotente en las dos direcciones: si la marca ya está con el
 * mismo valor documentado no se escribe, y si el conflicto se resolvió —porque
 * el reanálisis volvió a leer el dato deducido, o porque el dato desapareció de
 * la lámina— la marca se levanta y queda auditado.
 */
async function sincronizarContradicciones(
  db: Db,
  obraId: string,
  decididas: readonly Deduccion[],
  contradichas: readonly DeduccionSuperada[],
  resumen: ResumenRecompute,
): Promise<void> {
  const superadas = new Map(contradichas.map((superada) => [superada.deduccion.id, superada]));

  for (const fila of decididas) {
    if (fila.estado !== 'validada') continue;
    const superada = superadas.get(fila.id);
    const marcada = estaContradicha(fila);
    const objetivo = `deducciones:${fila.entidadId}.${fila.campo}`;

    if (superada) {
      if (marcada && mismoDato(valorQueDocumenta(fila), superada.valorDocumentado)) continue;
      await db
        .update(deducciones)
        .set({
          valorJson: {
            ...sinMarcas(fila.valorJson),
            [MARCA_CONTRADICHA]: true,
            [MARCA_VALOR_DOCUMENTADO]: superada.valorDocumentado,
          },
        })
        .where(eq(deducciones.id, fila.id));
      resumen.deduccionesContradichas += 1;
      await auditar(obraId, 'deduccion_contradicha', objetivo, {
        campo: fila.campo,
        regla: fila.regla,
        valorDeducido: superada.valorDeducido,
        valorDocumentado: superada.valorDocumentado,
        motivo: 'La documentación pasó a decir otra cosa: manda lo escrito.',
      });
      continue;
    }

    if (!marcada) continue;
    await db
      .update(deducciones)
      .set({ valorJson: sinMarcas(fila.valorJson) })
      .where(eq(deducciones.id, fila.id));
    resumen.deduccionesContradichas += 1;
    await auditar(obraId, 'deduccion_contradiccion_resuelta', objetivo, {
      campo: fila.campo,
      valorDocumentado: { antes: valorQueDocumenta(fila), despues: null },
      motivo: 'La documentación volvió a coincidir con la deducción.',
    });
  }
}

// ---------------------------------------------------------------------------
// Datos de obra (§5.2): los hechos que valen para toda la obra
// ---------------------------------------------------------------------------

/**
 * La fila de `datos_obra` como la esperan las plantillas.
 *
 * El `valor_json` guarda `{ valor, unidad? }` y el resto de la provenance vive
 * en columnas: acá se arma el objeto plano con el que la cadena de respaldo
 * trabaja, sin perder ni el origen ni las fuentes ni el método (P1 — que el
 * hecho sea de la obra entera no lo exime de citar de dónde salió).
 */
export function comoDatoResuelto(fila: DatoObra): DatoObraResuelto {
  return {
    clave: fila.clave,
    valor: fila.valorJson.valor,
    ...(fila.valorJson.unidad === undefined ? {} : { unidad: fila.valorJson.unidad }),
    origen: fila.origen,
    fuentes: fila.fuentesJson,
    confianza: fila.confianza,
    ...(fila.metodo === null ? {} : { metodo: fila.metodo }),
  };
}

/**
 * Los datos de obra de una obra, indexados por clave.
 *
 * Es un `Map` porque las plantillas lo consultan una vez por entidad y por campo
 * (`altura_local.PB`, y si no está, `altura_local.general`): buscar linealmente
 * en cada tabique sería cuadrático sin ninguna ganancia.
 */
async function datosDeObra(db: Db, obraId: string): Promise<DatosObraResueltos> {
  const filas = await db.select().from(datosObra).where(eq(datosObra.obraId, obraId));
  return new Map(filas.map((fila) => [fila.clave, comoDatoResuelto(fila)]));
}

// ---------------------------------------------------------------------------
// Precios (§5.6): la cascada, corrida contra lo que hay escrito
// ---------------------------------------------------------------------------

/**
 * El corte del índice del estudio con el que se costea cada clave de ítem: el
 * `p50` del **mes más reciente con al menos una muestra**, en la zona de la obra.
 *
 * Tres filtros y ninguno es cosmético:
 *
 *  - **la zona**, porque el precio de Rosario no es el precio de esta obra;
 *  - **`n ≥ 1`**, porque una fila sin muestras no es un precio barato, es un
 *    renglón vacío;
 *  - **el mes más reciente**, comparado como texto — `price_index.mes` es
 *    `YYYY-MM`, así que el orden alfabético *es* el cronológico.
 */
async function corteDelIndice(
  db: Db,
  estudioId: string,
  zona: string,
): Promise<Map<string, CorteIndice>> {
  const filas = await db
    .select({
      claveItem: priceIndex.claveItem,
      mes: priceIndex.mes,
      p50: priceIndex.p50,
      n: priceIndex.n,
    })
    .from(priceIndex)
    .where(and(eq(priceIndex.estudioId, estudioId), eq(priceIndex.zona, zona)));

  const porClave = new Map<string, CorteIndice>();
  for (const fila of filas) {
    if (fila.n < 1) continue;
    const previo = porClave.get(fila.claveItem);
    if (previo !== undefined && previo.mes >= fila.mes) continue;
    porClave.set(fila.claveItem, { p50: fila.p50, mes: fila.mes, n: fila.n });
  }
  return porClave;
}

/**
 * Recalcula `computo_items.precio_json` de los ítems **activos** de la obra.
 *
 * Corre después de sincronizar los ítems porque necesita las cantidades ya
 * escritas: el precio es del ítem que quedó, no del que se acaba de anular.
 *
 * Qué precio le toca a cada uno lo decide `resolverPrecio` (puro, §5.6): precio
 * manual del ítem → lista del estudio → índice de la zona → `null`. Acá solo
 * está la mitad sucia: leer las dos tablas una vez por obra y escribir lo que
 * cambió.
 *
 * **También le pone precio a los ítems editados a mano.** La regla 2 del archivo
 * —lo humano es intocable— es sobre las cantidades, que son la afirmación del
 * arquitecto sobre la obra; el precio no lo es, y un ítem que él agregó merece
 * costearse como cualquier otro. Lo que sí es suyo y no se toca es el precio que
 * cargó él: entra por el primer escalón de la cascada y le gana a todo.
 *
 * Idempotente: el mismo precio resuelto dos veces no escribe ni audita
 * (`igualJson`, no `JSON.stringify` — el orden de las claves del jsonb no es un
 * cambio de precio).
 */
async function sincronizarPrecios(
  db: Db,
  obra: Obra,
  resumen: ResumenRecompute,
): Promise<void> {
  const [items, lista, indice] = await Promise.all([
    db
      .select()
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obra.id), eq(computoItems.estado, 'activo'))),
    listaDelEstudio(db, obra.estudioId),
    corteDelIndice(db, obra.estudioId, obra.zona),
  ]);

  for (const item of items) {
    const manual: PrecioEstimado | null =
      item.precioJson !== null && item.precioJson.fuente === 'manual' ? item.precioJson : null;

    const precio = resolverPrecio(
      { claveItem: item.claveItem, precioManual: manual },
      lista,
      indice.get(item.claveItem) ?? null,
    );
    if (igualJson(item.precioJson, precio)) continue;

    await db
      .update(computoItems)
      .set({ precioJson: precio, updatedAt: new Date() })
      .where(eq(computoItems.id, item.id));
    resumen.preciosActualizados += 1;
    await auditar(obra.id, 'computo_item_precio', `computo_items:${item.claveItem}`, {
      precio: { antes: item.precioJson, despues: precio },
    });
  }
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
 *  4. Se refresca el resumen ejecutivo (`persistirResumen`), que es una lectura
 *     del estado que se acaba de sincronizar.
 *
 * `deps.resumen = false` saltea el paso 4, y lo usa **solo** `procesarLamina`:
 * ahí el recompute corre una vez por lámina y `procesarDocumento` rehace el
 * resumen una sola vez al final, con todas analizadas. Publicar N resúmenes a
 * medio hacer sería ruido en `auditoria` y en la pantalla.
 */
export async function recomputarObra(
  obraId: string,
  deps: { db?: Db; resumen?: boolean } = {},
): Promise<ResumenRecompute> {
  const db = deps.db ?? (await getDb());

  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ObraInexistenteError(obraId);

  const [filas, decididas, planos, config, datos] = await Promise.all([
    db.select().from(entidades).where(eq(entidades.obraId, obraId)),
    db.select().from(deducciones).where(eq(deducciones.obraId, obraId)),
    laminasResumen(db, obraId),
    leerConfig(db, obra.estudioId),
    datosDeObra(db, obraId),
  ]);

  const crudas = filas.map(comoEntidadPersistida);
  const yaDecidido = aplicarDeduccionesValidadas(crudas, decididas);
  // El motor deduce sobre el estado real de conocimiento de la obra: un dato ya
  // validado es un dato, y puede sostener la deducción siguiente.
  const { propuestas, inconsistencias } = deducir(yaDecidido.entidades, planos);

  // Lo que **nace** validado se aplica en ESTA corrida, no en la siguiente: una
  // deducción determinista con fuentes es un dato, y hacer esperar al cómputo
  // hasta el próximo recompute dejaba la planilla mintiendo por omisión.
  //
  // Solo los nacimientos: una fila que ya existe manda ella. Si está validada o
  // rechazada, es una decisión y entró por `decididas`; si está en `propuesta`
  // —el cruce por debajo del umbral, o una fila que alguien dejó esperando— el
  // cómputo tiene que verse como la bandeja la muestra, y no aplicarse a
  // escondidas.
  const yaExiste = new Set(decididas.map(claveDeDeduccion));
  const nacenValidadas = propuestas.filter(
    (propuesta) =>
      !yaExiste.has(claveDeDeduccion(propuesta)) &&
      estadoInicialDeduccion(propuesta.confianza, propuesta.regla) === 'validada',
  );
  const { entidades: persistidas, camposDeducidos, contradichas } =
    nacenValidadas.length === 0
      ? yaDecidido
      : aplicarDeduccionesValidadas(crudas, [
          ...decididas,
          ...nacenValidadas.map((propuesta) => comoFilaValidada(obraId, propuesta)),
        ]);

  // Tres cosas que el motor no adivina y el pipeline sí sabe:
  //  - `plantillasConConfig(config)`: el desperdicio por rubro es configurable
  //    por estudio (P2 del PRD), y sin esto el formulario de configuración
  //    guardaba un número que no cambiaba ningún ítem;
  //  - `planos`: sin el tipo de cada lámina, la misma carpintería dibujada en la
  //    planta y listada en la planilla se contaría dos veces
  //    (ver `src/lib/rubros/aberturas.ts`);
  //  - `datos`: los hechos que valen para toda la obra (§5.2), que son el
  //    respaldo de un campo que la entidad no trae — sin ellos, cuatro tabiques
  //    del mismo local abren cuatro consultas por la misma altura.
  const { items, hallazgos: detectados } = computarObraConPlantillas(
    persistidas,
    obra.tipo,
    plantillasConConfig(config),
    { camposDeducidos, laminas: planos, datosObra: datos },
  );

  // Las contradicciones son hallazgos como cualquier otro: se emiten en esta
  // misma pasada, así que el conciliador las abre y las cierra solo.
  const superadas = contradichas.map(hallazgoContradiccion);

  const resumen = resumenVacio();
  await sincronizarItems(db, obraId, items, resumen);
  await sincronizarHallazgos(
    db,
    obraId,
    [...detectados, ...inconsistencias, ...superadas],
    resumen,
  );
  await sincronizarDeducciones(db, obraId, propuestas, resumen);
  await sincronizarContradicciones(db, obraId, decididas, contradichas, resumen);
  // Al final y sobre lo ya escrito: el precio es del ítem que quedó activo, con
  // la cantidad que quedó (§5.6).
  await sincronizarPrecios(db, obra, resumen);

  const huboCambios = Object.values(resumen).some((n) => n > 0);
  if (huboCambios) {
    await auditar(obraId, 'computo_recalculado', `obras:${obraId}`, {
      entidades: filas.length,
      items: items.length,
      hallazgos: detectados.length + inconsistencias.length + superadas.length,
      deducciones: propuestas.length,
      ...resumen,
    });
  }

  // El resumen ejecutivo (RF-205) es una lectura del mismo estado que se acaba
  // de sincronizar: si no se refresca acá, responder una consulta o validar una
  // deducción deja la pantalla del expediente contando una obra que ya no es.
  // Va al final y con la misma base: `persistirResumen` es idempotente y no
  // escribe ni audita si el resumen no cambió, así que no encarece el recompute
  // que no movió nada.
  if (deps.resumen !== false) await persistirResumen(db, obraId);

  return resumen;
}

/**
 * Recomputa las obras **activas** de un estudio y devuelve cuántas tocó.
 *
 * Lo llama la configuración del estudio cuando cambia el desperdicio por rubro:
 * ese número no es un dato de la obra sino del estudio, y mueve la cantidad de
 * compra de ítems que ya están escritos. Sin este barrido, la pantalla guardaba
 * el número y la planilla seguía mostrando el anterior hasta que algo más
 * disparara un recompute —responder una consulta, validar una deducción,
 * reprocesar una lámina—.
 *
 * Va **en serie y sin transacción**, como el resto del pipeline:
 * `recomputarObra` es idempotente y barata, y correrlas de a una deja la base en
 * un estado consistente obra por obra en vez de a medio camino en todas.
 *
 * Las archivadas quedan afuera: no se listan, no se exportan y no se compulsan.
 * Cuando se desarchiva una, el primer recompute la pone al día.
 */
export async function recomputarObrasDelEstudio(
  estudioId: string,
  deps: { db?: Db } = {},
): Promise<number> {
  const db = deps.db ?? (await getDb());

  const activas = await db
    .select({ id: obras.id })
    .from(obras)
    .where(and(eq(obras.estudioId, estudioId), eq(obras.estado, 'activa')));

  for (const obra of activas) await recomputarObra(obra.id, { db });
  return activas.length;
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
