/**
 * Motor de cómputo: la única entrada pública del dominio.
 *
 * Recibe las entidades detectadas de una obra y devuelve ítems de cómputo y
 * hallazgos. Es **puro y determinístico**: no toca base, ni archivos, ni red;
 * las mismas entidades dan siempre el mismo resultado (condición para el
 * golden set y para el recómputo incremental).
 *
 * Lo que hace el engine, y solo esto:
 *   1. corre la plantilla de cada rubro pedido (los números viven en `rubros/`);
 *   2. aplica la regla de oro §11.b — un ítem con confianza por debajo del
 *      umbral no se emite y se degrada a consulta bloqueante;
 *   3. suma los sanity checks de obra;
 *   4. deduplica hallazgos por clave, que es única por obra (idempotencia).
 */
import { sanityChecks } from '@/lib/computo/sanity';
import { hallazgoBajaConfianza, UMBRAL_CONFIANZA } from '@/lib/hallazgos/taxonomia';
import { PLANTILLAS, type PlantillaRubro, type ResultadoComputo } from '@/lib/rubros/index';
import type { EntidadDetectada, HallazgoDetectado, ItemComputo, RubroId, TipoObra } from '@/types/domain';
import { RUBROS } from '@/types/domain';

/**
 * Una entidad ya guardada: lo que detectó el análisis (`EntidadDetectada`) más
 * su identidad en la base y la lámina de la que salió. El motor necesita las
 * dos cosas: `laminaId` + `bbox` arman la `Fuente` de cada ítem (P1) e `id`
 * permite que un hallazgo apunte al campo exacto que hay que completar.
 */
export type EntidadPersistida = EntidadDetectada & { id: string; laminaId: string };

export type { ResultadoComputo };
export { UMBRAL_CONFIANZA };

/**
 * Corre una plantilla y aplica la regla de confianza (§11.b): el ítem que se
 * apoya en datos por debajo del umbral no se emite —el sistema no computa lo
 * que no está seguro de haber leído— y sale como consulta bloqueante con la
 * provenance del ítem que se cayó, para que el arquitecto vea qué mirar.
 */
export function computarRubro(
  entidades: readonly EntidadPersistida[],
  plantilla: PlantillaRubro,
  tipoObra: TipoObra,
): ResultadoComputo {
  const { items, hallazgos } = plantilla.computar(entidades, tipoObra);
  const emitidos: ItemComputo[] = [];
  const degradados: HallazgoDetectado[] = [];

  for (const item of items) {
    if (item.confianza < UMBRAL_CONFIANZA) {
      degradados.push(
        hallazgoBajaConfianza({
          rubro: item.rubro,
          claveItem: item.claveItem,
          descripcion: item.descripcion,
          confianza: item.confianza,
          fuentes: item.fuentes,
        }),
      );
      continue;
    }
    emitidos.push(item);
  }

  return { items: emitidos, hallazgos: [...hallazgos, ...degradados] };
}

/** Deja el primer hallazgo de cada clave: la clave es única por obra. */
function deduplicarPorClave(hallazgos: readonly HallazgoDetectado[]): HallazgoDetectado[] {
  const vistas = new Set<string>();
  const unicos: HallazgoDetectado[] = [];
  for (const hallazgo of hallazgos) {
    if (vistas.has(hallazgo.clave)) continue;
    vistas.add(hallazgo.clave);
    unicos.push(hallazgo);
  }
  return unicos;
}

/**
 * Computa la obra entera.
 *
 * Los rubros se corren siempre en el orden canónico de `RUBROS` (no en el que
 * los pida el llamador) para que el resultado sea comparable entre corridas.
 * Los sanity checks son de obra, no de rubro: corren aunque se pida un solo
 * rubro, y sus hallazgos salen con `rubro: null`.
 */
export function computarObra(
  entidades: readonly EntidadPersistida[],
  tipoObra: TipoObra,
  rubros: readonly RubroId[] = RUBROS,
): ResultadoComputo {
  const items: ItemComputo[] = [];
  const hallazgos: HallazgoDetectado[] = [];

  for (const rubro of RUBROS) {
    if (!rubros.includes(rubro)) continue;
    const resultado = computarRubro(entidades, PLANTILLAS[rubro], tipoObra);
    items.push(...resultado.items);
    hallazgos.push(...resultado.hallazgos);
  }

  hallazgos.push(...sanityChecks(entidades));

  return { items, hallazgos: deduplicarPorClave(hallazgos) };
}
