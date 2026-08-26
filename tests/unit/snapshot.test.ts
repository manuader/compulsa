import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crearSnapshot, hashSnapshot } from '@/lib/compulsa/snapshot';
import { canonicalizar } from '@/lib/pipeline/json';
import type { CondicionesRfq, ItemComputo, ItemRfq } from '@/types/domain';

const CONDICIONES: CondicionesRfq = {
  ivaDiscriminado: true,
  separarManoObraMateriales: true,
  validezMinimaDias: 7,
  plazoEntregaDias: 15,
  notas: null,
};

function itemComputo(over: Partial<ItemComputo> = {}): ItemComputo {
  return {
    rubro: 'seco',
    descripcion: 'Placa de yeso 12,5 mm',
    unidad: 'm2',
    cantNeta: 26,
    desperdicioPct: 10,
    cantCompra: 31.68,
    presentacion: '11 placas de 2,88 m²',
    origen: 'explicito',
    fuentes: [{ laminaId: 'lam-1', bbox: [0.1, 0.2, 0.3, 0.4] }],
    confianza: 0.9,
    claveItem: 'seco.placas',
    ...over,
  };
}

const VENTANA = itemComputo({
  rubro: 'aberturas',
  claveItem: 'aberturas.V2',
  descripcion: 'Ventana V2 corrediza',
  unidad: 'u',
  cantNeta: 3,
  desperdicioPct: 0,
  cantCompra: 3,
  presentacion: 'a medida',
  entidadRef: 'ent-v2',
});

const PLACAS = itemComputo();

/**
 * Hash pinneado del snapshot de `[VENTANA, PLACAS]` con `CONDICIONES`, calculado
 * aparte con la receta de `contratos-y-formulas.md` (RF-701):
 * `sha256(JSON.stringify(canonicalizar({ items ordenados por claveItem, condiciones })))`.
 * Si este valor cambia, cambió la receta del hash — no el código de un helper.
 */
const HASH_PIN = 'af4f733ae8f26118606ac15646b032baecc91d176114a8634743fc9d91728e90';

const ATRIBUTOS = new Map<string, Record<string, unknown>>([
  ['ent-v2', { tag: 'V2', tipologia: 'ventana', vidrio: 'DVH', material: 'aluminio', anchoM: 1.2 }],
]);

describe('crearSnapshot — qué se le manda al proveedor', () => {
  it('cotiza la cantidad de COMPRA, no la neta', () => {
    const { itemsRfq } = crearSnapshot([PLACAS], CONDICIONES);

    expect(itemsRfq).toHaveLength(1);
    expect(itemsRfq[0]).toEqual({
      claveItem: 'seco.placas',
      descripcion: 'Placa de yeso 12,5 mm',
      unidad: 'm2',
      cantidad: 31.68,
      presentacion: '11 placas de 2,88 m²',
      specsCriticas: {},
    } satisfies ItemRfq);
  });

  it('ordena los ítems por claveItem', () => {
    const { itemsRfq } = crearSnapshot([PLACAS, VENTANA], CONDICIONES, ATRIBUTOS);

    expect(itemsRfq.map((i) => i.claveItem)).toEqual(['aberturas.V2', 'seco.placas']);
  });

  it('rechaza dos ítems con la misma claveItem: el snapshot quedaría ambiguo', () => {
    expect(() => crearSnapshot([PLACAS, itemComputo()], CONDICIONES)).toThrow(/seco\.placas/);
  });
});

