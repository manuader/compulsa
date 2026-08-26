import { describe, expect, it } from 'vitest';

import { acumularAhorros, calcularAhorro } from '@/lib/ahorro/calculo';

describe('calcularAhorro', () => {
  it('el pin de RF-1104: totales [100,110,120], adjudicado 100 tras negociar de 105 ⇒ 15', () => {
    expect(calcularAhorro([100, 110, 120], 100, [5])).toBe(15);
  });

  it('sin negociación es solo la distancia a la mediana', () => {
    expect(calcularAhorro([100, 110, 120], 100, [])).toBe(10);
  });

  it('suma todas las mejoras aceptadas, ronda por ronda', () => {
    expect(calcularAhorro([100, 110, 120], 100, [3, 2])).toBe(15);
  });

  it('la mediana es nearest-rank: con [100,120] es 100, no 110', () => {
    expect(calcularAhorro([100, 120], 90, [])).toBe(10);
  });

  it('con un solo comparable la mediana es ese total', () => {
    expect(calcularAhorro([100], 90, [])).toBe(10);
  });

  it('no depende del orden de los comparables', () => {
    expect(calcularAhorro([120, 100, 110], 100, [5])).toBe(15);
  });

  it('adjudicar por encima de la mediana da ahorro negativo, y se muestra así', () => {
    // El contador no se recorta en cero: pagar arriba de la mediana es
    // información, no un dato que haya que esconder.
    expect(calcularAhorro([100, 110, 120], 130, [])).toBe(-20);
  });

  it('redondea a 2 decimales el ruido binario de las restas', () => {
    expect(10.2 - 10.05 + 0.1).not.toBe(0.25); // el problema que el redondeo resuelve
    expect(calcularAhorro([10.1, 10.2, 10.3], 10.05, [0.1])).toBe(0.25);
  });

  it('no calcula ahorro sin comparables', () => {
    expect(() => calcularAhorro([], 100, [])).toThrow(/comparable/i);
  });

  it('rechaza totales y mejoras que no son números finitos', () => {
    expect(() => calcularAhorro([100], Number.NaN, [])).toThrow(/finito/i);
    expect(() => calcularAhorro([100], 90, [Number.POSITIVE_INFINITY])).toThrow(/finito/i);
  });

  it('rechaza una mejora negativa: eso no es una mejora aceptada', () => {
    expect(() => calcularAhorro([100], 90, [-5])).toThrow(/negativa/i);
  });
});

describe('acumularAhorros', () => {
  it('suma los ahorros de la obra o del estudio sin arrastrar ruido binario', () => {
    expect(acumularAhorros([15, 0.1, 0.2])).toBe(15.3);
    expect(acumularAhorros([])).toBe(0);
  });
});
