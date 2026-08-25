/**
 * Pipeline de análisis: del PDF que sube el arquitecto a las entidades, el
 * cómputo y la bandeja.
 *
 *   subirDocumento → procesarDocumento → procesarLamina (×N) → recomputarObra
 *
 * Tres propiedades que el código de acá tiene que sostener:
 *
 *  1. **Idempotente y re-ejecutable.** Volver a correr el pipeline sobre el
 *     mismo documento no duplica láminas, ni entidades, ni ítems: todo se
 *     matchea por clave estable (página, `tipo|nombre` de entidad, `clave_item`).
 *  2. **Sin escala no se computa (RF-201).** Una lámina cuya escala no se pudo
 *     verificar queda `bloqueada_escala` con un hallazgo bloqueante y **no** se
 *     le extraen entidades: medir sobre una escala desconocida sería inventar
 *     (P4). El arquitecto la desbloquea a mano y el análisis se re-dispara.
 *  3. **Nunca una excepción suelta.** El error de una lámina queda en su
 *     `estado_analisis = 'error'` con `error_detalle`, no tira abajo el resto
 *     del documento.
 *  4. **Una lámina se analiza de a una.** Dos corridas encimadas sobre la misma
 *     lámina duplicarían entidades y cantidades: la transición a `procesando`
 *     es la que decide quién corre (ver `reclamarLamina`).
 *
 * Toda escritura de agente pasa por `registrarAuditoria` (CLAUDE.md §4).
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '@/db/client';
import {
  auditoria,
  documentos,
  entidades,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Documento,
  type Entidad,
  type Lamina,
  type NuevaEntidad,
} from '@/db/schema';
import { getAnalysisProvider, type AnalysisProvider } from '@/lib/analysis/index';
import { registrarAuditoria } from '@/lib/audit';
import { separarPaginas } from '@/lib/pdf/split';
import { extraerTexto } from '@/lib/pdf/texto';
import { claveEscala } from '@/lib/pipeline/claves';
import { MIME_PDF, refDocumento, refLamina } from '@/lib/pipeline/refs';
import {
  ACTOR_PIPELINE,
  desvincularItemsDeEntidades,
  recomputarObra,
} from '@/lib/pipeline/recomputar';
import { getStorage, type StorageAdapter } from '@/lib/storage/index';
import { DISCIPLINAS, TIPOS_LAMINA } from '@/types/domain';
import type { BBox, EntidadDetectada, LaminaInput, RotuloDetectado } from '@/types/domain';

/** 60 MB: un legajo de plantas grande entra; un video, no. */
export const TAMANO_MAXIMO_BYTES = 60 * 1024 * 1024;

/** Todo PDF arranca con esta firma. El `Content-Type` del cliente no se cree. */
const FIRMA_PDF = '%PDF-';

/** Texto del hallazgo de bloqueo por escala (RF-201). */
export const DESCRIPCION_ESCALA_BLOQUEADA =
  'La lámina no tiene escala confiable; indicá la escala o una medida de referencia.';

/** Respuesta con la que el desbloqueo manual cierra el hallazgo de escala. */
export const RESPUESTA_ESCALA_CONFIRMADA = { auto: 'escala confirmada a mano' } as const;

/** Acción con la que queda registrado el arranque del análisis de una lámina. */
export const ACCION_PROCESANDO = 'lamina_procesando';

/**
 * Cuánto puede una lámina quedarse en `procesando` antes de darla por
 * abandonada. Si el proceso que la tomó murió (timeout de la función, deploy en
 * el medio), nadie va a limpiar ese estado: pasado este plazo, la próxima
 * corrida la retoma. Sin esta salida, un "Reprocesar" sobre una lámina colgada
 * no haría nada y el arquitecto se quedaría sin manera de destrabarla.
 */
export const TTL_PROCESANDO_MS = 15 * 60 * 1000;

/** Prefijo del `error_detalle` de una lámina que se analizó pero no se computó. */
export const PREFIJO_RECOMPUTO_FALLIDO =
  'La lámina se analizó bien, pero el cómputo de la obra no se pudo recalcular: ';

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export class ArchivoInvalidoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ArchivoInvalidoError';
  }
}

export class DocumentoInexistenteError extends Error {
  constructor(readonly documentoId: string) {
    super(`No existe el documento ${documentoId}.`);
    this.name = 'DocumentoInexistenteError';
  }
}

