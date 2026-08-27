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
 *  2. **Sin escala DECLARADA no se computa (RF-201 + decisión 1).** Medir sobre
 *     una escala desconocida sería inventar (P4), así que una lámina que no
 *     declara ninguna escala queda `bloqueada_escala`, con un hallazgo
 *     bloqueante y sin entidades, hasta que el arquitecto la desbloquee. Pero
 *     una lámina que **sí** declara escala en el rótulo y que el modelo no pudo
 *     verificar contra las cotas ya no se bloquea: se analiza y se computa con
 *     la escala declarada, y lo que queda abierto es un **supuesto** —no
 *     bloqueante— con esa escala propuesta para confirmar de un click. Ver
 *     `modoEscala`.
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
  computoItems,
  documentos,
  entidades,
  hallazgos,
  laminas,
  obras,
  recomputos,
  usuarios,
  type ComputoItem,
  type Documento,
  type Entidad,
  type Lamina,
  type NuevaEntidad,
  type Obra,
} from '@/db/schema';
import { getAnalysisProvider, type AnalysisProvider } from '@/lib/analysis/index';
import { textoInstrucciones } from '@/lib/analysis/prompt';
import { registrarAuditoria } from '@/lib/audit';
import { separarPaginas } from '@/lib/pdf/split';
import { extraerTexto } from '@/lib/pdf/texto';
import { buscarDatosFaltantes } from '@/lib/pipeline/busqueda';
import { claveEscala } from '@/lib/pipeline/claves';
import { igualJson } from '@/lib/pipeline/json';
import { MIME_PDF, refDocumento, refLamina } from '@/lib/pipeline/refs';
import {
  ACTOR_PIPELINE,
  borrarDeduccionesDeEntidades,
  comoItemComputo,
  desvincularItemsDeEntidades,
  diferenciasDeItem,
  recomputarObra,
} from '@/lib/pipeline/recomputar';
import { leerResumen, persistirResumen } from '@/lib/pipeline/resumen';
import { leerConfig } from '@/lib/plataforma/config-estudio';
import { getStorage, type StorageAdapter } from '@/lib/storage/index';
import { DISCIPLINAS, TIPOS_LAMINA } from '@/types/domain';
import type {
  BBox,
  EntidadDetectada,
  LaminaInput,
  ObraContexto,
  RotuloDetectado,
  RubroId,
  TipoHallazgo,
  Unidad,
  ValorPropuesto,
} from '@/types/domain';

/** 60 MB: un legajo de plantas grande entra; un video, no. */
export const TAMANO_MAXIMO_BYTES = 60 * 1024 * 1024;

/** Todo PDF arranca con esta firma. El `Content-Type` del cliente no se cree. */
const FIRMA_PDF = '%PDF-';

/** Texto del hallazgo de bloqueo por escala (RF-201): la lámina no declara ninguna. */
export const DESCRIPCION_ESCALA_BLOQUEADA =
  'La lámina no tiene escala confiable; indicá la escala o una medida de referencia.';

/**
 * Texto del supuesto de escala asumida (decisión 1).
 *
 * Dice las tres cosas que el arquitecto necesita saber para decidir en un
 * segundo: **qué leí**, **que no lo pude verificar** y **que igual computé con
 * eso**. El reclamo que lo originó fue literal: "podía confirmarlo sin mí, para
 * algo estoy pagando los créditos". Pedirle que tipee de cero una escala que el
 * rótulo declara y que el sistema ya leyó es trabajo que el sistema le está
 * pasando a él.
 */
export function descripcionEscalaAsumida(escala: string): string {
  return (
    `Leí la escala ${escala} en el rótulo pero no la pude verificar contra cotas. ` +
    'Analicé la lámina asumiendo esa escala: confirmala o corregila.'
  );
}

/** Respuesta con la que el desbloqueo manual cierra el hallazgo de escala. */
export const RESPUESTA_ESCALA_CONFIRMADA = { auto: 'escala confirmada a mano' } as const;

/** Acción con la que queda registrado el arranque del análisis de una lámina. */
export const ACCION_PROCESANDO = 'lamina_procesando';

