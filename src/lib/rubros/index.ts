/**
 * Plantillas de rubro: qué se computa en cada rubro y con qué números.
 *
 * Una plantilla es **dato**, no lógica del engine: los rendimientos, las
 * presentaciones comerciales y los porcentajes de desperdicio viven en el
 * archivo del rubro. Agregar un rubro = agregar un archivo acá + sus tests;
 * `engine.ts` no se toca.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import type { HallazgoDetectado, ItemComputo, RubroId, TipoObra } from '@/types/domain';

/** Lo que devuelve cualquier cómputo del motor. */
export interface ResultadoComputo {
  items: ItemComputo[];
  hallazgos: HallazgoDetectado[];
}

export interface PlantillaRubro {
  id: RubroId;
  /** Nombre para la UI, en es-AR. */
  nombre: string;
  /** Desperdicio de referencia del rubro; cada ítem puede tener el suyo. */
  desperdicioDefaultPct: number;
  computar(entidades: readonly EntidadPersistida[], tipoObra: TipoObra): ResultadoComputo;
}
