/**
 * La cadena de respaldo de un campo de medida (§5.2 del diseño).
 *
 * Un tabique sin altura no es un tabique sin altura: es un tabique al que la
 * planta no le acotó la altura porque **el corte la declara una vez para todo
 * el local**. Hasta acá cada plantilla leía el atributo y, si no estaba, abría
 * una consulta por entidad; cuatro tabiques del mismo local abrían cuatro
 * consultas que el arquitecto contestaba cuatro veces con el mismo número.
 *
 * La cadena es: **atributo de la entidad → dato de obra que aplique → pregunta**.
 *
 *  - Si el dato de obra resuelve el campo, el valor entra al cómputo con las
 *    `fuentes` del dato sumadas al ítem (P1: la altura la dice el corte, y el
 *    ítem tiene que citarlo) y el campo queda anotado en `origenPorEntidad` con
 *    **el origen del dato** — un `alturaM` que salió de un dato deducido no es
 *    `explicito`, y el engine (T4) le pone al ítem el peor origen de sus campos.
 *  - Si la entidad no dice a cuál pertenece —un tabique sin `nivel`, que es lo
 *    normal en una planta de verdad— y la obra declaró **una sola** altura de
 *    la familia, esa es. Preguntar `altura_local.general` cuando el cruce ya
 *    anotó `altura_local.PB` es pedirle al arquitecto un número que el sistema
 *    tiene escrito dos renglones más abajo.
 *  - Si tampoco hay dato, la pregunta se hace **una sola vez por clave de dato**:
 *    todas las entidades a las que les falta el mismo hecho entran a un único
 *    `hallazgoDatoObraFaltante`, que apunta a `targetDato` en vez de a una
 *    entidad. Responderlo escribe `datos_obra` y el recompute lo propaga. Esa
 *    consulta **bloquea la aprobación si el rubro emitió ítems sin las
 *    entidades que la esperan**: agrupar las preguntas era el punto; dejar
 *    aprobar una planilla corta, no.
 *
 * El valor del dato **no se escribe en la entidad**: entra al cálculo y queda
 * declarado de dónde salió. Copiar el atributo a la entidad no cambiaría ningún
 * número (ni `armarItem` ni la confianza leen `atributos`) y sí haría creer que
 * la documentación dice algo que no dice.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { unirFuentes } from '@/lib/computo/presentacion';
import {
  datoEnFrase,
  enumerar,
  hallazgoDatoObraFaltante,
  leerMedida,
  leerTexto,
  respaldoDeDatoObra,
} from '@/lib/hallazgos/taxonomia';
import type {
  DatoObraResuelto,
  Fuente,
  HallazgoDetectado,
  ItemComputo,
  Origen,
  RubroId,
  Unidad,
} from '@/types/domain';

/** Lo que recibe una plantilla en su cuarto parámetro (opcional: los tests puros no lo pasan). */
export type DatosObra = ReadonlyMap<string, DatoObraResuelto> | undefined;

/** El sufijo `general`: el hecho que vale para toda la obra cuando no hay uno más fino. */
export const CLAVE_GENERAL = 'general';

/**
 * Una familia de datos de obra: cómo se llama y qué distingue a sus claves.
 *
 * `altura_local` se parte por `nivel` (`altura_local.PB`) y
 * `altura_revestimiento` por ambiente (`altura_revestimiento.Baño`). La cadena
 * necesita las dos cosas: la clave, para buscar el dato, y el nombre de lo que
 * distingue, para poder decirle al arquitecto **por qué** le pregunta.
 */
export interface FamiliaDeDato {
  /** El prefijo de la clave: `altura_local`. */
  familia: string;
  /** Cómo se llama, en es-AR, lo que separa una clave de otra: «nivel». */
  queDistingue: string;
  /** Qué dice la entidad sobre a cuál pertenece, o `null` si no lo dice. */
  especifica(entidad: EntidadPersistida): string | null;
}

/** La altura del local, por nivel. */
export const ALTURA_LOCAL: FamiliaDeDato = {
  familia: 'altura_local',
  queDistingue: 'nivel',
  especifica: (entidad) => leerTexto(entidad, 'nivel'),
};

/** Hasta dónde sube el revestimiento, por ambiente. */
export const ALTURA_REVESTIMIENTO: FamiliaDeDato = {
  familia: 'altura_revestimiento',
  queDistingue: 'ambiente',
  especifica: (entidad) => leerTexto(entidad, 'ambiente') ?? entidad.nombre,
};

