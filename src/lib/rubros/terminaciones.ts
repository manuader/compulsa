/**
 * Rubro terminaciones: solados, zócalos, cielorrasos, revestimientos,
 * contrapiso y carpeta.
 *
 * **Stub honesto.** El rubro existe en el dominio desde T1 —está en `RubroId`,
 * en el `pgEnum`, en las etiquetas y en `PLANTILLAS`— pero todavía no computa
 * nada: devuelve cero ítems y cero hallazgos. No es un no-op silencioso: es una
 * plantilla vacía, y una obra con ambientes simplemente no ve el rubro en la
 * planilla, que es exactamente lo que pasaba antes de que el rubro existiera.
 *
 * TODO(T6): reemplazar por el cómputo real desde `ambiente` (solado, zócalo por
 * perímetro, cielorraso, revestimiento por altura, contrapiso y carpeta), con
 * la cadena de respaldo de `datosObra` para `alturaRevestimientoM`.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { TipoObra } from '@/types/domain';

const RUBRO = 'terminaciones';

/** El del solado, que es el ítem que manda el rubro. */
const DESPERDICIO_DEFAULT_PCT = 10;

export const plantillaTerminaciones = {
  id: RUBRO,
  nombre: 'Terminaciones',
  desperdicioDefaultPct: DESPERDICIO_DEFAULT_PCT,

  computar(_entidades: readonly EntidadPersistida[], _tipoObra: TipoObra): ResultadoComputo {
    return { items: [], hallazgos: [] };
  },
} satisfies PlantillaRubro;
