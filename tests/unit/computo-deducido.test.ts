/**
 * `computarObra(..., camposDeducidos)`: qué ítems salen con `origen: 'deducido'`.
 *
 * La regla del PRD (§11 · P4) es que validar una deducción no la disimula: el
 * ítem que se apoya en ese dato queda marcado como deducido para siempre, en la
 * planilla y en el XLSX. Estos tests pinean las dos mitades de esa regla —lo que
 * se marca y lo que NO se marca— porque un motor que marca de más miente igual
 * que uno que marca de menos.
 *
 * Dominio puro: sin base, sin fixtures.
 */
import { describe, expect, it } from 'vitest';

import { computarObra, type CamposDeducidos, type EntidadPersistida } from '@/lib/computo/engine';
import type { ItemComputo } from '@/types/domain';

const LAMINA_PLANTA = 'lam-planta';

let contador = 0;

function entidad(parcial: Partial<EntidadPersistida> & Pick<EntidadPersistida, 'tipo' | 'nombre'>): EntidadPersistida {
  contador += 1;
  return {
    id: `ent-${contador}`,
    laminaId: LAMINA_PLANTA,
    bbox: [0.1, 0.1, 0.2, 0.2],
    confianza: 0.9,
    estadoReforma: 'na',
    atributos: {},
    ...parcial,
  };
}

function porClave(items: readonly ItemComputo[], clave: string): ItemComputo | undefined {
  return items.find((item) => item.claveItem === clave);
}

function deducidos(entradas: readonly (readonly [string, readonly string[]])[]): CamposDeducidos {
  return new Map(entradas.map(([id, campos]) => [id, new Set(campos)]));
}

describe('camposDeducidos', () => {
  it('sin el parámetro el motor no cambia ni un origen (default vacío)', () => {
    const tabique = entidad({
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { tipo: 'durlock', largoM: 5, alturaM: 2.6, caras: 2 },
    });

    const { items } = computarObra([tabique], 'nueva');
    const placas = porClave(items, 'seco.placas');
    expect(placas?.origen).toBe('explicito');
    expect(placas?.cantNeta).toBe(26);
    expect(placas?.cantCompra).toBe(31.68);
  });

  it('la altura deducida de un tabique deja seco.placas en origen deducido', () => {
    const tabique = entidad({
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { tipo: 'durlock', largoM: 5, alturaM: 2.6, caras: 2 },
    });

    const { items } = computarObra(
      [tabique],
      'nueva',
      undefined,
      deducidos([[tabique.id, ['alturaM']]]),
    );

    // Los números son los mismos: lo único que cambia es de dónde salió el dato.
    const placas = porClave(items, 'seco.placas');
    expect(placas?.origen).toBe('deducido');
    expect(placas?.cantNeta).toBe(26);
    expect(placas?.cantCompra).toBe(31.68);

    // Todos los ítems del rubro se apoyan en los mismos m²: todos deducidos.
    for (const clave of ['seco.soleras', 'seco.montantes', 'seco.tornillos', 'seco.masilla', 'seco.cinta']) {
      expect(porClave(items, clave)?.origen).toBe('deducido');
    }
  });

  it('un campo deducido que el ítem no usa no lo ensucia', () => {
    // El cielorraso solo mira la superficie; las paredes miran la altura.
    const estar = entidad({
      tipo: 'ambiente',
      nombre: 'Estar',
      atributos: { superficieM2: 20, perimetroM: 18, vanosM2: 4, alturaM: 2.6 },
    });

    const { items } = computarObra(
      [estar],
      'nueva',
      undefined,
      deducidos([[estar.id, ['alturaM']]]),
    );

    const paredes = porClave(items, 'pintura.latex_paredes');
    expect(paredes?.origen).toBe('deducido');
    expect(paredes?.cantNeta).toBe(8.56); // (18 × 2,60 − 4) × 2 manos / 10

    const cielorrasos = porClave(items, 'pintura.latex_cielorrasos');
    expect(cielorrasos?.origen).toBe('explicito');
    expect(cielorrasos?.cantNeta).toBe(4); // 20 m² × 2 manos / 10
  });

  it('una deducción que repite el default de la plantilla no marca nada', () => {
    // `caras` sin declarar computa 2 igual: deducir un 2 no cambia un solo número.
    const tabique = entidad({
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { tipo: 'durlock', largoM: 5, alturaM: 2.6, caras: 2 },
    });

    const { items } = computarObra(
      [tabique],
      'nueva',
      undefined,
      deducidos([[tabique.id, ['caras']]]),
    );
    expect(porClave(items, 'seco.placas')?.origen).toBe('explicito');
  });

  it('la deducción de una entidad no contagia a los ítems de otra', () => {
    const v1 = entidad({
      tipo: 'abertura',
      nombre: 'V1',
      atributos: { tag: 'V1', tipologia: 'ventana', anchoM: 1.5, altoM: 1.1 },
    });
    const v2 = entidad({
      tipo: 'abertura',
      nombre: 'V2',
      atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.2, altoM: 1.1 },
    });

    const { items } = computarObra([v1, v2], 'nueva', undefined, deducidos([[v2.id, ['anchoM']]]));

    expect(porClave(items, 'aberturas.V1')?.origen).toBe('explicito');
    expect(porClave(items, 'aberturas.V2')?.origen).toBe('deducido');
    expect(porClave(items, 'aberturas.V2')?.descripcion).toBe('Ventana V2 (1,20 × 1,10 m)');
  });

  it('un ítem supuesto no se degrada a deducido: el supuesto es la advertencia más fuerte', () => {
    // Sin `vanosM2` las paredes se computan de más y el ítem nace `supuesto`.
    const estar = entidad({
      tipo: 'ambiente',
      nombre: 'Estar',
      atributos: { superficieM2: 20, perimetroM: 18, alturaM: 2.6 },
    });

    const { items } = computarObra(
      [estar],
      'nueva',
      undefined,
      deducidos([[estar.id, ['alturaM']]]),
    );
    expect(porClave(items, 'pintura.latex_paredes')?.origen).toBe('supuesto');
  });

  it('los hallazgos son los de la obra real, no los de la pasada de control', () => {
    // Sin la altura deducida el tabique generaría `seco.altura_tabiques.T1`;
    // con ella, ese hallazgo NO existe (la pasada de control no se publica).
    const tabique = entidad({
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { tipo: 'durlock', largoM: 5, alturaM: 2.6 },
    });

    const { hallazgos } = computarObra(
      [tabique],
      'nueva',
      undefined,
      deducidos([[tabique.id, ['alturaM']]]),
    );
    expect(hallazgos.map((h) => h.clave)).not.toContain('seco.altura_tabiques.T1');
  });
});