export class LaminaInexistenteError extends Error {
  constructor(readonly laminaId: string) {
    super(`No existe la lámina ${laminaId}.`);
    this.name = 'LaminaInexistenteError';
  }
}

// ---------------------------------------------------------------------------
// Dependencias inyectables
// ---------------------------------------------------------------------------

/**
 * Todo lo que el pipeline toca del mundo exterior. Los defaults son los reales
 * (`getDb`, `getStorage`, `getAnalysisProvider`); los tests inyectan una base en
 * memoria y un storage temporal para no escribir en `data/uploads/`.
 */
export interface DepsPipeline {
  db?: Db;
  storage?: StorageAdapter;
  provider?: AnalysisProvider;
  /**
   * El recompute que corre después de cada lámina. Es una costura, no una
   * opción de configuración: existe para poder ejercitar el camino de "la
   * lámina se analizó bien y el recompute falló" sin romper la base a mano.
   */
  recomputar?: (obraId: string, deps: { db: Db }) => Promise<unknown>;
}

interface Entorno {
  db: Db;
  storage: StorageAdapter;
  provider: AnalysisProvider;
  recomputar: NonNullable<DepsPipeline['recomputar']>;
}

async function resolver(deps: DepsPipeline): Promise<Entorno> {
  return {
    db: deps.db ?? (await getDb()),
    storage: deps.storage ?? getStorage(),
    provider: deps.provider ?? getAnalysisProvider(),
    recomputar: deps.recomputar ?? recomputarObra,
  };
}

function detalleDeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Alta de documento (la lógica que el route handler de upload envuelve)
// ---------------------------------------------------------------------------

/** Sin path, sin separadores y acotado: el nombre viaja del cliente. */
function nombreSeguro(nombre: string): string {
  const base = nombre.split(/[/\\]/).pop() ?? '';
  const limpio = base.replace(/[\u0000-\u001f]/g, '').trim();
  return limpio.slice(0, 200);
}

