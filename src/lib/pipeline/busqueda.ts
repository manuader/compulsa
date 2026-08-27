/**
 * Búsqueda dirigida: releer la documentación buscando lo que la bandeja pregunta.
 *
 * El feedback que la originó, textual: la bandeja se llenaba de consultas
 * pidiendo las medidas de FP01 y FP02 **que están escritas en la planilla de
 * carpinterías**. El sistema ya tenía la lámina, ya la había analizado, y aun
 * así preguntaba — porque el análisis mira cada lámina una vez, sola, sin saber
 * qué le va a faltar al cómputo tres pasos después.
 *
 * Esto invierte el orden. Primero se computa y se abre la bandeja; después se
 * agarra la lista de lo que falta y se vuelve a leer la documentación **con esa
 * lista en la mano**. Es la automatización del prompt que el arquitecto escribe
 * hoy a mano en un chat, con dos cosas que ese prompt no tiene: la respuesta
 * queda atada a la consulta que la motivó y viene con lámina y bbox.
 *
 * ## Las cinco decisiones que definen el comportamiento
 *
 *  1. **Solo propone (P4).** Esta función **jamás** escribe
 *     `entidades.atributos_json`. Lo que encuentra va a
 *     `hallazgos.valor_propuesto_json` con `origen: 'busqueda_dirigida'`, y el
 *     dato entra a la entidad recién cuando el arquitecto confirma. Un número
 *     leído por un modelo y escrito en silencio sobre la entidad sería
 *     exactamente lo que el producto promete no hacer.
 *  2. **Una llamada por lámina, y se corta apenas alcanza.** Las candidatas van
 *     ordenadas con las planillas primero —que es donde vive la tabla de
 *     carpinterías— y el loop frena cuando no queda ningún campo pendiente. En
 *     la obra del reclamo eso es **una** llamada, no una por lámina: el usuario
 *     paga estos créditos.
 *  3. **Cap duro de `MAX_LAMINAS_POR_BUSQUEDA`.** Una obra de 25 láminas no
 *     puede convertirse en 25 llamadas extra por corrida.
 *  4. **Idempotente.** Solo entran hallazgos abiertos **sin** propuesta, y el
 *     update se saltea si el valor no cambió (`igualJson`). Correrla dos veces
 *     seguidas no escribe ni audita nada la segunda vez.
 *  5. **Lo que el arquitecto cerró no se toca.** Un hallazgo `respondido` o
 *     `descartado` no entra a la lista, y el que se cierra **mientras** la
 *     corrida está en vuelo se descarta al momento de escribir: entre pedir el
 *     dato y guardarlo pasan segundos de red.
 *
 * Las propuestas que deja acá sobreviven al recompute: la regla de merge de
 * `recomputar.ts` (decisión 8 del plan) no pisa una `busqueda_dirigida` cuando
 * el motor re-emite el hallazgo sin propuesta propia. Sin eso, el primer
 * recompute posterior tiraba lo que esta corrida pagó.
 */
import { and, eq, isNull } from 'drizzle-orm';

import { getDb, type Db } from '@/db/client';
import {
  documentos,
  entidades,
  hallazgos,
  laminas,
  obras,
  type Hallazgo,
} from '@/db/schema';
import {
  esCampoDeMedida,
  getBusquedaProvider,
  type BusquedaProvider,
  type DatoEncontrado,
  type ObjetivoBusqueda,
} from '@/lib/analysis/busqueda-tipos';
import { registrarAuditoria } from '@/lib/audit';
import type { EntidadPersistida } from '@/lib/computo/engine';
import { camposDelTarget } from '@/lib/hallazgos/target';
import { leerMedida, leerTexto } from '@/lib/hallazgos/taxonomia';
import { PREFIJO_ESCALA, PREFIJO_VERIFICACION } from '@/lib/pipeline/claves';
import { igualJson } from '@/lib/pipeline/json';
import { ACTOR_PIPELINE, comoEntidadPersistida, ObraInexistenteError } from '@/lib/pipeline/recomputar';
import { getStorage, type StorageAdapter } from '@/lib/storage/index';
import type { LaminaIndice, LaminaInput, ObraContexto, ValorPropuesto } from '@/types/domain';

