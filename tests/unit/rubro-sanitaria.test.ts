import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaSanitaria } from '@/lib/rubros/sanitaria';
import type { DatoObraResuelto, EntidadDetectada, ItemComputo } from '@/types/domain';

type Atributos = EntidadDetectada['atributos'];

function entidad(
  tipo: EntidadDetectada['tipo'],
  id: string,
  nombre: string,
  atributos: Atributos,
  over: Partial<EntidadPersistida> = {},
): EntidadPersistida {
  return {
    id,
    laminaId: 'L1',
    tipo,
    nombre,
    bbox: [0.1, 0.1, 0.2, 0.02],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos,
    ...over,
  };
}

function tramo(id: string, atributos: Atributos, over: Partial<EntidadPersistida> = {}): EntidadPersistida {
  return entidad('tramo', id, id.toUpperCase(), atributos, over);
}

function accesorio(id: string, atributos: Atributos): EntidadPersistida {
  return entidad('accesorio', id, id.toUpperCase(), atributos);
}

function artefacto(id: string, nombre: string, atributos: Atributos): EntidadPersistida {
  return entidad('artefacto', id, nombre, atributos);
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

describe('plantilla sanitaria: cañería por sistema y diámetro', () => {
  const tramos = [
    tramo('t1', { sistema: 'ac', diametro: '20', longitudM: 2 }),
    tramo('t2', { sistema: 'ac', diametro: 'Ø20', longitudM: 3 }, { bbox: [0.2, 0.2, 0.2, 0.02] }),
    tramo('t3', { sistema: 'ac', diametro: '20mm', longitudM: 1.5 }, { bbox: [0.3, 0.3, 0.2, 0.02] }),
  ];
  const { items, hallazgos } = plantillaSanitaria.computar(tramos, 'nueva');
  const item = porClave(items);

  it('suma 2 + 3 + 1,5 en un solo ítem de 6,5 ml', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual(['sanitaria.canieria.ac.20']);
    expect(item['sanitaria.canieria.ac.20']!.cantNeta).toBe(6.5);
    expect(item['sanitaria.canieria.ac.20']!.unidad).toBe('ml');
  });

  it('6,5 ml + 5% = 6,83 → 2 tiras de 4 m = 8 ml', () => {
    const canieria = item['sanitaria.canieria.ac.20']!;
    expect(canieria.desperdicioPct).toBe(5);
    expect(canieria.cantCompra).toBe(8);
    expect(canieria.presentacion).toBe('2 tiras de 4 m');
    expect(canieria.descripcion).toBe('Cañería de agua caliente Ø 20');
  });

  it('hereda fuentes y confianza de los tres tramos', () => {
    const canieria = item['sanitaria.canieria.ac.20']!;
    expect(canieria.fuentes).toHaveLength(3);
    expect(canieria.fuentes[0]).toEqual({ laminaId: 'L1', bbox: [0.1, 0.1, 0.2, 0.02], detalle: 'T1' });
    expect(canieria.confianza).toBe(0.9);
    expect(canieria.origen).toBe('explicito');
    expect(canieria.rubro).toBe('sanitaria');
  });

  it('separa los ítems por sistema y por diámetro, ordenados', () => {
    const { items: varios } = plantillaSanitaria.computar(
      [
        tramo('t4', { sistema: 'cloacal', diametro: '110', longitudM: 6 }),
        tramo('t5', { sistema: 'af', diametro: '20', longitudM: 4 }),
        tramo('t6', { sistema: 'cloacal', diametro: '40', longitudM: 2 }),
      ],
      'nueva',
    );

    expect(varios.map((i) => i.claveItem)).toEqual([
      'sanitaria.canieria.af.20',
      'sanitaria.canieria.cloacal.40',
      'sanitaria.canieria.cloacal.110',
    ]);
    expect(porClave(varios)['sanitaria.canieria.cloacal.110']!.cantNeta).toBe(6);
  });
});

