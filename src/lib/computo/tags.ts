/**
 * Cómo se comparan dos tags de carpintería.
 *
 * La misma carpintería viene escrita distinto en cada lámina: la planta la
 * rotula `V5`, la planilla la lista como `v5` y el detalle como `FP 01`. Para el
 * arquitecto es obviamente la misma; para un `===` no lo era, y por eso la
 * deducción planilla↔plano no disparaba con planos reales y el mismo tag se
 * computaba dos veces.
 *
 * ## Por qué vive acá y no en la regla que lo motivó
 *
 * Lo usan el rubro aberturas (para agrupar) y la regla `planilla_plano` (para
 * matchear). Ponerlo en la regla y que `rubros/aberturas.ts` lo importara de ahí
 * arrastraba `deduccion/motor.ts` al grafo del motor de cómputo y **rompía en
 * runtime**: `motor.ts` arma su tabla `IMPLEMENTACIONES` en el cuerpo del
 * módulo, y con el ciclo nuevo el módulo de las reglas quedaba a medio evaluar
 * cuando esa tabla se construía (`IMPLEMENTACIONES[regla] is not a function`).
 * `computo/` es la hoja de la que ya dependen los dos, así que acá no hay ciclo
 * posible. `planilla-plano.ts` lo re-exporta para quien lo busque ahí.
 *
 * Módulo puro: sin imports, sin I/O.
 */

/**
 * El tag, en la forma en la que se comparan y se agrupan dos tags.
 *
 * Saca **todos** los espacios (también los internos) y pasa a mayúsculas:
 * `' fp 01 '` y `'FP01'` son el mismo tag. Es solo para comparar — lo que se
 * muestra sigue siendo el tag tal como está escrito en la lámina.
 */
export function normalizarTag(tag: string): string {
  return tag.replace(/\s+/g, '').toUpperCase();
}