describe('specsCriticas por rubro', () => {
  it('aberturas toma vidrio y material de los atributos de la entidad', () => {
    const { itemsRfq } = crearSnapshot([VENTANA], CONDICIONES, ATRIBUTOS);

    expect(itemsRfq[0]!.specsCriticas).toEqual({ vidrio: 'DVH', material: 'aluminio' });
  });

  it('seco y gruesa toman tipo', () => {
    const tabique = itemComputo({ entidadRef: 'ent-t1' });
    const muro = itemComputo({
      rubro: 'gruesa',
      claveItem: 'gruesa.muros',
      descripcion: 'Mampostería de ladrillo hueco 18',
      entidadRef: 'ent-m1',
    });
    const atributos = new Map<string, Record<string, unknown>>([
      ['ent-t1', { tipo: 'durlock', largoM: 5 }],
      ['ent-m1', { tipo: 'mampostería', largoM: 6 }],
    ]);

    const { itemsRfq } = crearSnapshot([tabique, muro], CONDICIONES, atributos);

    expect(itemsRfq[0]!.specsCriticas).toEqual({ tipo: 'mampostería' }); // gruesa.muros ordena primero
    expect(itemsRfq[1]!.specsCriticas).toEqual({ tipo: 'durlock' });
  });

  it('pintura no tiene specs críticas aunque la entidad traiga atributos', () => {
    const pintura = itemComputo({
      rubro: 'pintura',
      claveItem: 'pintura.latex',
      unidad: 'l',
      entidadRef: 'ent-v2',
    });

    const { itemsRfq } = crearSnapshot([pintura], CONDICIONES, ATRIBUTOS);

    expect(itemsRfq[0]!.specsCriticas).toEqual({});
  });

  it('sin mapa de atributos (o sin la entidad) las specs quedan vacías, no inventadas', () => {
    expect(crearSnapshot([VENTANA], CONDICIONES).itemsRfq[0]!.specsCriticas).toEqual({});
    expect(
      crearSnapshot([VENTANA], CONDICIONES, new Map()).itemsRfq[0]!.specsCriticas,
    ).toEqual({});
  });

  it('ignora los atributos nulos o vacíos y pasa los numéricos a texto', () => {
    const atributos = new Map<string, Record<string, unknown>>([
      ['ent-v2', { vidrio: null, material: '  ', tipo: 4 }],
    ]);
    const tabique = itemComputo({ entidadRef: 'ent-v2' });

    expect(crearSnapshot([VENTANA], CONDICIONES, atributos).itemsRfq[0]!.specsCriticas).toEqual({});
    expect(crearSnapshot([tabique], CONDICIONES, atributos).itemsRfq[0]!.specsCriticas).toEqual({
      tipo: '4',
    });
  });

  it('un ítem agregado (sin entidadRef) resuelve sus specs por claveItem', () => {
    const atributos = new Map<string, Record<string, unknown>>([
      ['seco.placas', { tipo: 'durlock' }],
    ]);

    expect(crearSnapshot([PLACAS], CONDICIONES, atributos).itemsRfq[0]!.specsCriticas).toEqual({
      tipo: 'durlock',
    });
  });
});

describe('hash del snapshot (RF-701)', () => {
  it('es el sha256 de la forma canónica pinneada en contratos-y-formulas.md', () => {
    const { hash } = crearSnapshot([PLACAS, VENTANA], CONDICIONES, ATRIBUTOS);

    const esperado = createHash('sha256')
      .update(
        JSON.stringify(
          canonicalizar({
            items: [
              {
                claveItem: 'aberturas.V2',
                descripcion: 'Ventana V2 corrediza',
                unidad: 'u',
                cantidad: 3,
                presentacion: 'a medida',
                specsCriticas: { vidrio: 'DVH', material: 'aluminio' },
              },
              {
                claveItem: 'seco.placas',
                descripcion: 'Placa de yeso 12,5 mm',
                unidad: 'm2',
                cantidad: 31.68,
                presentacion: '11 placas de 2,88 m²',
                specsCriticas: {},
              },
            ],
            condiciones: CONDICIONES,
          }),
        ),
      )
      .digest('hex');

    expect(hash).toBe(esperado);
    expect(hash).toBe(HASH_PIN);
  });

  it('no depende del orden en que vengan los ítems', () => {
    const a = crearSnapshot([PLACAS, VENTANA], CONDICIONES, ATRIBUTOS).hash;
    const b = crearSnapshot([VENTANA, PLACAS], CONDICIONES, ATRIBUTOS).hash;

    expect(a).toBe(b);
    expect(a).toBe(HASH_PIN);
  });

  it('no depende del orden de las claves de condiciones (canonicalizar)', () => {
    const alReves: CondicionesRfq = {
      notas: null,
      plazoEntregaDias: 15,
      validezMinimaDias: 7,
      separarManoObraMateriales: true,
      ivaDiscriminado: true,
    };

    expect(crearSnapshot([PLACAS, VENTANA], alReves, ATRIBUTOS).hash).toBe(HASH_PIN);
  });

  it('cambiar una cantidad cambia el hash: toda edición es una versión nueva', () => {
    const editado = crearSnapshot(
      [itemComputo({ cantCompra: 34.56 }), VENTANA],
      CONDICIONES,
      ATRIBUTOS,
    ).hash;

    expect(editado).not.toBe(HASH_PIN);
  });

  it('cambiar una condición cambia el hash', () => {
    const otras: CondicionesRfq = { ...CONDICIONES, validezMinimaDias: 15 };

    expect(crearSnapshot([PLACAS, VENTANA], otras, ATRIBUTOS).hash).not.toBe(HASH_PIN);
  });

  it('cambiar una specCrítica cambia el hash', () => {
    const float = new Map<string, Record<string, unknown>>([
      ['ent-v2', { vidrio: 'float', material: 'aluminio' }],
    ]);

    expect(crearSnapshot([PLACAS, VENTANA], CONDICIONES, float).hash).not.toBe(HASH_PIN);
  });

  it('hashSnapshot recalcula el mismo hash sobre los ítems ya guardados (RF-701)', () => {
    const { itemsRfq, hash } = crearSnapshot([PLACAS, VENTANA], CONDICIONES, ATRIBUTOS);

    expect(hashSnapshot(itemsRfq, CONDICIONES)).toBe(hash);
    // y sigue dando lo mismo aunque los ítems vuelvan de la base desordenados
    expect(hashSnapshot([...itemsRfq].reverse(), CONDICIONES)).toBe(hash);
  });
});
