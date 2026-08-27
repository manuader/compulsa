import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaGruesa } from '@/lib/rubros/gruesa';
import type { ItemComputo } from '@/types/domain';

function muro(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'muro',
    nombre: 'M1',
    bbox: [0.1, 0.1, 0.5, 0.03],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: { largoM: 6, alturaM: 2.6, espesorM: 0.12, tipo: 'mamposteria' },
    ...over,
  };
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

describe('plantilla gruesa: muro de 6 × 2,60 m (15,6 m²)', () => {
  const { items, hallazgos } = plantillaGruesa.computar([muro({ id: 'm1' })], 'nueva');
  const item = porClave(items);

  it('emite ladrillos, cemento, cal y arena, sin hallazgos', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual([
      'gruesa.ladrillos',
      'gruesa.cemento',
      'gruesa.cal',
      'gruesa.arena',
    ]);
  });

  it('ladrillos: 15,6 × 16,5 = 257,4 + 5% = 270,27 → 2 pallets de 198 u (396 u)', () => {
    const ladrillos = item['gruesa.ladrillos']!;
    expect(ladrillos.rubro).toBe('gruesa');
    expect(ladrillos.unidad).toBe('u');
    expect(ladrillos.cantNeta).toBe(257.4);
    expect(ladrillos.desperdicioPct).toBe(5);
    expect(ladrillos.cantCompra).toBe(396);
    expect(ladrillos.presentacion).toBe('2 pallets de 198 u');
    expect(ladrillos.confianza).toBe(0.9);
    expect(ladrillos.fuentes).toEqual([{ laminaId: 'L1', bbox: [0.1, 0.1, 0.5, 0.03], detalle: 'M1' }]);
  });

  it('cemento: 8 kg/m² = 124,8 kg → 3 bolsas de 50 kg', () => {
    const cemento = item['gruesa.cemento']!;
    expect(cemento.unidad).toBe('kg');
    expect(cemento.cantNeta).toBe(124.8);
    expect(cemento.cantCompra).toBe(150);
    expect(cemento.presentacion).toBe('3 bolsas de 50 kg');
  });

  it('cal: 12 kg/m² = 187,2 kg → 8 bolsas de 25 kg', () => {
    const cal = item['gruesa.cal']!;
    expect(cal.unidad).toBe('kg');
    expect(cal.cantNeta).toBe(187.2);
    expect(cal.cantCompra).toBe(200);
    expect(cal.presentacion).toBe('8 bolsas de 25 kg');
  });

  it('arena: 0,04 m³/m² = 0,624 m³ → 1 m³ (múltiplos de 0,5)', () => {
    const arena = item['gruesa.arena']!;
    expect(arena.unidad).toBe('m3');
    expect(arena.cantNeta).toBe(0.62); // los netos se emiten con 2 decimales
    expect(arena.cantCompra).toBe(1);
    expect(arena.presentacion).toBe('1 m³ a granel (múltiplos de 0,5 m³)');
  });
});

describe('plantilla gruesa: reforma y huecos', () => {
  it('un muro a demoler computa demolición: 3 × 2,60 = 7,8 m² sin desperdicio', () => {
    const aDemoler = muro({
      id: 'm2',
      nombre: 'M2',
      estadoReforma: 'demoler',
      atributos: { largoM: 3, alturaM: 2.6, tipo: 'mamposteria' },
    });
    const { items } = plantillaGruesa.computar([aDemoler], 'reforma');

    expect(items.map((i) => i.claveItem)).toEqual(['gruesa.demolicion']);
    const demolicion = items[0]!;
    expect(demolicion.unidad).toBe('m2');
    expect(demolicion.cantNeta).toBe(7.8);
    expect(demolicion.desperdicioPct).toBe(0);
    expect(demolicion.cantCompra).toBe(7.8);
    expect(demolicion.presentacion).toBe('global');
  });

  it('lo existente no se computa', () => {
    const existente = muro({ id: 'm3', estadoReforma: 'existente' });
    const { items, hallazgos } = plantillaGruesa.computar([existente], 'reforma');
    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('convive lo nuevo con lo que se demuele', () => {
    const aDemoler = muro({
      id: 'm2',
      nombre: 'M2',
      bbox: [0.1, 0.5, 0.25, 0.03],
      estadoReforma: 'demoler',
      atributos: { largoM: 3, alturaM: 2.6, tipo: 'mamposteria' },
    });
    const { items } = plantillaGruesa.computar([muro({ id: 'm1' }), aDemoler], 'reforma');
    const item = porClave(items);

    expect(item['gruesa.ladrillos']!.cantNeta).toBe(257.4); // el muro a demoler no aporta ladrillos
    expect(item['gruesa.demolicion']!.cantNeta).toBe(7.8);
  });

  it('sin alturaM el muro no se computa y sale hallazgo bloqueante', () => {
    const sinAltura = muro({ id: 'm4', nombre: 'M4', atributos: { largoM: 5, tipo: 'mamposteria' } });
    const { items, hallazgos } = plantillaGruesa.computar([sinAltura], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('gruesa.altura_muros.M4');
    expect(hallazgos[0]!.tipo).toBe('faltante');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.targetRef).toEqual({ entidadId: 'm4', campos: ['alturaM'] });
  });

  it('un muro que no es de mampostería no se auto-computa (RF-506)', () => {
    const hormigon = muro({
      id: 'm5',
      nombre: 'M5',
      atributos: { largoM: 6, alturaM: 2.6, tipo: 'hormigon armado' },
    });
    const { items, hallazgos } = plantillaGruesa.computar([hormigon], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('gruesa.sistema_muro.M5');
    expect(hallazgos[0]!.bloqueante).toBe(true);
    expect(hallazgos[0]!.descripcion).toContain('profesional competente');
  });

  it('suma varios muros nuevos en los mismos ítems', () => {
    const otro = muro({
      id: 'm6',
      nombre: 'M6',
      bbox: [0.6, 0.1, 0.3, 0.03],
      confianza: 0.71,
      atributos: { largoM: 4, alturaM: 2.6, tipo: 'mamposteria' },
    });
    const { items } = plantillaGruesa.computar([muro({ id: 'm1' }), otro], 'nueva');
    const item = porClave(items);

    // 15,6 + 10,4 = 26 m²
    expect(item['gruesa.ladrillos']!.cantNeta).toBe(429); // 26 × 16,5
    expect(item['gruesa.cemento']!.cantNeta).toBe(208);
    expect(item['gruesa.cal']!.cantNeta).toBe(312);
    expect(item['gruesa.arena']!.cantNeta).toBe(1.04);
    expect(item['gruesa.ladrillos']!.confianza).toBe(0.71);
  });
});
