import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaElectrica } from '@/lib/rubros/electrica';
import type { DatoObraResuelto, EntidadDetectada, ItemComputo } from '@/types/domain';

type Atributos = EntidadDetectada['atributos'];

function boca(
  id: string,
  atributos: Atributos,
  over: Partial<EntidadPersistida> = {},
): EntidadPersistida {
  return {
    id,
    laminaId: 'L1',
    tipo: 'boca',
    nombre: id.toUpperCase(),
    bbox: [0.1, 0.1, 0.02, 0.02],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos,
    ...over,
  };
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

describe('plantilla eléctrica: bocas por tipo', () => {
  const bocas = [
    boca('b1', { tipo: 'toma', circuito: 'TUG1' }),
    boca('b2', { tipo: 'toma', circuito: 'TUG1' }, { bbox: [0.2, 0.1, 0.02, 0.02] }),
    boca('b3', { tipo: 'luz', circuito: 'IUG1' }, { bbox: [0.3, 0.1, 0.02, 0.02] }),
    boca('b4', { tipo: 'luz', circuito: 'IUG1' }, { bbox: [0.4, 0.1, 0.02, 0.02] }),
    boca('b5', { tipo: 'luz', circuito: 'IUG2' }, { bbox: [0.5, 0.1, 0.02, 0.02], confianza: 0.8 }),
  ];
  const { items, hallazgos } = plantillaElectrica.computar(bocas, 'nueva');
  const item = porClave(items);

  it('2 tomas y 3 bocas de luz son dos ítems de 2 y 3 unidades', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual(['electrica.boca.toma', 'electrica.boca.luz']);
    expect(item['electrica.boca.toma']!.cantNeta).toBe(2);
    expect(item['electrica.boca.luz']!.cantNeta).toBe(3);
  });

  it('la boca se cuenta por unidad: sin desperdicio y sin bulto que redondear', () => {
    const luz = item['electrica.boca.luz']!;
    expect(luz.unidad).toBe('u');
    expect(luz.desperdicioPct).toBe(0);
    expect(luz.cantCompra).toBe(3);
    expect(luz.presentacion).toBe('global');
    expect(luz.descripcion).toBe('Boca de luz');
    expect(item['electrica.boca.toma']!.descripcion).toBe('Boca de toma');
  });

  it('hereda fuentes y la peor confianza de las bocas que la componen', () => {
    const luz = item['electrica.boca.luz']!;
    expect(luz.fuentes).toHaveLength(3);
    expect(luz.fuentes[0]).toEqual({ laminaId: 'L1', bbox: [0.3, 0.1, 0.02, 0.02], detalle: 'B3' });
    expect(luz.confianza).toBe(0.8);
    expect(luz.origen).toBe('explicito');
    expect(luz.rubro).toBe('electrica');
  });

  it('dos tableros en la misma lámina suman dos unidades', () => {
    const { items: tableros } = plantillaElectrica.computar(
      [
        boca('b6', { tipo: 'tablero' }),
        boca('b7', { tipo: 'tablero' }, { bbox: [0.6, 0.1, 0.04, 0.04] }),
      ],
      'nueva',
    );

    expect(porClave(tableros)['electrica.boca.tablero']!.cantNeta).toBe(2);
    expect(porClave(tableros)['electrica.boca.tablero']!.descripcion).toBe('Tablero eléctrico');
  });

  it('emite los tipos en el orden del rubro, no en el de la lámina', () => {
    const { items: mezcla } = plantillaElectrica.computar(
      [
        boca('b8', { tipo: 'datos' }),
        boca('b9', { tipo: 'caja' }),
        boca('b10', { tipo: 'toma' }),
      ],
      'nueva',
    );

    expect(mezcla.map((i) => i.claveItem)).toEqual([
      'electrica.boca.toma',
      'electrica.boca.caja',
      'electrica.boca.datos',
    ]);
  });
});

describe('plantilla eléctrica: lo que le falta a una boca', () => {
  it('sin tipo no se cuenta y sale consulta bloqueante', () => {
    const { items, hallazgos } = plantillaElectrica.computar(
      [boca('b1', { tipo: 'toma' }), boca('b2', { circuito: 'TUG1' })],
      'nueva',
    );

    expect(porClave(items)['electrica.boca.toma']!.cantNeta).toBe(1);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.tipo).toBe('faltante');
    expect(hallazgos[0]!.rubro).toBe('electrica');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.clave).toBe('electrica.tipo_bocas.B2');
    expect(hallazgos[0]!.checklistItem).toBe('electrica.tipo_bocas');
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 'b2', campos: ['tipo'] });
  });

  it('un tipo que el rubro no computa tampoco se cuenta a ciegas', () => {
    const { items, hallazgos } = plantillaElectrica.computar([boca('b3', { tipo: 'termo' })], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('electrica.tipo_bocas.B3');
    expect(hallazgos[0]!.descripcion).toContain('termo');
  });

  it('una boca existente no se computa ni pregunta (reforma)', () => {
    const { items, hallazgos } = plantillaElectrica.computar(
      [boca('b4', { tipo: 'toma' }, { estadoReforma: 'existente' })],
      'reforma',
    );

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });
});

describe('plantilla eléctrica: bordes', () => {
  it('sin bocas no emite ítems en cero', () => {
    const { items, hallazgos } = plantillaElectrica.computar(
      [
        {
          id: 'am1',
          laminaId: 'L1',
          tipo: 'ambiente',
          nombre: 'Living',
          bbox: [0.1, 0.1, 0.3, 0.3],
          confianza: 0.9,
          estadoReforma: 'nueva',
          atributos: { superficieM2: 12, perimetroM: 14 },
        },
      ],
      'nueva',
    );

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('ignora las láminas y los datos de obra (no hay alturas en este rubro)', () => {
    const entidades = [boca('b1', { tipo: 'toma' })];
    const datosObra = new Map<string, DatoObraResuelto>([
      [
        'altura_local.PB',
        { clave: 'altura_local.PB', valor: 2.6, unidad: 'm', origen: 'explicito', fuentes: [], confianza: 1 },
      ],
    ]);

    const solo = plantillaElectrica.computar(entidades, 'nueva');
    const conTodo = plantillaElectrica.computar(entidades, 'nueva', [{ id: 'L1', tipo: 'planta' }], datosObra);

    expect(conTodo).toEqual(solo);
  });
});