/** Acción con la que queda registrado que la búsqueda dirigida no pudo correr. */
export const ACCION_BUSQUEDA_FALLIDA = 'busqueda_fallida';

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
  recomputar?: (obraId: string, deps: { db: Db; resumen?: boolean }) => Promise<unknown>;
  /**
   * Si el resumen ejecutivo (RF-205) se rehace al terminar de analizar la
   * lámina. Default `true`: analizar una lámina suelta —el arquitecto confirmó
   * la escala, la API reprocesa— cambia el estado de la obra y la pantalla del
   * expediente tiene que reflejarlo.
   *
   * `procesarDocumento` lo apaga durante su loop y rehace el resumen **una sola
   * vez** al final, con todas las láminas analizadas: N resúmenes a medio hacer
   * serían ruido en `auditoria` y en la pantalla.
   */
  resumen?: boolean;
  /**
   * La búsqueda dirigida (C2) que corre al final de `procesarDocumento`, con
   * toda la obra analizada y la bandeja ya abierta. Default:
   * `buscarDatosFaltantes`.
   *
   * Es la misma clase de costura que `recomputar`: existe para poder contar las
   * llamadas y ejercitar el camino de "la búsqueda se cayó" sin salir a la red.
   */
  buscar?: (obraId: string, deps: { db: Db; storage: StorageAdapter }) => Promise<unknown>;
}

interface Entorno {
  db: Db;
  storage: StorageAdapter;
  provider: AnalysisProvider;
  recomputar: NonNullable<DepsPipeline['recomputar']>;
  resumen: boolean;
  buscar: NonNullable<DepsPipeline['buscar']>;
}

async function resolver(deps: DepsPipeline): Promise<Entorno> {
  return {
    db: deps.db ?? (await getDb()),
    storage: deps.storage ?? getStorage(),
    provider: deps.provider ?? getAnalysisProvider(),
    recomputar: deps.recomputar ?? recomputarObra,
    resumen: deps.resumen ?? true,
    buscar: deps.buscar ?? buscarDatosFaltantes,
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
// Diff de revisiones (RF-308)
// ---------------------------------------------------------------------------

/** Por qué se recalculó la obra: la subida de una revisión, o un reproceso. */
export type MotivoRecomputo = 'reproceso' | 'revision_nueva';

export type EstadoCambio = 'agregado' | 'modificado' | 'anulado';

/** Un ítem de la planilla que quedó distinto después de procesar el documento. */
export interface CambioDeRevision {
  claveItem: string;
  rubro: RubroId;
  descripcion: string;
  unidad: Unidad;
  estado: EstadoCambio;
  cantCompraAntes: number | null;
  cantCompraDespues: number | null;
  /** El diff campo a campo, el mismo que el recompute deja en `auditoria`. */
  campos: Record<string, unknown>;
}

/** Lo que se guarda en `recomputos.diff_json`. */
export interface DiffDeRevision {
  documentoId: string;
  documentoNombre: string;
  version: number;
  cambios: CambioDeRevision[];
  [clave: string]: unknown;
}

/** Los ítems **activos** de la obra por clave: lo que la planilla muestra hoy. */
async function fotoDeItems(db: Db, obraId: string): Promise<Map<string, ComputoItem>> {
  const filas = await db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.estado, 'activo')));
  return new Map(filas.map((fila) => [fila.claveItem, fila]));
}

/**
 * Qué cambió en la planilla entre dos fotos, ordenado por clave.
 *
 * La comparación campo a campo es la **misma** que usa el recompute para
 * auditar (`diferenciasDeItem`): si algún día cambia qué se considera un cambio,
 * cambia en un solo lugar y las dos pantallas siguen diciendo lo mismo.
 */
