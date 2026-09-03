/**
 * El pool de paralelismo del pipeline: sin dependencias nuevas y con el cap
 * pinneado.
 *
 * Lo que estos tests protegen no es "que ande en paralelo" sino las tres
 * propiedades de las que depende el pipeline por fases: **nunca más de `cap` en
 * vuelo** (son llamadas al modelo y son plata del usuario), **el orden del
 * resultado es el de la entrada** (la lámina 3 tiene que ser la tercera aunque
 * termine primera) y **un rechazo no tira el lote** (una lámina rota no puede
 * dejar sin analizar a las otras veinticuatro).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { CAP_ANALISIS, capDeAnalisis, enParalelo, VAR_PARALELISMO } from '@/lib/pipeline/pool';

/** Una promesa que se resuelve cuando alguien la suelta desde afuera. */
function diferida<T>(): { promesa: Promise<T>; soltar: (valor: T) => void } {
  let soltar!: (valor: T) => void;
  const promesa = new Promise<T>((resolve) => {
    soltar = resolve;
  });
  return { promesa, soltar };
}

const original = process.env[VAR_PARALELISMO];

afterEach(() => {
  if (original === undefined) delete process.env[VAR_PARALELISMO];
  else process.env[VAR_PARALELISMO] = original;
});

describe('enParalelo', () => {
  it('nunca tiene más de `cap` tareas en vuelo (10 ítems, cap 4)', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const sueltas = items.map(() => diferida<number>());
    let enVuelo = 0;
    let pico = 0;

    const corrida = enParalelo(items, 4, async (item) => {
      enVuelo += 1;
      pico = Math.max(pico, enVuelo);
      const valor = await sueltas[item]!.promesa;
      enVuelo -= 1;
      return valor;
    });

    // Con las diez tareas arrancadas pero ninguna resuelta, el pico es el cap:
    // si fuera 10, el pool no estaría limitando nada.
    await Promise.resolve();
    expect(pico).toBe(4);

    for (const item of items) sueltas[item]!.soltar(item * 10);
    const resultados = await corrida;

    expect(pico).toBe(4);
    expect(resultados.map((r) => (r.ok ? r.valor : null))).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]);
  });

  it('devuelve los resultados en el orden de la entrada, no en el de finalización', async () => {
    const resultados = await enParalelo(['a', 'b', 'c'], 4, async (item, indice) => {
      // La primera tarda más que las otras dos: si el orden fuera el de
      // finalización, 'a' saldría última.
      await new Promise((resolve) => setTimeout(resolve, indice === 0 ? 12 : 1));
      return `${item}${indice}`;
    });

    expect(resultados).toEqual([
      { ok: true, valor: 'a0' },
      { ok: true, valor: 'b1' },
      { ok: true, valor: 'c2' },
    ]);
  });

  it('un rechazo no tira el lote: vuelve por ítem, en su posición', async () => {
    const resultados = await enParalelo([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('la lámina 2 está rota');
      return item;
    });

    expect(resultados[0]).toEqual({ ok: true, valor: 1 });
    expect(resultados[1]?.ok).toBe(false);
    expect(resultados[1]?.ok === false && (resultados[1].error as Error).message).toBe(
      'la lámina 2 está rota',
    );
    expect(resultados[2]).toEqual({ ok: true, valor: 3 });
  });

  it('un cap absurdo no rompe: mínimo uno, y nunca más obreros que ítems', async () => {
    let enVuelo = 0;
    let pico = 0;
    const correr = (cap: number) =>
      enParalelo([1, 2, 3], cap, async (item) => {
        enVuelo += 1;
        pico = Math.max(pico, enVuelo);
        await Promise.resolve();
        enVuelo -= 1;
        return item;
      });

    expect((await correr(0)).map((r) => r.ok)).toEqual([true, true, true]);
    expect(pico).toBe(1);

    pico = 0;
    await correr(100);
    expect(pico).toBe(3);
  });

  it('sin ítems no llama a la función y devuelve la lista vacía', async () => {
    let llamadas = 0;
    const resultados = await enParalelo([], 4, async () => {
      llamadas += 1;
      return 1;
    });

    expect(resultados).toEqual([]);
    expect(llamadas).toBe(0);
  });
});

describe('capDeAnalisis', () => {
  it('el default es 4', () => {
    expect(CAP_ANALISIS).toBe(4);
    expect(capDeAnalisis({})).toBe(4);
  });

  it('la variable de entorno lo pisa', () => {
    expect(capDeAnalisis({ [VAR_PARALELISMO]: '2' })).toBe(2);
    expect(capDeAnalisis({ [VAR_PARALELISMO]: '8' })).toBe(8);
  });

  it('un valor que no es un entero positivo vuelve al default', () => {
    expect(capDeAnalisis({ [VAR_PARALELISMO]: '0' })).toBe(4);
    expect(capDeAnalisis({ [VAR_PARALELISMO]: '-3' })).toBe(4);
    expect(capDeAnalisis({ [VAR_PARALELISMO]: 'muchas' })).toBe(4);
    expect(capDeAnalisis({ [VAR_PARALELISMO]: '' })).toBe(4);
  });
});
