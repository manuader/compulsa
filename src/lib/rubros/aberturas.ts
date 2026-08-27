/**
 * Rubro aberturas: carpinterías por tipología.
 *
 * Se computa por unidad, agrupando por `tag` (V2, P1…): el corralón/carpintero
 * cotiza "3 × V2", no metros cuadrados. Sin ancho y alto no hay ítem — una
 * carpintería sin medidas no se puede fabricar ni cotizar —, va a la bandeja
 * como faltante bloqueante apuntando al campo que hay que completar.
 *
 * ## Cuántas hay: la planta cuenta, la planilla especifica
 *
 * Un expediente dice la misma carpintería en dos lugares con dos propósitos
 * distintos: la **planta** la ubica (ahí se ve cuántas hay y dónde) y la
 * **planilla de carpinterías** la describe (medidas, tipología, vidrio). La V2
 * dibujada en la planta y listada en la planilla es UNA sola ventana, y contar
 * una unidad por aparición la duplicaría — el error que el estudio paga en el
 * corralón.
 *
 * La regla, entonces:
 *
 *  1. la cantidad de un tag son sus instancias en láminas `planta`;
 *  2. si ninguna instancia está en una planta, las que estén en cualquier lámina
 *     que **no** sea `planilla` (un corte, una vista, un detalle);
 *  3. si el tag **solo** vive en planillas, se computa **una** y se avisa: una
 *     planilla no dice cuántas hay, y suponerlo es exactamente lo que P4
 *     prohíbe. El ítem sale con `origen: 'supuesto'` y un hallazgo no
 *     bloqueante.
 *
 * En los tres casos las **fuentes** del ítem son las de todas las entidades del
 * grupo: la planilla no suma cantidad, pero sí es documentación del ítem y tiene
 * que quedar citada (P1).
 *
 * Sin el parámetro `laminas` no hay forma de saber qué lámina es cuál, así que
 * el conteo vuelve a ser "una por aparición": es el comportamiento histórico y
 * el que usan los tests de rubro puro. El pipeline siempre lo pasa.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { armarItem } from '@/lib/computo/presentacion';
import { normalizarTag } from '@/lib/computo/tags';
import { formatearNumero } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  hallazgoDatoFaltante,
  hallazgoSupuesto,
  leerMedida,
  leerTexto,
} from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { HallazgoDetectado, ItemComputo, TipoLamina, TipoObra } from '@/types/domain';

const RUBRO = 'aberturas';

/** Las medidas del vano, en el orden en que se piden al responder el hallazgo. */
const MEDIDAS = [
  { campo: 'anchoM', nombre: 'el ancho' },
  { campo: 'altoM', nombre: 'el alto' },
] as const;

/** El tag manda (V2, P1); si no está, el nombre de la entidad. */
function tagDe(entidad: EntidadPersistida): string {
  return leerTexto(entidad, 'tag') ?? entidad.nombre;
}

/**
 * Con qué clave se agrupan dos aberturas. `normalizarTag` saca espacios y pasa
 * a mayúsculas: la `v2` de la planilla y la `V2` de la planta son la misma
 * ventana, y agruparlas por el texto crudo las contaba dos veces.
 *
 * Lo que se **muestra** (descripción, `claveItem`, clave del hallazgo) sigue
 * siendo el tag tal como está escrito en la lámina del primer miembro del
 * grupo: el arquitecto tiene que poder buscar ese texto en su plano.
 */
