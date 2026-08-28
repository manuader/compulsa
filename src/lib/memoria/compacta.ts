/**
 * La memoria de obra, en el formato que lee un modelo.
 *
 * El cruce (§25 del prompt maestro: inventariar → extraer → **cruzar**) no
 * puede razonar sobre el conjunto si lo único que ve es una lámina por vez.
 * Esta función serializa el estado entero de la obra —qué láminas hay, qué se
 * leyó en cada una, qué hechos ya valen para toda la obra, qué se dedujo y qué
 * falta— en un texto plano y denso que entra en un prompt.
 *
 * ## Por qué es texto y no JSON
 *
 * Porque el que lo lee no es un parser: es un modelo al que hay que darle el
 * expediente como se lo daría un arquitecto a otro. El JSON gasta tokens en
 * llaves y comillas que no agregan sentido, y las claves repetidas por objeto
 * ahogan lo que importa.
 *
 * ## Dos reglas de formato que no son estilo
 *
 *  1. **Los números van en formato máquina** (`2.6`, no `2,6`). Es la única
 *     salida del sistema que no se escribe en es-AR, y a propósito: el modelo
 *     devuelve valores que `sanearCruce` vuelve a parsear, y una coma decimal
 *     de ida es una ambigüedad de vuelta.
 *  2. **Cada lámina se nombra por su código** (`## A-01`), porque el modelo no
 *     conoce uuids y el saneo del cruce resuelve código → id. La lámina que no
 *     tiene código leído se nombra por su id: es feo, pero es lo único que sigue
 *     siendo resoluble. Inventarle una etiqueta (`s/c-3`) sería darle al modelo
 *     una referencia que después nadie puede resolver.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import type { Lamina } from '@/db/schema';
import type { EntidadPersistida } from '@/lib/computo/engine';
import type {
  DatoObraResuelto,
  EstadoDeduccion,
  ReglaDeduccion,
  TipoHallazgo,
  TipoObra,
} from '@/types/domain';

/**
 * Lo que se dice cuando una sección no tiene nada. **La sección se escribe
 * igual**: que desaparezca se lee como "no había que mirar ahí", y no hay dato
 * más caro que el que nadie sabe que falta.
 */
export const SIN_REGISTRO = '— nada registrado —';

/** Una deducción, aplanada para contarla: el valor ya vive en la entidad. */
export interface DeduccionDeMemoria {
  campo: string;
  regla: ReglaDeduccion;
  confianza: number;
  estado: EstadoDeduccion;
  entidadNombre: string;
  laminaCodigo: string;
}

/** Un hueco abierto, tal como se pregunta en la bandeja. */
export interface HallazgoDeMemoria {
  clave: string;
  tipo: TipoHallazgo;
  descripcion: string;
  bloqueante: boolean;
}

/**
 * El estado de la obra en un objeto, único insumo de las dos memorias.
 *
 * Las dos salidas —la compacta para el cruce y el `.md` para el arquitecto—
 * salen de acá y de nada más: si cada una leyera la base por su cuenta, el día
 * que discrepen nadie sabría cuál de las dos miente.
 */
export interface EntradaMemoria {
  obra: { nombre: string; tipo: TipoObra };
  laminas: Pick<
    Lamina,
    'id' | 'codigo' | 'titulo' | 'tipo' | 'escala' | 'escalaConfiable' | 'estadoAnalisis'
  >[];
  entidades: EntidadPersistida[];
  datosObra: DatoObraResuelto[];
  deducciones: DeduccionDeMemoria[];
  hallazgosAbiertos: HallazgoDeMemoria[];
}

/** Una lámina de la entrada, tal como la mira cualquiera de las dos memorias. */
export type LaminaDeMemoria = EntradaMemoria['laminas'][number];

/** Las entidades de una lámina, con el nombre por el que esa lámina se cita. */
export interface GrupoDeLamina {
  ref: string;
  entidades: EntidadPersistida[];
}

/** Cómo se llama una lámina en el texto: su código, o su id si no leyó código. */
export function refDeLamina(lamina: LaminaDeMemoria): string {
  return lamina.codigo ?? lamina.id;
}

/**
 * Las entidades agrupadas por lámina, en el orden del índice.
 *
 * Vive acá —y no en cada memoria— porque las dos tienen que agrupar igual: el
 * `.md` que baja el arquitecto y el texto que lee el modelo no pueden ordenar
 * la obra de dos maneras distintas.
 *
 * Las láminas sin entidades **no** salen: el índice ya dice que existen y en
 * qué estado están. Y una entidad cuya lámina no vino en la entrada tampoco se
 * tira: sale en un grupo propio, nombrado por su id.
 */
export function agruparPorLamina(entrada: EntradaMemoria): GrupoDeLamina[] {
  const porLamina = new Map<string, EntidadPersistida[]>();
  for (const entidad of entrada.entidades) {
    const grupo = porLamina.get(entidad.laminaId);
    if (grupo) grupo.push(entidad);
    else porLamina.set(entidad.laminaId, [entidad]);
  }

  const orden = [
    ...entrada.laminas.map((lamina) => [lamina.id, refDeLamina(lamina)] as const),
    ...[...porLamina.keys()].map((id) => [id, id] as const),
  ];

  const grupos: GrupoDeLamina[] = [];
  const vistas = new Set<string>();
  for (const [id, ref] of orden) {
    if (vistas.has(id)) continue;
    vistas.add(id);
    const entidades = porLamina.get(id);
    if (entidades === undefined || entidades.length === 0) continue;
    grupos.push({ ref, entidades });
  }
  return grupos;
}

