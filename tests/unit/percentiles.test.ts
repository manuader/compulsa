import { describe, expect, it } from 'vitest';

import {
  MIN_MUESTRAS_BENCHMARK,
  acumularMuestra,
  clasificarContraIndice,
  percentilesNearestRank,
} from '@/lib/indice/percentiles';

describe('percentilesNearestRank', () => {
  it('usa nearest-rank: sobre [10,20,30,40,50] da 20 / 30 / 40', () => {
    // El pin de RF-1103. Con interpolación lineal daría 20 / 30 / 40 también acá,
    // pero nearest-rank NUNCA inventa un valor que no está en la serie.
    expect(percentilesNearestRank([10, 20, 30, 40, 50])).toEqual({ p25: 20, p50: 30, p75: 40 });
  });

  it('no depende del orden de entrada', () => {
    expect(percentilesNearestRank([40, 10, 50, 30, 20])).toEqual({ p25: 20, p50: 30, p75: 40 });
  });

  it('con una sola muestra los tres percentiles son esa muestra', () => {
    expect(percentilesNearestRank([42])).toEqual({ p25: 42, p50: 42, p75: 42 });
  });

  it('con dos muestras el rango ceil(P×N) cae en 1, 1 y 2', () => {
    expect(percentilesNearestRank([10, 20])).toEqual({ p25: 10, p50: 10, p75: 20 });
  });

  it('con cuatro muestras devuelve siempre valores de la serie', () => {
    expect(percentilesNearestRank([10, 20, 30, 40])).toEqual({ p25: 10, p50: 20, p75: 30 });
  });

  it('emite con 2 decimales, como la columna de price_index', () => {
    expect(percentilesNearestRank([1.005])).toEqual({ p25: 1.01, p50: 1.01, p75: 1.01 });
  });

  it('no acepta una serie vacía', () => {
    expect(() => percentilesNearestRank([])).toThrow(/vacía/i);
  });

  it('no acepta valores que no son números finitos', () => {
    expect(() => percentilesNearestRank([10, Number.NaN])).toThrow(/finito/i);
    expect(() => percentilesNearestRank([10, Number.POSITIVE_INFINITY])).toThrow(/finito/i);
  });
});

describe('acumularMuestra', () => {
  it('agrega el precio a la serie y recalcula los percentiles con el pin', () => {
    expect(acumularMuestra([10, 20, 30, 40], 50)).toEqual({
      muestras: [10, 20, 30, 40, 50],
      p25: 20,
      p50: 30,
      p75: 40,
      n: 5,
    });
  });

  it('arranca una serie vacía (la fila nueva de price_index)', () => {
    expect(acumularMuestra([], 100)).toEqual({ muestras: [100], p25: 100, p50: 100, p75: 100, n: 1 });
  });

  it('deja la serie ordenada de menor a mayor', () => {
    expect(acumularMuestra([40, 20], 10).muestras).toEqual([10, 20, 40]);
  });

  it('conserva los repetidos: dos cotizaciones al mismo precio son dos muestras', () => {
    expect(acumularMuestra([20, 20], 20)).toMatchObject({ muestras: [20, 20, 20], n: 3 });
  });

  it('no muta la serie que recibe', () => {
    const previas = [30, 10];
    acumularMuestra(previas, 20);
    expect(previas).toEqual([30, 10]);
  });

  it('rechaza precios que no son positivos y finitos', () => {
    expect(() => acumularMuestra([10], 0)).toThrow(/positivo/i);
    expect(() => acumularMuestra([10], -5)).toThrow(/positivo/i);
    expect(() => acumularMuestra([10], Number.NaN)).toThrow(/positivo/i);
  });
});

describe('clasificarContraIndice', () => {
  it('exige n ≥ 3 para mostrar benchmark', () => {
    expect(MIN_MUESTRAS_BENCHMARK).toBe(3);
    expect(clasificarContraIndice(10, { p50: 30, p75: 40, n: 2 })).toBe('sin_datos');
  });

  it('verde hasta p50, amarillo hasta p75, rojo arriba', () => {
    const indice = { p50: 30, p75: 40, n: 5 };
    expect(clasificarContraIndice(29, indice)).toBe('verde');
    expect(clasificarContraIndice(30, indice)).toBe('verde');
    expect(clasificarContraIndice(30.01, indice)).toBe('amarillo');
    expect(clasificarContraIndice(40, indice)).toBe('amarillo');
    expect(clasificarContraIndice(40.01, indice)).toBe('rojo');
  });
});
