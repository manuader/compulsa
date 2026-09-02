/**
 * Rubro obra gruesa: mampostería de ladrillo hueco y su mortero.
 *
 * Datos de la plantilla: 16,5 ladrillos huecos del 12 por m² con 5% de
 * desperdicio (pallet de 198 u), 8 kg/m² de cemento (bolsa de 50 kg),
 * 12 kg/m² de cal (bolsa de 25 kg) y 0,04 m³/m² de arena, que se compra a
 * granel en múltiplos de 0,5 m³.
 *
 * Reforma: los muros marcados `demoler` **salieron de este rubro**. Lo que se
 * tira no es obra gruesa: es demolición, y desde que existe el rubro
 * `demolicion` (§5.7) esos m² se computan una sola vez ahí — `gruesa.demolicion`
 * y `demolicion.muros` conviviendo habrían hecho que la obra pidiera dos veces
 * la misma tarea. Un muro que no es de mampostería no se computa con esta
 * plantilla: si es estructural, la respuesta es consultar al profesional
 * competente (RF-506), nunca un número automático.
 *
 * La altura pasa por la cadena de respaldo (`respaldo.ts`): atributo del muro →
 * dato de obra `altura_local.<nivel|general>` → UNA consulta agrupada.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { armarItem, type Presentacion } from '@/lib/computo/presentacion';
import { redondear2 } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  datoEnFrase,
  hallazgoDatoFaltante,
  leerMedida,
  leerTexto,
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

const RUBRO = 'gruesa';

/** Datos de la plantilla. */
const LADRILLOS_POR_M2 = 16.5;
const DESPERDICIO_LADRILLOS_PCT = 5;
const CEMENTO_KG_POR_M2 = 8;
const CAL_KG_POR_M2 = 12;
const ARENA_M3_POR_M2 = 0.04;
const MULTIPLO_ARENA_M3 = 0.5;
const SISTEMA_ESPERADO = 'mamposteria';

const PALLET: Presentacion = { singular: 'pallet', plural: 'pallets', contenido: 198, detalle: '198 u' };
const BOLSA_CEMENTO: Presentacion = { singular: 'bolsa', plural: 'bolsas', contenido: 50, detalle: '50 kg' };
const BOLSA_CAL: Presentacion = { singular: 'bolsa', plural: 'bolsas', contenido: 25, detalle: '25 kg' };

/** Compara el sistema constructivo sin acentos ni mayúsculas ("Mampostería"). */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export const plantillaGruesa = {
  id: RUBRO,
  nombre: 'Obra gruesa',
  desperdicioDefaultPct: DESPERDICIO_LADRILLOS_PCT,

  computar(
    entidades: readonly EntidadPersistida[],
    _tipoObra: TipoObra,
    _laminas?: readonly LaminaDeComputo[],
    datosObra?: DatosObra,
  ): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const nuevos: EntidadPersistida[] = [];
    const cadena = cadenaDeRespaldo(datosObra);
    let m2Nuevos = 0;

    for (const entidad of entidades) {
      if (entidad.tipo !== 'muro') continue;
      // Lo existente no se computa; lo que se demuele es del rubro demolición.
      if (alcanceDeReforma(entidad.estadoReforma) !== 'completo') continue;

      const sistema = leerTexto(entidad, 'tipo');
      if (sistema !== null && normalizar(sistema) !== SISTEMA_ESPERADO) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.sistema_muro.${entidad.nombre}`,
            checklistItem: `${RUBRO}.sistema_muro`,
            descripcion:
              `El muro ${entidad.nombre} figura como "${sistema}", no como mampostería: no lo computo con esta plantilla. ` +
              'Si es un elemento estructural, corresponde consultar al profesional competente antes de computarlo.',
            entidad,
            campos: ['tipo'],
          }),
        );
        continue;
      }

      const altura = cadena.medida(entidad, 'alturaM', ALTURA_LOCAL);
      if (altura === null) continue; // la consulta agrupada sale al final

      const largo = leerMedida(entidad, 'largoM');
      if (largo === null) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.largo_muros.${entidad.nombre}`,
            checklistItem: `${RUBRO}.largo_muros`,
            descripcion:
              `No encontré el largo del muro ${entidad.nombre}. Sin largo no computo sus m²: ` +
              'cargá el dato o indicá la planta donde está acotado.',
            entidad,
            campos: ['largoM'],
          }),
        );
        continue;
      }

      m2Nuevos += largo * altura;
      nuevos.push(entidad);
    }

    const items: ItemComputo[] = [];

    if (nuevos.length > 0 && m2Nuevos > 0) {
      const m2 = redondear2(m2Nuevos);
      // Los cuatro materiales salen de los mismos m²: si la altura la puso un
      // dato de obra, los cuatro citan su lámina (P1).
      const conAltura = (item: ItemComputo): ItemComputo =>
        conFuentesDeDato(item, cadena.fuentesDe(nuevos, 'alturaM'));
      items.push(
        conAltura(
          armarItem({
            rubro: RUBRO,
            claveItem: `${RUBRO}.ladrillos`,
            descripcion: 'Ladrillo hueco 12',
            unidad: 'u',
            cantNeta: redondear2(m2 * LADRILLOS_POR_M2),
            desperdicioPct: DESPERDICIO_LADRILLOS_PCT,
            compra: { tipo: 'bulto', presentacion: PALLET },
            entidades: nuevos,
          }),
        ),
        conAltura(
          armarItem({
            rubro: RUBRO,
            claveItem: `${RUBRO}.cemento`,
            descripcion: 'Cemento de albañilería',
            unidad: 'kg',
            cantNeta: redondear2(m2 * CEMENTO_KG_POR_M2),
            desperdicioPct: 0,
            compra: { tipo: 'bulto', presentacion: BOLSA_CEMENTO },
            entidades: nuevos,
          }),
        ),
        conAltura(
          armarItem({
            rubro: RUBRO,
            claveItem: `${RUBRO}.cal`,
            descripcion: 'Cal hidratada',
            unidad: 'kg',
            cantNeta: redondear2(m2 * CAL_KG_POR_M2),
            desperdicioPct: 0,
            compra: { tipo: 'bulto', presentacion: BOLSA_CAL },
            entidades: nuevos,
          }),
        ),
        conAltura(
          armarItem({
            rubro: RUBRO,
            claveItem: `${RUBRO}.arena`,
            descripcion: 'Arena para mortero',
            unidad: 'm3',
            cantNeta: redondear2(m2 * ARENA_M3_POR_M2),
            desperdicioPct: 0,
            compra: { tipo: 'granel', multiplo: MULTIPLO_ARENA_M3 },
            entidades: nuevos,
          }),
        ),
      );
    }

    // Va al final porque bloquea según lo que el rubro haya emitido: un muro
    // que quedó afuera de un `gruesa.ladrillos` que igual salió lo dejó corto.
    hallazgos.push(
      ...cadena.hallazgosFaltantes({
        rubro: RUBRO,
        unidad: 'm',
        computados: items,
        descripcion: (clave) =>
          `No encontré la altura de estos muros y en el expediente tampoco hay ${datoEnFrase(clave)}. ` +
          'Cargá la altura del local una sola vez y la aplico a todos, o indicá el corte donde está acotada.',
      }),
    );

    return { items, hallazgos, ...conOrigenes(cadena.origenPorEntidad()) };
  },
} satisfies PlantillaRubro;
