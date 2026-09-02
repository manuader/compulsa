/**
 * Pipeline de análisis: del PDF que sube el arquitecto a las entidades, el
 * cómputo y la bandeja.
 *
 *   subirDocumento → procesarDocumento → cinco fases → recomputarObra
 *
 * ## Las cinco fases (§4 del diseño)
 *
 * `procesarDocumento` dejó de ser "una lámina a la vez, a ciegas". Ahora:
 *
 *  1. **inventario** — una pasada barata y en paralelo que lee SOLO rótulos, así
 *     el índice completo del expediente existe **antes** de extraer nada y cada
 *     extracción arranca sabiendo qué otras láminas hay ("no copies a esta
 *     lámina un dato que está escrito en otra");
 *  2. **extraccion** — las láminas se analizan en paralelo con cap
 *     (`pool.ts`), y al terminar se mide sobre el dibujo lo que ninguna cota
 *     declaró (§5.5);
 *  3. **cruce** — se recomputa la obra (reglas §11), se compacta a texto y una
 *     sola llamada mira el expediente entero: hechos de obra, campos que una
 *     lámina completa de otra, identidades, contradicciones y relecturas;
 *  4. **relectura** — la búsqueda dirigida, ahora también con las láminas que
 *     pidió el cruce;
 *  5. **listo** — recompute final, «qué cambió» y resumen ejecutivo.
 *
 * `obras.analisis_json` lleva la fase en curso (`FaseAnalisis`) para que el
 * expediente pueda decir "analizando 12/25" en vez de un spinner eterno, **con
 * su `desde`**: todo esto corre adentro del POST del upload (`maxDuration =
 * 300`), así que una corrida grande se pasa del límite y muere en el medio de
 * una fase. Sin la hora, esa fase se lee como viva para siempre; con ella,
 * `faseVencida()` la lee como abandonada y la pantalla ofrece reintentar. El
 * reintento es `reintentarCruce()`, que rehace las tres fases de obra —cruce,
 * relectura y cómputo final— sin volver a subir el PDF.
 *
 * **Todas las fases son tolerantes.** Una que falla queda anotada, la corrida
 * sigue con las que puede y el estado final es `{fase: 'error', detalle}` — lo
 * ya persistido no se tira. Analizar veinticinco láminas y perderlas porque el
 * cruce dio timeout sería el peor negocio posible.
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
  deducciones,
  documentos,
  entidades,
  hallazgos,
  laminas,
  obras,
  recomputos,
  usuarios,
  type ComputoItem,
  type Deduccion,
  type Documento,
  type Entidad,
  type Lamina,
  type NuevaEntidad,
  type Obra,
} from '@/db/schema';
import {
  getCruceProvider,
  type CruceProvider,
  type RelecturaPedida,
} from '@/lib/analysis/cruce-tipos';
import { getAnalysisProvider, inventariarLamina, type AnalysisProvider } from '@/lib/analysis/index';
import { textoInstrucciones } from '@/lib/analysis/prompt';
import { registrarAuditoria } from '@/lib/audit';
import type { EntidadPersistida } from '@/lib/computo/engine';
import { denominadorDeEscala, medidaGrafica } from '@/lib/computo/medicion';
import { esCampoDeducible } from '@/lib/deduccion/motor';
import { leerMedida } from '@/lib/hallazgos/taxonomia';
import { armarEntradaMemoria } from '@/lib/memoria/armar';
import { memoriaCompacta } from '@/lib/memoria/compacta';
import { separarPaginasConTamano, type TamanoPagina } from '@/lib/pdf/split';
import { extraerTexto } from '@/lib/pdf/texto';
import { buscarDatosFaltantes } from '@/lib/pipeline/busqueda';
import { claveEscala, claveEscalaRotulo } from '@/lib/pipeline/claves';
import { ACCION_DEDUCCION_APLICADA, aplicarCruce, expedienteDelCruce } from '@/lib/pipeline/cruce';
import { igualJson } from '@/lib/pipeline/json';
import { capDeAnalisis, enParalelo, type ResultadoParalelo } from '@/lib/pipeline/pool';
import { MIME_PDF, refDocumento, refLamina } from '@/lib/pipeline/refs';
import {
  ACTOR_PIPELINE,
  borrarDeduccionesDeEntidades,
  comoEntidadPersistida,
  comoItemComputo,
  desvincularItemsDeEntidades,
  diferenciasDeItem,
  recomputarObra,
} from '@/lib/pipeline/recomputar';
import { leerResumen, persistirResumen } from '@/lib/pipeline/resumen';
import { leerConfig } from '@/lib/plataforma/config-estudio';
import { getStorage, type StorageAdapter } from '@/lib/storage/index';
import { DISCIPLINAS, faseVencida, TIPOS_LAMINA } from '@/types/domain';
import type {
  BBox,
  EntidadDetectada,
  FaseAnalisis,
  Fuente,
  LaminaInput,
  ObraContexto,
  RotuloDetectado,
  RubroId,
  TipoHallazgo,
  TipoLamina,
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

/**
 * Texto del aviso de relectura: el rótulo, verificado contra cotas, dice otra
 * cosa que la escala confirmada.
 *
 * Dice las tres cosas en orden: **qué leí ahora**, **con qué está computada la
 * lámina** y **que no le pisé nada**. La decisión la toma él, que es el único
 * que sabe si el rótulo está mal impreso o si la corrección quedó vieja.
 */
export function descripcionEscalaRelectura(confirmada: string, releida: string): string {
  return (
    `Al volver a analizarla verifiqué contra cotas la escala ${releida} del rótulo, ` +
    `y la lámina está computada con ${confirmada}, que es la escala confirmada. ` +
    'No la pisé: si la buena es la del rótulo, confirmala y vuelvo a medir.'
  );
}

/** Respuesta con la que el desbloqueo manual cierra el hallazgo de escala. */
export const RESPUESTA_ESCALA_CONFIRMADA = { auto: 'escala confirmada a mano' } as const;

/**
 * Respuesta con la que se cierra la consulta de escala de una lámina que resultó
 * ser una **planilla**: ahí no hay nada que medir, así que la escala no aplica.
 * Cubre la lámina que quedó bloqueada en una corrida vieja —o clasificada como
 * plano y reclasificada después— y que ahora se analiza igual.
 */
export const RESPUESTA_ESCALA_NO_APLICA = {
  auto: 'la lámina es una planilla: sus datos están escritos, no se miden',
} as const;

/** Respuesta con la que se cierra el aviso de relectura cuando deja de aplicar. */
export const RESPUESTA_RELECTURA_COINCIDE = {
  auto: 'el rótulo volvió a leerse igual que la escala confirmada',
} as const;

/** Acción con la que queda registrado el arranque del análisis de una lámina. */
export const ACCION_PROCESANDO = 'lamina_procesando';

/** Acción con la que queda registrado que la búsqueda dirigida no pudo correr. */
export const ACCION_BUSQUEDA_FALLIDA = 'busqueda_fallida';

/** Acción con la que queda registrado que el cruce del expediente no pudo correr. */
export const ACCION_CRUCE_FALLIDO = 'cruce_fallido';

/** Acción con la que queda registrada cada fase del análisis al arrancar. */
export const ACCION_FASE = 'analisis_fase';

/**
 * El reintento del cruce, pedido a mano desde el expediente. Se distingue de
 * `analisis_fase` porque lo dispara una persona, no la subida de un documento.
 */
export const ACCION_CRUCE_REINTENTADO = 'cruce_reintentado';

