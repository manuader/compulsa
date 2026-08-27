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
 *  6. **Lo que no está no se vuelve a pagar.** Un objetivo que se buscó y
 *     volvió vacío queda marcado (`hallazgos.busqueda_json`) con la **huella**
 *     de la documentación sobre la que se buscó, y la corrida siguiente no lo
 *     vuelve a pedir. La marca **caduca sola** cuando entra documentación
 *     nueva: la huella cambia y el dato se busca otra vez. Sin esto, una
 *     consulta que la documentación simplemente no puede responder le costaba
 *     al usuario hasta ocho llamadas en cada `procesarDocumento`, para siempre.
 *
 * Las propuestas que deja acá sobreviven al recompute: la regla de merge de
 * `recomputar.ts` (decisión 8 del plan) no pisa una `busqueda_dirigida` cuando
 * el motor re-emite el hallazgo sin propuesta propia. Sin eso, el primer
 * recompute posterior tiraba lo que esta corrida pagó.
 */
import { createHash } from 'node:crypto';

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
import {
  zValorPropuesto,
  type LaminaIndice,
  type LaminaInput,
  type MarcaBusqueda,
  type ObraContexto,
  type ValorPropuesto,
} from '@/types/domain';

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

/** Acción de auditoría de cada marca de "lo busqué y no está en la documentación". */
export const ACCION_SIN_RESULTADO = 'hallazgo_sin_resultado';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

export interface DepsBusqueda {
  db?: Db;
  storage?: StorageAdapter;
  /** El provider de la búsqueda. Default: `getBusquedaProvider()`. */
  provider?: BusquedaProvider;
}

/**
 * El resultado de una corrida.
 *
 * `propuestos + sinResultado` puede ser **menor** que `objetivos`, y la
 * diferencia son los objetivos que encontraron el dato pero no lo escribieron:
 * el arquitecto cerró la consulta mientras la corrida estaba en vuelo, o la
 * propuesta armada no pasó `zValorPropuesto`. Ninguno de los dos casos es "el
 * dato no está en la documentación", que es lo que `sinResultado` significa;
 * meterlos ahí sería mentir en el único número que dice si vale la pena seguir
 * buscando. Los dos quedan en la auditoría de la corrida.
 */
