/**
 * Núcleos puros de las acciones de la planilla de cómputo.
 *
 * La regla que protegen estos tests: cuando el arquitecto edita a mano la
 * cantidad neta o el desperdicio de un ítem, la **cantidad de compra la
 * recalcula el server** con la misma presentación comercial que usó la plantilla
 * del rubro (P2 del PRD: neta ≠ compra, y la compra se redondea hacia arriba al
 * bulto que vende el corralón). El cliente nunca manda `cantCompra`.
 */
import { describe, expect, it } from 'vitest';

import {
  diffDeItem,
  parsearCantidad,
  recalcularCompra,
} from '@/app/obras/[obraId]/computo/actions';

describe('recalcularCompra: bultos (la presentación de la plantilla manda)', () => {
  it('seco.placas editado a 30 m² con 12% → 33,6 → 12 placas de 2,88 m² = 34,56', async () => {
    const compra = await recalcularCompra({
      unidad: 'm2',
      cantNeta: 30,
      desperdicioPct: 12,
      presentacion: '11 placas de 2,88 m²',
      cantCompraActual: 31.68,
    });

    expect(compra.cantCompra).toBe(34.56);
    expect(compra.presentacion).toBe('12 placas de 2,88 m²');
  });

  it('vuelve al valor de la plantilla si se reponen los 26 m² originales', async () => {
    const compra = await recalcularCompra({
      unidad: 'm2',
      cantNeta: 26,
      desperdicioPct: 12,
      presentacion: '12 placas de 2,88 m²',
      cantCompraActual: 34.56,
    });

    expect(compra.cantCompra).toBe(31.68);
    expect(compra.presentacion).toBe('11 placas de 2,88 m²');
  });

  it('usa el singular cuando entra un solo bulto', async () => {
    const compra = await recalcularCompra({
      unidad: 'm2',
      cantNeta: 2,
      desperdicioPct: 12,
      presentacion: '11 placas de 2,88 m²',
      cantCompraActual: 31.68,
    });

    expect(compra.cantCompra).toBe(2.88);
    expect(compra.presentacion).toBe('1 placa de 2,88 m²');
  });

  it('el contenido del bulto sale de la compra vigente, no del texto del detalle', async () => {
    // "14 tiras de 2,60 m" son 14 unidades (contenido 1), no 2,60 por tira:
    // el detalle es la medida de la tira, no lo que trae el bulto.
    const compra = await recalcularCompra({
      unidad: 'u',
      cantNeta: 20,
      desperdicioPct: 0,
      presentacion: '14 tiras de 2,60 m',
      cantCompraActual: 14,
    });

    expect(compra.cantCompra).toBe(20);
    expect(compra.presentacion).toBe('20 tiras de 2,60 m');
  });

  it('tornillos: 620 u → 2 cajas de 500 u (redondeo hacia arriba, nunca hacia abajo)', async () => {
    const compra = await recalcularCompra({
      unidad: 'u',
      cantNeta: 620,
      desperdicioPct: 0,
      presentacion: '1 caja de 500 u',
      cantCompraActual: 500,
    });

    expect(compra.cantCompra).toBe(1000);
    expect(compra.presentacion).toBe('2 cajas de 500 u');
  });
});