function esPdf(bytes: Uint8Array): boolean {
  if (bytes.length < FIRMA_PDF.length) return false;
  for (let i = 0; i < FIRMA_PDF.length; i++) {
    if (bytes[i] !== FIRMA_PDF.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Guarda el archivo original y crea su fila en `documentos`. No analiza nada:
 * de eso se ocupa `procesarDocumento`.
 *
 * El id del documento se genera acá (y no lo pone la base) porque la ruta del
 * storage lo lleva adentro: sin id previo habría que insertar, guardar y hacer
 * un update, y un fallo en el medio dejaría una fila apuntando a la nada.
 */
export async function subirDocumento(
  db: Db,
  storage: StorageAdapter,
  obraId: string,
  usuarioId: string,
  archivo: File,
): Promise<Documento> {
  const nombreArchivo = nombreSeguro(archivo.name);
  if (nombreArchivo === '') throw new ArchivoInvalidoError('El archivo no tiene nombre.');
  if (archivo.size > TAMANO_MAXIMO_BYTES) {
    throw new ArchivoInvalidoError(
      `El archivo pesa más de ${Math.round(TAMANO_MAXIMO_BYTES / (1024 * 1024))} MB.`,
    );
  }

  const bytes = new Uint8Array(await archivo.arrayBuffer());
  if (bytes.length === 0) throw new ArchivoInvalidoError('El archivo está vacío.');
  if (!esPdf(bytes)) {
    throw new ArchivoInvalidoError('Por ahora solo se pueden subir PDF; este archivo no lo es.');
  }

  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ArchivoInvalidoError(`No existe la obra ${obraId}.`);

  const documentoId = randomUUID();
  const archivoRef = refDocumento(obra.estudioId, obra.id, documentoId);
  await storage.guardar(archivoRef, bytes, MIME_PDF);

  // Mismo nombre subido de nuevo ⇒ versión siguiente. El original es inmutable
  // (CLAUDE.md §6): la versión anterior queda, no se pisa.
  const previas = await db
    .select({ version: documentos.version })
    .from(documentos)
    .where(and(eq(documentos.obraId, obra.id), eq(documentos.nombreArchivo, nombreArchivo)));
  const version = previas.reduce((maxima, fila) => Math.max(maxima, fila.version), 0) + 1;

  const [documento] = await db
    .insert(documentos)
    .values({
      id: documentoId,
      obraId: obra.id,
      nombreArchivo,
      tipo: 'plano',
      archivoRef,
      mime: MIME_PDF,
      hash: createHash('sha256').update(bytes).digest('hex'),
      version,
      subidoPor: usuarioId,
    })
    .returning();

  const [usuario] = await db
    .select({ email: usuarios.email })
    .from(usuarios)
    .where(eq(usuarios.id, usuarioId));

  await registrarAuditoria({
    obraId: obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario?.email ?? usuarioId,
    accion: 'documento_subido',
    targetRef: `documentos:${documento.id}`,
    diff: { nombreArchivo, version, bytes: bytes.length, hash: documento.hash },
  });

  return documento;
}

// ---------------------------------------------------------------------------
// Documento → láminas
// ---------------------------------------------------------------------------

/**
 * Separa el PDF en una lámina por página y analiza cada una en secuencia.
 *
 * Re-ejecutable: las láminas se matchean por `numero_pagina`, así que volver a
 * correrlo re-analiza las mismas filas en lugar de crear otras nuevas.
 */
export async function procesarDocumento(
  documentoId: string,
  deps: DepsPipeline = {},
): Promise<void> {
  const entorno = await resolver(deps);
  const { db, storage } = entorno;

  const [documento] = await db.select().from(documentos).where(eq(documentos.id, documentoId));
  if (!documento) throw new DocumentoInexistenteError(documentoId);
  const [obra] = await db.select().from(obras).where(eq(obras.id, documento.obraId));
  if (!obra) throw new DocumentoInexistenteError(documentoId);

  const original = await storage.leer(documento.archivoRef);
  const paginas = await separarPaginas(original);

  const existentes = await db.select().from(laminas).where(eq(laminas.documentoId, documentoId));
  const porPagina = new Map(existentes.map((lamina) => [lamina.numeroPagina, lamina]));

  const aProcesar: string[] = [];

  for (const [indice, bytes] of paginas.entries()) {
    const numeroPagina = indice + 1;
    const previa = porPagina.get(numeroPagina);

    if (previa) {
      // Re-escribir la página es barato y deja storage y base consistentes aunque
      // el archivo derivado se haya perdido entre corridas.
      await storage.guardar(previa.archivoRef, bytes, MIME_PDF);
      aProcesar.push(previa.id);
      continue;
    }

    const laminaId = randomUUID();
    const archivoRef = refLamina(obra.estudioId, obra.id, documento.id, numeroPagina);
    await storage.guardar(archivoRef, bytes, MIME_PDF);
    await db.insert(laminas).values({
      id: laminaId,
      documentoId: documento.id,
      obraId: obra.id,
      numeroPagina,
      archivoRef,
      estadoAnalisis: 'pendiente',
    });
    await auditarAgente(obra.id, 'lamina_creada', `laminas:${laminaId}`, {
      documentoId: documento.id,
      numeroPagina,
    });
    aProcesar.push(laminaId);
  }

  for (const laminaId of aProcesar) {
    await procesarLamina(laminaId, entorno);
  }
}

// ---------------------------------------------------------------------------
// Lámina → rótulo, entidades y recompute
// ---------------------------------------------------------------------------

/** Campos de la lámina que salen del rótulo. */
type CamposRotulo = Pick<
  Lamina,
  'codigo' | 'titulo' | 'disciplina' | 'tipo' | 'escala' | 'escalaConfiable' | 'revision'
>;

/**
 * El agente completa, nunca borra: si no leyó un campo, queda el que estaba
 * (que puede ser el que cargó el arquitecto). Y `escalaConfiable` es de una
 * sola vía — una escala confirmada a mano no la "des-confirma" un re-análisis,
 * que es lo que hace que el desbloqueo de RF-201 sobreviva a un reproceso.
 */
export function fusionarRotulo(lamina: Lamina, rotulo: RotuloDetectado): CamposRotulo {
  return {
    codigo: rotulo.codigo ?? lamina.codigo,
    titulo: rotulo.titulo ?? lamina.titulo,
    disciplina: rotulo.disciplina ?? lamina.disciplina,
    tipo: rotulo.tipoLamina ?? lamina.tipo,
    escala: rotulo.escala ?? lamina.escala,
    escalaConfiable: rotulo.escalaConfiable || lamina.escalaConfiable,
    revision: rotulo.revision ?? lamina.revision,
  };
}

/** Sin bbox no hay entidad (`src/lib/analysis/CLAUDE.md` §1): el pipeline la descarta. */
export function tieneBBoxUtil(bbox: BBox | undefined): bbox is BBox {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  if (!bbox.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) {
    return false;
  }
  const [, , ancho, alto] = bbox;
  return ancho > 0 && alto > 0;
}

function claveDeEntidad(tipo: string, nombre: string): string {
  return `${tipo}\u0000${nombre}`;
}

/**
 * Reemplaza las entidades de la lámina por las recién detectadas, **conservando
 * el id** de las que vuelven a aparecer (mismo tipo y mismo nombre).
 *
 * Borrar e insertar sería más corto y estaría mal: `computo_items.entidad_id` y
 * `hallazgos.target_ref` apuntan a esos ids, y un reproceso los dejaría
 * colgando. Con el match por `tipo|nombre` un reproceso idéntico no mueve un id.
 */
async function sincronizarEntidades(
  db: Db,
  lamina: Lamina,
  detectadas: readonly EntidadDetectada[],
): Promise<{ creadas: number; actualizadas: number; eliminadas: number }> {
  const previas = await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id));

  const pool = new Map<string, Entidad[]>();
  for (const previa of previas) {
    const clave = claveDeEntidad(previa.tipo, previa.nombre);
    const cola = pool.get(clave);
    if (cola) cola.push(previa);
    else pool.set(clave, [previa]);
  }

  const conservadas = new Set<string>();
  let creadas = 0;
  let actualizadas = 0;

  for (const detectada of detectadas) {
    const valores: Omit<NuevaEntidad, 'id'> = {
      obraId: lamina.obraId,
      laminaId: lamina.id,
      tipo: detectada.tipo,
      nombre: detectada.nombre,
      atributosJson: detectada.atributos,
      estadoReforma: detectada.estadoReforma,
      // P1: la entidad y su provenance son el mismo dato.
      fuentesJson: [{ laminaId: lamina.id, bbox: detectada.bbox, detalle: detectada.nombre }],
      confianza: detectada.confianza,
    };

    const previa = pool.get(claveDeEntidad(detectada.tipo, detectada.nombre))?.shift();
    if (!previa) {
      await db.insert(entidades).values(valores);
      creadas += 1;
      continue;
    }

    conservadas.add(previa.id);
    const cambio =
      JSON.stringify(previa.atributosJson) !== JSON.stringify(valores.atributosJson) ||
      JSON.stringify(previa.fuentesJson) !== JSON.stringify(valores.fuentesJson) ||
      previa.estadoReforma !== valores.estadoReforma ||
      previa.confianza !== valores.confianza;
    if (!cambio) continue;

    await db.update(entidades).set(valores).where(eq(entidades.id, previa.id));
    actualizadas += 1;
  }

  const sobrantes = previas.filter((previa) => !conservadas.has(previa.id)).map((e) => e.id);
  if (sobrantes.length > 0) {
    await desvincularItemsDeEntidades(db, lamina.obraId, sobrantes);
    await db.delete(entidades).where(inArray(entidades.id, sobrantes));
  }

  return { creadas, actualizadas, eliminadas: sobrantes.length };
}

async function upsertHallazgoEscala(db: Db, lamina: Lamina): Promise<void> {
  const clave = claveEscala(lamina.id);
  const [previo] = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, lamina.obraId), eq(hallazgos.clave, clave)));

  if (!previo) {
    await db.insert(hallazgos).values({
      obraId: lamina.obraId,
      clave,
      tipo: 'faltante',
      rubro: null,
      descripcion: DESCRIPCION_ESCALA_BLOQUEADA,
      checklistItem: 'escala',
      // La consulta es sobre la lámina entera: la fuente es la lámina completa.
      laminasJson: [{ laminaId: lamina.id, bbox: [0, 0, 1, 1], detalle: 'Lámina completa' }],
      targetRef: null,
      bloqueante: true,
    });
    await auditarAgente(lamina.obraId, 'hallazgo_abierto', `hallazgos:${clave}`, {
      tipo: 'faltante',
      bloqueante: true,
    });
    return;
  }

  // La lámina volvió a quedar sin escala confiable: la consulta vuelve a estar viva.
  if (previo.estado === 'abierto') return;
  await db
    .update(hallazgos)
    .set({ estado: 'abierto', respuestaJson: null, resueltoPor: null })
    .where(eq(hallazgos.id, previo.id));
  await auditarAgente(lamina.obraId, 'hallazgo_reabierto', `hallazgos:${clave}`, {
    motivo: 'La lámina volvió a quedar sin escala confiable.',
  });
}