/**
 * Cuántas láminas puede releer una corrida. Peor caso de la obra del reclamo
 * (25 láminas): 8 llamadas extra, ~30 % del costo de analizarla, todas
 * auditadas. El corte es por corrida, no por obra: la búsqueda siguiente
 * arranca por las que quedaron pendientes de propuesta.
 */
export const MAX_LAMINAS_POR_BUSQUEDA = 8;

/** Acción de auditoría de la corrida completa. */
export const ACCION_BUSQUEDA = 'busqueda_dirigida';

/** Acción de auditoría de cada propuesta escrita. */
export const ACCION_PROPUESTA = 'hallazgo_valor_propuesto';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

export interface DepsBusqueda {
  db?: Db;
  storage?: StorageAdapter;
  /** El provider de la búsqueda. Default: `getBusquedaProvider()`. */
  provider?: BusquedaProvider;
}

export interface ResultadoBusqueda {
  /** Hallazgos que efectivamente se salieron a buscar. */
  objetivos: number;
  /** Láminas que se releyeron: una llamada al provider cada una. */
  laminasConsultadas: number;
  /** Objetivos que volvieron con al menos un campo. */
  propuestos: number;
  /** Objetivos que volvieron vacíos: el dato no está en la documentación. */
  sinResultado: number;
}

/** Un dato encontrado, con la lámina en la que se lo encontró. */
interface Hallado extends DatoEncontrado {
  laminaId: string;
}

/** Una lámina candidata, con todo lo que hace falta para releerla. */
interface LaminaCandidata {
  id: string;
  numeroPagina: number;
  archivoRef: string;
  codigo: string | null;
  titulo: string | null;
  tipo: LaminaIndice['tipo'];
  estadoAnalisis: string;
  textoExtraido: string | null;
  documentoNombre: string;
}

// ---------------------------------------------------------------------------
// Qué se sale a buscar
// ---------------------------------------------------------------------------

/**
 * `true` si la consulta es de las que un dato leído en la documentación puede
 * responder.
 *
 * Quedan afuera dos namespaces del pipeline, y no por prolijidad:
 *
 *  - `escala.*` no apunta a un dato de una entidad sino a la escala de la
 *    lámina, que se confirma con el botón de escala (decisión 7 del plan) y que
 *    ya llega propuesta desde el rótulo;
 *  - `verificacion.*` no pide un dato: reporta que dos lecturas de la misma
 *    lámina no coincidieron. Buscar "el dato" ahí es pedirle a una tercera
 *    lectura que desempate dos anteriores, y el arquitecto tiene que mirar esa
 *    diferencia con sus ojos.
 */
function esClaveBuscable(clave: string): boolean {
  return !clave.startsWith(PREFIJO_ESCALA) && !clave.startsWith(PREFIJO_VERIFICACION);
}

/**
 * `true` si la entidad ya tiene el campo. Mismo criterio que los rubros: una
 * medida tiene que estar **y** ser positiva; un texto, no estar vacío.
 *
 * Es lo que evita pagar una llamada para buscar el ancho de una carpintería a
 * la que solo le falta el alto.
 */
function yaLoTiene(entidad: EntidadPersistida, campo: string): boolean {
  return esCampoDeMedida(campo)
    ? leerMedida(entidad, campo) !== null
    : leerTexto(entidad, campo) !== null;
}

/** Cómo se nombra la entidad dentro del pedido que lee el modelo. */
function etiquetaEntidad(entidad: EntidadPersistida): string {
  return `${entidad.tipo} ${entidad.nombre}`;
}

interface Pedido {
  hallazgo: Hallazgo;
  objetivo: ObjetivoBusqueda;
}

/**
 * Los hallazgos abiertos, con target y sin propuesta, traducidos a pedidos.
 *
 * El orden es el de la base filtrado por clave, que es estable dentro de una
 * obra: la lista que se le manda al modelo no cambia entre corridas idénticas.
 */
