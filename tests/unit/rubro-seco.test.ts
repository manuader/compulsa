import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaSeco } from '@/lib/rubros/seco';
import type { ItemComputo } from '@/types/domain';

function tabique(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'tabique',
    nombre: 'T1',
    bbox: [0.1, 0.1, 0.4, 0.02],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: { largoM: 5, alturaM: 2.6, caras: 2, tipo: 'durlock' },
    ...over,
  };
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

describe('plantilla seco: tabique de 5 × 2,60 m a dos caras (26 m²)', () => {
  const { items, hallazgos } = plantillaSeco.computar([tabique({ id: 't1' })], 'nueva');
  const item = porClave(items);

  it('emite los seis ítems del tabique de durlock, sin hallazgos', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual([
      'seco.placas',
      'seco.soleras',
      'seco.montantes',
      'seco.tornillos',
      'seco.masilla',
      'seco.cinta',
    ]);
  });

  it('placas: 26 m² + 12% = 29,12 → 11 placas de 2,88 m² = 31,68 m²', () => {
    const placas = item['seco.placas']!;
    expect(placas.unidad).toBe('m2');
    expect(placas.cantNeta).toBe(26);
    expect(placas.desperdicioPct).toBe(12);
    expect(placas.cantCompra).toBe(31.68);
    expect(placas.presentacion).toBe('11 placas de 2,88 m²');
    expect(placas.descripcion).toContain('Placa');
    expect(placas.origen).toBe('explicito');
    expect(placas.confianza).toBe(0.9);
    expect(placas.fuentes).toEqual([{ laminaId: 'L1', bbox: [0.1, 0.1, 0.4, 0.02], detalle: 'T1' }]);
  });

  it('soleras: 2 × 5 m = 10 ml → 4 barras de 2,60 m', () => {
    const soleras = item['seco.soleras']!;
    expect(soleras.unidad).toBe('ml');
    expect(soleras.cantNeta).toBe(10);
    expect(soleras.desperdicioPct).toBe(0);
    expect(soleras.cantCompra).toBe(10.4);
    expect(soleras.presentacion).toBe('4 barras de 2,60 m');
  });

  it('montantes: ceil(5 / 0,40) + 1 = 14 tiras', () => {
    const montantes = item['seco.montantes']!;
    expect(montantes.unidad).toBe('u');
    expect(montantes.cantNeta).toBe(14);
    expect(montantes.cantCompra).toBe(14);
    expect(montantes.presentacion).toBe('14 tiras de 2,60 m');
  });

  it('tornillos: 15 × 26 m² = 390 u → 1 caja de 500 u', () => {
    const tornillos = item['seco.tornillos']!;
    expect(tornillos.unidad).toBe('u');
    expect(tornillos.cantNeta).toBe(390);
    expect(tornillos.cantCompra).toBe(500);
    expect(tornillos.presentacion).toBe('1 caja de 500 u');
  });

  it('masilla: 0,9 × 26 m² = 23,4 kg → 2 baldes de 15 kg', () => {
    const masilla = item['seco.masilla']!;
    expect(masilla.unidad).toBe('kg');
    expect(masilla.cantNeta).toBe(23.4);
    expect(masilla.cantCompra).toBe(30);
    expect(masilla.presentacion).toBe('2 baldes de 15 kg');
  });

  it('cinta: 2,3 × 26 m² = 59,8 ml → 1 rollo de 90 m', () => {
    const cinta = item['seco.cinta']!;
    expect(cinta.unidad).toBe('ml');
    expect(cinta.cantNeta).toBe(59.8);
    expect(cinta.cantCompra).toBe(90);
    expect(cinta.presentacion).toBe('1 rollo de 90 m');
  });
});

describe('plantilla seco: varios tabiques y datos faltantes', () => {
  it('suma los tabiques computables en un solo juego de ítems', () => {
    const otro = tabique({ id: 't2', nombre: 'T2', bbox: [0.1, 0.5, 0.4, 0.02], confianza: 0.75 });
    const { items } = plantillaSeco.computar([tabique({ id: 't1' }), otro], 'nueva');
    const item = porClave(items);

    expect(item['seco.placas']!.cantNeta).toBe(52);
    expect(item['seco.placas']!.cantCompra).toBe(60.48); // 52 × 1,12 = 58,24 → 21 placas
    expect(item['seco.soleras']!.cantNeta).toBe(20);
    expect(item['seco.montantes']!.cantNeta).toBe(28);
    expect(item['seco.tornillos']!.cantNeta).toBe(780);
    expect(item['seco.placas']!.confianza).toBe(0.75); // la peor de las entidades usadas
    expect(item['seco.placas']!.fuentes).toHaveLength(2);
  });

  it('sin alturaM el tabique NO se computa y sale hallazgo bloqueante', () => {
    const sinAltura = tabique({
      id: 't3',
      nombre: 'T3',
      atributos: { largoM: 4, caras: 2, tipo: 'durlock' },
    });
    const { items, hallazgos } = plantillaSeco.computar([tabique({ id: 't1' }), sinAltura], 'nueva');

    expect(porClave(items)['seco.placas']!.cantNeta).toBe(26); // solo T1
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('seco.altura_tabiques.T3');
    expect(hallazgos[0]!.tipo).toBe('faltante');
    expect(hallazgos[0]!.rubro).toBe('seco');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 't3', campos: ['alturaM'] });
  });

  it('sin ningún tabique computable no emite ítems en cero', () => {
    const sinAltura = tabique({ id: 't3', nombre: 'T3', atributos: { largoM: 4 } });
    const { items } = plantillaSeco.computar([sinAltura], 'nueva');
    expect(items).toEqual([]);
  });

  it('respeta las caras declaradas en la entidad', () => {
    const unaCara = tabique({ id: 't4', atributos: { largoM: 5, alturaM: 2.6, caras: 1, tipo: 'durlock' } });
    const { items } = plantillaSeco.computar([unaCara], 'nueva');
    expect(porClave(items)['seco.placas']!.cantNeta).toBe(13);
  });

  it('un tabique existente no se computa (reforma)', () => {
    const existente = tabique({ id: 't5', estadoReforma: 'existente' });
    const { items, hallazgos } = plantillaSeco.computar([existente], 'reforma');
    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('un tabique que no es de durlock no se computa a ciegas', () => {
    const otroSistema = tabique({
      id: 't6',
      nombre: 'T6',
      atributos: { largoM: 5, alturaM: 2.6, tipo: 'mamposteria' },
    });
    const { items, hallazgos } = plantillaSeco.computar([otroSistema], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('seco.sistema_tabique.T6');
    expect(hallazgos[0]!.bloqueante).toBe(true);
  });
});
