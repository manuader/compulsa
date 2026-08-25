/**
 * Rubro obra gruesa: mampostería de ladrillo hueco y su mortero.
 *
 * Datos de la plantilla: 16,5 ladrillos huecos del 12 por m² con 5% de
 * desperdicio (pallet de 198 u), 8 kg/m² de cemento (bolsa de 50 kg),
 * 12 kg/m² de cal (bolsa de 25 kg) y 0,04 m³/m² de arena, que se compra a
 * granel en múltiplos de 0,5 m³.
 *
 * Reforma: los muros marcados `demoler` no aportan materiales, solo m² de
 * demolición (sin desperdicio, se contrata global). Un muro que no es de
 * mampostería no se computa con esta plantilla: si es estructural, la respuesta
 * es consultar al profesional competente (RF-506), nunca un número automático.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { armarItem, type Presentacion } from '@/lib/computo/presentacion';
import { redondear2 } from '@/lib/computo/unidades';
import { alcanceDeReforma, hallazgoDatoFaltante, leerMedida, leerTexto } from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
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

  computar(entidades: readonly EntidadPersistida[], _tipoObra: TipoObra): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const nuevos: EntidadPersistida[] = [];
    const demolidos: EntidadPersistida[] = [];
    let m2Nuevos = 0;
    let m2Demolicion = 0;

    for (const entidad of entidades) {
      if (entidad.tipo !== 'muro') continue;
      const alcance = alcanceDeReforma(entidad.estadoReforma);
      if (alcance === 'ninguno') continue; // lo existente no se computa

      const sistema = leerTexto(entidad, 'tipo');
      if (alcance === 'completo' && sistema !== null && normalizar(sistema) !== SISTEMA_ESPERADO) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.sistema_muro.${entidad.nombre}`,
            checklistItem: `${RUBRO}.sistema_muro`,
            descripcion:
              `El muro ${entidad.nombre} figura como "${sistema}", no como mampostería: no lo computo con esta plantilla. ` +
              'Si es un elemento estructural, corresponde consultar al profesional competente antes de computarlo (RF-506).',
            entidad,
            campo: 'tipo',
          }),
        );
        continue;
      }

      const altura = leerMedida(entidad, 'alturaM');
      if (altura === null) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.altura_muros.${entidad.nombre}`,
            checklistItem: `${RUBRO}.altura_muros`,
            descripcion:
              `No encontré la altura del muro ${entidad.nombre}. Sin altura no computo sus m²: ` +
              'cargá el dato o indicá el corte donde está acotada.',
            entidad,
            campo: 'alturaM',
          }),
        );
        continue;
      }

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
            campo: 'largoM',
          }),
        );
        continue;
      }

      if (alcance === 'demolicion') {
        m2Demolicion += largo * altura;
        demolidos.push(entidad);
      } else {
        m2Nuevos += largo * altura;
        nuevos.push(entidad);
      }
    }

    const items: ItemComputo[] = [];

    if (nuevos.length > 0 && m2Nuevos > 0) {
      const m2 = redondear2(m2Nuevos);
      items.push(
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
      );
    }

    if (demolidos.length > 0 && m2Demolicion > 0) {
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.demolicion`,
          descripcion: 'Demolición de muros',
          unidad: 'm2',
          cantNeta: redondear2(m2Demolicion),
          desperdicioPct: 0,
          compra: { tipo: 'global' },
          entidades: demolidos,
        }),
      );
    }

    return { items, hallazgos };
  },
} satisfies PlantillaRubro;
