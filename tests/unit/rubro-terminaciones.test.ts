import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaTerminaciones } from '@/lib/rubros/terminaciones';
import type { DatoObraResuelto, Fuente, ItemComputo } from '@/types/domain';

function ambiente(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'ambiente',
    nombre: 'Living',
    bbox: [0.2, 0.2, 0.3, 0.25],
    confianza: 0.95,
    estadoReforma: 'nueva',
    atributos: { superficieM2: 12, perimetroM: 14, solado: 'porcelanato', zocalo: 'madera' },
    ...over,
  };
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

const CUADRO: Fuente = { laminaId: 'L7', bbox: [0.1, 0.1, 0.8, 0.2], detalle: 'Cuadro de locales' };

function alturaDeRevestimiento(clave: string, valor: number): Map<string, DatoObraResuelto> {
  return new Map([
    [clave, { clave, valor, unidad: 'm', origen: 'deducido', fuentes: [CUADRO], confianza: 0.9 }],
  ]);
}

describe('plantilla terminaciones: ambiente de 12 m² con perímetro 14 m', () => {
  const { items, hallazgos } = plantillaTerminaciones.computar([ambiente({ id: 'a1' })], 'nueva');
  const item = porClave(items);

  it('emite solado, zócalo, contrapiso y carpeta, sin hallazgos', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual([
      'terminaciones.solado.porcelanato',
      'terminaciones.zocalo.madera',
      'terminaciones.contrapiso',
      'terminaciones.carpeta',
    ]);
  });

  it('solado: 12 m² + 10 % = 13,2 → 14 m² (se compra por m² enteros)', () => {
    const solado = item['terminaciones.solado.porcelanato']!;
    expect(solado.rubro).toBe('terminaciones');
    expect(solado.unidad).toBe('m2');
    expect(solado.cantNeta).toBe(12);
    expect(solado.desperdicioPct).toBe(10);
    expect(solado.cantCompra).toBe(14);
    expect(solado.presentacion).toBe('14 m² a granel (múltiplos de 1 m²)');
    expect(solado.descripcion).toBe('Solado de porcelanato');
    expect(solado.origen).toBe('explicito');
    expect(solado.confianza).toBe(0.95);
    expect(solado.fuentes).toEqual([{ laminaId: 'L1', bbox: [0.2, 0.2, 0.3, 0.25], detalle: 'Living' }]);
  });

  it('zócalo: el perímetro, 14 ml + 5 % = 14,7 → 15 ml', () => {
    const zocalo = item['terminaciones.zocalo.madera']!;
    expect(zocalo.unidad).toBe('ml');
    expect(zocalo.cantNeta).toBe(14);
    expect(zocalo.desperdicioPct).toBe(5);
    expect(zocalo.cantCompra).toBe(15);
    expect(zocalo.descripcion).toBe('Zócalo de madera');
  });

  it('contrapiso y carpeta: los mismos m² del solado, sin desperdicio y global', () => {
    for (const clave of ['terminaciones.contrapiso', 'terminaciones.carpeta']) {
      const base = item[clave]!;
      expect(base.unidad).toBe('m2');
      expect(base.cantNeta).toBe(12);
      expect(base.desperdicioPct).toBe(0);
      expect(base.cantCompra).toBe(12);
      expect(base.presentacion).toBe('global');
    }
  });
});