async function cerrarHallazgoEscala(db: Db, lamina: Lamina): Promise<void> {
  const clave = claveEscala(lamina.id);
  const [previo] = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, lamina.obraId), eq(hallazgos.clave, clave)));

  if (!previo || previo.estado !== 'abierto') return;

  await db
    .update(hallazgos)
    .set({ estado: 'descartado', respuestaJson: { ...RESPUESTA_ESCALA_CONFIRMADA } })
    .where(eq(hallazgos.id, previo.id));
  await auditarAgente(lamina.obraId, 'hallazgo_descartado', `hallazgos:${clave}`, {
    ...RESPUESTA_ESCALA_CONFIRMADA,
  });
}

/** Cuándo arrancó el análisis que dejó la lámina en `procesando`, si lo sabemos. */
async function inicioDelProcesamiento(db: Db, laminaId: string): Promise<Date | null> {
  const [ultimo] = await db
    .select({ at: auditoria.at })
    .from(auditoria)
    .where(
      and(eq(auditoria.targetRef, `laminas:${laminaId}`), eq(auditoria.accion, ACCION_PROCESANDO)),
    )
    .orderBy(desc(auditoria.at))
    .limit(1);
  return ultimo?.at ?? null;
}

/**
 * Toma la lámina para analizarla, o devuelve `null` si ya la tiene otra corrida.
 *
 * El `UPDATE ... WHERE estado_analisis <> 'procesando' RETURNING` es la
 * exclusión mutua: la base decide un único ganador aunque lleguen dos requests
 * juntos (doble click, dos pestañas, un reintento encima del original). Sin
 * esto, las dos corridas extraerían entidades de la misma lámina en paralelo y
 * el `sincronizarEntidades` de cada una vería un pool distinto: entidades
 * duplicadas y cantidades duplicadas en la planilla, en silencio.
 *
 * Si el estado quedó colgado de un proceso muerto, pasado `TTL_PROCESANDO_MS`
 * la corrida siguiente lo retoma (el arranque queda fechado en `auditoria`, que
 * es el único reloj que tenemos: `laminas` no tiene `updated_at`, y esa columna
 * es de la Tarea 2). Dos procesos podrían decidir el rescate a la vez, pero
 * hace falta que los dos lleguen dentro del mismo milisegundo *y* quince
 * minutos después del cuelgue; el caso frecuente —dos clicks seguidos— lo cubre
 * el guard de arriba.
 */