describe('recalcularCompra: granel, latas y contratos globales', () => {
  it('arena a granel: 5,2 m³ → múltiplos de 0,5 m³ → 5,5 m³', async () => {
    const compra = await recalcularCompra({
      unidad: 'm3',
      cantNeta: 5.2,
      desperdicioPct: 0,
      presentacion: '4,5 m³ a granel (múltiplos de 0,5 m³)',
      cantCompraActual: 4.5,
    });

    expect(compra.cantCompra).toBe(5.5);
    expect(compra.presentacion).toBe('5,5 m³ a granel (múltiplos de 0,5 m³)');
  });

  it('látex: 30 L + 5% = 31,5 → 1 lata 20 L + 1 lata 10 L + 2 latas 1 L = 32 L', async () => {
    const compra = await recalcularCompra({
      unidad: 'l',
      cantNeta: 30,
      desperdicioPct: 5,
      presentacion: '1 lata 20 L + 1 lata 4 L',
      cantCompraActual: 24,
    });

    expect(compra.cantCompra).toBe(32);
    expect(compra.presentacion).toBe('1 lata 20 L + 1 lata 10 L + 2 latas 1 L');
  });

  it('demolición global: la compra es la neta con desperdicio, sin bulto', async () => {
    const compra = await recalcularCompra({
      unidad: 'm2',
      cantNeta: 12.5,
      desperdicioPct: 0,
      presentacion: 'global',
      cantCompraActual: 8,
    });

    expect(compra.cantCompra).toBe(12.5);
    expect(compra.presentacion).toBe('global');
  });

  it('carpintería a medida: 3 unidades siguen siendo a medida', async () => {
    const compra = await recalcularCompra({
      unidad: 'u',
      cantNeta: 3,
      desperdicioPct: 0,
      presentacion: 'a medida',
      cantCompraActual: 2,
    });

    expect(compra.cantCompra).toBe(3);
    expect(compra.presentacion).toBe('a medida');
  });
});

describe('recalcularCompra: presentación desconocida', () => {
  it('cae en neta × (1 + desperdicio) redondeado a 2 decimales y deja la presentación', async () => {
    const compra = await recalcularCompra({
      unidad: 'kg',
      cantNeta: 7,
      desperdicioPct: 10,
      presentacion: 'sin presentación',
      cantCompraActual: 0,
    });

    expect(compra.cantCompra).toBe(7.7);
    expect(compra.presentacion).toBe('sin presentación');
  });

  it('un bulto sin compra vigente no puede deducir su contenido: no inventa uno', async () => {
    const compra = await recalcularCompra({
      unidad: 'u',
      cantNeta: 5,
      desperdicioPct: 0,
      presentacion: '0 tiras de 2,60 m',
      cantCompraActual: 0,
    });

    expect(compra.cantCompra).toBe(5);
    expect(compra.presentacion).toBe('0 tiras de 2,60 m');
  });

  it('nunca devuelve una compra negativa', async () => {
    const compra = await recalcularCompra({
      unidad: 'm2',
      cantNeta: 0,
      desperdicioPct: 12,
      presentacion: '11 placas de 2,88 m²',
      cantCompraActual: 31.68,
    });

    expect(compra.cantCompra).toBe(0);
    expect(compra.presentacion).toBe('0 placas de 2,88 m²');
  });
});

describe('parsearCantidad: el arquitecto escribe con coma', () => {
  it('acepta coma decimal', async () => {
    expect(await parsearCantidad('30,5')).toBe(30.5);
  });

  it('acepta punto decimal y espacios', async () => {
    expect(await parsearCantidad(' 30.5 ')).toBe(30.5);
  });

  it('acepta separador de miles es-AR', async () => {
    expect(await parsearCantidad('1.234,5')).toBe(1234.5);
  });

  it('redondea a 2 decimales', async () => {
    expect(await parsearCantidad('33,606')).toBe(33.61);
  });

  it('rechaza vacío, texto y negativos', async () => {
    expect(await parsearCantidad('')).toBeNull();
    expect(await parsearCantidad('   ')).toBeNull();
    expect(await parsearCantidad('treinta')).toBeNull();
    expect(await parsearCantidad('-1')).toBeNull();
  });
});

describe('diffDeItem: la auditoría guarda solo lo que cambió', () => {
  const antes = {
    descripcion: 'Placa de roca de yeso (1,20 × 2,40 m)',
    cantNeta: 26,
    desperdicioPct: 12,
    cantCompra: 31.68,
    presentacion: '11 placas de 2,88 m²',
  };

  it('registra antes/después campo por campo', async () => {
    const diff = await diffDeItem(antes, { ...antes, cantNeta: 30, cantCompra: 34.56, presentacion: '12 placas de 2,88 m²' });

    expect(diff).toEqual({
      cantNeta: { antes: 26, despues: 30 },
      cantCompra: { antes: 31.68, despues: 34.56 },
      presentacion: { antes: '11 placas de 2,88 m²', despues: '12 placas de 2,88 m²' },
    });
  });

  it('sin cambios devuelve un diff vacío', async () => {
    expect(await diffDeItem(antes, { ...antes })).toEqual({});
  });
});