describe('plantilla sanitaria: lo que le falta a un tramo', () => {
  it('sin longitudM no computa y sale consulta bloqueante', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [
        tramo('t1', { sistema: 'ac', diametro: '20', longitudM: 2 }),
        tramo('t9', { sistema: 'ac', diametro: '20' }),
      ],
      'nueva',
    );

    expect(porClave(items)['sanitaria.canieria.ac.20']!.cantNeta).toBe(2); // solo T1
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.tipo).toBe('faltante');
    expect(hallazgos[0]!.rubro).toBe('sanitaria');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.clave).toBe('sanitaria.longitud_tramos.T9');
    expect(hallazgos[0]!.checklistItem).toBe('sanitaria.longitud_tramos');
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 't9', campos: ['longitudM'] });
  });

  it('sin diámetro no computa y pide el diámetro', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [tramo('t9', { sistema: 'ac', longitudM: 2 })],
      'nueva',
    );

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('sanitaria.diametro_tramos.T9');
    expect(hallazgos[0]!.checklistItem).toBe('sanitaria.diametro_tramos');
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 't9', campos: ['diametro'] });
  });

  it('sin sistema, o con uno que el rubro no computa, pide el sistema', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [
        tramo('t9', { diametro: '20', longitudM: 2 }),
        tramo('t8', { sistema: 'gas', diametro: '20', longitudM: 2 }),
      ],
      'nueva',
    );

    expect(items).toEqual([]);
    expect(hallazgos.map((h) => h.clave)).toEqual([
      'sanitaria.sistema_tramos.T9',
      'sanitaria.sistema_tramos.T8',
    ]);
    expect(hallazgos[1]!.descripcion).toContain('gas');
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 't9', campos: ['sistema'] });
  });

  it('un tramo existente no se computa ni pregunta (reforma)', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [tramo('t7', { sistema: 'ac', diametro: '20' }, { estadoReforma: 'existente' })],
      'reforma',
    );

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });
});

describe('plantilla sanitaria: accesorios y artefactos', () => {
  it('3 codos 90° Ø20 y 1 te Ø20 son dos ítems de 3 y 1 unidades', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [
        accesorio('a1', { tipo: 'codo90', sistema: 'ac', diametro: 'Ø20' }),
        accesorio('a2', { tipo: 'codo90', sistema: 'ac', diametro: '20' }),
        accesorio('a3', { tipo: 'codo90', sistema: 'ac', diametro: '20 mm' }),
        accesorio('a4', { tipo: 'te', sistema: 'ac', diametro: '20' }),
      ],
      'nueva',
    );
    const item = porClave(items);

    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual([
      'sanitaria.accesorio.codo90.20',
      'sanitaria.accesorio.te.20',
    ]);
    expect(item['sanitaria.accesorio.codo90.20']!.cantNeta).toBe(3);
    expect(item['sanitaria.accesorio.codo90.20']!.unidad).toBe('u');
    expect(item['sanitaria.accesorio.codo90.20']!.desperdicioPct).toBe(0);
    expect(item['sanitaria.accesorio.codo90.20']!.cantCompra).toBe(3);
    expect(item['sanitaria.accesorio.codo90.20']!.descripcion).toBe('Codo 90° Ø 20');
    expect(item['sanitaria.accesorio.te.20']!.cantNeta).toBe(1);
  });

  it('un accesorio sin tipo o sin diámetro sale como consulta y no se cuenta', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [accesorio('a5', { sistema: 'ac', diametro: '20' }), accesorio('a6', { tipo: 'te', sistema: 'ac' })],
      'nueva',
    );

    expect(items).toEqual([]);
    expect(hallazgos.map((h) => h.clave)).toEqual([
      'sanitaria.tipo_accesorios.A5',
      'sanitaria.diametro_accesorios.A6',
    ]);
    expect(hallazgos[0]!.checklistItem).toBe('sanitaria.tipo_accesorios');
    expect(hallazgos[1]!.checklistItem).toBe('sanitaria.diametro_accesorios');
    expect(hallazgos[1]!.targetRef).toEqual({ entidadId: 'a6', campos: ['diametro'] });
  });

  it('los artefactos se cuentan por unidad, agrupados por su tipo', () => {
    const { items } = plantillaSanitaria.computar(
      [
        artefacto('f1', 'Inodoro 1', { tipo: 'inodoro', ambiente: 'Baño' }),
        artefacto('f2', 'Inodoro 2', { tipo: 'inodoro', ambiente: 'Baño' }),
        artefacto('f3', 'Bacha', { tipo: 'bacha', ambiente: 'Baño' }),
      ],
      'nueva',
    );
    const item = porClave(items);

    expect(items.map((i) => i.claveItem)).toEqual([
      'sanitaria.artefacto.bacha',
      'sanitaria.artefacto.inodoro',
    ]);
    expect(item['sanitaria.artefacto.inodoro']!.cantNeta).toBe(2);
    expect(item['sanitaria.artefacto.inodoro']!.unidad).toBe('u');
    expect(item['sanitaria.artefacto.inodoro']!.cantCompra).toBe(2);
    expect(item['sanitaria.artefacto.bacha']!.cantNeta).toBe(1);
  });
});