/** Acción con la que queda registrado el rótulo que leyó la fase de inventario. */
export const ACCION_INVENTARIADA = 'lamina_inventariada';

/** Acción con la que queda registrado que el inventario falló (de una lámina, o entero). */
export const ACCION_INVENTARIO_FALLIDO = 'lamina_inventario_fallido';

/** Acción con la que queda registrada una lámina que se cayó dentro del lote paralelo. */
export const ACCION_EXTRACCION_FALLIDA = 'lamina_extraccion_fallida';

/**
 * Confianza fija de una medida sacada del dibujo (§5.5). No es un default
 * configurable: es cuánto vale medir un rectángulo en una lámina a escala
 * comparado con leer una cota, y la respuesta es "la mitad".
 */
export const CONFIANZA_MEDICION = 0.5;

/**
 * Tercera clave meta de `deducciones.valor_json`, hermana de `MARCA_CONTRADICHA`
 * y `MARCA_VALOR_DOCUMENTADO` (`recomputar.ts`): **cómo** se llegó al número.
 *
 * `datos_obra` tiene una columna `metodo` para esto y `deducciones` no; agregar
 * una migración desde una rama paralela es peor negocio que una clave meta
 * documentada, y el precedente ya existe. Los lectores del valor
 * (`aplicarDeduccionesValidadas`, `validarDeduccion`) leen `valorJson[campo]` y
 * nada más, así que la clave no ensucia ningún atributo.
 */
export const MARCA_METODO = '_metodo';

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

export class ObraInexistenteError extends Error {
  constructor(readonly obraId: string) {
    super(`No existe la obra ${obraId}.`);
    this.name = 'ObraInexistenteError';
  }
}

