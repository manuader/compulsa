/**
 * Doble pasada sobre el cómputo (RF-306): leer las láminas una segunda vez y
 * comparar contra lo que está en la planilla.
 *
 * La extracción de una lámina no es determinística —el modelo puede leer `2,60`
 * donde antes leyó `2,50`, o perderse una abertura—, y el arquitecto no tiene
 * cómo saberlo mirando una planilla que se ve prolija. Verificar es pedirle al
 * provider que lea todo de nuevo, computar esa segunda lectura **sin persistir
 * nada** y contar dónde las dos no coinciden.
 *
 * Tres decisiones que definen el comportamiento:
 *
 *  1. **La segunda pasada no escribe entidades ni ítems.** Si escribiera,
 *     "verificar" sería "reprocesar" y perderíamos justamente el punto de
 *     comparación. Lo único que queda en la base son las consultas del diff.
 *  2. **El desvío se mide sobre `cantCompra`**, que es lo que se compra, y con
 *     el umbral pinneado del contrato: más de 5 % relativo ⇒ consulta. Un ítem
 *     que aparece en una sola de las dos pasadas también se reporta: que una
 *     lectura vea una ventana y la otra no es más grave que un 6 % de
 *     diferencia.
 *  3. **La consulta es `inconsistencia` y NO bloqueante.** El cómputo no está
 *     mal —es el que salió de la documentación— pero hay una duda de lectura que
 *     alguien tiene que mirar antes de mandar a comprar. Bloquear la aprobación
 *     del rubro por una diferencia entre dos lecturas del sistema sería trasladar
 *     al arquitecto un problema nuestro.
 *
 * Las claves `verificacion.<claveItem>` están fuera del alcance del recompute
 * (`esClaveDelMotor`): las abre y las cierra esta función, corrida de nuevo.
 */
import { and, eq } from 'drizzle-orm';

import type { Db } from '@/db/client';
import {
  computoItems,
  documentos,
  hallazgos,
  laminas,
  obras,
  type Hallazgo,
  type NuevoHallazgo,
} from '@/db/schema';
import { crearProviderClaude } from '@/lib/analysis/claude';
import { crearProviderMock, SUFIJO_SEGUNDA_PASADA } from '@/lib/analysis/mock';
import type { AnalysisProvider } from '@/lib/analysis/tipos';
import { registrarAuditoria } from '@/lib/audit';
import { computarObra, type EntidadPersistida } from '@/lib/computo/engine';
import { ETIQUETA_UNIDAD, formatearNumero, redondear2 } from '@/lib/computo/unidades';
import { hallazgoInconsistencia } from '@/lib/hallazgos/taxonomia';
import { claveVerificacion, PREFIJO_VERIFICACION } from '@/lib/pipeline/claves';
import { igualJson } from '@/lib/pipeline/json';
import { tieneBBoxUtil } from '@/lib/pipeline/procesar';
import { ACTOR_PIPELINE, ObraInexistenteError } from '@/lib/pipeline/recomputar';
import { requireRolCore, type UsuarioConRol } from '@/lib/plataforma/roles';
import { getStorage, type StorageAdapter } from '@/lib/storage/index';
import type { Fuente, ItemComputo, LaminaInput, RubroId, TipoObra, Unidad } from '@/types/domain';

/** Desvío relativo tolerado entre las dos pasadas, en porcentaje (contrato). */
export const DESVIO_MAXIMO_PCT = 5;

/** Respuesta con la que una verificación posterior cierra una consulta que ya no aplica. */
export const RESPUESTA_VERIFICADO = { auto: 'la segunda lectura dejó de diferir' } as const;

/** Acción de auditoría de la corrida completa. */
export const ACCION_VERIFICACION = 'verificacion_computo';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

export interface DepsVerificacion {
  storage?: StorageAdapter;
  /** El provider de la **segunda** pasada. Default: el de segunda pasada real. */
  provider?: AnalysisProvider;
}

export interface ActorVerificacion extends UsuarioConRol {
  usuarioId: string;
  email: string;
}

/** Por qué una clave entró al diff. */
export type MotivoDiferencia = 'desvio' | 'solo_computo' | 'solo_verificacion';