/** Las láminas que sostienen algo, citadas por código y sin repetir. */
export function refsDeFuentes(
  fuentes: readonly { laminaId: string }[],
  laminas: readonly LaminaDeMemoria[],
): string[] {
  const refs = new Map(laminas.map((lamina) => [lamina.id, refDeLamina(lamina)]));
  return [...new Set(fuentes.map((fuente) => refs.get(fuente.laminaId) ?? fuente.laminaId))];
}

/**
 * El estado de la obra como texto para el cruce.
 *
 * Cinco bloques, siempre los cinco: índice de láminas, entidades agrupadas por
 * lámina, datos de obra resueltos, deducciones ya aplicadas y lo que falta.
 */
export function memoriaCompacta(entrada: EntradaMemoria): string {
  const bloques = [
    `# OBRA: ${entrada.obra.nombre} (${entrada.obra.tipo})`,
    bloque('LÁMINAS', entrada.laminas.map(lineaDeLamina)),
    bloque('ENTIDADES POR LÁMINA', lineasDeEntidades(entrada)),
    bloque('DATOS DE OBRA', entrada.datosObra.map((dato) => lineaDeDato(dato, entrada))),
    bloque('DEDUCCIONES APLICADAS', lineasDeDeducciones(entrada.deducciones)),
    bloque('QUÉ FALTA', entrada.hallazgosAbiertos.map(lineaDeHallazgo)),
  ];
  return `${bloques.join('\n\n')}\n`;
}

function bloque(titulo: string, lineas: readonly string[]): string {
  return `# ${titulo}\n${lineas.length === 0 ? SIN_REGISTRO : lineas.join('\n')}`;
}

/** `- A-01 · Planta baja · planta · esc. 1:50 (confirmada) · analizada` */
function lineaDeLamina(lamina: LaminaDeMemoria): string {
  return [
    `- ${refDeLamina(lamina)}`,
    lamina.titulo ?? 'sin título',
    lamina.tipo ?? 'sin clasificar',
    escalaCompacta(lamina),
    lamina.estadoAnalisis,
  ].join(' · ');
}

function escalaCompacta(lamina: LaminaDeMemoria): string {
  if (lamina.escala === null) return 'sin escala';
  return `esc. ${lamina.escala} (${lamina.escalaConfiable ? 'confirmada' : 'asumida'})`;
}

/** Las entidades agrupadas por lámina, una línea por entidad. */
function lineasDeEntidades(entrada: EntradaMemoria): string[] {
  return agruparPorLamina(entrada).flatMap((grupo) => [
    `## ${grupo.ref}`,
    ...grupo.entidades.map(lineaDeEntidad),
  ]);
}

/** `- T1 (tabique): largoM=4` — el formato es contrato: lo lee un modelo. */
function lineaDeEntidad(entidad: EntidadPersistida): string {
  const reforma = entidad.estadoReforma === 'na' ? '' : `, ${entidad.estadoReforma}`;
  const atributos = Object.entries(entidad.atributos)
    // Un atributo en `null` no es un dato: es un campo que nadie leyó.
    .filter(([, valor]) => valor !== null)
    .map(([clave, valor]) => `${clave}=${valor}`)
    .join('; ');
  const cabeza = `- ${entidad.nombre} (${entidad.tipo}${reforma})`;
  return atributos === '' ? cabeza : `${cabeza}: ${atributos}`;
}

/** `- altura_local.PB = 2.6 m · deducido · confianza 0.80 · A-02` */
function lineaDeDato(dato: DatoObraResuelto, entrada: EntradaMemoria): string {
  const unidad = dato.unidad === undefined ? '' : ` ${dato.unidad}`;
  const citas = refsDeFuentes(dato.fuentes, entrada.laminas);
  const partes = [
    `- ${dato.clave} = ${dato.valor}${unidad}`,
    dato.origen,
    `confianza ${dato.confianza.toFixed(2)}`,
    citas.length === 0 ? 'sin fuente' : citas.join(', '),
  ];
  if (dato.metodo !== undefined) partes.push(dato.metodo);
  return partes.join(' · ');
}

/**
 * Solo las **validadas**: son las que ya escribieron el atributo en la entidad,
 * así que el modelo las tiene que leer como parte del estado de la obra. Una
 * propuesta todavía no cambió nada y ofrecérsela como hecho sería mentirle.
 */
function lineasDeDeducciones(deducciones: readonly DeduccionDeMemoria[]): string[] {
  return deducciones
    .filter((deduccion) => deduccion.estado === 'validada')
    .map(
      (deduccion) =>
        `- ${deduccion.entidadNombre} · ${deduccion.campo} · ${deduccion.regla} · ` +
        `confianza ${deduccion.confianza.toFixed(2)} · ${deduccion.laminaCodigo}`,
    );
}

/** `- [bloqueante] seco.altura_tabiques.T2 (faltante): Falta la altura...` */
function lineaDeHallazgo(hallazgo: HallazgoDeMemoria): string {
  const marca = hallazgo.bloqueante ? '[bloqueante] ' : '';
  return `- ${marca}${hallazgo.clave} (${hallazgo.tipo}): ${hallazgo.descripcion}`;
}