/** Ya hay un análisis corriendo sobre esta obra y todavía no venció. */
export class AnalisisEnCursoError extends Error {
  constructor(readonly fase: FaseAnalisis) {
    super('El análisis de esta obra ya está corriendo. Esperá a que termine.');
    this.name = 'AnalisisEnCursoError';
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
   *
   * `'diferido'` es el otro uso, y ese sí es del pipeline: durante la
   * **extracción en paralelo** no puede correr un recompute por lámina. Dos
   * recomputes encimados sobre la misma obra leen la misma foto de
   * `computo_items` y los dos insertan la clave que no vieron —`computo_items`
   * no tiene UNIQUE por `(obra, clave)`—, así que la planilla terminaría con
   * ítems duplicados en silencio. La obra se recomputa **una vez**, en la fase
   * de cruce, que es donde el diseño la pone.
   */
  recomputar?: ((obraId: string, deps: { db: Db; resumen?: boolean }) => Promise<unknown>) | 'diferido';
  /**
   * El provider del cruce del expediente. Default: `getCruceProvider()` (el
   * mock, siempre, en tests).
   */
  cruce?: CruceProvider;
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
  buscar?: (
    obraId: string,
    deps: { db: Db; storage: StorageAdapter; relecturas?: readonly RelecturaPedida[] },
  ) => Promise<unknown>;
}

interface Entorno {
  db: Db;
  storage: StorageAdapter;
  provider: AnalysisProvider;
  cruce: CruceProvider;
  recomputar: NonNullable<DepsPipeline['recomputar']>;
  resumen: boolean;
  buscar: NonNullable<DepsPipeline['buscar']>;
}

async function resolver(deps: DepsPipeline): Promise<Entorno> {
  return {
    db: deps.db ?? (await getDb()),
    storage: deps.storage ?? getStorage(),
    provider: deps.provider ?? getAnalysisProvider(),
    cruce: deps.cruce ?? getCruceProvider(),
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

/** Una lámina de este documento, con lo que hace falta para analizarla. */
interface PaginaDelDocumento {
  laminaId: string;
  numeroPagina: number;
  bytes: Uint8Array;
  /** Tamaño de la hoja en puntos: el insumo de la medición gráfica (§5.5). */
  tamanoPts: TamanoPagina;
}

/**
 * Separa el PDF en una lámina por página y corre las cinco fases del análisis
 * sobre la obra (ver la cabecera del módulo).
 *
 * Re-ejecutable: las láminas se matchean por `numero_pagina`, así que volver a
 * correrlo re-analiza las mismas filas en lugar de crear otras nuevas, y una
 * corrida idéntica no escribe ni audita nada.
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
  const paginas = await separarPaginasConTamano(original);

  const existentes = await db.select().from(laminas).where(eq(laminas.documentoId, documentoId));
  const porPagina = new Map(existentes.map((lamina) => [lamina.numeroPagina, lamina]));

  // La foto de la planilla ANTES de tocar nada: es la mitad izquierda del "qué
  // cambió" (RF-308). Un documento que se procesa por primera vez y que trae una
  // versión mayor a la 1 es una revisión nueva; todo lo demás es un reproceso.
  const antes = await fotoDeItems(db, obra.id);
  const motivo: MotivoRecomputo =
    documento.version > 1 && existentes.length === 0 ? 'revision_nueva' : 'reproceso';

  const aProcesar: PaginaDelDocumento[] = [];

  for (const [indice, pagina] of paginas.entries()) {
    const numeroPagina = indice + 1;
    const previa = porPagina.get(numeroPagina);

    if (previa) {
      // Re-escribir la página es barato y deja storage y base consistentes aunque
      // el archivo derivado se haya perdido entre corridas.
      await storage.guardar(previa.archivoRef, pagina.bytes, MIME_PDF);
      aProcesar.push({ laminaId: previa.id, numeroPagina, ...pagina });
      continue;
    }

    const laminaId = randomUUID();
    const archivoRef = refLamina(obra.estudioId, obra.id, documento.id, numeroPagina);
    await storage.guardar(archivoRef, pagina.bytes, MIME_PDF);
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
    aProcesar.push({ laminaId, numeroPagina, ...pagina });
  }

  const marcarFase = seguidorDeFases(db, obra.id);
  /** Las fases que se cayeron: deciden el estado final del análisis. */
  const fallos: string[] = [];
  const total = aProcesar.length;

  // --- 1. Inventario: el índice del expediente, antes de extraer nada --------
  await marcarFase({ fase: 'inventario', total, completadas: 0 });
  await inventariarTolerante(entorno, obra, documento, aProcesar, marcarFase, fallos);

  // --- 2. Extracción en paralelo + medición gráfica --------------------------
  await marcarFase({ fase: 'extraccion', total, completadas: 0 });
  let completadas = 0;
  const extracciones = await enParalelo(aProcesar, capDeAnalisis(), async (pagina) => {
    // `resumen: false` y `recomputar: 'diferido'`: el resumen se publica una
    // sola vez al final y la obra se recomputa una sola vez, en la fase de
    // cruce (ver `DepsPipeline.recomputar`).
    await procesarLamina(pagina.laminaId, { ...entorno, resumen: false, recomputar: 'diferido' });
    completadas += 1;
    await marcarFase({ fase: 'extraccion', total, completadas });
  });
  // `procesarLamina` deja sus propios errores en la lámina y no lanza, así que
  // lo que llegue acá es algo que se rompió **alrededor** del análisis (el
  // storage, la base, el marcado de la fase). Descartar el resultado del pool
  // sería tragárselo: el análisis terminaría en `listo` con una lámina que
  // nadie miró.
  await anotarFallosDelLote(obra.id, extracciones, aProcesar, fallos);
  await medirTolerante(entorno, obra.id, aProcesar, fallos);

  // --- 3. Cruce: el expediente mirado como conjunto --------------------------
  await marcarFase({ fase: 'cruce' });
  await recomputarObraTolerante(entorno, obra.id, fallos);
  const relecturas = await cruzarTolerante(entorno, obra, fallos);

  // --- 4. Relectura dirigida -------------------------------------------------
  await marcarFase({ fase: 'relectura', total: relecturas.length });
  await buscarTolerante(entorno, obra.id, relecturas);

  // --- 5. Cierre: cómputo final, qué cambió y resumen ------------------------
  await recomputarObraTolerante(entorno, obra.id, fallos);

  // RF-308: qué le hizo este documento a la planilla, para la pantalla "Qué
  // cambió". Va antes del resumen porque el resumen es la foto final y esto es
  // el movimiento.
  await registrarRecomputo(db, documento, motivo, antes);

  // RF-205: el resumen ejecutivo se rehace recién acá, con todas las láminas del
  // documento analizadas y el cómputo ya sincronizado. Hacerlo por lámina sería
  // publicar N resúmenes a medio hacer.
  await resumirTolerante(db, obra.id);

  // El estado final dice la verdad: si una fase se cayó, la obra terminó con lo
  // que se pudo y la pantalla lo cuenta, en vez de un "listo" que tapa el hueco.
  //
  // **`fallos` lo lee el arquitecto**, así que cada entrada dice qué quedó sin
  // hacer y qué puede hacer él — no el nombre interno de la fase ni el
  // `error.message` del provider. El detalle técnico va a la fila de auditoría
  // de cada fase (`errorDetalle`), que es donde se lo busca cuando hay que
  // arreglarlo: "el inventario de rótulos no corrió (fetch failed)" no le sirve
  // a nadie del otro lado de la pantalla.
  await marcarFase(
    fallos.length === 0 ? { fase: 'listo' } : { fase: 'error', detalle: fallos.join(' · ') },
  );
}

/**
 * Vuelve a correr las tres últimas fases sobre una obra ya analizada: cruce,
 * relectura y cómputo final. Es el reintento del expediente.
 *
 * **Por qué existe:** el cruce es la fase cara, la única que manda el
 * expediente entero a la red y la más probable de caerse — y no había forma de
 * reintentarla. `cruzarTolerante` la atrapa y deja la obra con sus huecos, pero
 * después de eso ni la pantalla ni ninguna ruta la volvían a llamar: el único
 * llamador era `procesarDocumento`, o sea que reintentar el cruce exigía volver
 * a subir el PDF. El botón de reprocesar de una lámina solo re-extrae esa
 * lámina.
 *
 * **Qué NO rehace:** el inventario, la extracción y la medición gráfica, que
 * son por lámina y ya tienen su propio botón (`procesarLamina`). Acá se rehace
 * lo que es de la obra entera, que es exactamente lo que no tenía reintento.
 *
 * Idempotente por las mismas razones que la corrida original: `aplicarCruce` es
 * upsert con comparación previa, `recomputarObra` es idempotente y la búsqueda
 * dirigida no vuelve a pagar lo que ya buscó. Correrlo dos veces sobre una obra
 * quieta no escribe ni audita nada nuevo.
 *
 * Lanza `AnalisisEnCursoError` si ya hay una corrida viva encima (la fase está
 * en curso y no venció): dos cruces simultáneos sobre la misma obra se pisan el
 * recompute, que es el bug que `recomputar: 'diferido'` existe para evitar.
 */
export async function reintentarCruce(
  obraId: string,
  deps: DepsPipeline = {},
): Promise<{ fase: FaseAnalisis; relecturas: number }> {
  const entorno = await resolver(deps);
  const { db } = entorno;

  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ObraInexistenteError(obraId);

  const enCurso = obra.analisisJson;
  if (enCurso && enCurso.fase !== 'listo' && enCurso.fase !== 'error' && !faseVencida(enCurso)) {
    throw new AnalisisEnCursoError(enCurso);
  }

  const marcarFase = seguidorDeFases(db, obra.id);
  const fallos: string[] = [];

  await marcarFase({ fase: 'cruce' });
  await recomputarObraTolerante(entorno, obra.id, fallos);
  const relecturas = await cruzarTolerante(entorno, obra, fallos);

  await marcarFase({ fase: 'relectura', total: relecturas.length });
  await buscarTolerante(entorno, obra.id, relecturas);

  await recomputarObraTolerante(entorno, obra.id, fallos);
  await resumirTolerante(db, obra.id);

  const fase: FaseAnalisis =
    fallos.length === 0 ? { fase: 'listo' } : { fase: 'error', detalle: fallos.join(' · ') };
  await marcarFase(fase);

  await auditarAgente(obra.id, ACCION_CRUCE_REINTENTADO, `obras:${obra.id}`, {
    relecturas: relecturas.length,
    fases: ['cruce', 'relectura', 'computo'],
    resultado: fase.fase,
    ...(fase.detalle === undefined ? {} : { detalle: fase.detalle }),
  });

  return { fase, relecturas: relecturas.length };
}

/**
 * Escribe la fase en curso en `obras.analisis_json` y la audita **cuando
 * cambia**.
 *
 * El progreso dentro de una fase ("12 de 25") se guarda pero no se audita: es
 * un contador para la pantalla, no una decisión. El cambio de fase sí, y eso
 * deja en `auditoria` la línea de tiempo de la corrida, que es donde se ve
 * cuánto tardó cada parte y cuál se cayó.
 */
function seguidorDeFases(db: Db, obraId: string): (estado: FaseAnalisis) => Promise<void> {
  let anterior: FaseAnalisis['fase'] | null = null;
  return async (estado: FaseAnalisis): Promise<void> => {
    // `desde` en CADA marca, no solo al cambiar de fase: el contador de la
    // extracción («12 de 25») es lo que prueba que la corrida sigue viva, y una
    // fase que arrancó hace nueve minutos y avanzó hace diez segundos no está
    // colgada. Ver `faseVencida()`.
    const conReloj: FaseAnalisis = { ...estado, desde: new Date().toISOString() };
    await db.update(obras).set({ analisisJson: conReloj }).where(eq(obras.id, obraId));
    if (estado.fase === anterior) return;
    anterior = estado.fase;
    await auditarAgente(obraId, ACCION_FASE, `obras:${obraId}`, { ...conReloj });
  };
}

/**
 * Deja el análisis de la obra en `error`, sin pasar por el seguidor de fases.
 *
 * Existe para el único camino que el seguidor no cubre: `procesarDocumento`
 * levantó una excepción **antes** de llegar a su marca final —el PDF no se pudo
 * separar, el storage falló, el proceso se cortó—. Sin esto, el route handler
 * del upload solo hacía `console.error` y `analisis_json` quedaba clavado en la
 * fase que estuviera en curso: la pantalla mostraba «Analizando las láminas ·
 * 12 de 25» para siempre y pedía un refresh cada cuatro segundos, para siempre.
 *
 * No lanza: es el manejador de un error, y romper adentro del `catch` de otro
 * error taparía el primero.
 */
export async function marcarAnalisisFallido(
  obraId: string,
  detalle: string,
  deps: { db?: Db } = {},
): Promise<void> {
  try {
    const db = deps.db ?? (await getDb());
    const estado: FaseAnalisis = { fase: 'error', detalle, desde: new Date().toISOString() };
    await db.update(obras).set({ analisisJson: estado }).where(eq(obras.id, obraId));
    await auditarAgente(obraId, ACCION_FASE, `obras:${obraId}`, { ...estado });
  } catch (error) {
    console.error('[pipeline] no pude marcar el análisis como fallido:', error);
  }
}

// ---------------------------------------------------------------------------
// Fase 1: inventario (§25.1)
// ---------------------------------------------------------------------------

/** Campos del rótulo que arma el **índice** del expediente. */
type CamposDeIndice = Pick<Lamina, 'codigo' | 'titulo' | 'tipo' | 'disciplina' | 'revision'>;

/**
 * El índice de una lámina después del inventario: **el agente completa, nunca
 * borra**, igual que `fusionarRotulo`.
 *
 * Lo que el inventario NO toca es la **escala**, y es deliberado. La escala es
 * la que decide si la lámina se computa, se computa con un supuesto o se
 * bloquea (RF-201), y esa decisión la toma `analizarLamina` con el rótulo que
 * lee en la fase siguiente, sobre la misma lámina y con el contexto completo.
 * Duplicarla acá sería tener dos lugares donde se decide lo mismo — y el
 * inventario, que es una pasada barata con `effort: 'low'`, sería el que manda.
 */
export function fusionarIndice(lamina: Lamina, rotulo: RotuloDetectado): CamposDeIndice {
  return {
    codigo: rotulo.codigo ?? lamina.codigo,
    titulo: rotulo.titulo ?? lamina.titulo,
    tipo: rotulo.tipoLamina ?? lamina.tipo,
    disciplina: rotulo.disciplina ?? lamina.disciplina,
    revision: rotulo.revision ?? lamina.revision,
  };
}

function cambioDeIndice(lamina: Lamina, campos: CamposDeIndice): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {};
  for (const [campo, despues] of Object.entries(campos)) {
    const antes = lamina[campo as keyof CamposDeIndice];
    if (antes !== despues) diff[campo] = { antes, despues };
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Lee los rótulos de todas las láminas del documento, en paralelo, y los
 * persiste **antes** de extraer nada.
 *
 * Es la fase que hace que la extracción de la primera lámina ya sepa que existe
 * una "DET00 — PLANILLA DE CARPINTERÍAS": hasta acá, el índice que viajaba en el
 * `ObraContexto` era el de las láminas analizadas en corridas anteriores, así
 * que la primera subida de un expediente se analizaba entera a ciegas.
 *
 * Tolerante por lámina: un rótulo que no se pudo leer queda en `auditoria` y la
 * lámina sigue su camino —la fase de extracción vuelve a leer el rótulo igual,
 * esta vez por el camino caro—. No marca la lámina en `error`: no hay nada roto
 * en ella todavía.
 */
async function inventariarDocumento(
  entorno: Entorno,
  obra: Obra,
  documento: Documento,
  paginas: readonly PaginaDelDocumento[],
  marcarFase: (estado: FaseAnalisis) => Promise<void>,
): Promise<void> {
  if (paginas.length === 0) return;
  const { db, provider } = entorno;

  // El ctx del inventario no lleva índice —construirlo es lo que esta fase
  // hace— pero sí la obra: sin `obraId` la fila `inventario_llm` queda sin obra
  // y el costo del inventario no se ve en la auditoría del estudio (RNF-7).
  const ctx: ObraContexto = {
    obraId: obra.id,
    tipoObra: obra.tipo,
    nombreObra: obra.nombre,
  };

  let completadas = 0;
  const rotulos = await enParalelo(paginas, capDeAnalisis(), async (pagina) => {
    const rotulo = await inventariarLamina(
      provider,
      {
        laminaId: pagina.laminaId,
        pdfBytes: pagina.bytes,
        documentoNombre: documento.nombreArchivo,
        numeroPagina: pagina.numeroPagina,
      },
      ctx,
    );
    completadas += 1;
    await marcarFase({ fase: 'inventario', total: paginas.length, completadas });
    return rotulo;
  });

  // La persistencia va en serie y después del lote: son escrituras cortas y
  // así el índice queda completo de una vez, sin que dos láminas se pisen.
  for (const [indice, resultado] of rotulos.entries()) {
    const pagina = paginas[indice] as PaginaDelDocumento;
    if (!resultado.ok) {
      await auditarAgente(obra.id, ACCION_INVENTARIO_FALLIDO, `laminas:${pagina.laminaId}`, {
        errorDetalle: detalleDeError(resultado.error),
        motivo: 'El inventario no pudo leer el rótulo; la extracción lo vuelve a intentar.',
      });
      continue;
    }

    const [fila] = await db.select().from(laminas).where(eq(laminas.id, pagina.laminaId));
    if (!fila) continue;
    const campos = fusionarIndice(fila, resultado.valor);
    const diff = cambioDeIndice(fila, campos);
    if (diff === null) continue; // sin cambios no se escribe ni se audita

    await db.update(laminas).set(campos).where(eq(laminas.id, pagina.laminaId));
    await auditarAgente(obra.id, ACCION_INVENTARIADA, `laminas:${pagina.laminaId}`, diff);
  }
}

// ---------------------------------------------------------------------------
// Fase 2 (cola): medición gráfica sobre el dibujo (§5.5)
// ---------------------------------------------------------------------------

/**
 * Qué eje del mundo real representa el dibujo de cada tipo de lámina.
 *
 * Es la regla que evita el error más caro que puede cometer la medición
 * gráfica: **una planta no tiene altura**. El bbox de un tabique en planta mide
 * su largo y su *espesor*; leer ese espesor como la altura del tabique daría un
 * número plausible y equivocado, y encima cortocircuitaría la cadena de
 * respaldo del §5.2 —la altura la dice el corte, o el dato de obra, o el
 * arquitecto—, que es donde vive la información buena. La medición gráfica es
 * el **último** respaldo, no el primero.
 *
 * Un `detalle` no entra (su escala es propia y su recorte no mapea a un campo
 * computable), una `planilla` tampoco (es una tabla: sus datos están escritos,
 * no se miden) y una lámina sin clasificar menos todavía.
 */
const EJE_DE_LAMINA: Partial<Record<TipoLamina, 'planta' | 'vertical'>> = {
  planta: 'planta',
  corte: 'vertical',
  vista: 'vertical',
};

/** Los tipos de entidad cuyo rectángulo es una medida de arquitectura. */
const TIPOS_MEDIBLES: ReadonlySet<string> = new Set(['muro', 'tabique', 'ambiente']);

/** Una medida sacada del dibujo, lista para escribir como deducción. */
interface MedidaDeDibujo {
  campo: string;
  valor: number;
  metodo: string;
}

/**
 * Qué campos se pueden medir de esta entidad en esta lámina, con su valor.
 *
 * `medidaGrafica` devuelve el rectángulo en metros de obra; el mapeo a campos
 * es el del §5.5: el ancho del bbox es el largo del elemento, el alto es su
 * altura (solo donde el dibujo tiene eje vertical) y el producto es la
 * superficie de un ambiente en planta. Solo se devuelven los campos que la
 * entidad **no** tiene: la medición no compite con una cota escrita.
 */
export function medidasDeDibujo(
  entidad: EntidadPersistida,
  tipoLamina: TipoLamina | null,
  escala: string,
  tamanoPts: TamanoPagina,
): MedidaDeDibujo[] {
  const eje = tipoLamina === null ? undefined : EJE_DE_LAMINA[tipoLamina];
  if (eje === undefined || !TIPOS_MEDIBLES.has(entidad.tipo)) return [];

  const medida = medidaGrafica(entidad.bbox, tamanoPts, escala);
  if (medida === null) return [];

  const metodo = `medición gráfica sobre el dibujo a escala ${escala}`;
  /**
   * Un campo se mide si **falta** y si es de los que el sistema puede deducir
   * (RF-506, `esCampoDeducible`): nada estructural ni de seguridad entra por
   * acá, y la lista no se mantiene en paralelo en este archivo.
   */
  const medible = (campo: string): boolean =>
    leerMedida(entidad, campo) === null && esCampoDeducible(entidad.tipo, campo);
  const medidas: MedidaDeDibujo[] = [];

  if (eje === 'vertical') {
    // La única lectura honesta de un corte o una vista: la vertical.
    if (medida.altoM > 0 && medible('alturaM')) {
      medidas.push({ campo: 'alturaM', valor: medida.altoM, metodo });
    }
    return medidas;
  }

  if (entidad.tipo === 'ambiente') {
    // El área no depende de la orientación: un ambiente apaisado y uno vertical
    // con el mismo rectángulo miden lo mismo.
    const superficie = redondearM2(medida.anchoM * medida.altoM);
    if (superficie > 0 && medible('superficieM2')) {
      medidas.push({ campo: 'superficieM2', valor: superficie, metodo });
    }
    return medidas;
  }

  const largo = largoDelDibujo(medida);
  if (largo !== null && medible('largoM')) {
    medidas.push({ campo: 'largoM', valor: largo, metodo });
  }
  return medidas;
}

/**
 * Cuánto mide de largo un muro o un tabique dibujado en planta, o `null` si el
 * dibujo no alcanza para decirlo.
 *
 * El bbox está alineado a los ejes de la hoja, así que **el largo no es el
 * ancho del rectángulo**: el mismo tabique dibujado en vertical tiene un bbox
 * angosto y alto, y leer su ancho daría el **espesor** —0,30 m en vez de 6 m—,
 * un número plausible que entra al cómputo y nadie mira dos veces. El largo es
 * el lado **más largo** de los dos.
 *
 * Y solo se mide si el rectángulo **identifica** el eje: un muro es largo y
 * flaco, así que se exige una relación de aspecto de al menos
 * `RELACION_MINIMA_MURO`. Un rectángulo casi cuadrado no dice para dónde corre
 * el muro —puede ser un muro en L mal encuadrado, o el bloque entero de un
 * núcleo— y ahí la respuesta honesta es no medir: la cota sigue faltando, la
 * consulta sigue abierta, y nadie computó un número inventado.
 */
export function largoDelDibujo(medida: { anchoM: number; altoM: number }): number | null {
  const largo = Math.max(medida.anchoM, medida.altoM);
  const corto = Math.min(medida.anchoM, medida.altoM);
  if (largo <= 0) return null;
  // Un lado que redondea a cero es tan flaco como se puede: el eje está claro.
  const relacion = corto > 0 ? largo / corto : Infinity;
  return relacion >= RELACION_MINIMA_MURO ? largo : null;
}

/**
 * Cuánto más largo que ancho tiene que ser el rectángulo de un muro para que su
 * dibujo diga hacia dónde corre. Tres a uno: un tabique de 3 m tiene 0,10 de
 * espesor (30:1) y hasta el más corto de una obra real pasa este filtro; lo que
 * no lo pasa es un bloque cuadrado, que es justamente el caso en el que medir
 * sería adivinar.
 */
export const RELACION_MINIMA_MURO = 3;

/** Dos decimales, los mismos con los que el motor emite toda cantidad. */
function redondearM2(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * Mide sobre el dibujo lo que ninguna cota declaró, para las láminas de este
 * documento.
 *
 * Las deducciones que salen de acá nacen **validadas por regla propia** (§5.5):
 * no pasan por el umbral de 0,7 —su confianza es 0,5 fija— porque no son una
 * deducción documental sino una medición, y el ítem que se apoye en ellas sale
 * `origen: 'inferido'`, que es lo que las distingue de todo lo demás.
 *
 * Se mide solo lo de **este** documento: las láminas de otro se midieron cuando
 * se subió, y sus filas siguen ahí (una `validada` no la borra el recompute).
 */
async function medirDibujo(
  entorno: Entorno,
  obraId: string,
  paginas: readonly PaginaDelDocumento[],
): Promise<{ medidas: number; actualizadas: number }> {
  const { db } = entorno;
  const resumen = { medidas: 0, actualizadas: 0 };
  if (paginas.length === 0) return resumen;

  const ids = paginas.map((pagina) => pagina.laminaId);
  const [planos, elementos, previas] = await Promise.all([
    db.select().from(laminas).where(inArray(laminas.id, ids)),
    db.select().from(entidades).where(inArray(entidades.laminaId, ids)),
    db.select().from(deducciones).where(eq(deducciones.obraId, obraId)),
  ]);

  const tamanos = new Map(paginas.map((pagina) => [pagina.laminaId, pagina.tamanoPts]));
  const porLamina = new Map(planos.map((plano) => [plano.id, plano]));
  const porClave = new Map(previas.map((fila) => [`${fila.entidadId}::${fila.campo}`, fila]));

  for (const fila of elementos) {
    const plano = porLamina.get(fila.laminaId);
    // Una escala utilizable es la confirmada **o** la declarada-asumida: las dos
    // son el número con el que la lámina ya se computó. Sin escala no se mide,
    // que es la regla que evita un cómputo entero de números inventados.
    if (!plano || plano.escala === null || denominadorDeEscala(plano.escala) === null) continue;
    const tamanoPts = tamanos.get(fila.laminaId);
    if (tamanoPts === undefined) continue;

    const entidad = comoEntidadPersistida(fila);
    const medidas = medidasDeDibujo(entidad, plano.tipo, plano.escala, tamanoPts);
    for (const medida of medidas) {
      const escrita = await escribirMedicion(db, obraId, entidad, medida, porClave, plano.id);
      if (escrita === 'creada') resumen.medidas += 1;
      if (escrita === 'actualizada') resumen.actualizadas += 1;
    }
  }

  return resumen;
}

/**
 * Upsert de una medición por `(obra, entidad, campo)`, **sin pisar lo que
 * alguien decidió**: una deducción rechazada o validada a mano se respeta, y
 * una propuesta del motor de reglas también —esa se apoya en documentación, que
 * le gana a medir un rectángulo—.
 */
async function escribirMedicion(
  db: Db,
  obraId: string,
  entidad: { id: string; bbox: BBox; laminaId: string },
  medida: MedidaDeDibujo,
  previas: ReadonlyMap<string, Deduccion>,
  laminaId: string,
): Promise<'creada' | 'actualizada' | null> {
  const previa = previas.get(`${entidad.id}::${medida.campo}`);
  if (previa !== undefined && previa.regla !== 'medicion_grafica') return null;
  // El mismo criterio que `esDecidida()` en `cruce.ts`: una rechazada es una
  // decisión suya, y una validada **por una persona** también —la bandeja de
  // deducciones deja validar una medición a mano, y el `validado_por` es lo
  // único que distingue esa fila de las que escribe esta función—.
  if (previa !== undefined && previa.estado === 'rechazada') return null;
  if (previa !== undefined && previa.validadoPor !== null) return null;

  const fuentes: Fuente[] = [{ laminaId, bbox: entidad.bbox, detalle: medida.metodo }];
  const valores = {
    obraId,
    entidadId: entidad.id,
    campo: medida.campo,
    regla: 'medicion_grafica' as const,
    fuentesJson: fuentes,
    valorJson: { [medida.campo]: medida.valor, [MARCA_METODO]: medida.metodo },
    confianza: CONFIANZA_MEDICION,
    // §5.5: la medición gráfica se auto-valida por regla propia, no por umbral.
    estado: 'validada' as const,
    validadoPor: null,
  };

  if (previa === undefined) {
    await db.insert(deducciones).values(valores);
    await auditarAgente(obraId, ACCION_DEDUCCION_APLICADA, `deducciones:${entidad.id}.${medida.campo}`, {
      regla: 'medicion_grafica',
      valor: medida.valor,
      confianza: CONFIANZA_MEDICION,
      metodo: medida.metodo,
      laminaId,
    });
    return 'creada';
  }

  const igual =
    previa.estado === 'validada' &&
    previa.validadoPor === null &&
    previa.confianza === CONFIANZA_MEDICION &&
    igualJson(previa.valorJson, valores.valorJson) &&
    igualJson(previa.fuentesJson, fuentes);
  if (igual) return null;

  await db.update(deducciones).set(valores).where(eq(deducciones.id, previa.id));
  await auditarAgente(obraId, ACCION_DEDUCCION_APLICADA, `deducciones:${entidad.id}.${medida.campo}`, {
    regla: 'medicion_grafica',
    valor: { antes: previa.valorJson[medida.campo], despues: medida.valor },
    metodo: medida.metodo,
  });
  return 'actualizada';
}

// ---------------------------------------------------------------------------
// Fase 3: el cruce del expediente
// ---------------------------------------------------------------------------

/**
 * Compacta la obra a texto, se la da al cruce y aplica lo que vuelve.
 *
 * Una llamada por obra, la más grande del pipeline, y la única que ve el
 * expediente entero. Devuelve las láminas que el cruce pidió releer, que es lo
 * que alimenta la fase siguiente.
 */
async function cruzarObra(entorno: Entorno, obra: Obra): Promise<RelecturaPedida[]> {
  const { db } = entorno;

  const memoria = memoriaCompacta(await armarEntradaMemoria(db, obra));
  // El mismo ctx que ve una lámina, pero con el índice **completo**: el cruce no
  // mira una lámina, mira todas. De ahí sale también `nombreObra`, con el que el
  // mock resuelve su fixture y el prompt real nombra la obra.
  const ctx = await contextoDeObra(db, obra);

  const crudo = await entorno.cruce.cruzar(memoria, ctx);
  const expediente = await expedienteDelCruce(db, obra.id);
  const { resultado } = await aplicarCruce(db, obra.id, crudo, expediente);
  return resultado.relecturas;
}

// ---------------------------------------------------------------------------
// Las envolturas tolerantes de cada fase
// ---------------------------------------------------------------------------

/**
 * Recomputa la obra sin tirar la corrida si falla.
 *
 * Mismo criterio que `recomputarTolerante` por lámina: el análisis ya está
 * guardado y el cómputo es derivado. Lo que cambia es que acá el fallo queda
 * anotado en `fallos`, y eso deja el análisis en `{fase: 'error'}` — porque un
 * expediente analizado cuyo cómputo no se pudo recalcular **no está listo**, y
 * decir que sí sería mentirle a la pantalla.
 */
async function recomputarObraTolerante(
  entorno: Entorno,
  obraId: string,
  fallos: string[],
): Promise<void> {
  if (entorno.recomputar === 'diferido') return;
  try {
    await entorno.recomputar(obraId, { db: entorno.db, resumen: false });
  } catch (error) {
    const errorDetalle = detalleDeError(error);
    fallos.push(
      'el cómputo de la obra quedó sin recalcular: las láminas están analizadas, ' +
        'pero la planilla puede no estar al día. Reintentá el cruce del expediente y se recalcula',
    );
    await auditarAgente(obraId, 'recomputo_fallido', `obras:${obraId}`, {
      errorDetalle,
      motivo: 'Las láminas quedaron analizadas; el cómputo de la obra quedó sin recalcular.',
    });
  }
}

/**
 * Anota en `fallos` —y en `auditoria`— cada lámina cuyo turno del pool terminó
 * en error.
 *
 * El pool devuelve un resultado **settled** por ítem justamente para esto: si
 * quien llama descarta el array, un rechazo desaparece sin dejar rastro y la
 * corrida termina diciendo `listo` con una lámina que nadie analizó. Con esto,
 * la fase queda en `error` y la fila de auditoría dice cuál se cayó y por qué.
 */
async function anotarFallosDelLote(
  obraId: string,
  resultados: readonly ResultadoParalelo<unknown>[],
  paginas: readonly PaginaDelDocumento[],
  fallos: string[],
): Promise<void> {
  for (const [indice, resultado] of resultados.entries()) {
    if (resultado.ok) continue;
    const pagina = paginas[indice] as PaginaDelDocumento;
    const errorDetalle = detalleDeError(resultado.error);
    fallos.push(
      `la lámina de la página ${pagina.numeroPagina} quedó sin analizar: lo que dibuja no entró ` +
        'al cómputo. Reprocesala desde el expediente',
    );
    await auditarAgente(obraId, ACCION_EXTRACCION_FALLIDA, `laminas:${pagina.laminaId}`, {
      errorDetalle,
      numeroPagina: pagina.numeroPagina,
      motivo: 'El análisis de la lámina se cortó antes de dejar su estado escrito.',
    });
  }
}

/**
 * Corre el inventario sin tirar la corrida si falla.
 *
 * Un rótulo suelto que no se lee ya lo tolera `inventariarDocumento` lámina por
 * lámina; esto cubre el otro caso —la fase entera se cae, por el storage o por
 * la base— para que `analisis_json` no quede clavado en `inventario` para
 * siempre. La extracción sigue igual: vuelve a leer cada rótulo por su cuenta.
 */
async function inventariarTolerante(
  entorno: Entorno,
  obra: Obra,
  documento: Documento,
  paginas: readonly PaginaDelDocumento[],
  marcarFase: (estado: FaseAnalisis) => Promise<void>,
  fallos: string[],
): Promise<void> {
  try {
    await inventariarDocumento(entorno, obra, documento, paginas, marcarFase);
  } catch (error) {
    const errorDetalle = detalleDeError(error);
    fallos.push(
      'el índice del expediente quedó sin armar: cada lámina se analizó leyendo su propio rótulo, ' +
        'sin saber qué otras láminas hay. Lo que se computó vale igual',
    );
    await auditarAgente(obra.id, ACCION_INVENTARIO_FALLIDO, `obras:${obra.id}`, {
      errorDetalle,
      motivo: 'El índice del expediente quedó sin armar; la extracción lee el rótulo igual.',
    });
  }
}

/** Mide sobre el dibujo sin tirar la corrida si falla. */
async function medirTolerante(
  entorno: Entorno,
  obraId: string,
  paginas: readonly PaginaDelDocumento[],
  fallos: string[],
): Promise<void> {
  try {
    await medirDibujo(entorno, obraId, paginas);
  } catch (error) {
    const errorDetalle = detalleDeError(error);
    fallos.push(
      'lo que el plano dibuja sin acotar quedó sin medir: puede faltar alguna cantidad en la ' +
        'planilla. Reprocesá esas láminas desde el expediente',
    );
    await auditarAgente(obraId, 'medicion_fallida', `obras:${obraId}`, {
      errorDetalle,
      motivo: 'Las láminas quedaron analizadas; lo que no tiene cota quedó sin medir.',
    });
  }
}

/**
 * Corre el cruce sin tirar la corrida si falla.
 *
 * Es la fase más cara y la que sale a la red con el expediente entero: un
 * timeout del provider no puede convertir veinticinco láminas analizadas en un
 * upload fallido. Lo que se pierde si falla son las relaciones entre láminas
 * —la obra queda como estaba, con sus huecos honestos en la bandeja— y la
 * corrida siguiente vuelve a intentarlo (`aplicarCruce` es idempotente).
 */
async function cruzarTolerante(
  entorno: Entorno,
  obra: Obra,
  fallos: string[],
): Promise<RelecturaPedida[]> {
  try {
    return await cruzarObra(entorno, obra);
  } catch (error) {
    const errorDetalle = detalleDeError(error);
    fallos.push(
      'el expediente no se cruzó: las láminas están analizadas y computadas, pero lo que una ' +
        'lámina dice y a otra le falta quedó sin resolver. Reintentá el cruce del expediente',
    );
    await auditarAgente(obra.id, ACCION_CRUCE_FALLIDO, `obras:${obra.id}`, {
      errorDetalle,
      motivo: 'Las láminas quedaron analizadas y computadas; el expediente no se cruzó.',
    });
    return [];
  }
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
async function buscarTolerante(
  entorno: Entorno,
  obraId: string,
  relecturas: readonly RelecturaPedida[] = [],
): Promise<void> {
  try {
    await entorno.buscar(obraId, {
      db: entorno.db,
      storage: entorno.storage,
      // Lo que el cruce pidió releer cambia el ORDEN de las candidatas, no la
      // lista de objetivos (ver `DepsBusqueda.relecturas`).
      ...(relecturas.length > 0 ? { relecturas } : {}),
    });
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
 * Dos escalas son la misma aunque no se escriban igual: `"1:20"`, `" 1:20 "` y
 * `"1: 20"` salieron del mismo rótulo. Comparar los textos crudos avisaría de
 * una contradicción que no existe.
 */
function mismaEscala(una: string, otra: string): boolean {
  const normalizar = (texto: string): string => texto.replace(/\s+/g, '').toLowerCase();
  return normalizar(una) === normalizar(otra);
}

/**
 * La escala que el rótulo acaba de **verificar contra cotas** y que contradice
 * la que la lámina tiene confirmada, o `null` si no hay contradicción.
 *
 * Es la red que le faltaba a `fusionarRotulo`. Que la escala confirmada no se
 * pise está bien y está testeado —protege la corrección del arquitecto—, pero
 * el valor descartado se iba en silencio: la lámina quedaba computada con el
 * viejo y nada en ningún lado decía que la relectura no coincidía. Si esa
 * relectura es la verificada, el cómputo entero puede estar corrido por el
 * factor entre las dos escalas.
 *
 * Las dos condiciones que evitan que esto sea ruido:
 *
 *  - **la relectura tiene que venir verificada** (`rotulo.escalaConfiable`). Una
 *    lectura no verificada que difiere es el caso normal del rótulo mal impreso
 *    que el arquitecto ya corrigió: insistir con eso en cada reproceso sería
 *    pedirle que vuelva a descartar lo mismo para siempre.
 *  - **la lámina tiene que tener una escala confirmada** que contradecir. Con
 *    `escala` en `null`, `fusionarRotulo` adopta la del rótulo y no se descarta
 *    nada.
 */
export function escalaRelectura(
  lamina: Pick<Lamina, 'escala' | 'escalaConfiable'>,
  rotulo: Pick<RotuloDetectado, 'escala' | 'escalaConfiable'>,
): string | null {
  if (!lamina.escalaConfiable || lamina.escala === null) return null;
  if (!rotulo.escalaConfiable || rotulo.escala === null) return null;
  return mismaEscala(lamina.escala, rotulo.escala) ? null : rotulo.escala;
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
 *
 * **Esto dice qué escala hay, no qué hace el pipeline con ella.** Quien decide
 * es `analizarLamina`, y tiene una excepción: una lámina `tipo === 'planilla'`
 * se analiza igual aunque el modo sea `bloqueada`, porque en una tabla no se
 * mide, se lee. Esa excepción vive allá y no acá para que esta función siga
 * siendo la lectura del rótulo y nada más.
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

/**
 * Abre —o cierra— el aviso de que la relectura del rótulo contradice la escala
 * confirmada de la lámina (`escala.<laminaId>.rotulo`).
 *
 * No pisa nada: la lámina sigue computada con la escala confirmada, que es lo
 * que decidió el arquitecto. Lo único que cambia es que el valor descartado
 * deja de irse en silencio.
 *
 * `releida === null` ⇒ la contradicción ya no existe (la relectura coincide, o
 * él confirmó una de las dos) y el aviso abierto se cierra solo. Y **lo que él
 * cerró no se reabre**, igual que en `upsertHallazgoEscala`: descartar el aviso
 * es decir "la buena es la mía", y volver a preguntárselo en cada reproceso
 * sería exactamente el ruido que hay que evitar.
 */
async function sincronizarHallazgoRelectura(
  db: Db,
  lamina: Lamina,
  releida: string | null,
  confianza: number | null,
): Promise<void> {
  const clave = claveEscalaRotulo(lamina.id);
  const [previo] = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, lamina.obraId), eq(hallazgos.clave, clave)));

  if (releida === null) {
    if (!previo || previo.estado !== 'abierto') return;
    await db
      .update(hallazgos)
      .set({ estado: 'descartado', respuestaJson: { ...RESPUESTA_RELECTURA_COINCIDE } })
      .where(eq(hallazgos.id, previo.id));
    await auditarAgente(lamina.obraId, 'hallazgo_descartado', `hallazgos:${clave}`, {
      ...RESPUESTA_RELECTURA_COINCIDE,
    });
    return;
  }

  const campos = {
    tipo: 'inconsistencia' as TipoHallazgo,
    // NO bloqueante: la lámina se computó, y con la escala que él confirmó. Es
    // un aviso, no un freno — frenar la obra por una relectura sería el
    // problema que el plan entero vino a sacar.
    bloqueante: false,
    descripcion: descripcionEscalaRelectura(lamina.escala ?? '', releida),
    valorPropuestoJson: {
      valores: { escala: releida },
      origen: 'rotulo',
      ...(confianza !== null ? { confianza } : {}),
    } satisfies ValorPropuesto,
  };

  if (!previo) {
    await db.insert(hallazgos).values({
      obraId: lamina.obraId,
      clave,
      rubro: null,
      checklistItem: 'escala',
      laminasJson: [{ laminaId: lamina.id, bbox: [0, 0, 1, 1], detalle: 'Lámina completa' }],
      targetRef: null,
      ...campos,
    });
    await auditarAgente(lamina.obraId, 'hallazgo_abierto', `hallazgos:${clave}`, {
      tipo: campos.tipo,
      bloqueante: campos.bloqueante,
      escalaConfirmada: lamina.escala,
      escalaReleida: releida,
    });
    return;
  }

  if (previo.estado !== 'abierto') return;

  // Sin cambios no se escribe: un reproceso idéntico no puede dejar un diff
  // fantasma en `auditoria`.
  const igual =
    previo.descripcion === campos.descripcion &&
    igualJson(previo.valorPropuestoJson, campos.valorPropuestoJson);
  if (igual) return;

  await db.update(hallazgos).set(campos).where(eq(hallazgos.id, previo.id));
  await auditarAgente(lamina.obraId, 'hallazgo_actualizado', `hallazgos:${clave}`, {
    escalaConfirmada: lamina.escala,
    escalaReleida: releida,
  });
}

async function cerrarHallazgoEscala(
  db: Db,
  lamina: Lamina,
  respuesta: Record<string, string> = RESPUESTA_ESCALA_CONFIRMADA,
): Promise<void> {
  const clave = claveEscala(lamina.id);
  const [previo] = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, lamina.obraId), eq(hallazgos.clave, clave)));

  if (!previo || previo.estado !== 'abierto') return;

  // `respondido`, no `descartado`: la consulta se cerró porque alguien aportó
  // el dato —el arquitecto confirmando la escala desde el visor o el
  // expediente, o el propio análisis verificándola contra las cotas—, no
  // porque se decidiera ignorarla. La bandeja muestra ese estado tal cual, y
  // "Descartada" sobre una escala que el arquitecto acaba de confirmar es la
  // auditoría contando otra historia que la que pasó.
  await db
    .update(hallazgos)
    .set({ estado: 'respondido', respuestaJson: { ...respuesta } })
    .where(eq(hallazgos.id, previo.id));
  await auditarAgente(lamina.obraId, 'hallazgo_respondido', `hallazgos:${clave}`, {
    ...respuesta,
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
async function recomputarTolerante(entorno: Entorno, lamina: Lamina): Promise<boolean | 'diferido'> {
  // Durante la extracción en paralelo el recompute no corre por lámina: corre
  // una sola vez, en la fase de cruce (ver `DepsPipeline.recomputar`). Queda
  // dicho en la auditoría de la lámina para que nadie lea un `recomputado:
  // true` que no ocurrió.
  if (entorno.recomputar === 'diferido') return 'diferido';
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
async function contextoDeObra(db: Db, obra: Obra, laminaId?: string): Promise<ObraContexto> {
  // Sin `laminaId` el índice es el expediente completo: es el ctx del **cruce**,
  // que no mira una lámina sino todas.
  const alcance =
    laminaId === undefined
      ? eq(laminas.obraId, obra.id)
      : and(eq(laminas.obraId, obra.id), ne(laminas.id, laminaId));
  const otras = await db
    .select({ codigo: laminas.codigo, titulo: laminas.titulo, tipo: laminas.tipo })
    .from(laminas)
    .where(alcance)
    .orderBy(laminas.numeroPagina);

  const { instruccionesExtraccion } = await leerConfig(db, obra.estudioId);
  const instrucciones = textoInstrucciones(instruccionesExtraccion);
  const titular = leerResumen(obra)?.titular;

  return {
    obraId: obra.id,
    tipoObra: obra.tipo,
    // El nombre de la obra: los providers de lámina lo ignoran y **el cruce lo
    // necesita** —lo nombra en el prompt y el mock resuelve su fixture con
    // `slug(nombreObra)`—. Sin esto, el cruce de toda obra vuelve vacío y nadie
    // se entera: las cinco listas vacías son una respuesta válida.
    nombreObra: obra.nombre,
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
    // igual dice cosas: una carátula o una memoria descriptiva no computan nada
    // y aun así se citan. Vacío ⇒ `null`, que es "no hay texto que citar" y no
    // "no leí".
    const textoExtraido = entrada.textoExtraido?.trim() ? entrada.textoExtraido : null;

    const modo = modoEscala(campos);
    // La escala que el rótulo leyó es la que se propone; la que ya estaba en la
    // lámina puede ser la que cargó el arquitecto, y esa no tiene "confianza de
    // lectura" que declarar.
    const confianzaEscala = rotulo.escala !== null ? rotulo.confianza : null;

    /**
     * **Una planilla no se mide: se lee**, y por eso la falta de escala no la
     * bloquea.
     *
     * Una planilla de carpinterías casi nunca imprime una escala en el rótulo
     * —no tiene por qué: es una tabla—, y el prompt manda `escalaConfiable:
     * true` SOLO tras verificar contra ≥ 2 cotas, así que el provider real
     * devuelve `escala: null, escalaConfiable: false` y `modoEscala` daba
     * `bloqueada`. Con eso la planilla no extraía ni una fila, la deducción
     * planilla↔plano se quedaba sin nada que cruzar y la búsqueda dirigida la
     * excluía de las candidatas (exige `analizada`): la ola entera de "el
     * sistema propone lo que sabe leer" se apagaba para esa obra justo en la
     * lámina donde están escritas las medidas que el arquitecto reclamaba.
     *
     * Bloquearla no protegía nada. RF-201 existe para que nadie mida sobre una
     * escala que no es; en una tabla no se mide, se transcribe, y sus números
     * vienen con todas las letras y con el bbox de la fila.
     *
     * Corolario: tampoco se le abre consulta de escala. Preguntar por la escala
     * de una planilla es pedir un dato que no cambia nada de lo que se extrajo.
     */
    const esPlanilla = campos.tipo === 'planilla';

    if (modo === 'bloqueada' && !esPlanilla) {
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

    // Las tres salidas que sí computan. La diferencia es qué queda en la
    // bandeja: con la escala verificada, nada; con la escala asumida, un
    // supuesto no bloqueante que se confirma de un click con lo que ya se leyó;
    // con una planilla sin escala, tampoco nada — ahí no hay nada que medir, y
    // si una corrida vieja dejó la consulta abierta, se cierra diciendo por qué.
    if (modo === 'asumida') {
      await upsertHallazgoEscala(db, lamina, 'asumida', campos.escala, confianzaEscala);
    } else if (modo === 'bloqueada') {
      await cerrarHallazgoEscala(db, lamina, RESPUESTA_ESCALA_NO_APLICA);
    } else {
      await cerrarHallazgoEscala(db, lamina);
    }
    // Y la red de `fusionarRotulo`: la escala confirmada no se pisa, pero si la
    // relectura verificada dice otra cosa, eso deja de irse en silencio.
    await sincronizarHallazgoRelectura(
      db,
      lamina,
      escalaRelectura(lamina, rotulo),
      confianzaEscala,
    );
    const recomputado = await recomputarTolerante(entorno, lamina);

    await auditarAgente(lamina.obraId, 'lamina_analizada', `laminas:${laminaId}`, {
      codigo: campos.codigo,
      titulo: campos.titulo,
      escala: campos.escala,
      escalaAsumida: modo === 'asumida',
      // Una planilla analizada sin escala: queda dicho en la auditoría, que es
      // donde se ve por qué una lámina sin escala igual trajo entidades.
      ...(modo === 'bloqueada' ? { escalaNoAplica: true } : {}),
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
 *  - **la lámina no está analizada y ahora hay escala confirmada**: no tiene
 *    entidades porque nunca se le extrajeron. Sin re-análisis no hay cómputo
 *    (RF-201); el caso vivo es `bloqueada_escala`;
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
  // Confirmar la escala de una lámina que NO está analizada la manda a
  // analizar: `bloqueada_escala` es el caso vivo, pero una que quedó en `error`
  // o `pendiente` tampoco tiene entidades, y cerrarle la consulta sin
  // reprocesar la dejaría fuera del cómputo sin nada que lo explique.
  const faltaAnalizar = confirmaEscala && previa.estadoAnalisis !== 'analizada';
  const escalaCambio = cambios.escala !== undefined && cambios.escala !== previa.escala;
  const reprocesa = faltaAnalizar || escalaCambio;

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
