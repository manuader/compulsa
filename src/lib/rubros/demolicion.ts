/**
 * Rubro demolición: lo que hay que sacar antes de construir.
 *
 * El rubro no lo define el tipo de entidad sino su `estadoReforma`: todo lo que
 * está marcado `demoler` entra acá, sea un muro, un tabique, una carpintería o
 * un solado. Tres ítems, los tres sin desperdicio y contratados global — lo que
 * se tira no se compra:
 *
 *  - `demolicion.muros` (m²): muros y tabiques, largo × altura;
 *  - `demolicion.carpinterias` (u): puertas y ventanas a retirar;
 *  - `demolicion.solados` (m²): pisos a levantar.
 *
 * La altura pasa por la cadena de respaldo (`respaldo.ts`): el atributo del
 * elemento, si no el dato de obra del local (`altura_local.<nivel|general>`) y,
 * si tampoco, UNA consulta para todos los que la esperan.
 *
 * ## Este rubro es el único dueño de lo que se saca
 *
 * `demolicion.carpinterias` cuenta **todas** las carpinterías a retirar, y
 * `demolicion.muros` todos los m² de mampostería y durlock que se tiran. Los
 * rubros que construyen no computan nada de eso: `aberturas.ts` y `gruesa.ts`
 * saltean lo que está marcado `demoler`. Antes emitían su propia versión
 * (`aberturas.retiro.<tag>` y `gruesa.demolicion`), y con las dos vivas una obra
 * de reforma pedía dos veces la misma tarea en la misma planilla. Si algún rubro
 * vuelve a emitir un ítem de retiro o de demolición, eso es el bug.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { armarItem } from '@/lib/computo/presentacion';
import { redondear2 } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  datoEnFrase,
  hallazgoDatoFaltante,
  leerMedida,
} from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import {
  ALTURA_LOCAL,
  cadenaDeRespaldo,
  conFuentesDeDato,
  conOrigenes,
  type DatosObra,
} from '@/lib/rubros/respaldo';
import type { HallazgoDetectado, ItemComputo, TipoObra } from '@/types/domain';

const RUBRO = 'demolicion';

/** Lo que se demuele no se compra: no hay desperdicio que aplicar. */
const DESPERDICIO_DEFAULT_PCT = 0;

/** Los tipos de entidad que aportan m² de muro. */
const TIPOS_MUROS = new Set(['muro', 'tabique']);
/** Los que aportan m² de solado a levantar. */
const TIPOS_SOLADOS = new Set(['ambiente', 'terminacion']);

export const plantillaDemolicion = {
  id: RUBRO,
  nombre: 'Demolición',
  desperdicioDefaultPct: DESPERDICIO_DEFAULT_PCT,

  computar(
    entidades: readonly EntidadPersistida[],
    _tipoObra: TipoObra,
    _laminas?: readonly LaminaDeComputo[],
    datosObra?: DatosObra,
  ): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const cadena = cadenaDeRespaldo(datosObra);
    const deMuros: EntidadPersistida[] = [];
    const deCarpinterias: EntidadPersistida[] = [];
    const deSolados: EntidadPersistida[] = [];
    let m2Muros = 0;
    let m2Solados = 0;

    for (const entidad of entidades) {
      if (alcanceDeReforma(entidad.estadoReforma) !== 'demolicion') continue;

      if (TIPOS_MUROS.has(entidad.tipo)) {
        const altura = cadena.medida(entidad, 'alturaM', ALTURA_LOCAL);
        if (altura === null) continue; // la consulta agrupada sale al final

        const largo = leerMedida(entidad, 'largoM');
        if (largo === null) {
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.largo.${entidad.nombre}`,
              checklistItem: `${RUBRO}.largo`,
              descripcion:
                `No encontré el largo de ${entidad.nombre}, que está marcado para demoler. Sin largo no computo sus m²: ` +
                'cargá el dato o indicá la planta donde está acotado.',
              entidad,
              campos: ['largoM'],
            }),
          );
          continue;
        }

        m2Muros += largo * altura;
        deMuros.push(entidad);
        continue;
      }

      if (entidad.tipo === 'abertura') {
        // Retirar una carpintería no necesita medidas: es una unidad y se saca.
        deCarpinterias.push(entidad);
        continue;
      }

      if (TIPOS_SOLADOS.has(entidad.tipo)) {
        const superficie = leerMedida(entidad, 'superficieM2');
        if (superficie === null) {
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.superficie.${entidad.nombre}`,
              checklistItem: `${RUBRO}.superficie`,
              descripcion:
                `No encontré la superficie de ${entidad.nombre}, que está marcado para demoler. Sin m² no computo el solado a levantar: ` +
                'cargá el dato o indicá la planilla de locales.',
              entidad,
              campos: ['superficieM2'],
            }),
          );
          continue;
        }

        m2Solados += superficie;
        deSolados.push(entidad);
      }
    }

    const items: ItemComputo[] = [];

    if (deMuros.length > 0 && m2Muros > 0) {
      items.push(
        conFuentesDeDato(
          armarItem({
            rubro: RUBRO,
            claveItem: `${RUBRO}.muros`,
            descripcion: 'Demolición de muros y tabiques',
            unidad: 'm2',
            cantNeta: redondear2(m2Muros),
            desperdicioPct: DESPERDICIO_DEFAULT_PCT,
            compra: { tipo: 'global' },
            entidades: deMuros,
          }),
          cadena.fuentesDe(deMuros, 'alturaM'),
        ),
      );
    }

    if (deCarpinterias.length > 0) {
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.carpinterias`,
          descripcion: 'Retiro de carpinterías',
          unidad: 'u',
          cantNeta: deCarpinterias.length,
          desperdicioPct: DESPERDICIO_DEFAULT_PCT,
          compra: { tipo: 'global' },
          entidades: deCarpinterias,
        }),
      );
    }

    if (deSolados.length > 0 && m2Solados > 0) {
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.solados`,
          descripcion: 'Levantamiento de solados',
          unidad: 'm2',
          cantNeta: redondear2(m2Solados),
          desperdicioPct: DESPERDICIO_DEFAULT_PCT,
          compra: { tipo: 'global' },
          entidades: deSolados,
        }),
      );
    }

    // Al final, porque bloquea según lo emitido: el retiro de carpinterías no
    // necesita altura y sale igual, así que el rubro puede tener ítems mientras
    // los m² de muro a demoler están cortos.
    hallazgos.push(
      ...cadena.hallazgosFaltantes({
        rubro: RUBRO,
        unidad: 'm',
        computados: items,
        descripcion: (clave) =>
          `No encontré la altura de lo que hay que demoler y en el expediente tampoco hay ${datoEnFrase(clave)}. ` +
          'Cargá la altura del local una sola vez y la aplico a todo, o indicá el corte donde está acotada.',
      }),
    );

    return { items, hallazgos, ...conOrigenes(cadena.origenPorEntidad()) };
  },
} satisfies PlantillaRubro;
