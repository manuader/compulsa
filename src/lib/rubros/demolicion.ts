/**
 * Rubro demolición: lo que hay que sacar antes de construir.
 *
 * **Stub honesto.** El rubro existe en el dominio desde T1 pero todavía no
 * computa nada: devuelve cero ítems y cero hallazgos. Una obra de reforma con
 * entidades `estadoReforma: 'demoler'` no ve el rubro en la planilla, igual que
 * antes de que el rubro existiera — no es un no-op silencioso, es una plantilla
 * vacía.
 *
 * TODO(T6): reemplazar por el cómputo real sobre las entidades con
 * `estadoReforma: 'demoler'` — m² de muro y tabique (largo × altura, con la
 * cadena de respaldo de `datosObra` para la altura), carpinterías a retirar (u)
 * y solados a levantar (m²).
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { TipoObra } from '@/types/domain';

const RUBRO = 'demolicion';

/** Lo que se demuele no se compra: no hay desperdicio que aplicar. */
const DESPERDICIO_DEFAULT_PCT = 0;

export const plantillaDemolicion = {
  id: RUBRO,
  nombre: 'Demolición',
  desperdicioDefaultPct: DESPERDICIO_DEFAULT_PCT,

  computar(_entidades: readonly EntidadPersistida[], _tipoObra: TipoObra): ResultadoComputo {
    return { items: [], hallazgos: [] };
  },
} satisfies PlantillaRubro;