async function reclamarLamina(db: Db, laminaId: string): Promise<Lamina | null> {
  const [tomada] = await db
    .update(laminas)
    .set({ estadoAnalisis: 'procesando', errorDetalle: null })
    .where(and(eq(laminas.id, laminaId), ne(laminas.estadoAnalisis, 'procesando')))
    .returning();

  if (tomada) {
    await auditarAgente(tomada.obraId, ACCION_PROCESANDO, `laminas:${laminaId}`, {
      numeroPagina: tomada.numeroPagina,
      retomada: false,
    });
    return tomada;
  }

  const [existente] = await db.select().from(laminas).where(eq(laminas.id, laminaId));
  if (!existente) throw new LaminaInexistenteError(laminaId);

  const desde = await inicioDelProcesamiento(db, laminaId);
  if (desde === null || Date.now() - desde.getTime() <= TTL_PROCESANDO_MS) {
    await auditarAgente(existente.obraId, 'lamina_procesamiento_omitido', `laminas:${laminaId}`, {
      motivo: 'Ya hay un análisis en curso para esta lámina.',
      desde: desde?.toISOString() ?? null,
    });
    return null;
  }

  const [retomada] = await db
    .update(laminas)
    .set({ estadoAnalisis: 'procesando', errorDetalle: null })
    .where(eq(laminas.id, laminaId))
    .returning();
  await auditarAgente(retomada.obraId, ACCION_PROCESANDO, `laminas:${laminaId}`, {
    numeroPagina: retomada.numeroPagina,
    retomada: true,
    colgadaDesde: desde.toISOString(),
  });
  return retomada;
}

