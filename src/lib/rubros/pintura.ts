/**
 * Rubro pintura: látex interior en paredes y cielorrasos.
 *
 * Datos de la plantilla: 2 manos, rendimiento 10 m²/L por mano y 5% de
 * desperdicio. El litraje se compra en latas de 20/10/4/1 L, así que la
 * cantidad de compra sale del reparto en latas, no de un redondeo a secas.
 *
 * Paredes = perímetro × altura − vanos. Si el ambiente no declara `vanosM2` no
 * se inventa un descuento: se computa **bruto** y se avisa con un hallazgo
 * `supuesto` no bloqueante (el ítem queda con origen `supuesto`). Sin altura,
 * en cambio, no hay superficie posible: consulta bloqueante y las paredes de
 * ese ambiente no entran al cómputo — su cielorraso sí, que solo necesita m².
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { armarItem } from '@/lib/computo/presentacion';
import { redondear2 } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  hallazgoDatoFaltante,
  hallazgoSupuesto,
  leerMedida,
  leerNumero,
} from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { HallazgoDetectado, ItemComputo, TipoObra } from '@/types/domain';

const RUBRO = 'pintura';

/** Datos de la plantilla. */
const MANOS = 2;
const RENDIMIENTO_M2_POR_LITRO = 10; // por mano
const DESPERDICIO_PCT = 5;

/** m² de superficie a pintar → litros netos de látex. */
function litrosPara(m2: number): number {
  return redondear2((m2 * MANOS) / RENDIMIENTO_M2_POR_LITRO);
}

export const plantillaPintura = {
  id: RUBRO,
  nombre: 'Pintura',
  desperdicioDefaultPct: DESPERDICIO_PCT,

  computar(entidades: readonly EntidadPersistida[], _tipoObra: TipoObra): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const deParedes: EntidadPersistida[] = [];
    const deCielorrasos: EntidadPersistida[] = [];
    let m2Paredes = 0;
    let m2Cielorrasos = 0;
    let vanosSupuestos = false;

    for (const entidad of entidades) {
      if (entidad.tipo !== 'ambiente') continue;
      if (alcanceDeReforma(entidad.estadoReforma) !== 'completo') continue; // existente/demoler: no se pinta

      // --- Paredes ---
      const altura = leerMedida(entidad, 'alturaM');
      const perimetro = leerMedida(entidad, 'perimetroM');
      if (altura === null) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.altura_ambiente.${entidad.nombre}`,
            checklistItem: `${RUBRO}.altura_ambiente`,
            descripcion:
              `No encontré la altura de ${entidad.nombre}. Sin altura no computo los m² de pared: ` +
              'cargá el dato o indicá el corte donde está acotada.',
            entidad,
            campo: 'alturaM',
          }),
        );
      } else if (perimetro === null) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.perimetro_ambiente.${entidad.nombre}`,
            checklistItem: `${RUBRO}.perimetro_ambiente`,
            descripcion:
              `No encontré el perímetro de ${entidad.nombre}. Sin perímetro no computo los m² de pared: ` +
              'cargá el dato o indicá la planta donde está acotado.',
            entidad,
            campo: 'perimetroM',
          }),
        );
      } else {
        const vanos = leerNumero(entidad, 'vanosM2');
        if (vanos === null) {
          vanosSupuestos = true;
          hallazgos.push(
            hallazgoSupuesto({
              rubro: RUBRO,
              clave: `${RUBRO}.vanos_sin_descontar.${entidad.nombre}`,
              checklistItem: `${RUBRO}.vanos_sin_descontar`,
              descripcion:
                `En ${entidad.nombre} no hay superficie de vanos declarada: se computó sin descontar vanos, es decir, de más. ` +
                'Confirmá los m² de puertas y ventanas para ajustar el litraje.',
              entidades: [entidad],
            }),
          );
        }
        m2Paredes += Math.max(0, perimetro * altura - (vanos ?? 0));
        deParedes.push(entidad);
      }

      // --- Cielorraso ---
      const superficie = leerMedida(entidad, 'superficieM2');
      if (superficie === null) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.superficie_ambiente.${entidad.nombre}`,
            checklistItem: `${RUBRO}.superficie_ambiente`,
            descripcion:
              `No encontré la superficie de ${entidad.nombre}. Sin m² no computo la pintura del cielorraso: ` +
              'cargá el dato o indicá la planilla de locales.',
            entidad,
            campo: 'superficieM2',
          }),
        );
      } else {
        m2Cielorrasos += superficie;
        deCielorrasos.push(entidad);
      }
    }

    const items: ItemComputo[] = [];

    if (deParedes.length > 0 && m2Paredes > 0) {
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.latex_paredes`,
          descripcion: `Látex interior para paredes (${MANOS} manos)`,
          unidad: 'l',
          cantNeta: litrosPara(redondear2(m2Paredes)),
          desperdicioPct: DESPERDICIO_PCT,
          compra: { tipo: 'latas' },
          entidades: deParedes,
          ...(vanosSupuestos ? { origen: 'supuesto' as const } : {}),
        }),
      );
    }

    if (deCielorrasos.length > 0 && m2Cielorrasos > 0) {
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.latex_cielorrasos`,
          descripcion: `Látex interior para cielorrasos (${MANOS} manos)`,
          unidad: 'l',
          cantNeta: litrosPara(redondear2(m2Cielorrasos)),
          desperdicioPct: DESPERDICIO_PCT,
          compra: { tipo: 'latas' },
          entidades: deCielorrasos,
        }),
      );
    }

    return { items, hallazgos };
  },
} satisfies PlantillaRubro;