function claveDeTag(entidad: EntidadPersistida): string {
  return normalizarTag(tagDe(entidad));
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function descripcionDe(entidad: EntidadPersistida, tag: string): string {
  const tipologia = leerTexto(entidad, 'tipologia');
  const encabezado = tipologia ? `${capitalizar(tipologia)} ${tag}` : `Abertura ${tag}`;
  const ancho = leerMedida(entidad, 'anchoM');
  const alto = leerMedida(entidad, 'altoM');
  if (ancho === null || alto === null) return encabezado;
  return `${encabezado} (${formatearNumero(ancho, 2)} × ${formatearNumero(alto, 2)} m)`;
}

function agregar(mapa: Map<string, EntidadPersistida[]>, clave: string, entidad: EntidadPersistida): void {
  const grupo = mapa.get(clave);
  if (grupo) grupo.push(entidad);
  else mapa.set(clave, [entidad]);
}

/** Cuántas unidades físicas hay de un tag, y de dónde salió ese número. */
interface Conteo {
  cantidad: number;
  /** `true` si el tag solo aparece en planillas: la cantidad es un supuesto. */
  supuesto: boolean;
}

/**
 * Aplica la regla de arriba a un grupo de entidades del mismo tag. `tipoDe`
 * devuelve `null` cuando no se sabe de qué lámina salió la entidad, y entonces
 * la entidad cuenta (no es una planilla que se pueda descartar a ciegas).
 */
function contarInstancias(
  grupo: readonly EntidadPersistida[],
  tipoDe: (entidad: EntidadPersistida) => TipoLamina | null,
): Conteo {
  const enPlanta = grupo.filter((entidad) => tipoDe(entidad) === 'planta');
  if (enPlanta.length > 0) return { cantidad: enPlanta.length, supuesto: false };

  const fueraDePlanilla = grupo.filter((entidad) => tipoDe(entidad) !== 'planilla');
  if (fueraDePlanilla.length > 0) return { cantidad: fueraDePlanilla.length, supuesto: false };

  return { cantidad: 1, supuesto: true };
}

export const plantillaAberturas = {
  id: RUBRO,
  nombre: 'Aberturas',
  desperdicioDefaultPct: 0,

  computar(
    entidades: readonly EntidadPersistida[],
    _tipoObra: TipoObra,
    laminas: readonly LaminaDeComputo[] = [],
  ): ResultadoComputo {
    const items: ItemComputo[] = [];
    const hallazgos: HallazgoDetectado[] = [];
    const nuevas = new Map<string, EntidadPersistida[]>();
    const retiros = new Map<string, EntidadPersistida[]>();
    const sinMedidas = new Set<string>();
    const avisados = new Set<string>();

    const tipoPorLamina = new Map(laminas.map((lamina) => [lamina.id, lamina.tipo]));
    const tipoDe = (entidad: EntidadPersistida): TipoLamina | null =>
      tipoPorLamina.get(entidad.laminaId) ?? null;

    /** Un aviso por tag: la clave es única por obra y el ítem queda `supuesto`. */
    const avisarCantidadSupuesta = (
      clave: string,
      tag: string,
      grupo: readonly EntidadPersistida[],
    ): void => {
      if (avisados.has(clave)) return;
      avisados.add(clave);
      hallazgos.push(
        hallazgoSupuesto({
          rubro: RUBRO,
          clave: `${RUBRO}.cantidad_planilla.${tag}`,
          checklistItem: `${RUBRO}.cantidad_planilla`,
          descripcion:
            `${tag} solo aparece en la planilla de carpinterías: computé una sola. ` +
            'Una planilla dice cómo es la carpintería, no cuántas hay. ' +
            'Confirmá la cantidad o indicá en qué planta está dibujada.',
          entidades: grupo,
        }),
      );
    };

    for (const entidad of entidades) {
      if (entidad.tipo !== 'abertura') continue;
      const alcance = alcanceDeReforma(entidad.estadoReforma);
      if (alcance === 'ninguno') continue; // lo existente no se computa

      const tag = tagDe(entidad);
      const clave = claveDeTag(entidad);
      if (alcance === 'demolicion') {
        agregar(retiros, clave, entidad); // el retiro no necesita medidas
        continue;
      }

      const faltantes = MEDIDAS.filter(({ campo }) => leerMedida(entidad, campo) === null);
      if (faltantes.length > 0) {
        if (!sinMedidas.has(clave)) {
          sinMedidas.add(clave); // un hallazgo por tag: la clave es única por obra
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.medidas_vano.${tag}`,
              checklistItem: `${RUBRO}.medidas_vano`,
              descripcion:
                `No encontré ${faltantes.map((m) => m.nombre).join(' ni ')} de ${tag}. ` +
                'Sin medidas no la puedo computar ni pedir cotización: cargá el dato o indicá en qué lámina está la planilla de carpinterías.',
              entidad,
              // Todas las que faltan, no la primera: responder el ancho y que
              // reaparezca la consulta por el alto es exactamente lo que la
              // bandeja no tiene que hacer.
              campos: faltantes.map((m) => m.campo),
            }),
          );
        }
        continue;
      }

      agregar(nuevas, clave, entidad);
    }

    for (const [clave, grupo] of nuevas) {
      const tag = tagDe(grupo[0]!);
      const conteo = contarInstancias(grupo, tipoDe);
      if (conteo.supuesto) avisarCantidadSupuesta(clave, tag, grupo);
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.${tag}`,
          descripcion: descripcionDe(grupo[0]!, tag),
          unidad: 'u',
          cantNeta: conteo.cantidad,
          desperdicioPct: 0,
          compra: { tipo: 'medida' },
          // Todas las entidades del grupo: la planilla no suma cantidad, pero es
          // documentación del ítem y su fuente tiene que quedar citada (P1).
          entidades: grupo,
          ...(conteo.supuesto ? { origen: 'supuesto' as const } : {}),
        }),
      );
    }

    for (const [clave, grupo] of retiros) {
      const tag = tagDe(grupo[0]!);
      const conteo = contarInstancias(grupo, tipoDe);
      if (conteo.supuesto) avisarCantidadSupuesta(clave, tag, grupo);
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.retiro.${tag}`,
          descripcion: `Retiro de ${tag}`,
          unidad: 'u',
          cantNeta: conteo.cantidad,
          desperdicioPct: 0,
          compra: { tipo: 'global' },
          entidades: grupo,
          ...(conteo.supuesto ? { origen: 'supuesto' as const } : {}),
        }),
      );
    }

    return { items, hallazgos };
  },
} satisfies PlantillaRubro;