export function diffDeRevision(
  antes: ReadonlyMap<string, ComputoItem>,
  despues: ReadonlyMap<string, ComputoItem>,
): CambioDeRevision[] {
  const claves = [...new Set([...antes.keys(), ...despues.keys()])].sort((a, b) =>
    a.localeCompare(b, 'es-AR'),
  );

  const cambios: CambioDeRevision[] = [];
  for (const claveItem of claves) {
    const previo = antes.get(claveItem);
    const actual = despues.get(claveItem);

    if (previo && actual) {
      const campos = diferenciasDeItem(previo, comoItemComputo(actual));
      if (campos === null) continue;
      cambios.push({
        claveItem,
        rubro: actual.rubro,
        descripcion: actual.descripcion,
        unidad: actual.unidad,
        estado: 'modificado',
        cantCompraAntes: previo.cantCompra,
        cantCompraDespues: actual.cantCompra,
        campos,
      });
      continue;
    }

    if (actual) {
      cambios.push({
        claveItem,
        rubro: actual.rubro,
        descripcion: actual.descripcion,
        unidad: actual.unidad,
        estado: 'agregado',
        cantCompraAntes: null,
        cantCompraDespues: actual.cantCompra,
        campos: {},
      });
      continue;
    }

    if (previo) {
      cambios.push({
        claveItem,
        rubro: previo.rubro,
        descripcion: previo.descripcion,
        unidad: previo.unidad,
        estado: 'anulado',
        cantCompraAntes: previo.cantCompra,
        cantCompraDespues: null,
        campos: {},
      });
    }
  }

  return cambios;
}

/**
 * Deja en `recomputos` lo que este documento le hizo a la planilla.
 *
 * Es la memoria de "qué cambió" que la pantalla del expediente muestra después
 * de subir una revisión (RF-308): la auditoría guarda el detalle ítem por ítem
 * —una fila por cada uno—, y esto guarda **la corrida entera**, que es lo que se
 * puede leer de un vistazo. Sin cambios no escribe: una revisión que no movió un
 * número no tiene nada que contar.
 */
async function registrarRecomputo(
  db: Db,
  documento: Documento,
  motivo: MotivoRecomputo,
  antes: ReadonlyMap<string, ComputoItem>,
): Promise<void> {
  const cambios = diffDeRevision(antes, await fotoDeItems(db, documento.obraId));
  if (cambios.length === 0) return;

  const diff: DiffDeRevision = {
    documentoId: documento.id,
    documentoNombre: documento.nombreArchivo,
    version: documento.version,
    cambios,
  };

  await db.insert(recomputos).values({ obraId: documento.obraId, diffJson: diff, motivo });
  await auditarAgente(documento.obraId, 'recomputo_registrado', `documentos:${documento.id}`, {
    motivo,
    cambios: cambios.length,
    claves: cambios.map((cambio) => cambio.claveItem),
  });
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

  // La foto de la planilla ANTES de tocar nada: es la mitad izquierda del "qué
  // cambió" (RF-308). Un documento que se procesa por primera vez y que trae una
  // versión mayor a la 1 es una revisión nueva; todo lo demás es un reproceso.
  const antes = await fotoDeItems(db, obra.id);
  const motivo: MotivoRecomputo =
    documento.version > 1 && existentes.length === 0 ? 'revision_nueva' : 'reproceso';

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
    // `resumen: false`: el resumen se publica una sola vez, más abajo.
    await procesarLamina(laminaId, { ...entorno, resumen: false });
  }

  // RF-308: qué le hizo este documento a la planilla, para la pantalla "Qué
  // cambió". Va antes del resumen porque el resumen es la foto final y esto es
  // el movimiento.
  await registrarRecomputo(db, documento, motivo, antes);

  // RF-205: el resumen ejecutivo se rehace recién acá, con todas las láminas del
  // documento analizadas y el cómputo ya sincronizado. Hacerlo por lámina sería
  // publicar N resúmenes a medio hacer.
  await resumirTolerante(db, obra.id);

  // C2: y recién ahora, con la bandeja abierta, se sale a buscar en la
  // documentación lo que la bandeja está preguntando. Va último a propósito:
  // antes del recompute no existe la lista de lo que falta.
  await buscarTolerante(entorno, obra.id);
}

/**
 * Rehace el resumen sin arrastrar al documento si falla.
 *
 * Mismo criterio que `recomputarTolerante`: el análisis ya está guardado y el
 * resumen es una vista derivada; que no se pueda regenerar es algo para mirar
 * (queda en `auditoria`), no un motivo para marcar el documento como roto. La
 * reparación es volver a correrlo: `persistirResumen` es idempotente.
 */
async function resumirTolerante(db: Db, obraId: string): Promise<void> {
  try {
    await persistirResumen(db, obraId);
  } catch (error) {
    await auditarAgente(obraId, 'resumen_fallido', `obras:${obraId}`, {
      errorDetalle: detalleDeError(error),
      motivo: 'El análisis terminó bien; el resumen ejecutivo quedó sin actualizar.',
    });
  }
}

