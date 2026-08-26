import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import {
  armarItem,
  ceilAPresentacion,
  confianzaMinima,
  describirLatas,
  describirPresentacion,
  fuentesDeEntidades,
  latasParaLitros,
  type Presentacion,
} from '@/lib/computo/presentacion';
import { formatearNumero, redondear2, redondearEntero } from '@/lib/computo/unidades';

const PLACA: Presentacion = { singular: 'placa', plural: 'placas', contenido: 2.88, detalle: '2,88 m²' };

function ent(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'tabique',
    nombre: 'T1',
    bbox: [0.1, 0.2, 0.3, 0.4],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: {},
    ...over,
  };
}

describe('redondear2', () => {
  it('mata el ruido binario de las multiplicaciones del motor', () => {
    expect(26 * 1.12).not.toBe(29.12); // el problema que este helper resuelve
    expect(redondear2(26 * 1.12)).toBe(29.12);
    expect(redondear2(11 * 2.88)).toBe(31.68);
    expect(redondear2(3 * 2.6)).toBe(7.8);
    expect(redondear2(15.6 * 16.5)).toBe(257.4);
  });

  it('redondea al medio hacia arriba y deja los enteros intactos', () => {
    expect(redondear2(1.005)).toBe(1.01);
    expect(redondear2(2)).toBe(2);
    expect(redondear2(0)).toBe(0);
  });
});

describe('redondearEntero', () => {
  it('devuelve el entero más cercano, sin ruido binario', () => {
    expect(redondearEntero(13.999999999999998)).toBe(14);
    expect(redondearEntero(2.4)).toBe(2);
    expect(redondearEntero(2.5)).toBe(3);
  });
});

describe('formatearNumero', () => {
  it('usa coma decimal (es-AR) y respeta los decimales pedidos', () => {
    expect(formatearNumero(31.68)).toBe('31,68');
    expect(formatearNumero(14)).toBe('14');
    expect(formatearNumero(2.6, 2)).toBe('2,60');
    expect(formatearNumero(0.5, 1)).toBe('0,5');
  });
});

describe('ceilAPresentacion', () => {
  it('redondea SIEMPRE hacia arriba a la presentación comercial', () => {
    expect(ceilAPresentacion(29.12, 2.88)).toEqual({ unidades: 11, cantCompra: 31.68 }); // placas
    expect(ceilAPresentacion(10, 2.6)).toEqual({ unidades: 4, cantCompra: 10.4 }); // soleras
    expect(ceilAPresentacion(390, 500)).toEqual({ unidades: 1, cantCompra: 500 }); // tornillos
    expect(ceilAPresentacion(23.4, 15)).toEqual({ unidades: 2, cantCompra: 30 }); // masilla
    expect(ceilAPresentacion(59.8, 90)).toEqual({ unidades: 1, cantCompra: 90 }); // cinta
    expect(ceilAPresentacion(270.27, 198)).toEqual({ unidades: 2, cantCompra: 396 }); // ladrillos
    expect(ceilAPresentacion(0.624, 0.5)).toEqual({ unidades: 2, cantCompra: 1 }); // arena
  });

  it('no compra un bulto de más cuando la cantidad es múltiplo exacto', () => {
    expect(ceilAPresentacion(31.68, 2.88)).toEqual({ unidades: 11, cantCompra: 31.68 });
    expect(ceilAPresentacion(14, 1)).toEqual({ unidades: 14, cantCompra: 14 });
    expect(ceilAPresentacion(0, 2.88)).toEqual({ unidades: 0, cantCompra: 0 });
  });

  it('rechaza un contenido inválido en vez de devolver Infinity', () => {
    expect(() => ceilAPresentacion(10, 0)).toThrow(RangeError);
  });
});

describe('latasParaLitros', () => {
  it('resuelve 6,909 L como 1 lata de 4 L + 3 latas de 1 L (7 L)', () => {
    expect(latasParaLitros(6.909)).toEqual({ latas: { 4: 1, 1: 3 }, litrosTotales: 7 });
  });

  it('es greedy de mayor a menor y solo la lata de 1 L redondea hacia arriba', () => {
    expect(latasParaLitros(24)).toEqual({ latas: { 20: 1, 4: 1 }, litrosTotales: 24 });
    expect(latasParaLitros(35.2)).toEqual({ latas: { 20: 1, 10: 1, 4: 1, 1: 2 }, litrosTotales: 36 });
    expect(latasParaLitros(2.52)).toEqual({ latas: { 1: 3 }, litrosTotales: 3 });
    expect(latasParaLitros(0.2)).toEqual({ latas: { 1: 1 }, litrosTotales: 1 });
  });

  it('no inventa latas para 0 L', () => {
    expect(latasParaLitros(0)).toEqual({ latas: {}, litrosTotales: 0 });
  });
});