function armarPedidos(
  filas: readonly Hallazgo[],
  porEntidad: ReadonlyMap<string, EntidadPersistida>,
): Pedido[] {
  const pedidos: Pedido[] = [];

  for (const fila of filas) {
    if (!esClaveBuscable(fila.clave)) continue;

    const target = fila.targetRef;
    if (!target) continue;
    const entidad = porEntidad.get(target.entidadId);
    if (!entidad) continue;

    // `camposDelTarget` es el único lector válido de `target_ref` (T0).
    const campos = camposDelTarget(target).filter((campo) => !yaLoTiene(entidad, campo));
    if (campos.length === 0) continue;

    pedidos.push({
      hallazgo: fila,
      objetivo: {
        clave: fila.clave,
        descripcion: `${etiquetaEntidad(entidad)} — ${fila.descripcion}`,
        campos,
      },
    });
  }

  return pedidos;
}

// ---------------------------------------------------------------------------
// Dónde se busca
// ---------------------------------------------------------------------------

/**
 * Las láminas que vale la pena releer, en el orden en que se leen.
 *
 * Dos familias:
 *
 *  - **las citadas por los hallazgos** (`laminas_json`), que son donde está
 *    dibujado el elemento al que le falta el dato: la cota puede estar ahí
 *    mismo, en un detalle que el análisis no asoció a la entidad;
 *  - **todas las planillas analizadas de la obra**, aunque ningún hallazgo las
 *    cite. Ese es el caso del reclamo: la planilla de carpinterías no genera
 *    entidades (es una tabla, no un dibujo), así que jamás aparecería citada, y
 *    es justo donde están las medidas.
 *
 * Las planillas van **primero** porque es donde el dato aparece escrito con
 * todas las letras. Con el loop cortando apenas no queda nada pendiente, ese
 * orden es lo que hace que la obra del reclamo se resuelva con una sola llamada.
 */
export function laminasCandidatas(
  todas: readonly LaminaCandidata[],
  citadas: ReadonlySet<string>,
  cap: number = MAX_LAMINAS_POR_BUSQUEDA,
): LaminaCandidata[] {
  const esPlanilla = (lamina: LaminaCandidata): boolean =>
    lamina.tipo === 'planilla' && lamina.estadoAnalisis === 'analizada';

  const planillas = todas.filter(esPlanilla);
  const otras = todas.filter((lamina) => !esPlanilla(lamina) && citadas.has(lamina.id));

  return [...planillas, ...otras].slice(0, cap);
}

// ---------------------------------------------------------------------------
// De lo encontrado a la propuesta
// ---------------------------------------------------------------------------

/**
 * Arma la propuesta de un objetivo con lo que volvió de las láminas.
 *
 *  - **por campo gana la mayor confianza** (ya resuelto en `mejores`): dos
 *    láminas pueden decir cosas distintas del mismo vano y la lectura más
 *    segura es la que se propone;
 *  - **la fuente es la del campo mejor leído**: `ValorPropuesto` lleva una sola,
 *    y señalar la lectura más confiable es lo que le sirve al arquitecto que
 *    abre el visor para verificarla;
 *  - **la confianza es la mínima entre los campos**: una tarjeta que propone
 *    ancho al 95 % y alto al 60 % vale por su eslabón más débil. Promediar
 *    escondería el alto flojo detrás del ancho bueno.
 *
 * `null` si no se encontró ningún campo del objetivo.
 */
