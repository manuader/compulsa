/**
 * Rubro instalación sanitaria: cañerías, accesorios y artefactos.
 *
 * **Stub honesto.** El rubro existe en el dominio desde T1 pero todavía no
 * computa nada: devuelve cero ítems y cero hallazgos. Una obra con entidades
 * `tramo` o `accesorio` no ve el rubro en la planilla, igual que antes de que
 * el rubro existiera — no es un no-op silencioso, es una plantilla vacía.
 *
 * TODO(T7): reemplazar por el cómputo real —ml de cañería por sistema y
 * diámetro (tira de 4 m), accesorios y artefactos por unidad— más el control
 * del §22: un artefacto sin desagüe que le corresponda es una inconsistencia
 * **no bloqueante**, jamás un tramo auto-completado.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { TipoObra } from '@/types/domain';

const RUBRO = 'sanitaria';

/** El de la cañería, que es el ítem que manda el rubro. */
const DESPERDICIO_DEFAULT_PCT = 5;

export const plantillaSanitaria = {
  id: RUBRO,
  nombre: 'Instalación sanitaria',
  desperdicioDefaultPct: DESPERDICIO_DEFAULT_PCT,

  computar(_entidades: readonly EntidadPersistida[], _tipoObra: TipoObra): ResultadoComputo {
    return { items: [], hallazgos: [] };
  },
} satisfies PlantillaRubro;
