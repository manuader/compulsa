/**
 * Comparación de valores `jsonb` que sobrevive al viaje a Postgres.
 *
 * El problema, en una línea: **Postgres reordena las claves de un `jsonb`**.
 * Guardás `{laminaId, bbox, detalle}` y `SELECT` te devuelve
 * `{bbox, detalle, laminaId}` — mismo dato, otro orden. `JSON.stringify` es
 * sensible al orden, así que comparar el valor recién computado contra el que
 * leíste de la base da "distinto" siempre, aunque no haya cambiado nada.
 *
 * Qué rompía eso: el pipeline es idempotente **porque compara antes de
 * escribir**. Con la comparación rota, cada corrida reescribía todos los ítems
 * y todas las entidades y le metía a `auditoria` un diff por ítem con
 * `antes == despues`. El rastro de auditoría —que es de donde se lee qué tocó
 * el agente y cuándo (CLAUDE.md §4)— quedaba ahogado en ruido, y `updated_at`
 * marcaba como modificado lo que nadie modificó.
 *
 * La solución es comparar en forma canónica: mismas claves ordenadas de la
 * misma manera de los dos lados. Módulo puro, sin I/O.
 */

/**
 * El mismo valor con todos sus objetos ordenados por clave, recursivamente.
 * Los arrays conservan su orden: en un `jsonb` la posición de un elemento **sí**
 * es parte del dato (el orden de las fuentes de un ítem, por ejemplo).
 */
export function canonicalizar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonicalizar);
  if (valor === null || typeof valor !== 'object') return valor;

  const original = valor as Record<string, unknown>;
  const ordenado: Record<string, unknown> = {};
  for (const clave of Object.keys(original).sort()) {
    ordenado[clave] = canonicalizar(original[clave]);
  }
  return ordenado;
}

/**
 * Igualdad estructural de dos valores `jsonb`, sin importar el orden de las
 * claves. `undefined` y `null` son el mismo "no hay valor": es lo que devuelve
 * una columna nullable.
 */
export function igualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalizar(a ?? null)) === JSON.stringify(canonicalizar(b ?? null));
}
