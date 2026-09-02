import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaPintura } from '@/lib/rubros/pintura';
import type { DatoObraResuelto, Fuente, ItemComputo } from '@/types/domain';

function ambiente(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'ambiente',
    nombre: 'Living',
    bbox: [0.2, 0.2, 0.3, 0.25],
    confianza: 0.95,
    estadoReforma: 'na',
    atributos: { superficieM2: 12, perimetroM: 14, alturaM: 2.6, vanosM2: 3.5 },
    ...over,
  };
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

describe('plantilla pintura: ambiente de 4 × 3 m (per. 14 m, alto 2,60 m, vanos 3,5 m²)', () => {
  const { items, hallazgos } = plantillaPintura.computar([ambiente({ id: 'a1' })], 'nueva');
  const item = porClave(items);

  it('emite látex de paredes y de cielorrasos, sin hallazgos', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual(['pintura.latex_paredes', 'pintura.latex_cielorrasos']);
  });

  it('paredes: 14 × 2,60 − 3,5 = 32,9 m² → 6,58 L + 5% = 6,909 → 1 lata de 4 L + 3 de 1 L (7 L)', () => {
    const paredes = item['pintura.latex_paredes']!;
    expect(paredes.rubro).toBe('pintura');
    expect(paredes.unidad).toBe('l');
    expect(paredes.cantNeta).toBe(6.58);
    expect(paredes.desperdicioPct).toBe(5);
    expect(paredes.cantCompra).toBe(7);
    expect(paredes.presentacion).toBe('1 lata 4 L + 3 latas 1 L');
    expect(paredes.origen).toBe('explicito');
    expect(paredes.confianza).toBe(0.95);
    expect(paredes.fuentes).toEqual([{ laminaId: 'L1', bbox: [0.2, 0.2, 0.3, 0.25], detalle: 'Living' }]);
  });

  it('cielorrasos: 12 m² → 2,4 L + 5% = 2,52 → 3 latas de 1 L', () => {
    const cielos = item['pintura.latex_cielorrasos']!;
    expect(cielos.unidad).toBe('l');
    expect(cielos.cantNeta).toBe(2.4);
    expect(cielos.desperdicioPct).toBe(5);
    expect(cielos.cantCompra).toBe(3);
    expect(cielos.presentacion).toBe('3 latas 1 L');
  });
});

describe('plantilla pintura: huecos de documentación', () => {
  it('sin alturaM no computa las paredes: consulta de dato de obra (el cielorraso sí se computa)', () => {
    const sinAltura = ambiente({
      id: 'a2',
      nombre: 'Dormitorio 1',
      atributos: { superficieM2: 10, perimetroM: 13, vanosM2: 2 },
    });
    const { items, hallazgos } = plantillaPintura.computar([sinAltura], 'nueva');

    expect(items.map((i) => i.claveItem)).toEqual(['pintura.latex_cielorrasos']);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('dato_obra.altura_local.general');
    expect(hallazgos[0]!.tipo).toBe('faltante');
    expect(hallazgos[0]!.targetDato).toEqual({
      clave: 'altura_local.general',
      unidad: 'm',
      entidades: ['a2'],
    });
  });

  it('sin vanosM2 computa bruto, avisa con un supuesto NO bloqueante y degrada el origen', () => {
    const sinVanos = ambiente({
      id: 'a3',
      atributos: { superficieM2: 12, perimetroM: 14, alturaM: 2.6 },
    });
    const { items, hallazgos } = plantillaPintura.computar([sinVanos], 'nueva');
    const paredes = porClave(items)['pintura.latex_paredes']!;

    expect(paredes.cantNeta).toBe(7.28); // 36,4 m² brutos × 2 manos / 10
    expect(paredes.cantCompra).toBe(8); // 7,644 L → 1 lata de 4 L + 4 de 1 L
    expect(paredes.origen).toBe('supuesto');

    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('pintura.vanos_sin_descontar.Living');
    expect(hallazgos[0]!.tipo).toBe('supuesto');
    expect(hallazgos[0]!.bloqueante).toBe(false);
    expect(hallazgos[0]!.descripcion).toContain('sin descontar vanos');
  });

  it('sin superficieM2 no computa el cielorraso: hallazgo bloqueante', () => {
    const sinSuperficie = ambiente({
      id: 'a4',
      nombre: 'Baño',
      atributos: { perimetroM: 8, alturaM: 2.6, vanosM2: 1.6 },
    });
    const { items, hallazgos } = plantillaPintura.computar([sinSuperficie], 'nueva');

    expect(items.map((i) => i.claveItem)).toEqual(['pintura.latex_paredes']);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('pintura.superficie_ambiente.Baño');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 'a4', campos: ['superficieM2'] });
  });

  it('suma todos los ambientes en un solo ítem por clave', () => {
    const otro = ambiente({
      id: 'a5',
      nombre: 'Cocina',
      bbox: [0.6, 0.2, 0.2, 0.2],
      confianza: 0.8,
      atributos: { superficieM2: 8, perimetroM: 12, alturaM: 2.6, vanosM2: 2 },
    });
    const { items } = plantillaPintura.computar([ambiente({ id: 'a1' }), otro], 'nueva');
    const item = porClave(items);

    // paredes: 32,9 + (12 × 2,60 − 2 = 29,2) = 62,1 m² → 12,42 L
    expect(item['pintura.latex_paredes']!.cantNeta).toBe(12.42);
    expect(item['pintura.latex_cielorrasos']!.cantNeta).toBe(4); // (12 + 8) × 2 / 10
    expect(item['pintura.latex_paredes']!.confianza).toBe(0.8);
    expect(item['pintura.latex_paredes']!.fuentes).toHaveLength(2);
  });

  it('un ambiente existente no se pinta (reforma)', () => {
    const existente = ambiente({ id: 'a6', estadoReforma: 'existente' });
    const { items, hallazgos } = plantillaPintura.computar([existente], 'reforma');
    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });
});