describe('plantilla terminaciones: revestimiento', () => {
  const bano = ambiente({
    id: 'b1',
    nombre: 'Baño',
    atributos: { superficieM2: 4, perimetroM: 10, revestimiento: 'cerámica', alturaRevestimientoM: 2 },
  });

  it('revestimiento: perímetro 10 × altura 2 = 20 m² + 10 % = 22 m²', () => {
    const { items, hallazgos } = plantillaTerminaciones.computar([bano], 'nueva');
    const revestimiento = porClave(items)['terminaciones.revestimiento.ceramica']!;

    expect(hallazgos).toEqual([]);
    expect(revestimiento.unidad).toBe('m2');
    expect(revestimiento.cantNeta).toBe(20);
    expect(revestimiento.desperdicioPct).toBe(10);
    expect(revestimiento.cantCompra).toBe(22);
    expect(revestimiento.descripcion).toBe('Revestimiento de cerámica');
  });

  it('sin altura de revestimiento la busca en el dato del ambiente', () => {
    const sinAltura = ambiente({
      id: 'b2',
      nombre: 'Baño',
      atributos: { superficieM2: 4, perimetroM: 10, revestimiento: 'cerámica' },
    });
    const { items, hallazgos, origenPorEntidad } = plantillaTerminaciones.computar(
      [sinAltura],
      'nueva',
      undefined,
      alturaDeRevestimiento('altura_revestimiento.Baño', 2),
    );
    const revestimiento = porClave(items)['terminaciones.revestimiento.ceramica']!;

    expect(hallazgos).toEqual([]);
    expect(revestimiento.cantNeta).toBe(20);
    expect(revestimiento.fuentes.at(-1)).toEqual(CUADRO); // el cuadro que declara la altura
    expect(origenPorEntidad!.get('b2')!.get('alturaRevestimientoM')).toBe('deducido');
  });

  it('la altura general respalda al ambiente que no tiene la suya', () => {
    const sinAltura = ambiente({
      id: 'b3',
      nombre: 'Baño',
      atributos: { superficieM2: 4, perimetroM: 10, revestimiento: 'cerámica' },
    });
    const { items } = plantillaTerminaciones.computar(
      [sinAltura],
      'nueva',
      undefined,
      alturaDeRevestimiento('altura_revestimiento.general', 2.1),
    );
    expect(porClave(items)['terminaciones.revestimiento.ceramica']!.cantNeta).toBe(21);
  });

  it('sin altura ni dato: UNA consulta de dato de obra por ambiente revestido', () => {
    const bano1 = ambiente({
      id: 'b4',
      nombre: 'Baño',
      atributos: { superficieM2: 4, perimetroM: 10, revestimiento: 'cerámica' },
    });
    const bano2 = ambiente({
      id: 'b5',
      nombre: 'Toilette',
      atributos: { superficieM2: 2, perimetroM: 6, revestimiento: 'cerámica' },
    });
    const { items, hallazgos } = plantillaTerminaciones.computar([bano1, bano2], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos.map((h) => h.clave)).toEqual([
      'dato_obra.altura_revestimiento.Baño',
      'dato_obra.altura_revestimiento.Toilette',
    ]);
    expect(hallazgos[0]!.targetDato).toEqual({
      clave: 'altura_revestimiento.Baño',
      unidad: 'm',
      entidades: ['b4'],
    });
    expect(hallazgos[0]!.bloqueante).toBe(false);
  });
});

describe('plantilla terminaciones: huecos y materiales', () => {
  it('un ambiente que no declara terminaciones no computa ni pregunta', () => {
    const pelado = ambiente({
      id: 'a2',
      atributos: { superficieM2: 12, perimetroM: 14, alturaM: 2.6 },
    });
    const { items, hallazgos } = plantillaTerminaciones.computar([pelado], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('material declarado sin superficie: consulta bloqueante', () => {
    const sinSuperficie = ambiente({
      id: 'a3',
      nombre: 'Cocina',
      atributos: { solado: 'porcelanato' },
    });
    const { items, hallazgos } = plantillaTerminaciones.computar([sinSuperficie], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('terminaciones.superficie.Cocina');
    expect(hallazgos[0]!.checklistItem).toBe('terminaciones.superficie');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 'a3', campos: ['superficieM2'] });
  });

  it('zócalo declarado sin perímetro: consulta bloqueante', () => {
    const sinPerimetro = ambiente({
      id: 'a4',
      nombre: 'Cocina',
      atributos: { superficieM2: 9, zocalo: 'madera' },
    });
    const { hallazgos } = plantillaTerminaciones.computar([sinPerimetro], 'nueva');

    expect(hallazgos.map((h) => h.clave)).toEqual(['terminaciones.perimetro.Cocina']);
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 'a4', campos: ['perimetroM'] });
  });

  it('suma los ambientes que comparten material y separa los que no', () => {
    const cocina = ambiente({
      id: 'a5',
      nombre: 'Cocina',
      bbox: [0.6, 0.2, 0.2, 0.2],
      confianza: 0.8,
      atributos: { superficieM2: 8, perimetroM: 12, solado: 'Porcelanato', zocalo: 'madera' },
    });
    const bano = ambiente({
      id: 'a6',
      nombre: 'Baño',
      bbox: [0.6, 0.6, 0.2, 0.2],
      atributos: { superficieM2: 4, perimetroM: 8, solado: 'cerámica' },
    });
    const { items } = plantillaTerminaciones.computar([ambiente({ id: 'a1' }), cocina, bano], 'nueva');
    const item = porClave(items);

    // "Porcelanato" y "porcelanato" son el mismo material.
    expect(item['terminaciones.solado.porcelanato']!.cantNeta).toBe(20);
    expect(item['terminaciones.solado.porcelanato']!.confianza).toBe(0.8);
    expect(item['terminaciones.solado.porcelanato']!.fuentes).toHaveLength(2);
    expect(item['terminaciones.solado.ceramica']!.cantNeta).toBe(4);
    expect(item['terminaciones.zocalo.madera']!.cantNeta).toBe(26);
    // El contrapiso va debajo de los tres solados, sean del material que sean.
    expect(item['terminaciones.contrapiso']!.cantNeta).toBe(24);
    expect(item['terminaciones.carpeta']!.cantNeta).toBe(24);
  });

  it('un ambiente existente no se termina (reforma)', () => {
    const existente = ambiente({ id: 'a7', estadoReforma: 'existente' });
    const { items, hallazgos } = plantillaTerminaciones.computar([existente], 'reforma');

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });
});

