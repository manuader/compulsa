import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaDemolicion } from '@/lib/rubros/demolicion';
import type { DatoObraResuelto, Fuente, ItemComputo } from '@/types/domain';

function entidad(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'muro',
    nombre: 'M1',
    bbox: [0.06, 0.18, 0.02, 0.4],
    confianza: 0.9,
    estadoReforma: 'demoler',
    atributos: { tipo: 'mamposteria', largoM: 4, alturaM: 2.6 },
    ...over,
  };
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

const CORTE: Fuente = { laminaId: 'L9', bbox: [0.2, 0.3, 0.5, 0.4], detalle: 'Corte A-A' };

function alturaDeLocal(valor: number): Map<string, DatoObraResuelto> {
  const clave = 'altura_local.general';
  return new Map([
    [clave, { clave, valor, unidad: 'm', origen: 'deducido', fuentes: [CORTE], confianza: 0.9 }],
  ]);
}

describe('plantilla demolición: muro de 4 × 2,60 m a demoler', () => {
  const { items, hallazgos } = plantillaDemolicion.computar([entidad({ id: 'm1' })], 'reforma');

  it('computa 10,4 m² sin desperdicio, contratados global', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual(['demolicion.muros']);

    const muros = items[0]!;
    expect(muros.rubro).toBe('demolicion');
    expect(muros.unidad).toBe('m2');
    expect(muros.cantNeta).toBe(10.4);
    expect(muros.desperdicioPct).toBe(0);
    expect(muros.cantCompra).toBe(10.4);
    expect(muros.presentacion).toBe('global');
    expect(muros.descripcion).toBe('Demolición de muros y tabiques');
    expect(muros.origen).toBe('explicito');
    expect(muros.fuentes).toEqual([{ laminaId: 'L1', bbox: [0.06, 0.18, 0.02, 0.4], detalle: 'M1' }]);
  });
});

describe('plantilla demolición: qué entra y qué no', () => {
  it('los tabiques a demoler suman en el mismo ítem que los muros', () => {
    const tabique = entidad({
      id: 't1',
      tipo: 'tabique',
      nombre: 'T9',
      bbox: [0.12, 0.62, 0.28, 0.02],
      atributos: { tipo: 'durlock', largoM: 3, alturaM: 2.5 },
    });
    const { items } = plantillaDemolicion.computar([entidad({ id: 'm1' }), tabique], 'reforma');

    expect(porClave(items)['demolicion.muros']!.cantNeta).toBe(17.9); // 10,4 + 7,5
    expect(porClave(items)['demolicion.muros']!.fuentes).toHaveLength(2);
  });

  it('las carpinterías a demoler se cuentan por unidad, sin medidas', () => {
    const v5 = entidad({
      id: 'v5',
      tipo: 'abertura',
      nombre: 'V5',
      bbox: [0.18, 0.16, 0.1, 0.02],
      atributos: { tag: 'V5', tipologia: 'ventana' },
    });
    const p3 = entidad({
      id: 'p3',
      tipo: 'abertura',
      nombre: 'P3',
      bbox: [0.3, 0.62, 0.06, 0.02],
      atributos: { tag: 'P3', tipologia: 'puerta' },
    });
    const { items, hallazgos } = plantillaDemolicion.computar([v5, p3], 'reforma');

    expect(hallazgos).toEqual([]);
    const carpinterias = porClave(items)['demolicion.carpinterias']!;
    expect(carpinterias.unidad).toBe('u');
    expect(carpinterias.cantNeta).toBe(2);
    expect(carpinterias.cantCompra).toBe(2);
    expect(carpinterias.presentacion).toBe('global');
  });

  it('los solados a levantar salen de la superficie del ambiente', () => {
    const cocina = entidad({
      id: 'a1',
      tipo: 'ambiente',
      nombre: 'Cocina',
      atributos: { superficieM2: 9, perimetroM: 12 },
    });
    const { items } = plantillaDemolicion.computar([cocina], 'reforma');
    const solados = porClave(items)['demolicion.solados']!;

    expect(solados.unidad).toBe('m2');
    expect(solados.cantNeta).toBe(9);
    expect(solados.descripcion).toBe('Levantamiento de solados');
  });

  it('lo nuevo y lo existente no se demuelen', () => {
    const nuevo = entidad({ id: 'm2', estadoReforma: 'nueva' });
    const existente = entidad({ id: 'm3', estadoReforma: 'existente' });
    const naDeObraNueva = entidad({ id: 'm4', estadoReforma: 'na' });
    const { items, hallazgos } = plantillaDemolicion.computar(
      [nuevo, existente, naDeObraNueva],
      'reforma',
    );

    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('una obra sin nada a demoler no emite ítems en cero', () => {
    expect(plantillaDemolicion.computar([], 'nueva')).toEqual({ items: [], hallazgos: [] });
  });
});

describe('plantilla demolición: huecos', () => {
  it('sin largo no computa el muro y sale consulta bloqueante', () => {
    const sinLargo = entidad({ id: 'm5', nombre: 'M5', atributos: { alturaM: 2.6 } });
    const { items, hallazgos } = plantillaDemolicion.computar([sinLargo], 'reforma');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('demolicion.largo.M5');
    expect(hallazgos[0]!.checklistItem).toBe('demolicion.largo');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 'm5', campos: ['largoM'] });
  });

  it('sin superficie no computa el solado y sale consulta bloqueante', () => {
    const sinSuperficie = entidad({
      id: 'a2',
      tipo: 'ambiente',
      nombre: 'Baño',
      atributos: { perimetroM: 8 },
    });
    const { hallazgos } = plantillaDemolicion.computar([sinSuperficie], 'reforma');

    expect(hallazgos.map((h) => h.clave)).toEqual(['demolicion.superficie.Baño']);
    expect(hallazgos[0]!.checklistItem).toBe('demolicion.superficie');
  });

  it('sin altura ni dato de obra: UNA consulta para todo lo que hay que demoler', () => {
    const m1 = entidad({ id: 'm6', nombre: 'M6', atributos: { largoM: 4 } });
    const m2 = entidad({ id: 'm7', nombre: 'M7', atributos: { largoM: 3 } });
    const { items, hallazgos } = plantillaDemolicion.computar([m1, m2], 'reforma');

    expect(items).toEqual([]);
    expect(hallazgos.map((h) => h.clave)).toEqual(['dato_obra.altura_local.general']);
    expect(hallazgos[0]!.targetDato).toEqual({
      clave: 'altura_local.general',
      unidad: 'm',
      entidades: ['m6', 'm7'],
    });
    expect(hallazgos[0]!.descripcion).toContain('M6 y M7');
  });

  it('la altura del local computa la demolición y su lámina queda citada', () => {
    const sinAltura = entidad({ id: 'm8', nombre: 'M8', atributos: { largoM: 4 } });
    const { items, hallazgos, origenPorEntidad } = plantillaDemolicion.computar(
      [sinAltura],
      'reforma',
      undefined,
      alturaDeLocal(2.6),
    );

    expect(hallazgos).toEqual([]);
    const muros = porClave(items)['demolicion.muros']!;
    expect(muros.cantNeta).toBe(10.4);
    expect(muros.fuentes).toHaveLength(2);
    expect(muros.fuentes.at(-1)).toEqual(CORTE);
    expect(origenPorEntidad!.get('m8')!.get('alturaM')).toBe('deducido');
  });
});
