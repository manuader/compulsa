/**
 * Rubro aberturas: carpinterías por tipología.
 *
 * Se computa por unidad, agrupando por `tag` (V2, P1…): el corralón/carpintero
 * cotiza "3 × V2", no metros cuadrados. Sin ancho y alto no hay ítem — una
 * carpintería sin medidas no se puede fabricar ni cotizar —, va a la bandeja
 * como faltante bloqueante apuntando al campo que hay que completar.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { armarItem } from '@/lib/computo/presentacion';
import { formatearNumero } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  hallazgoDatoFaltante,
  leerMedida,
  leerTexto,
} from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { HallazgoDetectado, ItemComputo, TipoObra } from '@/types/domain';

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

export const plantillaAberturas = {
  id: RUBRO,
  nombre: 'Aberturas',
  desperdicioDefaultPct: 0,

  computar(entidades: readonly EntidadPersistida[], _tipoObra: TipoObra): ResultadoComputo {
    const items: ItemComputo[] = [];
    const hallazgos: HallazgoDetectado[] = [];
    const nuevas = new Map<string, EntidadPersistida[]>();
    const retiros = new Map<string, EntidadPersistida[]>();
    const sinMedidas = new Set<string>();

    for (const entidad of entidades) {
      if (entidad.tipo !== 'abertura') continue;
      const alcance = alcanceDeReforma(entidad.estadoReforma);
      if (alcance === 'ninguno') continue; // lo existente no se computa

      const tag = tagDe(entidad);
      if (alcance === 'demolicion') {
        agregar(retiros, tag, entidad); // el retiro no necesita medidas
        continue;
      }

      const faltantes = MEDIDAS.filter(({ campo }) => leerMedida(entidad, campo) === null);
      if (faltantes.length > 0) {
        if (!sinMedidas.has(tag)) {
          sinMedidas.add(tag); // un hallazgo por tag: la clave es única por obra
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.medidas_vano.${tag}`,
              checklistItem: `${RUBRO}.medidas_vano`,
              descripcion:
                `No encontré ${faltantes.map((m) => m.nombre).join(' ni ')} de ${tag}. ` +
                'Sin medidas no la puedo computar ni pedir cotización: cargá el dato o indicá en qué lámina está la planilla de carpinterías.',
              entidad,
              campo: faltantes[0]!.campo,
            }),
          );
        }
        continue;
      }

      agregar(nuevas, tag, entidad);
    }

    for (const [tag, grupo] of nuevas) {
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.${tag}`,
          descripcion: descripcionDe(grupo[0]!, tag),
          unidad: 'u',
          cantNeta: grupo.length,
          desperdicioPct: 0,
          compra: { tipo: 'medida' },
          entidades: grupo,
        }),
      );
    }

    for (const [tag, grupo] of retiros) {
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.retiro.${tag}`,
          descripcion: `Retiro de ${tag}`,
          unidad: 'u',
          cantNeta: grupo.length,
          desperdicioPct: 0,
          compra: { tipo: 'global' },
          entidades: grupo,
        }),
      );
    }

    return { items, hallazgos };
  },
} satisfies PlantillaRubro;