/** Las claves candidatas para una entidad, más por qué quedaron así. */
interface Candidatas {
  /** De la que más manda a la que menos; `claves[0]` es por la que se pregunta. */
  claves: string[];
  /**
   * Los sufijos entre los que no se pudo elegir. Vacío salvo que la obra
   * declare varias claves de la familia y la entidad no diga a cuál pertenece.
   */
  ambiguas: string[];
}

/** El sufijo de una clave: `altura_local.PB` ⇒ `PB`. */
function sufijoDeClave(claveDato: string): string {
  const punto = claveDato.indexOf('.');
  return punto === -1 ? claveDato : claveDato.slice(punto + 1);
}

/**
 * Las claves a probar, en orden.
 *
 * Si la entidad dice a cuál pertenece —un tabique con `nivel: 'PB'`—, es la
 * específica y después la general, como siempre.
 *
 * Si **no** lo dice, que es lo que pasa en una obra de verdad (la planta no
 * repite el nivel tabique por tabique, y el prompt tampoco lo pedía), la cadena
 * mira qué declaró la obra antes de preguntar:
 *
 *  - una sola altura específica ⇒ es esa, no hay ambigüedad posible;
 *  - varias ⇒ el sistema no puede elegir por el arquitecto (§P4: deducir no es
 *    inventar), así que pregunta por la general **diciendo cuáles hay**;
 *  - ninguna ⇒ la general, que es la pregunta de siempre.
 *
 * La general, cuando está, gana igual: es el hecho que vale para toda la obra.
 */
function candidatas(
  familia: FamiliaDeDato,
  entidad: EntidadPersistida,
  datosObra: DatosObra,
): Candidatas {
  const general = `${familia.familia}.${CLAVE_GENERAL}`;
  const especifica = familia.especifica(entidad);
  if (especifica !== null && especifica !== CLAVE_GENERAL) {
    return { claves: [`${familia.familia}.${especifica}`, general], ambiguas: [] };
  }

  const declaradas = [...(datosObra?.keys() ?? [])].filter(
    (clave) => clave.startsWith(`${familia.familia}.`) && clave !== general,
  );
  if (declaradas.length === 1) return { claves: [general, declaradas[0] as string], ambiguas: [] };
  if (declaradas.length > 1) {
    return { claves: [general], ambiguas: declaradas.map(sufijoDeClave) };
  }
  return { claves: [general], ambiguas: [] };
}