export interface DiferenciaVerificacion {
  /** Clave del hallazgo: `verificacion.<claveItem>`. */
  clave: string;
  claveItem: string;
  rubro: RubroId;
  descripcion: string;
  unidad: Unidad;
  /** Lo que hay hoy en la planilla. `null` si la primera pasada no lo emitió. */
  cantComputo: number | null;
  /** Lo que dio la segunda lectura. `null` si no lo encontró. */
  cantVerificacion: number | null;
  /** Desvío relativo en porcentaje, redondeado a 2 decimales. */
  desvioPct: number | null;
  motivo: MotivoDiferencia;
}

export interface ResultadoVerificacion {
  /** Láminas que se volvieron a leer. */
  laminasLeidas: number;
  /** Claves distintas comparadas entre las dos pasadas. */
  itemsComparados: number;
  diferencias: DiferenciaVerificacion[];
  hallazgosAbiertos: number;
  hallazgosActualizados: number;
  hallazgosCerrados: number;
}

export class VerificacionFallidaError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'VerificacionFallidaError';
  }
}

// ---------------------------------------------------------------------------
// Segunda pasada
// ---------------------------------------------------------------------------

/**
 * El provider de la segunda lectura.
 *
 * Con key y fuera de tests es Claude —que por no ser determinístico ya lee
 * distinto—; si no, el mock apuntado a los fixtures `-b`. Misma condición que
 * `getAnalysisProvider()`: ninguna suite sale a la red.
 */
export function getProviderSegundaPasada(): AnalysisProvider {
  if (process.env.NODE_ENV !== 'test' && process.env.ANTHROPIC_API_KEY) {
    return crearProviderClaude();
  }
  return crearProviderMock(undefined, { sufijoClave: SUFIJO_SEGUNDA_PASADA });
}

/**
 * Id sintético y estable de una entidad de la segunda pasada.
 *
 * La segunda lectura no se persiste, así que no hay UUID que ponerle; el motor
 * igual necesita un id por entidad (lo usa para `entidadRef` y para el mapa de
 * campos deducidos). `lamina::tipo::nombre` es estable entre corridas, que es lo
 * que hace determinística la verificación con el mock.
 */
function idSintetico(laminaId: string, tipo: string, nombre: string): string {
  return `${laminaId}::${tipo}::${nombre}`;
}

interface SegundaPasada {
  entidades: EntidadPersistida[];
  laminasLeidas: number;
}