describe('plantilla pintura: la altura la pone el dato de obra', () => {
  const CORTE: Fuente = { laminaId: 'L9', bbox: [0.2, 0.3, 0.5, 0.4], detalle: 'Corte A-A' };
  const datos = new Map<string, DatoObraResuelto>([
    [
      'altura_local.general',
      {
        clave: 'altura_local.general',
        valor: 2.6,
        unidad: 'm',
        origen: 'deducido',
        fuentes: [CORTE],
        confianza: 0.9,
      },
    ],
  ]);

  const sinAltura = ambiente({
    id: 'a7',
    atributos: { superficieM2: 12, perimetroM: 14, vanosM2: 3.5 },
  });
  const { items, hallazgos, origenPorEntidad } = plantillaPintura.computar(
    [sinAltura],
    'nueva',
    undefined,
    datos,
  );
  const item = porClave(items);

  it('da los mismos números que con la altura escrita en el ambiente', () => {
    expect(hallazgos).toEqual([]);
    expect(item['pintura.latex_paredes']!.cantNeta).toBe(6.58); // 14 × 2,60 − 3,5
    expect(item['pintura.latex_cielorrasos']!.cantNeta).toBe(2.4);
  });

  it('las paredes citan el corte; el cielorraso, que no usa la altura, no', () => {
    expect(item['pintura.latex_paredes']!.fuentes).toHaveLength(2);
    expect(item['pintura.latex_paredes']!.fuentes.at(-1)).toEqual(CORTE);
    expect(item['pintura.latex_cielorrasos']!.fuentes).toHaveLength(1);
  });

  it('anota alturaM con el origen del dato', () => {
    expect(origenPorEntidad!.get('a7')!.get('alturaM')).toBe('deducido');
  });

  it('agrupa a todos los ambientes sin altura en una sola consulta', () => {
    const otro = ambiente({
      id: 'a8',
      nombre: 'Cocina',
      bbox: [0.6, 0.2, 0.2, 0.2],
      atributos: { superficieM2: 8, perimetroM: 12, vanosM2: 2 },
    });
    const { hallazgos: consultas } = plantillaPintura.computar([sinAltura, otro], 'nueva');

    expect(consultas.map((h) => h.clave)).toEqual(['dato_obra.altura_local.general']);
    expect(consultas[0]!.targetDato?.entidades).toEqual(['a7', 'a8']);
    expect(consultas[0]!.descripcion).toContain('Living y Cocina');
  });
});

/**
 * El cielorraso no usa la altura, así que sale igual. O sea: el rubro tiene
 * ítems, la planilla se ve completa y a los m² de pared les falta un ambiente
 * entero. Aprobarlo así es cotizar menos látex del que la obra consume.
 */
describe('plantilla pintura: la pared corta frena, aunque el cielorraso salga', () => {
  const conAltura = ambiente({ id: 'a1', nombre: 'Living' });
  const sinAltura = ambiente({
    id: 'a2',
    nombre: 'Comedor',
    atributos: { superficieM2: 10, perimetroM: 12, vanosM2: 2 },
  });
  const { items, hallazgos } = plantillaPintura.computar([conAltura, sinAltura], 'nueva');

  it('las paredes salen con un solo ambiente y el cielorraso con los dos', () => {
    // Paredes: solo el Living (14 × 2,60 − 3,5 = 32,9 m² ⇒ 6,58 L).
    expect(porClave(items)['pintura.latex_paredes']!.cantNeta).toBe(6.58);
    // Cielorrasos: 12 + 10 = 22 m² ⇒ 4,4 L.
    expect(porClave(items)['pintura.latex_cielorrasos']!.cantNeta).toBe(4.4);
  });

  it('y la consulta por la altura que falta bloquea', () => {
    const consulta = hallazgos.find((h) => h.clave.startsWith('dato_obra.'))!;
    expect(consulta.bloqueante).toBe(true);
    expect(consulta.targetDato?.entidades).toEqual(['a2']);
  });
});
