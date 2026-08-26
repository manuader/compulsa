/**
 * `igualJson`: la comparación que sostiene la idempotencia del pipeline.
 *
 * Postgres devuelve las claves de un `jsonb` ordenadas; el pipeline arma sus
 * objetos en el orden en que los escribe el código. Si la comparación mira el
 * texto, todo "difiere" siempre y cada corrida reescribe y audita de más.
 */
import { describe, expect, it } from 'vitest';

import { canonicalizar, igualJson } from '@/lib/pipeline/json';

describe('igualJson: el orden de las claves no es parte del dato', () => {
  it('una Fuente y la misma Fuente reordenada por Postgres son iguales', () => {
    const emitida = { laminaId: 'l-1', bbox: [0.1, 0.2, 0.3, 0.4], detalle: 'V2' };
    const leidaDeJsonb = { bbox: [0.1, 0.2, 0.3, 0.4], detalle: 'V2', laminaId: 'l-1' };

    expect(JSON.stringify(emitida) === JSON.stringify(leidaDeJsonb)).toBe(false);
    expect(igualJson([emitida], [leidaDeJsonb])).toBe(true);
  });

  it('ordena también los objetos anidados', () => {
    expect(igualJson({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });

  it('el orden de un array SÍ es parte del dato', () => {
    expect(igualJson([1, 2], [2, 1])).toBe(false);
    expect(canonicalizar([{ b: 1, a: 2 }, { c: 3 }])).toEqual([{ a: 2, b: 1 }, { c: 3 }]);
  });

  it('null y undefined son el mismo "no hay valor" (columna nullable)', () => {
    expect(igualJson(null, undefined)).toBe(true);
    expect(igualJson(null, {})).toBe(false);
  });

  it('un cambio real sigue siendo un cambio', () => {
    expect(igualJson({ altoM: 2.05 }, { altoM: 2.06 })).toBe(false);
    expect(igualJson({ altoM: 2.05 }, { altoM: '2.05' })).toBe(false);
    expect(igualJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