/**
 * Corre el recompute de la obra sin arrastrar a la lámina si falla.
 *
 * El análisis de la lámina ya terminó y está guardado: marcarla `error` porque
 * el recompute no pudo con la obra sería mentir sobre qué se rompió y borraría
 * el trabajo bueno en el próximo reproceso. El fallo queda como lo que es —el
 * cómputo de la obra quedó sin recalcular— en su propia auditoría
 * (`recomputo_fallido`) y en el `error_detalle` de la lámina, que es donde la
 * pantalla lo puede mostrar. La reparación es volver a correr el recompute:
 * `recomputarObra` es idempotente.
 */
async function recomputarTolerante(entorno: Entorno, lamina: Lamina): Promise<boolean> {
  try {
    await entorno.recomputar(lamina.obraId, { db: entorno.db });
    return true;
  } catch (error) {
    const errorDetalle = detalleDeError(error);
    await entorno.db
      .update(laminas)
      .set({ errorDetalle: `${PREFIJO_RECOMPUTO_FALLIDO}${errorDetalle}` })
      .where(eq(laminas.id, lamina.id));
    await auditarAgente(lamina.obraId, 'recomputo_fallido', `obras:${lamina.obraId}`, {
      laminaId: lamina.id,
      errorDetalle,
      motivo: 'La lámina quedó analizada; el cómputo de la obra quedó sin recalcular.',
    });
    return false;
  }
}

/** Corridas de `procesarLamina` en vuelo en este proceso, por lámina. */
const enVuelo = new Map<string, Promise<void>>();

/**
 * Analiza una lámina de punta a punta. Idempotente: correrla dos veces sobre la
 * misma lámina deja exactamente el mismo estado.
 *
 * Nunca lanza por un fallo del análisis (PDF ilegible, provider caído): eso
 * queda escrito en la propia lámina como `error` + `error_detalle`.
 *
 * Dos llamadas encimadas sobre la misma lámina no la analizan dos veces: dentro
 * del proceso la segunda se cuelga de la primera y espera su resultado; entre
 * procesos decide la base (`reclamarLamina`) y la segunda no hace nada.
 */
export function procesarLamina(laminaId: string, deps: DepsPipeline = {}): Promise<void> {
  const enCurso = enVuelo.get(laminaId);
  if (enCurso) return enCurso;

  const corrida = analizarLamina(laminaId, deps).finally(() => {
    enVuelo.delete(laminaId);
  });
  enVuelo.set(laminaId, corrida);
  return corrida;
}

async function analizarLamina(laminaId: string, deps: DepsPipeline): Promise<void> {
  const entorno = await resolver(deps);
  const { db, storage, provider } = entorno;

  const lamina = await reclamarLamina(db, laminaId);
  if (!lamina) return;

  try {
    const [documento] = await db
      .select()
      .from(documentos)
      .where(eq(documentos.id, lamina.documentoId));
    const [obra] = await db.select().from(obras).where(eq(obras.id, lamina.obraId));
    if (!documento || !obra) throw new LaminaInexistenteError(laminaId);

    const pdfBytes = await storage.leer(lamina.archivoRef);
    const entrada: LaminaInput = {
      laminaId,
      pdfBytes,
      documentoNombre: documento.nombreArchivo,
      numeroPagina: lamina.numeroPagina,
      textoExtraido: await extraerTexto(pdfBytes),
    };

    const campos = fusionarRotulo(lamina, await provider.leerRotulo(entrada));

    if (!campos.escalaConfiable) {
      // RF-201: sin escala verificada no se mide nada. Si la lámina traía
      // entidades de una corrida anterior, se van con ella.
      const { eliminadas } = await sincronizarEntidades(db, lamina, []);
      await db
        .update(laminas)
        .set({ ...campos, estadoAnalisis: 'bloqueada_escala', errorDetalle: null })
        .where(eq(laminas.id, laminaId));
      await upsertHallazgoEscala(db, lamina);
      const recomputado = eliminadas === 0 || (await recomputarTolerante(entorno, lamina));
      await auditarAgente(lamina.obraId, 'lamina_bloqueada_escala', `laminas:${laminaId}`, {
        escala: campos.escala,
        entidadesEliminadas: eliminadas,
        recomputado,
      });
      return;
    }

    const detectadas = await provider.extraerEntidades(entrada, {
      obraId: obra.id,
      tipoObra: obra.tipo,
    });
    const validas = detectadas.filter((entidad) => tieneBBoxUtil(entidad.bbox));
    const descartadas = detectadas.length - validas.length;
    if (descartadas > 0) {
      await auditarAgente(lamina.obraId, 'entidades_descartadas', `laminas:${laminaId}`, {
        motivo: 'Entidades sin bbox utilizable: sin provenance no entran a la base (P1).',
        descartadas,
        nombres: detectadas
          .filter((entidad) => !tieneBBoxUtil(entidad.bbox))
          .map((entidad) => entidad.nombre),
      });
    }

    const resumen = await sincronizarEntidades(db, lamina, validas);
    await db
      .update(laminas)
      .set({ ...campos, estadoAnalisis: 'analizada', errorDetalle: null })
      .where(eq(laminas.id, laminaId));
    await cerrarHallazgoEscala(db, lamina);
    const recomputado = await recomputarTolerante(entorno, lamina);

    await auditarAgente(lamina.obraId, 'lamina_analizada', `laminas:${laminaId}`, {
      codigo: campos.codigo,
      titulo: campos.titulo,
      escala: campos.escala,
      entidades: validas.length,
      ...resumen,
      descartadas,
      recomputado,
    });
  } catch (error) {
    const errorDetalle = detalleDeError(error);
    await db
      .update(laminas)
      .set({ estadoAnalisis: 'error', errorDetalle })
      .where(eq(laminas.id, laminaId));
    await auditarAgente(lamina.obraId, 'lamina_error', `laminas:${laminaId}`, { errorDetalle });
  }
}

