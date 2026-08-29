/**
 * Medición gráfica (§5.5): medir sobre el dibujo cuando la cota no está escrita.
 *
 * Es el último respaldo de la cadena de un campo de medida, y el más frágil: si
 * la escala no es la que dice el rótulo, todos los números salen mal a la vez.
 * Por eso el módulo es puro y estos tests pinean la aritmética completa —de un
 * bbox normalizado a metros de obra— y, sobre todo, **cuándo no se mide**.
 *
 * Dominio puro: sin base, sin fixtures.
 */
import { describe, expect, it } from 'vitest';

import { denominadorDeEscala, medidaGrafica } from '@/lib/computo/medicion';
import type { BBox } from '@/types/domain';

/** A4 apaisado en puntos PostScript, que es como viene una lámina de PDF. */
const A4_APAISADO = { ancho: 842, alto: 595 };

const RECTANGULO: BBox = [0.1, 0.1, 0.5, 0.2];

describe('denominadorDeEscala', () => {
  it('lee el N de un 1:N', () => {
    expect(denominadorDeEscala('1:50')).toBe(50);
    expect(denominadorDeEscala('1:100')).toBe(100);
  });

  it('tolera los espacios que mete el rótulo', () => {
    expect(denominadorDeEscala(' 1 : 50 ')).toBe(50);
  });

  it('no adivina: lo que no es exactamente 1:N no es una escala usable', () => {
    // «Esc.» y la escala gráfica son rótulos legítimos, pero no dicen cuánto
    // mide un punto: medir con ellos sería inventar.
    expect(denominadorDeEscala('esc. gráfica')).toBeNull();
    expect(denominadorDeEscala('Esc. 1:50')).toBeNull();
    expect(denominadorDeEscala('2:100')).toBeNull();
    expect(denominadorDeEscala('1:')).toBeNull();
    expect(denominadorDeEscala('1:0')).toBeNull();
    expect(denominadorDeEscala('')).toBeNull();
  });
});

describe('medidaGrafica', () => {
  it('mide el rectángulo del dibujo en metros de obra', () => {
    // 0,5 × 842 = 421 pt ⇒ 421/72 × 0,0254 × 50 = 7,4259… m
    // 0,2 × 595 = 119 pt ⇒ 119/72 × 0,0254 × 50 = 2,0990… m
    expect(medidaGrafica(RECTANGULO, A4_APAISADO, '1:50')).toEqual({
      anchoM: 7.43,
      altoM: 2.1,
    });
  });

  it('el denominador escala linealmente: 1:100 mide el doble que 1:50', () => {
    expect(medidaGrafica(RECTANGULO, A4_APAISADO, '1:100')).toEqual({
      anchoM: 14.85,
      altoM: 4.2,
    });
  });

  it('los espacios del rótulo no cambian el número', () => {
    expect(medidaGrafica(RECTANGULO, A4_APAISADO, '1 : 50')).toEqual({
      anchoM: 7.43,
      altoM: 2.1,
    });
  });

  it('sin escala usable no se mide (null, nunca un número)', () => {
    expect(medidaGrafica(RECTANGULO, A4_APAISADO, 'esc. gráfica')).toBeNull();
    expect(medidaGrafica(RECTANGULO, A4_APAISADO, '')).toBeNull();
  });

  it('una página sin tamaño real tampoco se mide', () => {
    expect(medidaGrafica(RECTANGULO, { ancho: 0, alto: 595 }, '1:50')).toBeNull();
    expect(medidaGrafica(RECTANGULO, { ancho: 842, alto: Number.NaN }, '1:50')).toBeNull();
  });

  it('un bbox inválido no se mide', () => {
    expect(medidaGrafica([0.1, 0.1, -0.5, 0.2], A4_APAISADO, '1:50')).toBeNull();
    expect(medidaGrafica([0.1, 0.1, Number.NaN, 0.2], A4_APAISADO, '1:50')).toBeNull();
  });

  it('un bbox de área cero mide cero: la decisión de descartarlo es de quien llama', () => {
    expect(medidaGrafica([0.1, 0.1, 0, 0], A4_APAISADO, '1:50')).toEqual({
      anchoM: 0,
      altoM: 0,
    });
  });
});