async function segundaLectura(
  db: Db,
  obra: { id: string; tipo: TipoObra },
  storage: StorageAdapter,
  provider: AnalysisProvider,
): Promise<SegundaPasada> {
  const filas = await db
    .select({
      id: laminas.id,
      numeroPagina: laminas.numeroPagina,
      archivoRef: laminas.archivoRef,
      codigo: laminas.codigo,
      textoExtraido: laminas.textoExtraido,
      documentoNombre: documentos.nombreArchivo,
    })
    .from(laminas)
    .innerJoin(documentos, eq(documentos.id, laminas.documentoId))
    .where(and(eq(laminas.obraId, obra.id), eq(laminas.estadoAnalisis, 'analizada')))
    .orderBy(laminas.numeroPagina);

  const entidades: EntidadPersistida[] = [];

  for (const lamina of filas) {
    let detectadas;
    try {
      const entrada: LaminaInput = {
        laminaId: lamina.id,
        pdfBytes: await storage.leer(lamina.archivoRef),
        documentoNombre: lamina.documentoNombre,
        numeroPagina: lamina.numeroPagina,
        // El texto ya está guardado en la lámina (RF-106): no hace falta volver a
        // abrir el PDF para sacarlo.
        ...(lamina.textoExtraido !== null ? { textoExtraido: lamina.textoExtraido } : {}),
      };
      detectadas = await provider.extraerEntidades(entrada, {
        obraId: obra.id,
        tipoObra: obra.tipo,
      });
    } catch (error) {
      // Media verificación es peor que ninguna: sin esta lámina, todos sus ítems
      // aparecerían como "el cómputo lo tiene y la segunda lectura no".
      throw new VerificacionFallidaError(
        `No pude releer la lámina ${lamina.codigo ?? lamina.numeroPagina}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    for (const detectada of detectadas) {
      // Mismo filtro que el pipeline: sin bbox no hay entidad (P1).
      if (!tieneBBoxUtil(detectada.bbox)) continue;
      entidades.push({
        ...detectada,
        id: idSintetico(lamina.id, detectada.tipo, detectada.nombre),
        laminaId: lamina.id,
      });
    }
  }

  return { entidades, laminasLeidas: filas.length };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** El desvío relativo entre las dos cantidades, en porcentaje. */
export function desvioPorcentual(cantComputo: number, cantVerificacion: number): number {
  if (cantComputo === 0) return cantVerificacion === 0 ? 0 : Number.POSITIVE_INFINITY;
  return redondear2((Math.abs(cantVerificacion - cantComputo) / cantComputo) * 100);
}

function conUnidad(cantidad: number, unidad: Unidad): string {
  return `${formatearNumero(cantidad)} ${ETIQUETA_UNIDAD[unidad]}`;
}

/** El texto de la consulta: los dos valores, siempre, y qué hacer con eso. */
export function describirDiferencia(diferencia: DiferenciaVerificacion): string {
  const item = `«${diferencia.descripcion}»`;

  if (diferencia.motivo === 'solo_computo') {
    return (
      `La segunda lectura de las láminas no encontró ${item}, que en la planilla figura con ` +
      `${conUnidad(diferencia.cantComputo ?? 0, diferencia.unidad)}. ` +
      'Revisá la lámina: puede ser que el dato se lea con dificultad.'
    );
  }
  if (diferencia.motivo === 'solo_verificacion') {
    return (
      `La segunda lectura de las láminas encontró ${item} ` +
      `(${conUnidad(diferencia.cantVerificacion ?? 0, diferencia.unidad)}) y la planilla no lo ` +
      'tiene. Revisá la lámina: puede faltar un ítem en el cómputo.'
    );
  }

  const desvio =
    diferencia.desvioPct === null || !Number.isFinite(diferencia.desvioPct)
      ? 'una diferencia grande'
      : `${formatearNumero(diferencia.desvioPct)} % de diferencia`;
  return (
    `El cómputo dice ${conUnidad(diferencia.cantComputo ?? 0, diferencia.unidad)} de ${item} y una ` +
    `segunda lectura de las láminas da ${conUnidad(diferencia.cantVerificacion ?? 0, diferencia.unidad)} ` +
    `(${desvio}). Revisá la lámina antes de comprar.`
  );
}

interface ItemDelComputo {
  claveItem: string;
  rubro: RubroId;
  descripcion: string;
  unidad: Unidad;
  cantCompra: number;
  fuentes: Fuente[];
}

/**
 * Compara las dos pasadas por `claveItem` y devuelve solo lo que hay que
 * consultar: desvíos mayores al umbral e ítems que aparecen en una sola.
 *
 * El orden de salida es por clave: la lista es determinística.
 */
export function diferenciasEntrePasadas(
  computo: readonly ItemDelComputo[],
  verificacion: readonly ItemDelComputo[],
): DiferenciaVerificacion[] {
  const porClaveComputo = new Map(computo.map((item) => [item.claveItem, item]));
  const porClaveVerificacion = new Map(verificacion.map((item) => [item.claveItem, item]));

  const claves = [
    ...new Set([...porClaveComputo.keys(), ...porClaveVerificacion.keys()]),
  ].sort((a, b) => a.localeCompare(b, 'es-AR'));

  const diferencias: DiferenciaVerificacion[] = [];

  for (const claveItem of claves) {
    const enComputo = porClaveComputo.get(claveItem);
    const enVerificacion = porClaveVerificacion.get(claveItem);
    const referencia = enComputo ?? enVerificacion;
    if (!referencia) continue;

    const base = {
      clave: claveVerificacion(claveItem),
      claveItem,
      rubro: referencia.rubro,
      descripcion: referencia.descripcion,
      unidad: referencia.unidad,
    };

    if (enComputo && !enVerificacion) {
      diferencias.push({
        ...base,
        cantComputo: enComputo.cantCompra,
        cantVerificacion: null,
        desvioPct: null,
        motivo: 'solo_computo',
      });
      continue;
    }
    if (!enComputo && enVerificacion) {
      diferencias.push({
        ...base,
        cantComputo: null,
        cantVerificacion: enVerificacion.cantCompra,
        desvioPct: null,
        motivo: 'solo_verificacion',
      });
      continue;
    }
    if (!enComputo || !enVerificacion) continue;

    const desvioPct = desvioPorcentual(enComputo.cantCompra, enVerificacion.cantCompra);
    if (desvioPct <= DESVIO_MAXIMO_PCT) continue;

    diferencias.push({
      ...base,
      cantComputo: enComputo.cantCompra,
      cantVerificacion: enVerificacion.cantCompra,
      desvioPct: Number.isFinite(desvioPct) ? desvioPct : null,
      motivo: 'desvio',
    });
  }

  return diferencias;
}

// ---------------------------------------------------------------------------
// Persistencia de las consultas
// ---------------------------------------------------------------------------

function fuentesDeLaDiferencia(
  diferencia: DiferenciaVerificacion,
  computo: ReadonlyMap<string, ItemDelComputo>,
  verificacion: ReadonlyMap<string, ItemDelComputo>,
): Fuente[] {
  const desdeComputo = computo.get(diferencia.claveItem)?.fuentes ?? [];
  if (desdeComputo.length > 0) return desdeComputo;
  return verificacion.get(diferencia.claveItem)?.fuentes ?? [];
}

function valoresDeHallazgo(
  obraId: string,
  diferencia: DiferenciaVerificacion,
  fuentes: Fuente[],
): Omit<NuevoHallazgo, 'id'> {
  const detectado = hallazgoInconsistencia({
    rubro: diferencia.rubro,
    clave: diferencia.clave,
    checklistItem: 'verificacion.doble_pasada',
    descripcion: describirDiferencia(diferencia),
    fuentes,
  });

  return {
    obraId,
    clave: detectado.clave,
    tipo: detectado.tipo,
    rubro: detectado.rubro,
    descripcion: detectado.descripcion,
    checklistItem: detectado.checklistItem ?? null,
    laminasJson: detectado.fuentes,
    targetRef: null,
    bloqueante: detectado.bloqueante,
  };
}

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

/**
 * Sincroniza las consultas de la verificación: abre las nuevas, actualiza las
 * abiertas que cambiaron de números y descarta las que dejaron de diferir.
 *
 * Mismas dos reglas que el resto de la bandeja: lo que el arquitecto respondió o
 * descartó no se reabre, y si nada cambió no se escribe ni se audita.
 */
async function sincronizarConsultas(
  db: Db,
  obraId: string,
  diferencias: readonly DiferenciaVerificacion[],
  fuentesPorClave: ReadonlyMap<string, Fuente[]>,
  resultado: ResultadoVerificacion,
): Promise<void> {
  const existentes = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
  const deVerificacion = existentes.filter((fila) => fila.clave.startsWith(PREFIJO_VERIFICACION));
  const porClave = new Map<string, Hallazgo>(deVerificacion.map((fila) => [fila.clave, fila]));
  const emitidas = new Set<string>();

  for (const diferencia of diferencias) {
    emitidas.add(diferencia.clave);
    const valores = valoresDeHallazgo(obraId, diferencia, fuentesPorClave.get(diferencia.clave) ?? []);
    const previo = porClave.get(diferencia.clave);

    if (!previo) {
      await db.insert(hallazgos).values(valores);
      resultado.hallazgosAbiertos += 1;
      await auditarAgente(obraId, 'hallazgo_abierto', `hallazgos:${diferencia.clave}`, {
        tipo: valores.tipo,
        bloqueante: false,
        cantComputo: diferencia.cantComputo,
        cantVerificacion: diferencia.cantVerificacion,
        desvioPct: diferencia.desvioPct,
      });
      continue;
    }

    if (previo.estado !== 'abierto') continue;
    if (
      previo.descripcion === valores.descripcion &&
      igualJson(previo.laminasJson, valores.laminasJson)
    ) {
      continue;
    }

    await db.update(hallazgos).set(valores).where(eq(hallazgos.id, previo.id));
    resultado.hallazgosActualizados += 1;
    await auditarAgente(obraId, 'hallazgo_actualizado', `hallazgos:${diferencia.clave}`, {
      descripcion: { antes: previo.descripcion, despues: valores.descripcion },
    });
  }

  for (const fila of deVerificacion) {
    if (fila.estado !== 'abierto' || emitidas.has(fila.clave)) continue;
    await db
      .update(hallazgos)
      .set({ estado: 'descartado', respuestaJson: { ...RESPUESTA_VERIFICADO } })
      .where(eq(hallazgos.id, fila.id));
    resultado.hallazgosCerrados += 1;
    await auditarAgente(obraId, 'hallazgo_descartado', `hallazgos:${fila.clave}`, {
      ...RESPUESTA_VERIFICADO,
    });
  }
}

// ---------------------------------------------------------------------------
// Entrada pública
// ---------------------------------------------------------------------------

function comoItemDelComputo(item: ItemComputo): ItemDelComputo {
  return {
    claveItem: item.claveItem,
    rubro: item.rubro,
    descripcion: item.descripcion,
    unidad: item.unidad,
    cantCompra: item.cantCompra,
    fuentes: item.fuentes,
  };
}

/**
 * Verifica el cómputo de la obra con una segunda extracción (RF-306).
 *
 * Rol mínimo `colaborador`: es una acción que escribe consultas en la bandeja.
 * Se exige en el core y no en el botón — esconder el botón no esconde el
 * endpoint (`src/lib/plataforma/roles.ts`).
 */
export async function verificarComputo(
  db: Db,
  deps: DepsVerificacion,
  actor: ActorVerificacion,
  obraId: string,
): Promise<ResultadoVerificacion> {
  requireRolCore(actor, 'colaborador', 'verificar el cómputo');

  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ObraInexistenteError(obraId);

  const storage = deps.storage ?? getStorage();
  const provider = deps.provider ?? getProviderSegundaPasada();

  const { entidades, laminasLeidas } = await segundaLectura(db, obra, storage, provider);
  // Sin persistir nada: la segunda pasada es una hipótesis, no el estado de la obra.
  const { items } = computarObra(entidades, obra.tipo);
  const verificacion = items.map(comoItemDelComputo);

  const filas = await db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.estado, 'activo')));
  const computo: ItemDelComputo[] = filas.map((fila) => ({
    claveItem: fila.claveItem,
    rubro: fila.rubro,
    descripcion: fila.descripcion,
    unidad: fila.unidad,
    cantCompra: fila.cantCompra,
    fuentes: fila.fuentesJson,
  }));

  const diferencias = diferenciasEntrePasadas(computo, verificacion);

  const porClaveComputo = new Map(computo.map((item) => [item.claveItem, item]));
  const porClaveVerificacion = new Map(verificacion.map((item) => [item.claveItem, item]));
  const fuentesPorClave = new Map(
    diferencias.map((diferencia) => [
      diferencia.clave,
      fuentesDeLaDiferencia(diferencia, porClaveComputo, porClaveVerificacion),
    ]),
  );

  const resultado: ResultadoVerificacion = {
    laminasLeidas,
    itemsComparados: new Set([...porClaveComputo.keys(), ...porClaveVerificacion.keys()]).size,
    diferencias,
    hallazgosAbiertos: 0,
    hallazgosActualizados: 0,
    hallazgosCerrados: 0,
  };

  await sincronizarConsultas(db, obraId, diferencias, fuentesPorClave, resultado);

  await registrarAuditoria({
    obraId,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: ACCION_VERIFICACION,
    targetRef: `obras:${obraId}`,
    diff: {
      laminasLeidas,
      itemsComparados: resultado.itemsComparados,
      diferencias: diferencias.length,
      hallazgosAbiertos: resultado.hallazgosAbiertos,
      hallazgosActualizados: resultado.hallazgosActualizados,
      hallazgosCerrados: resultado.hallazgosCerrados,
      claves: diferencias.map((diferencia) => diferencia.claveItem),
    },
  });

  return resultado;
}

/** Las consultas abiertas que dejó la última verificación. Las lee la pantalla. */
export async function consultasDeVerificacion(db: Db, obraId: string): Promise<Hallazgo[]> {
  const filas = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.estado, 'abierto')))
    .orderBy(hallazgos.clave);
  return filas.filter((fila) => fila.clave.startsWith(PREFIJO_VERIFICACION));
}