// ---------------------------------------------------------------------------
// Clasificación y desbloqueo manual (RF-104 / RF-201)
// ---------------------------------------------------------------------------

/**
 * Payload del PATCH de lámina. `escalaConfiable` solo acepta `true`: el
 * arquitecto puede confirmar una escala, no puede "desconfirmar" la que el
 * análisis verificó contra las cotas.
 */
export const zCambiosLamina = z
  .object({
    disciplina: z.enum(DISCIPLINAS).optional(),
    tipo: z.enum(TIPOS_LAMINA).optional(),
    escala: z
      .string()
      .trim()
      .min(1, 'Escribí la escala, por ejemplo 1:100.')
      .max(40, 'La escala no puede pasar de 40 caracteres.')
      .optional(),
    escalaConfiable: z.literal(true).optional(),
  })
  .refine((cambios) => Object.values(cambios).some((valor) => valor !== undefined), {
    error: 'No mandaste ningún cambio.',
  });

export type CambiosLamina = z.infer<typeof zCambiosLamina>;

export interface ActorUsuario {
  usuarioId: string;
  email: string;
}

/**
 * Aplica la clasificación manual y, si el arquitecto confirmó la escala de una
 * lámina bloqueada, vuelve a dispararle el análisis.
 */
export async function actualizarLamina(
  db: Db,
  laminaId: string,
  cambios: CambiosLamina,
  actor: ActorUsuario,
  deps: DepsPipeline = {},
): Promise<Lamina> {
  const [previa] = await db.select().from(laminas).where(eq(laminas.id, laminaId));
  if (!previa) throw new LaminaInexistenteError(laminaId);

  const set: Partial<Pick<Lamina, 'disciplina' | 'tipo' | 'escala' | 'escalaConfiable'>> = {};
  if (cambios.disciplina !== undefined) set.disciplina = cambios.disciplina;
  if (cambios.tipo !== undefined) set.tipo = cambios.tipo;
  if (cambios.escala !== undefined) set.escala = cambios.escala;
  if (cambios.escalaConfiable === true) set.escalaConfiable = true;

  const desbloquea = cambios.escalaConfiable === true && !previa.escalaConfiable;

  if (Object.keys(set).length > 0) {
    await db.update(laminas).set(set).where(eq(laminas.id, laminaId));
    await registrarAuditoria({
      obraId: previa.obraId,
      actorTipo: 'usuario',
      actorNombre: actor.email,
      accion: desbloquea ? 'lamina_escala_confirmada' : 'lamina_clasificada',
      targetRef: `laminas:${laminaId}`,
      diff: { ...set },
    });
  }

  if (desbloquea) await procesarLamina(laminaId, { db, ...deps });

  const [actualizada] = await db.select().from(laminas).where(eq(laminas.id, laminaId));
  return actualizada;
}

// ---------------------------------------------------------------------------

function auditarAgente(
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