/** El valor del dato como medida física: número positivo, o `null` si no lo es. */
function medidaDelDato(dato: DatoObraResuelto): number | null {
  const valor =
    typeof dato.valor === 'number'
      ? dato.valor
      : Number(String(dato.valor).replace(',', '.'));
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

export interface EntradaHallazgosFaltantes {
  rubro: RubroId;
  unidad?: Unidad;
  /** El texto de la consulta, armado por la plantilla a partir de la clave del dato. */
  descripcion: (claveDato: string) => string;
  /**
   * Los ítems que el rubro **sí** emitió, que es lo que decide si la consulta
   * bloquea (RF-404).
   *
   * Con ítems emitidos, las entidades que quedaron afuera dejaron la planilla
   * corta —tres tabiques de cuatro son 46,80 m² donde van 62,40— y aprobar el
   * rubro es comprar de menos. Sin ítems no hay nada corto que frenar: lo que
   * impide aprobar un rubro vacío es `aprobarRubroCore`, no esta consulta.
   */
  computados: readonly ItemComputo[];
}

/** La cadena, con la memoria de lo que resolvió y de lo que quedó faltando. */
export interface CadenaRespaldo {
  /**
   * El campo, resuelto por la cadena. `null` = no está y no hay dato: la
   * entidad queda anotada para la consulta agrupada, y la plantilla no la
   * computa.
   */
  medida(entidad: EntidadPersistida, campo: string, familia: FamiliaDeDato): number | null;
  /** `entidadId → campo → origen`, solo para los campos que resolvió un dato de obra. */
  origenPorEntidad(): Map<string, Map<string, Origen>> | undefined;
  /** Las fuentes de los datos que resolvieron ese campo en esas entidades. */
  fuentesDe(entidades: readonly EntidadPersistida[], campo: string): Fuente[];
  /** UN hallazgo por clave de dato faltante, con todos los afectados adentro. */
  hallazgosFaltantes(entrada: EntradaHallazgosFaltantes): HallazgoDetectado[];
}

/** Lo que la cadena recuerda de una clave que nadie pudo resolver. */
interface Faltante {
  entidades: EntidadPersistida[];
  ambiguas: string[];
  familia: FamiliaDeDato;
}

/**
 * La parte honesta de la pregunta: cuando la obra declara varias alturas y la
 * entidad no dice a cuál pertenece, la consulta lo dice en vez de hacer como si
 * no hubiera ninguna. Elegir una por el arquitecto sería inventar (P4).
 */
function notaDeAmbiguedad(falta: Faltante): string {
  if (falta.ambiguas.length === 0) return '';
  const general = `${falta.familia.familia}.${CLAVE_GENERAL}`;
  return (
    ` En el expediente hay ${datoEnFrase(general)} para ${enumerar(falta.ambiguas)}, ` +
    `pero estos elementos no dicen a qué ${falta.familia.queDistingue} pertenecen: ` +
    `completá el ${falta.familia.queDistingue} de cada uno, o cargá un valor que valga para toda la obra.`
  );
}

export function cadenaDeRespaldo(datosObra: DatosObra): CadenaRespaldo {
  const origenes = new Map<string, Map<string, Origen>>();
  const usados = new Map<string, DatoObraResuelto>();
  const faltantes = new Map<string, Faltante>();
  const usoDe = (entidadId: string, campo: string): string => `${entidadId}|${campo}`;

  return {
    medida(entidad, campo, familia) {
      const propio = leerMedida(entidad, campo);
      if (propio !== null) return propio; // explícito: la cadena no interviene

      const { claves, ambiguas } = candidatas(familia, entidad, datosObra);
      for (const clave of claves) {
        const dato = respaldoDeDatoObra(datosObra, clave);
        if (dato === null) continue;
        const valor = medidaDelDato(dato);
        if (valor === null) continue; // un dato que no es una medida no respalda nada

        const porCampo = origenes.get(entidad.id) ?? new Map<string, Origen>();
        porCampo.set(campo, dato.origen);
        origenes.set(entidad.id, porCampo);
        usados.set(usoDe(entidad.id, campo), dato);
        return valor;
      }

      // Se pregunta por la clave que la entidad reconoce: la de su nivel si lo
      // declara ("la altura de PB"), y si no la general, que se responde una
      // vez para toda la obra.
      const clave = claves[0] as string;
      const falta = faltantes.get(clave) ?? { entidades: [], ambiguas, familia };
      falta.entidades.push(entidad);
      faltantes.set(clave, falta);
      return null;
    },

    origenPorEntidad() {
      return origenes.size === 0 ? undefined : origenes;
    },

    fuentesDe(entidades, campo) {
      const listas: Fuente[][] = [];
      for (const entidad of entidades) {
        const dato = usados.get(usoDe(entidad.id, campo));
        if (dato !== undefined) listas.push(dato.fuentes);
      }
      return unirFuentes(...listas);
    },

    hallazgosFaltantes(entrada) {
      // Un solo ítem emitido alcanza: lo que falta lo dejó corto.
      const bloqueante = entrada.computados.length > 0;
      return [...faltantes].map(([claveDato, falta]) =>
        hallazgoDatoObraFaltante({
          rubro: entrada.rubro,
          claveDato,
          ...(entrada.unidad ? { unidad: entrada.unidad } : {}),
          descripcion: entrada.descripcion(claveDato) + notaDeAmbiguedad(falta),
          entidades: falta.entidades,
          bloqueante,
        }),
      );
    },
  };
}

/**
 * El ítem con las fuentes del dato de obra sumadas a las de sus entidades.
 *
 * `armarItem()` hereda la provenance de las entidades y nada más; cuando una
 * medida la puso un dato de obra, la lámina que la declara es parte de la
 * cadena que sostiene el número y tiene que estar citada (P1).
 */
export function conFuentesDeDato(item: ItemComputo, fuentes: readonly Fuente[]): ItemComputo {
  if (fuentes.length === 0) return item;
  return { ...item, fuentes: unirFuentes(item.fuentes, fuentes) };
}

/**
 * El pedazo de `ResultadoComputo` que aporta la cadena, listo para el spread.
 *
 * Devuelve `{}` cuando ningún campo salió de un dato de obra: una plantilla que
 * solo leyó atributos explícitos no declara el mapa, y su resultado es
 * exactamente el de siempre.
 */
export function conOrigenes(
  origenes: Map<string, Map<string, Origen>> | undefined,
): { origenPorEntidad?: Map<string, Map<string, Origen>> } {
  return origenes === undefined ? {} : { origenPorEntidad: origenes };
}
