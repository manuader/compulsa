/**
 * Plantillas de rubro: qué se computa en cada rubro y con qué números.
 *
 * Una plantilla es **dato**, no lógica del engine: los rendimientos, las
 * presentaciones comerciales y los porcentajes de desperdicio viven en el
 * archivo del rubro. Agregar un rubro = agregar un archivo acá + sus tests;
 * `engine.ts` no se toca.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { plantillaAberturas } from '@/lib/rubros/aberturas';
import { plantillaDemolicion } from '@/lib/rubros/demolicion';
import { plantillaElectrica } from '@/lib/rubros/electrica';
import { plantillaGruesa } from '@/lib/rubros/gruesa';
import { plantillaPintura } from '@/lib/rubros/pintura';
import { plantillaSanitaria } from '@/lib/rubros/sanitaria';
import { plantillaSeco } from '@/lib/rubros/seco';
import { plantillaTerminaciones } from '@/lib/rubros/terminaciones';
import type {
  DatoObraResuelto,
  HallazgoDetectado,
  ItemComputo,
  Origen,
  RubroId,
  TipoObra,
} from '@/types/domain';

/** Lo que devuelve cualquier cómputo del motor. */
export interface ResultadoComputo {
  items: ItemComputo[];
  hallazgos: HallazgoDetectado[];
  /**
   * Con qué origen se computó cada campo de cada entidad: `entidadId → campo →
   * origen`. Lo llenan las plantillas que usan la cadena de respaldo (un
   * `alturaM` que salió de un dato de obra no es `explicito`), y el recompute lo
   * mergea con el mapa de deducciones para decidir el origen del ítem, que es
   * **el peor** de sus campos usados.
   *
   * Opcional: una plantilla que solo lee atributos explícitos no lo devuelve y
   * se comporta como siempre.
   */
  origenPorEntidad?: Map<string, Map<string, Origen>>;
}

export interface PlantillaRubro {
  id: RubroId;
  /** Nombre para la UI, en es-AR. */
  nombre: string;
  /** Desperdicio de referencia del rubro; cada ítem puede tener el suyo. */
  desperdicioDefaultPct: number;
  /**
   * `laminas` y `datosObra` son **opcionales**: una plantilla que no mira el
   * tipo de lámina lo ignora, y las que sí lo miran (aberturas) se comportan
   * como antes cuando no viene. El pipeline siempre los pasa; los tests de
   * rubro puro, no.
   *
   * `datosObra` es la cadena de respaldo del §5.2: `clave → dato resuelto`
   * (`altura_local.PB`), para que una plantilla pueda completar un campo que la
   * entidad no trae sin inventarlo — el ítem hereda el origen, las fuentes y la
   * confianza del dato.
   */
  computar(
    entidades: readonly EntidadPersistida[],
    tipoObra: TipoObra,
    laminas?: readonly LaminaDeComputo[],
    datosObra?: ReadonlyMap<string, DatoObraResuelto>,
  ): ResultadoComputo;
}

/** Registro de plantillas: la única lista que conoce el engine. */
export const PLANTILLAS: Record<RubroId, PlantillaRubro> = {
  aberturas: plantillaAberturas,
  seco: plantillaSeco,
  pintura: plantillaPintura,
  gruesa: plantillaGruesa,
  terminaciones: plantillaTerminaciones,
  sanitaria: plantillaSanitaria,
  electrica: plantillaElectrica,
  demolicion: plantillaDemolicion,
};

export {
  plantillaAberturas,
  plantillaDemolicion,
  plantillaElectrica,
  plantillaGruesa,
  plantillaPintura,
  plantillaSanitaria,
  plantillaSeco,
  plantillaTerminaciones,
};