function armarPropuesta(
  objetivo: ObjetivoBusqueda,
  mejores: ReadonlyMap<string, Hallado>,
): ValorPropuesto | null {
  // En el orden de los campos del target: `valores` queda estable y la tarjeta
  // pide el ancho antes que el alto, como el hallazgo.
  const ganadores = objetivo.campos
    .map((campo) => mejores.get(campo))
    .filter((hallado): hallado is Hallado => hallado !== undefined);
  if (ganadores.length === 0) return null;

  const valores: Record<string, number | string> = {};
  for (const ganador of ganadores) valores[ganador.campo] = ganador.valor;

  const mejor = ganadores.reduce((a, b) => (b.confianza > a.confianza ? b : a));

  return {
    valores,
    fuente: { laminaId: mejor.laminaId, bbox: mejor.bbox },
    confianza: Math.min(...ganadores.map((ganador) => ganador.confianza)),
    origen: 'busqueda_dirigida',
  };
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

// ---------------------------------------------------------------------------
// Entrada pública
// ---------------------------------------------------------------------------

/**
 * Busca en la documentación de la obra los datos que la bandeja está pidiendo y
 * los deja como **propuesta** en cada consulta.
 *
 * No pide rol: la corre el pipeline al terminar de procesar un documento, sin
 * usuario. El botón de la bandeja que la dispara a mano sí exige `colaborador`,
 * y eso se chequea en la acción (`src/lib/bandeja/`), que es donde hay actor.
 *
 * Sin nada que buscar sale sin tocar el storage, sin llamar al provider y sin
 * escribir una línea de auditoría: es la corrida que ocurre el 90 % de las
 * veces y tiene que ser gratis.
 */
export async function buscarDatosFaltantes(
  obraId: string,
  deps: DepsBusqueda = {},
): Promise<ResultadoBusqueda> {
  const db = deps.db ?? (await getDb());

  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ObraInexistenteError(obraId);

  const resultado: ResultadoBusqueda = {
    objetivos: 0,
    laminasConsultadas: 0,
    propuestos: 0,
    sinResultado: 0,
  };

  // Solo `abierto` + con target + sin propuesta. Las tres condiciones son la
  // idempotencia: una consulta que ya tiene propuesta no se vuelve a pagar.
  const abiertos = await db
    .select()
    .from(hallazgos)
    .where(
      and(
        eq(hallazgos.obraId, obraId),
        eq(hallazgos.estado, 'abierto'),
        isNull(hallazgos.valorPropuestoJson),
      ),
    )
    .orderBy(hallazgos.clave);
  if (abiertos.length === 0) return resultado;

  const filasEntidades = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
  const porEntidad = new Map(
    filasEntidades.map((fila) => [fila.id, comoEntidadPersistida(fila)] as const),
  );

  const pedidos = armarPedidos(abiertos, porEntidad);
  if (pedidos.length === 0) return resultado;
  resultado.objetivos = pedidos.length;

  const todasLasLaminas: LaminaCandidata[] = await db
    .select({
      id: laminas.id,
      numeroPagina: laminas.numeroPagina,
      archivoRef: laminas.archivoRef,
      codigo: laminas.codigo,
      titulo: laminas.titulo,
      tipo: laminas.tipo,
      estadoAnalisis: laminas.estadoAnalisis,
      textoExtraido: laminas.textoExtraido,
      documentoNombre: documentos.nombreArchivo,
    })
    .from(laminas)
    .innerJoin(documentos, eq(documentos.id, laminas.documentoId))
    .where(eq(laminas.obraId, obraId))
    .orderBy(laminas.numeroPagina);

  const citadas = new Set<string>();
  for (const pedido of pedidos) {
    for (const fuente of pedido.hallazgo.laminasJson) citadas.add(fuente.laminaId);
  }

  const candidatas = laminasCandidatas(todasLasLaminas, citadas);

  const storage = deps.storage ?? getStorage();
  const provider = deps.provider ?? getBusquedaProvider();

  // El contexto de obra que ve el prompt. `indiceLaminas` sale de las láminas
  // que ya se leyeron: saber que existe una "DET00 — PLANILLA DE CARPINTERÍAS"
  // es parte de saber dónde mirar.
  const ctx: ObraContexto = {
    obraId,
    tipoObra: obra.tipo,
    indiceLaminas: todasLasLaminas.map(({ codigo, titulo, tipo }) => ({ codigo, titulo, tipo })),
  };

  /** Campos que todavía no se encontraron, por clave. */
  const pendientes = new Map(pedidos.map((pedido) => [pedido.objetivo.clave, new Set(pedido.objetivo.campos)]));
  /** Lo mejor leído hasta ahora: clave → campo → dato. */
  const mejores = new Map<string, Map<string, Hallado>>();

  for (const lamina of candidatas) {
    const objetivos = pedidos
      .map((pedido) => ({
        ...pedido.objetivo,
        campos: pedido.objetivo.campos.filter((campo) =>
          pendientes.get(pedido.objetivo.clave)?.has(campo),
        ),
      }))
      .filter((objetivo) => objetivo.campos.length > 0);

    // Nada pendiente: la planilla ya contestó todo y las láminas que quedan no
    // se leen. Es el corte que hace barata la búsqueda.
    if (objetivos.length === 0) break;

    const entrada: LaminaInput = {
      laminaId: lamina.id,
      pdfBytes: await storage.leer(lamina.archivoRef),
      documentoNombre: lamina.documentoNombre,
      numeroPagina: lamina.numeroPagina,
      // El texto ya está guardado en la lámina: no hace falta reabrir el PDF.
      ...(lamina.textoExtraido !== null ? { textoExtraido: lamina.textoExtraido } : {}),
    };

    // Un fallo del provider corta la corrida entera y sube. La búsqueda es
    // aditiva y `procesarDocumento` la llama envuelta de forma tolerante (T2):
    // tragarse el error acá lo escondería de los dos lados.
    const datos = await provider.buscarDatos(entrada, objetivos, ctx);
    resultado.laminasConsultadas += 1;

    for (const dato of datos) {
      const camposPendientes = pendientes.get(dato.clave);
      // El saneo del provider ya filtró a lo pedido; esto es la misma invariante
      // del lado del pipeline, que es quien la necesita para no escribir de más.
      if (!camposPendientes?.has(dato.campo)) continue;

      const porCampo = mejores.get(dato.clave) ?? new Map<string, Hallado>();
      const previo = porCampo.get(dato.campo);
      if (!previo || dato.confianza > previo.confianza) {
        porCampo.set(dato.campo, { ...dato, laminaId: lamina.id });
      }
      mejores.set(dato.clave, porCampo);
    }

    // Lo encontrado deja de pedirse: la lámina siguiente solo busca lo que falta.
    for (const [clave, porCampo] of mejores) {
      const camposPendientes = pendientes.get(clave);
      if (!camposPendientes) continue;
      for (const campo of porCampo.keys()) camposPendientes.delete(campo);
    }
  }

  const escritas: string[] = [];

  for (const pedido of pedidos) {
    const propuesta = armarPropuesta(pedido.objetivo, mejores.get(pedido.objetivo.clave) ?? new Map());
    if (propuesta === null) {
      resultado.sinResultado += 1;
      continue;
    }
    resultado.propuestos += 1;

    // Se relee la fila: entre pedir el dato y guardarlo pasaron segundos de red
    // y el arquitecto pudo haber respondido o descartado la consulta. Lo que él
    // cerró no se toca (regla 3 de la bandeja).
    const [actual] = await db.select().from(hallazgos).where(eq(hallazgos.id, pedido.hallazgo.id));
    if (!actual || actual.estado !== 'abierto') continue;
    if (igualJson(actual.valorPropuestoJson, propuesta)) continue;

    // NUNCA `entidades.atributos_json` (P4): la propuesta vive en el hallazgo
    // hasta que alguien la confirme.
    await db
      .update(hallazgos)
      .set({ valorPropuestoJson: propuesta })
      .where(eq(hallazgos.id, pedido.hallazgo.id));
    escritas.push(pedido.objetivo.clave);

    await auditar(obraId, ACCION_PROPUESTA, `hallazgos:${pedido.objetivo.clave}`, {
      origen: propuesta.origen,
      valores: propuesta.valores,
      confianza: propuesta.confianza,
      laminaId: propuesta.fuente?.laminaId ?? null,
    });
  }

  await auditar(obraId, ACCION_BUSQUEDA, `obras:${obraId}`, {
    objetivos: resultado.objetivos,
    laminasConsultadas: resultado.laminasConsultadas,
    propuestos: resultado.propuestos,
    sinResultado: resultado.sinResultado,
    claves: escritas,
  });

  return resultado;
}
