import { describe, expect, it } from 'vitest';

import { computarObra, type EntidadPersistida } from '@/lib/computo/engine';
import { plantillaAberturas } from '@/lib/rubros/aberturas';

function abertura(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'abertura',
    nombre: 'V2',
    bbox: [0.1, 0.1, 0.05, 0.05],
    confianza: 0.92,
    estadoReforma: 'na',
    atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.2, altoM: 1.5 },
    ...over,
  };
}

const v2a = abertura({ id: 'e1' });
const v2b = abertura({ id: 'e2', bbox: [0.3, 0.1, 0.05, 0.05], confianza: 0.88 });
const p1SinAlto = abertura({
  id: 'e3',
  nombre: 'P1',
  bbox: [0.5, 0.1, 0.05, 0.1],
  atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
});

describe('plantilla aberturas', () => {
  it('agrupa por tag y computa una unidad por abertura', () => {
    const { items, hallazgos } = plantillaAberturas.computar([v2a, v2b], 'nueva');

    expect(hallazgos).toEqual([]);
    expect(items).toHaveLength(1);
    const [v2] = items;
    expect(v2!.claveItem).toBe('aberturas.V2');
    expect(v2!.rubro).toBe('aberturas');
    expect(v2!.descripcion).toBe('Ventana V2 (1,20 × 1,50 m)');
    expect(v2!.unidad).toBe('u');
    expect(v2!.cantNeta).toBe(2);
    expect(v2!.desperdicioPct).toBe(0);
    expect(v2!.cantCompra).toBe(2);
    expect(v2!.presentacion).toBe('a medida');
    expect(v2!.origen).toBe('explicito');
    expect(v2!.confianza).toBe(0.88); // la peor de las dos entidades
    expect(v2!.fuentes).toHaveLength(2);
  });

  it('sin medidas de vano no computa la abertura: hallazgo bloqueante con targetRef', () => {
    const { items, hallazgos } = plantillaAberturas.computar([v2a, v2b, p1SinAlto], 'nueva');

    expect(items.map((i) => i.claveItem)).toEqual(['aberturas.V2']);
    expect(items[0]!.cantNeta).toBe(2);

    expect(hallazgos).toHaveLength(1);
    const [falta] = hallazgos;
    expect(falta!.clave).toBe('aberturas.medidas_vano.P1');
    expect(falta!.tipo).toBe('faltante');
    expect(falta!.rubro).toBe('aberturas');
    expect(falta!.bloqueante).toBe(true);
    expect(falta!.targetRef).toEqual({ entidadId: 'e3', campo: 'altoM' });
    expect(falta!.fuentes).toEqual([
      { laminaId: 'L1', bbox: [0.5, 0.1, 0.05, 0.1], detalle: 'P1' },
    ]);
    expect(falta!.descripcion).toContain('alto');
  });

  it('emite un solo hallazgo por tag aunque falten las dos medidas', () => {
    const sinNada = abertura({ id: 'e9', nombre: 'V9', atributos: { tag: 'V9', tipologia: 'ventana' } });
    const { items, hallazgos } = plantillaAberturas.computar([sinNada], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('aberturas.medidas_vano.V9');
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 'e9', campo: 'anchoM' });
  });
});

describe('plantilla aberturas: reglas de reforma', () => {
  it('lo existente no se computa', () => {
    const existente = abertura({ id: 'e4', estadoReforma: 'existente' });
    const { items, hallazgos } = plantillaAberturas.computar([existente], 'reforma');

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('lo que se demuele computa solo su retiro', () => {
    const aDemoler = abertura({
      id: 'e5',
      nombre: 'V1',
      estadoReforma: 'demoler',
      atributos: { tag: 'V1', tipologia: 'ventana', anchoM: 1, altoM: 1 },
    });
    const { items } = plantillaAberturas.computar([aDemoler], 'reforma');

    expect(items).toHaveLength(1);
    expect(items[0]!.claveItem).toBe('aberturas.retiro.V1');
    expect(items[0]!.descripcion).toBe('Retiro de V1');
    expect(items[0]!.unidad).toBe('u');
    expect(items[0]!.cantNeta).toBe(1);
    expect(items[0]!.cantCompra).toBe(1);
    expect(items[0]!.presentacion).toBe('global');
    expect(items[0]!.entidadRef).toBe('e5');
  });

  it('el retiro no necesita medidas de vano', () => {
    const aDemoler = abertura({
      id: 'e6',
      nombre: 'P9',
      estadoReforma: 'demoler',
      atributos: { tag: 'P9', tipologia: 'puerta' },
    });
    const { items, hallazgos } = plantillaAberturas.computar([aDemoler], 'reforma');

    expect(items.map((i) => i.claveItem)).toEqual(['aberturas.retiro.P9']);
    expect(hallazgos).toEqual([]);
  });
});

describe('computarObra: regla de oro de confianza (§11.b)', () => {
  it('un ítem con confianza menor a 0,7 no se emite: sale como consulta bloqueante', () => {
    const dudosa = abertura({ id: 'e7', bbox: [0.7, 0.1, 0.05, 0.05], confianza: 0.6 });
    const { items, hallazgos } = computarObra([v2a, dudosa], 'nueva', ['aberturas']);

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    const [baja] = hallazgos;
    expect(baja!.clave).toBe('aberturas.baja_confianza.V2');
    expect(baja!.tipo).toBe('faltante');
    expect(baja!.rubro).toBe('aberturas');
    expect(baja!.bloqueante).toBe(true);
    expect(baja!.descripcion).toContain('60%');
    expect(baja!.fuentes).toHaveLength(2); // el hallazgo conserva la provenance del ítem que no se emitió
  });

  it('el umbral es 0,7 inclusive', () => {
    const justa = abertura({ id: 'e8', confianza: 0.7 });
    const { items, hallazgos } = computarObra([justa], 'nueva', ['aberturas']);

    expect(items.map((i) => i.claveItem)).toEqual(['aberturas.V2']);
    expect(hallazgos).toEqual([]);
  });

  it('la baja confianza de un ítem no se lleva puestos a los demás', () => {
    const dudosa = abertura({
      id: 'e9',
      nombre: 'P2',
      bbox: [0.7, 0.3, 0.05, 0.1],
      confianza: 0.5,
      atributos: { tag: 'P2', tipologia: 'puerta', anchoM: 0.8, altoM: 2 },
    });
    const { items, hallazgos } = computarObra([v2a, v2b, dudosa], 'nueva', ['aberturas']);

    expect(items.map((i) => i.claveItem)).toEqual(['aberturas.V2']);
    expect(hallazgos.map((h) => h.clave)).toEqual(['aberturas.baja_confianza.P2']);
  });
});