describe('plantilla terminaciones: el cuadro de locales (entidades `terminacion`)', () => {
  function terminacion(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
    return {
      laminaId: 'L2',
      tipo: 'terminacion',
      nombre: 'Piso Estar',
      bbox: [0.1, 0.6, 0.3, 0.05],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { superficieM2: 20, ubicacion: 'piso', ambiente: 'Estar', material: 'porcelanato' },
      ...over,
    };
  }

  it('un piso del cuadro computa solado, contrapiso y carpeta', () => {
    const { items, hallazgos } = plantillaTerminaciones.computar([terminacion({ id: 'p1' })], 'nueva');
    const item = porClave(items);

    expect(hallazgos).toEqual([]);
    expect(item['terminaciones.solado.porcelanato']!.cantNeta).toBe(20);
    expect(item['terminaciones.contrapiso']!.cantNeta).toBe(20);
  });

  it('un cielorraso del cuadro computa su m² con el desperdicio del rubro', () => {
    const cielo = terminacion({
      id: 'c1',
      nombre: 'Cielorraso Estar',
      atributos: { superficieM2: 19, ubicacion: 'cielorraso', ambiente: 'Estar', material: 'yeso' },
    });
    const { items } = plantillaTerminaciones.computar([cielo], 'nueva');
    const cielorraso = porClave(items)['terminaciones.cielorraso.yeso']!;

    expect(cielorraso.cantNeta).toBe(19);
    expect(cielorraso.desperdicioPct).toBe(12);
    expect(cielorraso.cantCompra).toBe(22); // 19 × 1,12 = 21,28 → 22 m²
  });

  it('una terminación sin material no se computa ni pregunta', () => {
    const sinMaterial = terminacion({
      id: 'p2',
      atributos: { superficieM2: 12, ubicacion: 'piso', ambiente: 'Dormitorio' },
    });
    const { items, hallazgos } = plantillaTerminaciones.computar([sinMaterial], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('una terminación con material y sin m² sí pregunta', () => {
    const sinSuperficie = terminacion({
      id: 'p3',
      nombre: 'Piso Dormitorio',
      atributos: { ubicacion: 'piso', ambiente: 'Dormitorio', material: 'porcelanato' },
    });
    const { hallazgos } = plantillaTerminaciones.computar([sinSuperficie], 'nueva');

    expect(hallazgos.map((h) => h.clave)).toEqual(['terminaciones.superficie.Piso Dormitorio']);
  });

  it('el cuadro y el ambiente suman en el mismo ítem', () => {
    const { items } = plantillaTerminaciones.computar(
      [ambiente({ id: 'a1' }), terminacion({ id: 'p1' })],
      'nueva',
    );
    expect(porClave(items)['terminaciones.solado.porcelanato']!.cantNeta).toBe(32);
  });
});

/**
 * El solado y el zócalo del mismo ambiente no usan la altura del revestimiento:
 * salen igual. El rubro queda con ítems y **sin una sola línea de
 * revestimiento**, que es peor que un número corto porque no se ve.
 */
describe('plantilla terminaciones: el revestimiento ausente frena, aunque el solado salga', () => {
  const bano = ambiente({
    id: 'b1',
    nombre: 'Baño',
    atributos: {
      superficieM2: 4,
      perimetroM: 10,
      solado: 'porcelanato',
      revestimiento: 'cerámica',
    },
  });
  const { items, hallazgos } = plantillaTerminaciones.computar([bano], 'nueva');

  it('el solado sale y el revestimiento no aparece en ningún lado', () => {
    expect(items.map((i) => i.claveItem)).toEqual([
      'terminaciones.solado.porcelanato',
      'terminaciones.contrapiso',
      'terminaciones.carpeta',
    ]);
  });

  it('y la consulta por la altura de revestimiento bloquea', () => {
    const consulta = hallazgos.find((h) => h.clave.startsWith('dato_obra.'))!;
    expect(consulta.bloqueante).toBe(true);
    expect(consulta.clave).toBe('dato_obra.altura_revestimiento.Baño');
  });
});
