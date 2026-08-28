/**
 * Rubro instalación eléctrica: bocas por tipo.
 *
 * **Stub honesto.** El rubro existe en el dominio desde T1 pero todavía no
 * computa nada: devuelve cero ítems y cero hallazgos. Una obra con entidades
 * `boca` no ve el rubro en la planilla, igual que antes de que el rubro
 * existiera — no es un no-op silencioso, es una plantilla vacía.
 *
 * TODO(T7): reemplazar por el conteo real de bocas por tipo (toma, luz, caja,
 * tablero, datos). Los metros de cable quedan **fuera de alcance a propósito**:
 * el recorrido no está dibujado y inferirlo sería inventar (P4).
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { TipoObra } from '@/types/domain';

const RUBRO = 'electrica';

/** Las bocas se cuentan de a una: no hay desperdicio que aplicar. */
const DESPERDICIO_DEFAULT_PCT = 0;

export const plantillaElectrica = {
  id: RUBRO,
  nombre: 'Instalación eléctrica',
  desperdicioDefaultPct: DESPERDICIO_DEFAULT_PCT,

  computar(_entidades: readonly EntidadPersistida[], _tipoObra: TipoObra): ResultadoComputo {
    return { items: [], hallazgos: [] };
  },
} satisfies PlantillaRubro;