/**
 * Corre la búsqueda dirigida sin arrastrar al documento si falla.
 *
 * Mismo criterio que `resumirTolerante` y `recomputarTolerante`, y acá pesa más
 * que en ninguno: la búsqueda sale a la red a releer láminas y es lo **último**
 * que pasa en la subida. Un timeout del provider no puede convertir un
 * documento que se analizó y se computó bien en un upload fallido. Lo que se
 * pierde si falla es una propuesta —la consulta sigue en la bandeja como
 * pregunta, que es el estado honesto— y el fallo queda en `auditoria`.
 *
 * La reparación es volver a correrla: el botón de la bandeja la dispara a mano
 * y `buscarDatosFaltantes` es idempotente.
 */
async function buscarTolerante(entorno: Entorno, obraId: string): Promise<void> {
  try {
    await entorno.buscar(obraId, { db: entorno.db, storage: entorno.storage });
  } catch (error) {
    await auditarAgente(obraId, ACCION_BUSQUEDA_FALLIDA, `obras:${obraId}`, {
      errorDetalle: detalleDeError(error),
      motivo: 'El documento se analizó y se computó bien; la búsqueda dirigida no corrió.',
    });
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
 *
 * **La escala ya confirmada tampoco la pisa el rótulo**, por el mismo motivo:
 * el supuesto de escala asumida se cierra con "confirmala o **corregila**", y
 * si el re-análisis volviera a escribir el `1:20` mal impreso del rótulo encima
 * del `1:25` que el arquitecto corrigió, la corrección duraría hasta el próximo
 * reproceso y él no se enteraría. Con `escala_confiable = false` manda el
 * rótulo, como siempre: ahí nadie confirmó nada todavía.
 */
export function fusionarRotulo(lamina: Lamina, rotulo: RotuloDetectado): CamposRotulo {
  return {
    codigo: rotulo.codigo ?? lamina.codigo,
    titulo: rotulo.titulo ?? lamina.titulo,
    disciplina: rotulo.disciplina ?? lamina.disciplina,
    tipo: rotulo.tipoLamina ?? lamina.tipo,
    escala: lamina.escalaConfiable
      ? (lamina.escala ?? rotulo.escala)
      : (rotulo.escala ?? lamina.escala),
    escalaConfiable: rotulo.escalaConfiable || lamina.escalaConfiable,
    revision: rotulo.revision ?? lamina.revision,
  };
}

/**
 * Las tres salidas de escala de una lámina (decisión 1 del plan).
 *
 *  - `confiable`: el modelo verificó la escala declarada contra las cotas (o el
 *    arquitecto la confirmó a mano). Se analiza y no queda ninguna consulta.
 *  - `asumida`: el rótulo **declara** una escala que no se pudo verificar. Se
 *    analiza y se computa igual, con esa escala asumida, y queda un supuesto no
 *    bloqueante con la escala propuesta. Antes esto bloqueaba la lámina y le
 *    hacía tipear a mano un dato que el sistema ya había leído.
 *  - `bloqueada`: no hay ninguna escala declarada. Acá sí no hay nada que
 *    asumir: medir sería inventar (P4) y la lámina queda trabada (RF-201).
 *
 * Una escala en blanco (`'   '`) es lo mismo que no tenerla: no se puede
 * proponer confirmar la nada.
 */
export type ModoEscala = 'confiable' | 'asumida' | 'bloqueada';

export function modoEscala(campos: Pick<CamposRotulo, 'escala' | 'escalaConfiable'>): ModoEscala {
  if (campos.escalaConfiable) return 'confiable';
  return campos.escala !== null && campos.escala.trim() !== '' ? 'asumida' : 'bloqueada';
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

/**
 * Clave de identidad de una entidad dentro de una lámina, solo para agrupar en
 * memoria. El separador es `::` y no un byte NUL: un NUL en el fuente le da a
 * `git diff` un archivo binario y lo esconde de `grep`. No hay ambigüedad
 * posible porque `tipo` sale de un enum cerrado y ninguno de sus valores lleva
 * `:`, así que el primer `::` siempre parte donde corresponde.
 */
function claveDeEntidad(tipo: string, nombre: string): string {
  return `${tipo}::${nombre}`;
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
    // `igualJson` y no `JSON.stringify`: `previa` viene de un `jsonb` con las
    // claves reordenadas por Postgres y `valores` recién armado acá. Comparar
    // texto daría "cambió" siempre y reescribiría la lámina entera en cada
    // corrida (ver `@/lib/pipeline/json`).
    const cambio =
      !igualJson(previa.atributosJson, valores.atributosJson) ||
      !igualJson(previa.fuentesJson, valores.fuentesJson) ||
      previa.estadoReforma !== valores.estadoReforma ||
      previa.confianza !== valores.confianza;
    if (!cambio) continue;

    await db.update(entidades).set(valores).where(eq(entidades.id, previa.id));
    actualizadas += 1;
  }

  const sobrantes = previas.filter((previa) => !conservadas.has(previa.id)).map((e) => e.id);
  if (sobrantes.length > 0) {
    await desvincularItemsDeEntidades(db, lamina.obraId, sobrantes);
    // `deducciones.entidad_id` es una FK NOT NULL: lo que se dijo de una entidad
    // que ya no está no se puede quedar apuntando a la nada (queda auditado).
    await borrarDeduccionesDeEntidades(db, lamina.obraId, sobrantes);
    await db.delete(entidades).where(inArray(entidades.id, sobrantes));
  }

  return { creadas, actualizadas, eliminadas: sobrantes.length };
}

/** Lo que distingue a las dos consultas de escala: la de bloqueo y el supuesto. */
interface CamposEscala {
  tipo: TipoHallazgo;
  descripcion: string;
  bloqueante: boolean;
  valorPropuestoJson: ValorPropuesto | null;
}

/**
 * La consulta que le corresponde a cada modo.
 *
 * `targetRef` es `null` en los dos: la escala no es un campo de ninguna entidad
 * y confirmarla no se escribe en `atributos_json` sino en la lámina. Por eso la
 * propuesta viaja igual (`valores.escala`) pero el que la confirma es el botón
 * «Confirmar escala» y no `confirmarSupuesto` (decisión 7).
 */
function camposDeEscala(
  modo: 'asumida' | 'bloqueada',
  escala: string | null,
  confianza: number | null,
): CamposEscala {
  if (modo === 'bloqueada' || escala === null) {
    return {
      tipo: 'faltante',
      descripcion: DESCRIPCION_ESCALA_BLOQUEADA,
      bloqueante: true,
      valorPropuestoJson: null,
    };
  }

  return {
    tipo: 'supuesto',
    descripcion: descripcionEscalaAsumida(escala),
    // NO bloqueante: la lámina se computó. Es la mitad del cambio — si siguiera
    // bloqueando, el rubro seguiría sin poder aprobarse por una escala que el
    // sistema ya leyó.
    bloqueante: false,
    valorPropuestoJson: {
      valores: { escala },
      origen: 'rotulo',
      ...(confianza !== null ? { confianza } : {}),
    },
  };
}

/**
 * Abre —o pone al día— la consulta de escala de la lámina.
 *
 * Cubre las dos transiciones que aparecen al reprocesar: una lámina bloqueada
 * cuya revisión nueva sí declara escala pasa de consulta bloqueante a supuesto,
 * y al revés. Las dos se resuelven **sobre la fila abierta**, que es la que el
 * arquitecto está mirando: la clave `escala.<laminaId>` es única por obra.
 *
 * **Lo que el arquitecto cerró no se reabre.** Antes, una consulta cerrada se
 * volvía a abrir "porque la lámina sigue sin escala confiable", y con la escala
 * asumida eso sería insistir en cada reproceso con un supuesto que él ya
 * descartó a propósito. El camino que justificaba reabrir no existe:
 * `escala_confiable` es de una sola vía (`fusionarRotulo`), así que una consulta
 * que el pipeline cerró solo jamás vuelve a hacer falta, y la única forma de
 * tener una cerrada con la lámina sin confirmar es que él la haya descartado.
 */
async function upsertHallazgoEscala(
  db: Db,
  lamina: Lamina,
  modo: 'asumida' | 'bloqueada',
  escala: string | null,
  confianza: number | null,
): Promise<void> {
  const clave = claveEscala(lamina.id);
  const campos = camposDeEscala(modo, escala, confianza);
  const [previo] = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, lamina.obraId), eq(hallazgos.clave, clave)));

  if (!previo) {
    await db.insert(hallazgos).values({
      obraId: lamina.obraId,
      clave,
      rubro: null,
      checklistItem: 'escala',
      // La consulta es sobre la lámina entera: la fuente es la lámina completa.
      laminasJson: [{ laminaId: lamina.id, bbox: [0, 0, 1, 1], detalle: 'Lámina completa' }],
      targetRef: null,
      ...campos,
    });
    await auditarAgente(lamina.obraId, 'hallazgo_abierto', `hallazgos:${clave}`, {
      tipo: campos.tipo,
      bloqueante: campos.bloqueante,
      modo,
    });
    return;
  }

  if (previo.estado !== 'abierto') return;

  // Sin cambios no se escribe: un reproceso idéntico no puede dejar un diff
  // fantasma en `auditoria` ni mover el `updated_at` de la consulta.
  const igual =
    previo.tipo === campos.tipo &&
    previo.bloqueante === campos.bloqueante &&
    previo.descripcion === campos.descripcion &&
    igualJson(previo.valorPropuestoJson, campos.valorPropuestoJson);
  if (igual) return;

  await db.update(hallazgos).set(campos).where(eq(hallazgos.id, previo.id));
  await auditarAgente(lamina.obraId, 'hallazgo_actualizado', `hallazgos:${clave}`, {
    tipo: { antes: previo.tipo, despues: campos.tipo },
    bloqueante: { antes: previo.bloqueante, despues: campos.bloqueante },
    modo,
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

/**
 * Cuándo arrancó el análisis que dejó la lámina en `procesando`, si lo sabemos.
 *
 * El dato vive en `laminas.procesando_desde`, que la propia reclamación sella.
 * El fallback a `auditoria` es para las filas que quedaron tomadas **antes** de
 * que existiera la columna: para ellas el sello es `null` y el único reloj sigue
 * siendo el registro de auditoría del arranque. Sin ese fallback, una lámina
 * colgada desde antes de la migración no se retomaría nunca.
 */
async function inicioDelProcesamiento(db: Db, lamina: Lamina): Promise<Date | null> {
  if (lamina.procesandoDesde !== null) return lamina.procesandoDesde;

  const [ultimo] = await db
    .select({ at: auditoria.at })
    .from(auditoria)
    .where(
      and(eq(auditoria.targetRef, `laminas:${lamina.id}`), eq(auditoria.accion, ACCION_PROCESANDO)),
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
 * la corrida siguiente lo retoma. El arranque queda fechado en la propia fila
 * (`procesando_desde`), que es el reloj del rescate: se sella acá y se limpia
 * cuando el análisis termina, así que un `procesando_desde` no nulo significa
 * exactamente "alguien la tiene tomada". Dos procesos podrían decidir el rescate
 * a la vez, pero hace falta que los dos lleguen dentro del mismo milisegundo *y*
 * quince minutos después del cuelgue; el caso frecuente —dos clicks seguidos— lo
 * cubre el guard de arriba.
 */
async function reclamarLamina(db: Db, laminaId: string): Promise<Lamina | null> {
  const [tomada] = await db
    .update(laminas)
    .set({ estadoAnalisis: 'procesando', errorDetalle: null, procesandoDesde: new Date() })
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

  const desde = await inicioDelProcesamiento(db, existente);
  if (desde === null || Date.now() - desde.getTime() <= TTL_PROCESANDO_MS) {
    await auditarAgente(existente.obraId, 'lamina_procesamiento_omitido', `laminas:${laminaId}`, {
      motivo: 'Ya hay un análisis en curso para esta lámina.',
      desde: desde?.toISOString() ?? null,
    });
    return null;
  }

  const [retomada] = await db
    .update(laminas)
    .set({ estadoAnalisis: 'procesando', errorDetalle: null, procesandoDesde: new Date() })
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
    // El recompute rehace el resumen, salvo cuando quien manda es
    // `procesarDocumento`, que lo apaga acá y lo rehace una sola vez al final
    // (ver `DepsPipeline.resumen` y `resumirTolerante`).
    await entorno.recomputar(lamina.obraId, { db: entorno.db, resumen: entorno.resumen });
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

/**
 * Suelta la lámina: va en TODA transición que la saca de `procesando`
 * (`analizada`, `bloqueada_escala`, `error`).
 *
 * Sin esto, `procesando_desde` quedaría con la fecha del último análisis y el
 * rescate por TTL leería el reloj de una corrida que ya terminó. La invariante
 * que sostiene el rescate es justamente esta: `procesando_desde` no nulo ⇔
 * alguien la tiene tomada.
 */
const SOLTAR = { procesandoDesde: null } as const;

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

/**
 * El contexto de obra que ve el prompt de análisis (T1: `armarContextoObra`).
 *
 * Hasta acá el pipeline mandaba `{obraId, tipoObra}` y nada más: el tipo de
 * obra, el resumen, el índice de láminas y las instrucciones del estudio no
 * llegaban nunca al modelo. Peor todavía, el rótulo se pedía **sin** ctx y el
 * caché del provider es por lámina, así que esa primera llamada era la que
 * quedaba cacheada y la segunda —la que sí traía contexto— no se hacía.
 *
 * Las tres piezas nuevas y por qué:
 *
 *  - **`resumen`** (titular del resumen ejecutivo): de qué se trata la obra.
 *    Null-safe a propósito — la primera lámina de la primera subida se analiza
 *    cuando todavía no hay resumen, y eso no es un error.
 *  - **`indiceLaminas`**: las **otras** láminas del expediente, que es como el
 *    prompt las presenta ("no copies a esta lámina un dato que está escrito en
 *    otra"). Meter la lámina que se está leyendo en su propio índice sería
 *    decirle al modelo que mire en otro lado lo que tiene delante.
 *  - **`instruccionesEstudio`**: la sistematización de los prompts que el
 *    arquitecto hoy escribe a mano en un chat ("las cotas de nuestros planos
 *    están en centímetros"). `textoInstrucciones` devuelve `null` si el estudio
 *    no escribió nada, y entonces el campo no viaja y el prompt queda como antes.
 */
async function contextoDeObra(db: Db, obra: Obra, laminaId: string): Promise<ObraContexto> {
  const otras = await db
    .select({ codigo: laminas.codigo, titulo: laminas.titulo, tipo: laminas.tipo })
    .from(laminas)
    .where(and(eq(laminas.obraId, obra.id), ne(laminas.id, laminaId)))
    .orderBy(laminas.numeroPagina);

  const { instruccionesExtraccion } = await leerConfig(db, obra.estudioId);
  const instrucciones = textoInstrucciones(instruccionesExtraccion);
  const titular = leerResumen(obra)?.titular;

  return {
    obraId: obra.id,
    tipoObra: obra.tipo,
    ...(typeof titular === 'string' && titular.trim() !== '' ? { resumen: titular } : {}),
    indiceLaminas: otras,
    ...(instrucciones !== null ? { instruccionesEstudio: instrucciones } : {}),
  };
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

    // El ctx se arma ANTES de la primera llamada: el caché del provider es por
    // lámina y sirve la promesa de la primera, así que pedir el rótulo sin
    // contexto dejaba al modelo sin contexto para todo el resto de la lámina.
    const ctx = await contextoDeObra(db, obra, laminaId);
    const rotulo = await provider.leerRotulo(entrada, ctx);
    const campos = fusionarRotulo(lamina, rotulo);
    // El texto del PDF se guarda en la lámina (RF-106): es lo que después lee el
    // Q&A del expediente para contestar con citas. Se persiste en las dos
    // salidas —analizada y bloqueada por escala— porque una lámina sin escala
    // igual dice cosas: una planilla de carpinterías es texto puro y no se
    // computa. Vacío ⇒ `null`, que es "no hay texto que citar" y no "no leí".
    const textoExtraido = entrada.textoExtraido?.trim() ? entrada.textoExtraido : null;

    const modo = modoEscala(campos);
    // La escala que el rótulo leyó es la que se propone; la que ya estaba en la
    // lámina puede ser la que cargó el arquitecto, y esa no tiene "confianza de
    // lectura" que declarar.
    const confianzaEscala = rotulo.escala !== null ? rotulo.confianza : null;

    if (modo === 'bloqueada') {
      // RF-201: sin escala declarada no se mide nada. Si la lámina traía
      // entidades de una corrida anterior, se van con ella.
      const { eliminadas } = await sincronizarEntidades(db, lamina, []);
      await db
        .update(laminas)
        .set({
          ...campos,
          ...SOLTAR,
          textoExtraido,
          estadoAnalisis: 'bloqueada_escala',
          errorDetalle: null,
        })
        .where(eq(laminas.id, laminaId));
      await upsertHallazgoEscala(db, lamina, 'bloqueada', campos.escala, confianzaEscala);
      const recomputado = eliminadas === 0 || (await recomputarTolerante(entorno, lamina));
      await auditarAgente(lamina.obraId, 'lamina_bloqueada_escala', `laminas:${laminaId}`, {
        escala: campos.escala,
        entidadesEliminadas: eliminadas,
        recomputado,
      });
      return;
    }

    const detectadas = await provider.extraerEntidades(entrada, ctx);
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
      .set({ ...campos, ...SOLTAR, textoExtraido, estadoAnalisis: 'analizada', errorDetalle: null })
      .where(eq(laminas.id, laminaId));

    // Las dos salidas que sí computan. La diferencia es qué queda en la bandeja:
    // con la escala verificada, nada; con la escala asumida, un supuesto no
    // bloqueante que se confirma de un click con lo que ya se leyó.
    if (modo === 'asumida') {
      await upsertHallazgoEscala(db, lamina, 'asumida', campos.escala, confianzaEscala);
    } else {
      await cerrarHallazgoEscala(db, lamina);
    }
    const recomputado = await recomputarTolerante(entorno, lamina);

    await auditarAgente(lamina.obraId, 'lamina_analizada', `laminas:${laminaId}`, {
      codigo: campos.codigo,
      titulo: campos.titulo,
      escala: campos.escala,
      escalaAsumida: modo === 'asumida',
      entidades: validas.length,
      ...resumen,
      descartadas,
      recomputado,
    });
  } catch (error) {
    const errorDetalle = detalleDeError(error);
    await db
      .update(laminas)
      .set({ ...SOLTAR, estadoAnalisis: 'error', errorDetalle })
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
 * Aplica la clasificación manual y, **solo si hace falta**, vuelve a
 * dispararle el análisis a la lámina.
 *
 * Cuándo hace falta, y por qué solo entonces:
 *
 *  - **la lámina estaba `bloqueada_escala` y ahora hay escala confirmada**: no
 *    tiene entidades porque nunca se le extrajeron. Sin re-análisis no hay
 *    cómputo (RF-201);
 *  - **la escala cambió de valor**: todo lo que se midió se midió con la
 *    anterior. Los números están mal hasta que se rehagan.
 *
 * Y cuándo **no**: confirmar la escala asumida de una lámina ya analizada. Ahí
 * el cómputo ya se hizo con esa misma escala; volver a llamar al modelo sería
 * pagarle al usuario los créditos de una extracción que va a dar exactamente lo
 * mismo — que es la queja que originó todo esto, al revés. Se marca el flag, se
 * cierra la consulta y listo.
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

  const confirmaEscala = cambios.escalaConfiable === true && !previa.escalaConfiable;
  const desbloquea = confirmaEscala && previa.estadoAnalisis === 'bloqueada_escala';
  const escalaCambio = cambios.escala !== undefined && cambios.escala !== previa.escala;
  const reprocesa = desbloquea || escalaCambio;

  if (Object.keys(set).length > 0) {
    await db.update(laminas).set(set).where(eq(laminas.id, laminaId));
    await registrarAuditoria({
      obraId: previa.obraId,
      actorTipo: 'usuario',
      actorNombre: actor.email,
      accion: confirmaEscala ? 'lamina_escala_confirmada' : 'lamina_clasificada',
      targetRef: `laminas:${laminaId}`,
      diff: { ...set, reprocesa },
    });
  }

  if (reprocesa) {
    await procesarLamina(laminaId, { db, ...deps });
  } else if (confirmaEscala) {
    // Sin re-análisis nadie más cierra la consulta: es la misma función que
    // usa el pipeline cuando la escala se verifica sola, así que la consulta
    // queda cerrada igual y con la misma auditoría. (Desde la bandeja la
    // consulta ya viene cerrada y esto es un no-op: `responderEscala` cierra
    // primero para que el pipeline no le pise la respuesta.)
    await cerrarHallazgoEscala(db, previa);
  }

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
