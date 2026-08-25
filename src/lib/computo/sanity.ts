/**
 * Verificaciones cruzadas del cómputo (PRD §12).
 *
 * No son reglas de un rubro sino chequeos de coherencia de la documentación:
 * dos datos que deberían cerrar entre sí y no cierran. Devuelven hallazgos de
 * tipo `inconsistencia` —nunca excepciones, nunca un ítem menos— para que el
 * arquitecto decida cuál de los dos datos vale.
 *
 * Primer chequeo: los m² de piso y los de cielorraso del mismo ambiente tienen
 * que parecerse (±10%). Si difieren más, alguien midió mal o hay un dato viejo.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { fuentesDeEntidades, unirFuentes } from '@/lib/computo/presentacion';
import { formatearNumero, redondear2 } from '@/lib/computo/unidades';
import { hallazgoInconsistencia, leerMedida, leerTexto } from '@/lib/hallazgos/taxonomia';
import type { HallazgoDetectado } from '@/types/domain';

/** Diferencia máxima aceptable entre piso y cielorraso del mismo ambiente. */
export const TOLERANCIA_PISO_CIELO = 0.1;

/** Margen para que el 10% exacto no dispare por ruido binario. */
const EPSILON = 1e-9;

interface Acumulado {
  m2: number;
  entidades: EntidadPersistida[];
}

function acumular(mapa: Map<string, Acumulado>, ambiente: string, m2: number, entidad: EntidadPersistida): void {
  const previo = mapa.get(ambiente);
  if (previo) {
    previo.m2 += m2;
    previo.entidades.push(entidad);
  } else {
    mapa.set(ambiente, { m2, entidades: [entidad] });
  }
}

/**
 * Compara, ambiente por ambiente, los m² de piso contra los de cielorraso.
 * Los ambientes que no tienen las dos terminaciones no se comparan: no hay
 * inconsistencia posible, a lo sumo un dato faltante que ya reporta su rubro.
 */
export function sanityChecks(entidades: readonly EntidadPersistida[]): HallazgoDetectado[] {
  const pisos = new Map<string, Acumulado>();
  const cielorrasos = new Map<string, Acumulado>();

  for (const entidad of entidades) {
    if (entidad.tipo !== 'terminacion') continue;
    const ambiente = leerTexto(entidad, 'ambiente');
    const superficie = leerMedida(entidad, 'superficieM2');
    if (ambiente === null || superficie === null) continue;

    const ubicacion = leerTexto(entidad, 'ubicacion');
    if (ubicacion === 'piso') acumular(pisos, ambiente, superficie, entidad);
    else if (ubicacion === 'cielorraso') acumular(cielorrasos, ambiente, superficie, entidad);
  }

  const hallazgos: HallazgoDetectado[] = [];

  for (const [ambiente, piso] of pisos) {
    const cielo = cielorrasos.get(ambiente);
    if (!cielo || piso.m2 <= 0) continue;

    const desvio = Math.abs(piso.m2 - cielo.m2) / piso.m2;
    if (desvio <= TOLERANCIA_PISO_CIELO + EPSILON) continue;

    hallazgos.push(
      hallazgoInconsistencia({
        rubro: null, // es coherencia de la documentación, no de un rubro
        clave: `sanity.piso_cielo.${ambiente}`,
        checklistItem: 'sanity.piso_cielo',
        descripcion:
          `En ${ambiente} el piso mide ${formatearNumero(redondear2(piso.m2))} m² y el cielorraso ` +
          `${formatearNumero(redondear2(cielo.m2))} m²: ${formatearNumero(redondear2(desvio * 100))}% de diferencia, ` +
          `más del ${formatearNumero(TOLERANCIA_PISO_CIELO * 100)}% que tolera el motor. Revisá cuál de los dos datos vale.`,
        fuentes: unirFuentes(fuentesDeEntidades(piso.entidades), fuentesDeEntidades(cielo.entidades)),
      }),
    );
  }

  return hallazgos;
}
