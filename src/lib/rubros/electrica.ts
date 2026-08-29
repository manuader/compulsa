/**
 * Rubro instalación eléctrica: bocas por tipo.
 *
 * Una cuenta sola: cuántas bocas hay de cada tipo (toma, luz, caja, tablero,
 * datos). Es la unidad con la que se presupuesta la instalación en un estudio
 * argentino —el electricista cotiza "la boca", con caño, cable y caja adentro—,
 * así que dos tableros dibujados en la misma lámina son dos unidades y se suman
 * sin más: acá no hay tag que pueda estar diciendo dos veces la misma cosa,
 * como sí pasa con una carpintería que está en la planta y en la planilla.
 *
 * **Los metros de cable quedan fuera a propósito.** El recorrido no está
 * dibujado en ninguna lámina de arquitectura y estimarlo a partir de la
 * cantidad de bocas sería inventar un número que después alguien compra (P4).
 * Si el proyecto trae el tendido, entra como entidades y se computa; mientras
 * tanto, el rubro dice lo que sabe y nada más.
 *
 * Una boca sin tipo no se cuenta: sale como consulta bloqueante, igual que el
 * tabique sin altura en `seco.ts`.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { armarItem, type ModoCompra } from '@/lib/computo/presentacion';
import { redondearEntero } from '@/lib/computo/unidades';
import { alcanceDeReforma, hallazgoDatoFaltante, leerTexto } from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { DatoObraResuelto, HallazgoDetectado, ItemComputo, TipoObra } from '@/types/domain';

const RUBRO = 'electrica';

/** Las bocas se cuentan de a una: no hay desperdicio que aplicar. */
const DESPERDICIO_DEFAULT_PCT = 0;

/**
 * La boca se contrata por unidad; no viene en bulto que haya que redondear, así
 * que la cantidad de compra es la neta.
 */
const SIN_BULTO: ModoCompra = { tipo: 'global' };

/** El orden acá es el orden de los ítems en la planilla. */
const TIPOS_BOCA = ['toma', 'luz', 'caja', 'tablero', 'datos'] as const;
type TipoBoca = (typeof TIPOS_BOCA)[number];

const ETIQUETA_BOCA: Record<TipoBoca, string> = {
  toma: 'Boca de tomacorriente',
  luz: 'Boca de luz',
  caja: 'Caja de paso',
  tablero: 'Tablero eléctrico',
  datos: 'Boca de datos',
};

/** Cómo se nombran los tipos en una consulta, en es-AR. */
const TIPOS_EN_TEXTO = 'toma, luz, caja, tablero o datos';

export const plantillaElectrica = {
  id: RUBRO,
  nombre: 'Instalación eléctrica',
  desperdicioDefaultPct: DESPERDICIO_DEFAULT_PCT,

  /**
   * `laminas` y `datosObra` se ignoran a propósito: contar bocas no depende del
   * tipo de lámina, y no hay ningún campo de medida que la cadena de respaldo
   * del §5.2 pueda completar (las alturas son de muros y ambientes).
   */
  computar(
    entidades: readonly EntidadPersistida[],
    _tipoObra: TipoObra,
    _laminas?: readonly LaminaDeComputo[],
    _datosObra?: ReadonlyMap<string, DatoObraResuelto>,
  ): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const porTipo = new Map<TipoBoca, EntidadPersistida[]>();

    for (const entidad of entidades) {
      if (entidad.tipo !== 'boca') continue;
      // Lo existente no está en el alcance y lo que se saca lo computa el rubro
      // demolición: acá no se pregunta por ninguno de los dos.
      if (alcanceDeReforma(entidad.estadoReforma) !== 'completo') continue;

      const declarado = leerTexto(entidad, 'tipo')?.toLowerCase() ?? null;
      const tipo = TIPOS_BOCA.find((candidato) => candidato === declarado) ?? null;
      if (tipo === null) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.tipo_bocas.${entidad.nombre}`,
            checklistItem: `${RUBRO}.tipo_bocas`,
            descripcion:
              declarado === null
                ? `La boca ${entidad.nombre} no dice de qué tipo es (${TIPOS_EN_TEXTO}). ` +
                  'Sin eso no la computo: cargá el tipo o indicá la referencia de la lámina donde está.'
                : `La boca ${entidad.nombre} figura como "${declarado}", que no es ninguno de los tipos del rubro ` +
                  `(${TIPOS_EN_TEXTO}): no la computo. Corregí el tipo o pedila aparte.`,
            entidad,
            campos: ['tipo'],
          }),
        );
        continue;
      }

      const previas = porTipo.get(tipo);
      if (previas) previas.push(entidad);
      else porTipo.set(tipo, [entidad]);
    }

    const items: ItemComputo[] = [];
    for (const tipo of TIPOS_BOCA) {
      const bocas = porTipo.get(tipo);
      if (!bocas) continue;
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.boca.${tipo}`,
          descripcion: ETIQUETA_BOCA[tipo],
          unidad: 'u',
          cantNeta: redondearEntero(bocas.length),
          desperdicioPct: DESPERDICIO_DEFAULT_PCT,
          compra: SIN_BULTO,
          entidades: bocas,
        }),
      );
    }

    return { items, hallazgos };
  },
} satisfies PlantillaRubro;