export interface ResultadoBusqueda {
  /**
   * Hallazgos que efectivamente se salieron a buscar. **No** cuenta los que ya
   * tenían marca de "buscado y no está" sobre esta misma documentación: esos no
   * se buscaron (decisión 6). Cuántos se saltearon queda en la auditoría de la
   * corrida, `omitidosPorMarca`.
   */
  objetivos: number;
  /** Láminas que se releyeron: una llamada al provider cada una. */
  laminasConsultadas: number;
  /** Objetivos cuya propuesta quedó escrita en la consulta. */
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
 *
 * **Caso de borde conocido:** el corte por cap es sobre la lista ya ordenada,
 * así que una obra con más de `cap` planillas analizadas no llega a mirar
 * ninguna lámina citada. Es el orden correcto igual —las planillas son donde
 * está el dato, y una obra con nueve planillas es una obra donde el dato está en
 * una planilla—, pero si algún día aparece una obra así y el dato se escapa, el
 * arreglo es reservar un par de lugares del cap para las citadas, no invertir la
 * prioridad.
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
// Lo que ya se buscó y no estaba
// ---------------------------------------------------------------------------

/** Lo que de una lámina define si la documentación de la obra cambió. */
type LaminaParaHuella = Pick<LaminaCandidata, 'id' | 'tipo' | 'estadoAnalisis' | 'textoExtraido'>;

/**
 * Huella de la documentación de la obra: **qué hay para leer y qué dice**.
 *
 * Es el reloj de la marca de "buscado y no está", y tiene que fallar para los
 * dos lados a la vez:
 *
 *  - **un reproceso del mismo documento no la mueve** — las láminas son las
 *    mismas, con el mismo texto y el mismo estado—, que es exactamente el caso
 *    que había que dejar de pagar;
 *  - **documentación nueva sí la mueve**: una lámina nueva (id nuevo), una que
 *    pasó de `bloqueada_escala` a `analizada` (recién ahora es candidata a
 *    releerse), una revisión que cambió el texto o el tipo de la lámina.
 *
 * Por eso entran esos cuatro campos y no una fecha: el dato no aparece porque
 * pase el tiempo, aparece porque el arquitecto sube el plano que lo tiene. Y
 * entra el **texto completo**, no su largo: una revisión que reemplaza una cota
 * por otra deja el largo igual y tiene que caducar la marca igual.
 *
 * Es la huella de **toda la obra**, no la de las candidatas que se leyeron: una
 * lámina nueva puede cambiar qué láminas son candidatas, y una marca que no
 * mirara eso no caducaría cuando llega justo la planilla que faltaba.
 */
export function huellaDocumentacion(laminas: readonly LaminaParaHuella[]): string {
  const filas = laminas
    .map((l) => `${l.id}|${l.tipo ?? ''}|${l.estadoAnalisis}|${l.textoExtraido ?? ''}`)
    .sort();

  const hash = createHash('sha256');
  // Las filas entran serializadas, no concatenadas con un separador: JSON escapa
  // las comillas y los saltos de línea, así que dos láminas no pueden "fusionarse"
  // en una huella distinta por lo que digan sus textos. Un separador imprimible no
  // puede garantizarlo —el texto extraído de un PDF es libre y puede traer
  // cualquier cosa— y el que sí podía, un byte NUL, le da a `git diff` un archivo
  // binario y **lo esconde de `grep -r` y de `rg`, en silencio**: este archivo no
  // aparecía en una búsqueda recursiva. Es la misma trampa que ya documenta
  // `claveDeEntidad` en `procesar.ts`.
  hash.update(JSON.stringify(filas));
  return hash.digest('hex');
}

/**
 * `true` si la marca del hallazgo todavía vale para este objetivo: se buscaron
 * **estos** campos sobre **esta misma** documentación y no estaban.
 *
 * Los campos importan además de la huella porque el objetivo puede haber
 * crecido: si la consulta pedía el ancho y ahora pide ancho y alto, lo que se
 * buscó no cubre lo que falta y hay que volver a salir.
 */
export function marcaVigente(
  marca: MarcaBusqueda | null | undefined,
  huella: string,
  campos: readonly string[],
): boolean {
  if (!marca || marca.huella !== huella) return false;
  const buscados = new Set(marca.campos);
  return campos.every((campo) => buscados.has(campo));
}

/**
 * Deja la marca en el hallazgo, **solo si sigue abierto**. Mismo `UPDATE`
 * condicional que `escribirPropuesta`, y por el mismo motivo: entre que se
 * pidió el dato y se escribe el resultado, el arquitecto puede haber cerrado la
 * consulta desde la bandeja. Marcar una consulta cerrada no rompe nada, pero
 * escribir sobre lo que él cerró es una regla del módulo, no una optimización.
 */
async function marcarSinResultado(
  db: Db,
  hallazgoId: string,
  marca: MarcaBusqueda,
): Promise<boolean> {
  const filas = await db
    .update(hallazgos)
    .set({ busquedaJson: marca })
    .where(and(eq(hallazgos.id, hallazgoId), eq(hallazgos.estado, 'abierto')))
    .returning({ id: hallazgos.id });

  return filas.length > 0;
}

// ---------------------------------------------------------------------------
// De lo encontrado a la propuesta
// ---------------------------------------------------------------------------

/**
 * Arma la propuesta de un objetivo con lo que volvió de las láminas.
 *
 *  - **por campo gana la mayor confianza** (ya resuelto en `mejores`): si una
 *    lámina devuelve dos lecturas del mismo vano, se propone la más segura.
 *    Ojo con el alcance real: como el loop corta apenas el campo aparece, esa
 *    competencia se resuelve **dentro de la respuesta de una lámina**, no entre
 *    láminas — un campo que ya se encontró no se vuelve a pedir. Es el precio
 *    de no pagar una llamada por lámina, y está tomado a propósito;
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

/**
 * La propuesta validada contra el contrato de `hallazgos.valor_propuesto_json`,
 * o `null` si no lo cumple.
 *
 * `sanearBusqueda` es la disciplina **del provider** sobre lo que devuelve un
 * modelo; esto es la del **pipeline** sobre lo que escribe en la base, y son dos
 * cosas distintas: `deps.provider` es inyectable y `DatoEncontrado` es una
 * interfaz de TypeScript, así que un provider que no pase por el saneo —o que
 * tenga un bug— puede devolver una confianza de 3 o un bbox fuera de la lámina
 * sin que nada lo frene. Confiar en que el de al lado ya validó es exactamente
 * cómo entra basura a una columna `jsonb`.
 *
 * Descarta en vez de explotar: la búsqueda es aditiva, y una propuesta que no
 * cumple el contrato deja la consulta como estaba —una pregunta honesta en la
 * bandeja— en vez de tirar abajo la corrida entera. El descarte se cuenta y
 * viaja en la auditoría de la corrida, así que no es silencioso.
 */
function propuestaValida(propuesta: ValorPropuesto): ValorPropuesto | null {
  const validada = zValorPropuesto.safeParse(propuesta);
  return validada.success ? validada.data : null;
}

/**
 * Escribe la propuesta **solo si el hallazgo sigue abierto**, en el mismo
 * `UPDATE`. Devuelve `false` si no tocó ninguna fila.
 *
 * La condición va en el `WHERE` y no solo en un `if` previo: entre leer la fila
 * y escribirla pasan milisegundos en los que el arquitecto puede responder o
 * descartar la consulta desde la bandeja, y con el chequeo únicamente en
 * memoria la propuesta se escribía igual sobre un hallazgo ya cerrado. Es el
 * mismo `UPDATE` condicional con el que `plataforma/usuarios.ts` protege al
 * último titular del estudio.
 *
 * Exportada para poder testear esa condición sola: simular la carrera de verdad
 * pediría meter una costura en el medio de la corrida, y lo que hay que probar
 * es que el `WHERE` la sostiene aunque el `if` no la haya visto.
 */
export async function escribirPropuesta(
  db: Db,
  hallazgoId: string,
  propuesta: ValorPropuesto,
): Promise<boolean> {
  const filas = await db
    .update(hallazgos)
    .set({ valorPropuestoJson: propuesta })
    .where(and(eq(hallazgos.id, hallazgoId), eq(hallazgos.estado, 'abierto')))
    .returning({ id: hallazgos.id });

  return filas.length > 0;
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

  const candidatos = armarPedidos(abiertos, porEntidad);
  if (candidatos.length === 0) return resultado;

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

  // Los que ya se buscaron sobre esta misma documentación no se vuelven a
  // pagar. Si el arquitecto sube algo nuevo, la huella cambia y vuelven a
  // entrar solos (decisión 6).
  const huella = huellaDocumentacion(todasLasLaminas);
  const pedidos = candidatos.filter(
    (pedido) => !marcaVigente(pedido.hallazgo.busquedaJson, huella, pedido.objetivo.campos),
  );
  const omitidos = candidatos.length - pedidos.length;
  if (pedidos.length === 0) return resultado;
  resultado.objetivos = pedidos.length;

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
  /** Propuestas que no cumplieron el contrato de la columna. */
  const invalidas: string[] = [];
  /** Consultas que el arquitecto cerró mientras la corrida estaba en vuelo. */
  const cerradasEnVuelo: string[] = [];
  /** Objetivos que se buscaron y no estaban: se marcan para no re-pagarlos. */
  const vacios: Pedido[] = [];

  for (const pedido of pedidos) {
    const armada = armarPropuesta(pedido.objetivo, mejores.get(pedido.objetivo.clave) ?? new Map());
    if (armada === null) {
      resultado.sinResultado += 1;
      vacios.push(pedido);
      continue;
    }

    // El contrato de `valor_propuesto_json` se aplica acá, antes de escribir:
    // el pipeline no confía en que el provider ya haya saneado.
    const propuesta = propuestaValida(armada);
    if (propuesta === null) {
      invalidas.push(pedido.objetivo.clave);
      continue;
    }

    // Se relee la fila: entre pedir el dato y guardarlo pasaron segundos de red
    // y el arquitecto pudo haber respondido o descartado la consulta. Lo que él
    // cerró no se toca (regla 3 de la bandeja).
    const [actual] = await db.select().from(hallazgos).where(eq(hallazgos.id, pedido.hallazgo.id));
    if (!actual || actual.estado !== 'abierto') {
      cerradasEnVuelo.push(pedido.objetivo.clave);
      continue;
    }
    if (igualJson(actual.valorPropuestoJson, propuesta)) {
      // Ya está escrita, idéntica: cuenta como propuesta y no se audita de nuevo.
      resultado.propuestos += 1;
      continue;
    }

    // NUNCA `entidades.atributos_json` (P4): la propuesta vive en el hallazgo
    // hasta que alguien la confirme. Y solo si sigue abierta: el chequeo de
    // arriba mira una foto, este `UPDATE` mira la fila.
    if (!(await escribirPropuesta(db, pedido.hallazgo.id, propuesta))) {
      cerradasEnVuelo.push(pedido.objetivo.clave);
      continue;
    }
    resultado.propuestos += 1;
    escritas.push(pedido.objetivo.clave);

    await auditar(obraId, ACCION_PROPUESTA, `hallazgos:${pedido.objetivo.clave}`, {
      origen: propuesta.origen,
      valores: propuesta.valores,
      confianza: propuesta.confianza,
      laminaId: propuesta.fuente?.laminaId ?? null,
    });
  }

  // La marca va después de intentar todas las propuestas: si el provider se
  // cayó a mitad de la corrida, nada de esto llegó a escribirse y la próxima
  // vuelve a buscar, que es lo correcto — no se buscó, se rompió.
  const marcadas: string[] = [];
  const at = new Date().toISOString();
  for (const pedido of vacios) {
    const marca: MarcaBusqueda = { campos: pedido.objetivo.campos, huella, at };
    if (!(await marcarSinResultado(db, pedido.hallazgo.id, marca))) {
      cerradasEnVuelo.push(pedido.objetivo.clave);
      continue;
    }
    marcadas.push(pedido.objetivo.clave);
    await auditar(obraId, ACCION_SIN_RESULTADO, `hallazgos:${pedido.objetivo.clave}`, {
      campos: marca.campos,
      huella,
      motivo:
        'El dato no está en la documentación de la obra: no se vuelve a buscar hasta que entre ' +
        'documentación nueva.',
    });
  }

  await auditar(obraId, ACCION_BUSQUEDA, `obras:${obraId}`, {
    objetivos: resultado.objetivos,
    laminasConsultadas: resultado.laminasConsultadas,
    propuestos: resultado.propuestos,
    sinResultado: resultado.sinResultado,
    claves: escritas,
    ...(marcadas.length > 0 ? { marcadas } : {}),
    ...(omitidos > 0 ? { omitidosPorMarca: omitidos } : {}),
    ...(invalidas.length > 0 ? { descartadasPorContrato: invalidas } : {}),
    ...(cerradasEnVuelo.length > 0 ? { cerradasEnVuelo } : {}),
  });

  return resultado;
}