describe('describirLatas / describirPresentacion', () => {
  it('arma el detalle comercial en es-AR', () => {
    expect(describirLatas(latasParaLitros(6.909).latas)).toBe('1 lata 4 L + 3 latas 1 L');
    expect(describirLatas(latasParaLitros(24).latas)).toBe('1 lata 20 L + 1 lata 4 L');
    expect(describirPresentacion(11, PLACA)).toBe('11 placas de 2,88 m²');
    expect(describirPresentacion(1, PLACA)).toBe('1 placa de 2,88 m²');
  });
});

describe('armarItem', () => {
  const e1 = ent({ id: 'e1' });
  const e2 = ent({ id: 'e2', nombre: 'T2', confianza: 0.82, bbox: [0.5, 0.2, 0.1, 0.1] });
  const e3 = ent({ id: 'e3', nombre: 'T1 (repetida)' }); // misma lámina + bbox que e1

  it('aplica desperdicio, redondea a presentación y hereda provenance', () => {
    const item = armarItem({
      rubro: 'seco',
      claveItem: 'seco.placas',
      descripcion: 'Placa de roca de yeso',
      unidad: 'm2',
      cantNeta: 26,
      desperdicioPct: 12,
      compra: { tipo: 'bulto', presentacion: PLACA },
      entidades: [e1, e2, e3],
    });

    expect(item.cantNeta).toBe(26);
    expect(item.desperdicioPct).toBe(12);
    expect(item.cantCompra).toBe(31.68);
    expect(item.presentacion).toBe('11 placas de 2,88 m²');
    expect(item.origen).toBe('explicito');
    expect(item.confianza).toBe(0.82); // la mínima de las entidades usadas
    expect(item.fuentes).toEqual([
      { laminaId: 'L1', bbox: [0.1, 0.2, 0.3, 0.4], detalle: 'T1' },
      { laminaId: 'L1', bbox: [0.5, 0.2, 0.1, 0.1], detalle: 'T2' },
    ]); // e3 duplica laminaId+bbox de e1: no se repite la fuente
    expect(item.entidadRef).toBeUndefined();
  });

  it('linkea entidadRef cuando el ítem sale de una sola entidad', () => {
    const item = armarItem({
      rubro: 'gruesa',
      claveItem: 'gruesa.demolicion',
      descripcion: 'Demolición de mampostería',
      unidad: 'm2',
      cantNeta: 7.8,
      desperdicioPct: 0,
      compra: { tipo: 'global' },
      entidades: [e1],
    });

    expect(item.entidadRef).toBe('e1');
    expect(item.cantCompra).toBe(7.8);
    expect(item.presentacion).toBe('global');
  });

  it('conoce los modos de compra a granel, en latas y a medida', () => {
    const arena = armarItem({
      rubro: 'gruesa',
      claveItem: 'gruesa.arena',
      descripcion: 'Arena',
      unidad: 'm3',
      cantNeta: 0.624,
      desperdicioPct: 0,
      compra: { tipo: 'granel', multiplo: 0.5 },
      entidades: [e1],
    });
    expect(arena.cantCompra).toBe(1);
    expect(arena.presentacion).toBe('1 m³ a granel (múltiplos de 0,5 m³)');

    const latex = armarItem({
      rubro: 'pintura',
      claveItem: 'pintura.latex_paredes',
      descripcion: 'Látex interior para paredes',
      unidad: 'l',
      cantNeta: 6.58,
      desperdicioPct: 5,
      compra: { tipo: 'latas' },
      entidades: [e1],
    });
    expect(latex.cantCompra).toBe(7);
    expect(latex.presentacion).toBe('1 lata 4 L + 3 latas 1 L');

    const ventana = armarItem({
      rubro: 'aberturas',
      claveItem: 'aberturas.V2',
      descripcion: 'Ventana V2',
      unidad: 'u',
      cantNeta: 2,
      desperdicioPct: 0,
      compra: { tipo: 'medida' },
      entidades: [e1],
    });
    expect(ventana.cantCompra).toBe(2);
    expect(ventana.presentacion).toBe('a medida');
  });
});

describe('provenance', () => {
  it('fuentesDeEntidades deduplica por laminaId + bbox y confianzaMinima toma la peor', () => {
    const a = ent({ id: 'a', laminaId: 'L1' });
    const b = ent({ id: 'b', laminaId: 'L2', confianza: 0.55 });
    const c = ent({ id: 'c', laminaId: 'L1' });

    expect(fuentesDeEntidades([a, b, c])).toHaveLength(2);
    expect(confianzaMinima([a, b, c])).toBe(0.55);
  });
});