describe('plantilla sanitaria: correspondencia artefacto ↔ desagüe (§22)', () => {
  const bacha = artefacto('f1', 'Bacha', { tipo: 'bacha', ambiente: 'Baño' });

  it('una bacha sin tramo cloacal en su ambiente es una inconsistencia NO bloqueante', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [bacha, tramo('t1', { sistema: 'af', diametro: '20', longitudM: 2, ambiente: 'Baño' })],
      'nueva',
    );

    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.tipo).toBe('inconsistencia');
    expect(hallazgos[0]!.rubro).toBe('sanitaria');
    expect(hallazgos[0]!.bloqueante).toBe(false);
    expect(hallazgos[0]!.clave).toBe('sanitaria.correspondencia.bacha');
    expect(hallazgos[0]!.checklistItem).toBe('sanitaria.correspondencia');
    expect(hallazgos[0]!.fuentes).toEqual([
      { laminaId: 'L1', bbox: [0.1, 0.1, 0.2, 0.02], detalle: 'Bacha' },
    ]);
    // El artefacto se computa igual: la inconsistencia avisa, no frena.
    expect(porClave(items)['sanitaria.artefacto.bacha']!.cantNeta).toBe(1);
    // Y jamás se auto-crea el tramo que falta.
    expect(items.map((i) => i.claveItem)).not.toContain('sanitaria.canieria.cloacal.110');
  });

  it('con el tramo cloacal en el mismo ambiente no hay nada que avisar', () => {
    const { hallazgos } = plantillaSanitaria.computar(
      [bacha, tramo('t1', { sistema: 'cloacal', diametro: '110', longitudM: 3, ambiente: 'baño' })],
      'nueva',
    );

    expect(hallazgos).toEqual([]);
  });

  it('un artefacto sin atributo ambiente no se chequea (control honesto)', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [artefacto('f2', 'Bacha', { tipo: 'bacha' })],
      'nueva',
    );

    expect(hallazgos).toEqual([]);
    expect(porClave(items)['sanitaria.artefacto.bacha']!.cantNeta).toBe(1);
  });

  it('el tramo cloacal existente de una reforma alcanza como desagüe', () => {
    const { hallazgos } = plantillaSanitaria.computar(
      [
        bacha,
        tramo(
          't1',
          { sistema: 'cloacal', diametro: '110', longitudM: 3, ambiente: 'Baño' },
          { estadoReforma: 'existente' },
        ),
      ],
      'reforma',
    );

    expect(hallazgos).toEqual([]);
  });
});

describe('plantilla sanitaria: bordes', () => {
  it('sin entidades del rubro no emite ítems en cero', () => {
    const { items, hallazgos } = plantillaSanitaria.computar(
      [entidad('ambiente', 'am1', 'Baño', { superficieM2: 4, perimetroM: 8 })],
      'nueva',
    );

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('ignora las láminas y los datos de obra (no hay alturas en este rubro)', () => {
    const entidades = [tramo('t1', { sistema: 'ac', diametro: '20', longitudM: 2 })];
    const datosObra = new Map<string, DatoObraResuelto>([
      [
        'altura_local.PB',
        { clave: 'altura_local.PB', valor: 2.6, unidad: 'm', origen: 'explicito', fuentes: [], confianza: 1 },
      ],
    ]);

    const solo = plantillaSanitaria.computar(entidades, 'nueva');
    const conTodo = plantillaSanitaria.computar(entidades, 'nueva', [{ id: 'L1', tipo: 'planta' }], datosObra);

    expect(conTodo).toEqual(solo);
  });
});
