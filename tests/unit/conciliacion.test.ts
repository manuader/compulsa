import { describe, expect, it } from 'vitest';
import {
  TOLERANCIA_CANTIDAD,
  UMBRAL_SOLAPAMIENTO,
  conciliar,
  normalizarUnidad,
  precioUnitarioDe,
  solapamientoTokens,
  tokens,
} from '@/lib/compulsa/conciliacion';
import type { ItemRfq, LineaPresupuesto, Unidad } from '@/types/domain';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function item(
  claveItem: string,
  descripcion: string,
  cantidad: number,
  specsCriticas: Record<string, string> = {},
  unidad: Unidad = 'u',
): ItemRfq {
  return { claveItem, descripcion, unidad, cantidad, presentacion: 'a medida', specsCriticas };
}

function linea(
  descripcion: string,
  cantidad: number | null,
  over: Partial<LineaPresupuesto> = {},
): LineaPresupuesto {
  return {
    descripcion,
    unidad: 'u',
    cantidad,
    precioUnitario: 100000,
    precioTotal: cantidad === null ? null : 100000 * cantidad,
    claveItemSugerida: null,
    notas: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Normalización y solapamiento de tokens
// ---------------------------------------------------------------------------

describe('normalización de descripciones', () => {
  it('baja a minúsculas, saca tildes y parte por lo no alfanumérico', () => {
    expect([...tokens('Mampostería de ladrillo hueco 18×18')]).toEqual([
      'mamposteria',
      'ladrillo',
      'hueco',
      '18',
    ]);
  });

  it('saca las stopwords de/la/el/con/para/x', () => {
    expect([...tokens('Puerta de madera con marco para el baño x 2')]).toEqual([
      'puerta',
      'madera',
      'marco',
      'bano',
      '2',
    ]);
  });

  it('la tilde no cambia el solapamiento', () => {
    expect(solapamientoTokens('Mampostería de ladrillo hueco 18', 'Mamposteria ladrillo hueco 18')).toBe(1);
  });

  it('"Durlock" a secas no se parece a "Placa de yeso": no hay tokens en común', () => {
    expect(solapamientoTokens('Placa de yeso 12,5 mm', 'Durlock')).toBe(0);
  });

  it('"Durlock 12,5 mm" da justo el umbral: comparte los tokens que importan', () => {
    // ∩ = {12, 5, mm} = 3 · ∪ = {placa, yeso, 12, 5, mm, durlock} = 6 ⇒ 0,5
    expect(solapamientoTokens('Placa de yeso 12,5 mm', 'Durlock 12,5 mm')).toBe(0.5);
    expect(UMBRAL_SOLAPAMIENTO).toBe(0.5);
  });

  it('unidades: sinónimos del gremio a la unidad del dominio', () => {
    expect(normalizarUnidad('M2')).toBe('m2');
    expect(normalizarUnidad('m²')).toBe('m2');
    expect(normalizarUnidad('mts2')).toBe('m2');
    expect(normalizarUnidad('un.')).toBe('u');
    expect(normalizarUnidad('unidades')).toBe('u');
    expect(normalizarUnidad('ml')).toBe('ml');
    expect(normalizarUnidad('metros')).toBe('m');
    expect(normalizarUnidad('lts')).toBe('l');
    expect(normalizarUnidad(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// El pin de aceptación RF-902
// ---------------------------------------------------------------------------

const ITEMS_RFQ: ItemRfq[] = [
  item('aberturas.V1', 'Ventana V1 corrediza 1,50 × 1,10', 4, { vidrio: 'DVH', material: 'aluminio' }),
  item('aberturas.V2', 'Ventana V2 corrediza 1,20 × 1,50', 3, { vidrio: 'DVH', material: 'aluminio' }),
  item('aberturas.V3', 'Ventana V3 paño fijo 0,60 × 0,60', 2, { vidrio: 'DVH', material: 'aluminio' }),
  item('aberturas.V4', 'Ventana V4 banderola 0,80 × 0,40', 3, { vidrio: 'DVH', material: 'aluminio' }),
  item('aberturas.V5', 'Ventana V5 corrediza 2,00 × 1,50', 2, { vidrio: 'DVH', material: 'aluminio' }),
  item('aberturas.PV1', 'Puerta ventana PV1 1,80 × 2,05', 2, { vidrio: 'DVH', material: 'aluminio' }),
  item('aberturas.P1', 'Puerta placa P1 0,80 × 2,05', 5, { material: 'madera' }),
  item('aberturas.P2', 'Puerta exterior P2 0,90 × 2,05', 1, { material: 'chapa' }),
  item('aberturas.P3', 'Puerta placa P3 0,70 × 2,05', 2, { material: 'madera' }),
  item('aberturas.M1', 'Mosquitero M1 corredizo 1,50 × 1,10', 4),
];

/** Lo que mandó el proveedor: 8 líneas fieles, 1 con el vidrio cambiado, y P3 sin cotizar. */
const PRESUPUESTO: LineaPresupuesto[] = [
  linea('Ventana corrediza V1 1.50 x 1.10 aluminio DVH', 4),
  linea('Ventana corrediza V2 1.20 x 1.50 aluminio DVH', 3),
  linea('Ventana paño fijo V3 0.60 x 0.60 aluminio DVH', 2),
  linea('Ventana banderola V4 0.80 x 0.40 aluminio DVH', 3),
  linea('Ventana corrediza V5 2.00 x 1.50 aluminio vidrio float', 2),
  linea('Puerta ventana PV1 1.80 x 2.05 aluminio DVH', 2),
  linea('Puerta placa P1 0.80 x 2.05 madera', 5),
  linea('Puerta exterior P2 0.90 x 2.05 chapa', 1),
  linea('Mosquitero corredizo M1 1.50 x 1.10', 4, { unidad: 'un.' }),
];

describe('conciliar — pin de aceptación RF-902', () => {
  const resultado = conciliar(ITEMS_RFQ, PRESUPUESTO);

  it('clasifica los 10 ítems del RFQ, en el orden del pedido', () => {
    expect(resultado.items).toHaveLength(10);
    expect(resultado.items.map((i) => [i.claveItem, i.match])).toEqual([
      ['aberturas.V1', 'exacto'],
      ['aberturas.V2', 'exacto'],
      ['aberturas.V3', 'exacto'],
      ['aberturas.V4', 'exacto'],
      ['aberturas.V5', 'sustituto'],
      ['aberturas.PV1', 'exacto'],
      ['aberturas.P1', 'exacto'],
      ['aberturas.P2', 'exacto'],
      ['aberturas.P3', 'no_cotizado'],
      ['aberturas.M1', 'exacto'],
    ]);
  });

  it('el score de fidelidad es 0,80: 8 exactas sobre 10 pedidas', () => {
    expect(resultado.score).toBe(0.8);
  });

  it('genera UNA repregunta, la del ítem que no cotizaron', () => {
    expect(resultado.repreguntas).toHaveLength(1);
    expect(resultado.repreguntas[0]!.clave).toBe('repregunta.no_cotizada.aberturas.P3');
    expect(resultado.repreguntas[0]!.texto).toContain('Puerta placa P3');
  });

  it('genera UNA alerta roja, la de la sustitución', () => {
    expect(resultado.alertas).toHaveLength(1);
    expect(resultado.alertas[0]!.nivel).toBe('rojo');
    expect(resultado.alertas[0]!.clave).toBe('sustitucion.aberturas.V5');
    expect(resultado.alertas[0]!.mensaje).toContain('DVH');
    expect(resultado.alertas[0]!.mensaje).toContain('float');
  });

  it('la sustitución dice qué spec se cambió y por qué valor', () => {
    expect(resultado.sustituciones).toHaveLength(1);
    expect(resultado.sustituciones[0]!.specContradicha).toEqual({
      spec: 'vidrio',
      pedido: 'DVH',
      cotizado: 'float',
    });
  });

  it('cada ítem conciliado cita la línea del presupuesto que lo respalda', () => {
    const v1 = resultado.items[0]!;
    expect(v1.lineaIndice).toBe(1);
    expect(v1.linea?.descripcion).toBe('Ventana corrediza V1 1.50 x 1.10 aluminio DVH');

    const p3 = resultado.items[8]!;
    expect(p3.linea).toBeNull();
    expect(p3.lineaIndice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reglas de matching, una por una
// ---------------------------------------------------------------------------

describe('matching por clave sugerida', () => {
  it('si el proveedor citó el código, matchea directo aunque describa distinto', () => {
    const { items } = conciliar(
      [item('aberturas.V2', 'Ventana V2 corrediza 1,20 × 1,50', 3)],
      [linea('Ítem 2 de su pedido', 3, { claveItemSugerida: 'aberturas.V2' })],
    );

    expect(items[0]!.match).toBe('exacto');
  });

  it('una clave sugerida que no existe no vale: cae al matching por descripción', () => {
    const { items } = conciliar(
      [item('aberturas.V2', 'Ventana V2 corrediza 1,20 × 1,50', 3)],
      [
        linea('Ventana V2 corrediza 1,20 × 1,50', 3, { claveItemSugerida: 'aberturas.ZZ' }),
        linea('Cortina de enrollar', 1, { claveItemSugerida: 'aberturas.ZZ' }),
      ],
    );

    expect(items[0]!.match).toBe('exacto');
    expect(items[1]!.match).toBe('extra');
  });
});

describe('matching por descripción', () => {
  it('sin solapamiento suficiente no hay match: la línea es extra y el ítem queda sin cotizar', () => {
    const { items, score } = conciliar(
      [item('seco.placas', 'Placa de yeso 12,5 mm', 100, {}, 'm2')],
      [linea('Durlock', 100, { unidad: 'm2' })],
    );

    expect(items.map((i) => i.match)).toEqual(['no_cotizado', 'extra']);
    expect(items[1]!.claveItem).toBeNull();
    expect(score).toBe(0);
  });

  it('la unidad tiene que ser la misma', () => {
    const { items } = conciliar(
      [item('seco.placas', 'Placa de yeso 12,5 mm', 100, {}, 'm2')],
      [linea('Placa de yeso 12,5 mm', 100, { unidad: 'u' })],
    );

    expect(items.map((i) => i.match)).toEqual(['no_cotizado', 'extra']);
  });

  it('una línea sin unidad declarada no bloquea el match (y queda como ambigua si además falta algo)', () => {
    const { items } = conciliar(
      [item('seco.placas', 'Placa de yeso 12,5 mm', 100, {}, 'm2')],
      [linea('Placa de yeso 12,5 mm', 100, { unidad: null })],
    );

    expect(items[0]!.match).toBe('exacto');
  });

  it('cada línea se queda con el ítem que más se le parece, y ningún ítem se cotiza dos veces', () => {
    const { items } = conciliar(
      [
        item('aberturas.P1', 'Puerta placa P1 0,80 × 2,05', 5, { material: 'madera' }),
        item('aberturas.P3', 'Puerta placa P3 0,70 × 2,05', 2, { material: 'madera' }),
      ],
      [linea('Puerta placa P3 0.70 x 2.05 madera', 2), linea('Puerta placa P1 0.80 x 2.05 madera', 5)],
    );

    expect(items.map((i) => [i.claveItem, i.match, i.lineaIndice])).toEqual([
      ['aberturas.P1', 'exacto', 2],
      ['aberturas.P3', 'exacto', 1],
    ]);
  });
});

describe('cantidad: ±5 %', () => {
  const rfq = [item('seco.placas', 'Placa de yeso 12,5 mm', 100, {}, 'm2')];
  const cotizada = (cantidad: number) =>
    conciliar(rfq, [linea('Placa de yeso 12,5 mm', cantidad, { unidad: 'm2' })]).items[0]!;

  it('la tolerancia es el 5 %', () => {
    expect(TOLERANCIA_CANTIDAD).toBe(0.05);
  });

  it('105 y 95 sobre 100 siguen siendo exactas: el borde entra', () => {
    expect(cotizada(105).match).toBe('exacto');
    expect(cotizada(95).match).toBe('exacto');
  });

  it('106 sobre 100 es parcial, con el desvío calculado', () => {
    const parcial = cotizada(106);

    expect(parcial.match).toBe('parcial');
    expect(parcial.desvio).toEqual({ cantidadRfq: 100, cantidadCotizada: 106, desvioPct: 6 });
  });

  it('94 sobre 100 es parcial y el desvío va en negativo', () => {
    expect(cotizada(94).desvio?.desvioPct).toBe(-6);
  });

  it('una línea sin cantidad es parcial: no se puede verificar', () => {
    const sinCantidad = conciliar(rfq, [
      linea('Placa de yeso 12,5 mm', null, { unidad: 'm2', precioUnitario: 5000, precioTotal: null }),
    ]);

    expect(sinCantidad.items[0]!.match).toBe('parcial');
    expect(sinCantidad.repreguntas.map((r) => r.motivo)).toEqual(['ambigua']);
  });
});

describe('sustituciones (specsCriticas contradichas)', () => {
  const ventana = item('aberturas.V5', 'Ventana V5 corrediza 2,00 × 1,50', 2, {
    vidrio: 'DVH',
    material: 'aluminio',
  });
  const clasificar = (descripcion: string, cantidad = 2) =>
    conciliar([ventana], [linea(descripcion, cantidad)]).items[0]!;

  it('float donde se pidió DVH es sustituto, no exacto', () => {
    expect(clasificar('Ventana V5 corrediza 2.00 x 1.50 aluminio float').match).toBe('sustituto');
  });

  it('laminado donde se pidió DVH también es sustituto', () => {
    expect(clasificar('Ventana V5 corrediza 2.00 x 1.50 aluminio laminado').specContradicha).toEqual({
      spec: 'vidrio',
      pedido: 'DVH',
      cotizado: 'laminado',
    });
  });

  it('PVC donde se pidió aluminio es sustituto de material', () => {
    expect(clasificar('Ventana V5 corrediza 2.00 x 1.50 PVC DVH').specContradicha).toEqual({
      spec: 'material',
      pedido: 'aluminio',
      cotizado: 'pvc',
    });
  });

  it('no decir nada del vidrio no es contradecirlo', () => {
    expect(clasificar('Ventana V5 corrediza 2.00 x 1.50 aluminio').match).toBe('exacto');
  });

  it('nombrar el vidrio pedido tampoco, aunque mencione otro', () => {
    expect(clasificar('Ventana V5 corrediza 2.00 x 1.50 aluminio DVH (opción float)').match).toBe('exacto');
  });

  it('la sustitución le gana al desvío de cantidad: es lo que hay que escalar', () => {
    const item = clasificar('Ventana V5 corrediza 2.00 x 1.50 aluminio float', 5);

    expect(item.match).toBe('sustituto');
    expect(item.desvio?.desvioPct).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Score, extras y precios
// ---------------------------------------------------------------------------

describe('score de fidelidad (RF-903)', () => {
  const rfq = [
    item('a.1', 'Ventana V1 corrediza 1,50 × 1,10', 4),
    item('a.2', 'Ventana V2 corrediza 1,20 × 1,50', 3),
    item('a.3', 'Puerta placa P1 0,80 × 2,05', 5),
    item('a.4', 'Mosquitero M1 corredizo 1,50 × 1,10', 4),
  ];

  it('un parcial vale medio: (2 + 0,5) / 4 = 0,63 redondeado a 2 decimales', () => {
    const { score, items } = conciliar(rfq, [
      linea('Ventana V1 corrediza 1,50 × 1,10', 4),
      linea('Ventana V2 corrediza 1,20 × 1,50', 3),
      linea('Puerta placa P1 0,80 × 2,05', 8),
    ]);

    expect(items.map((i) => i.match)).toEqual(['exacto', 'exacto', 'parcial', 'no_cotizado']);
    expect(score).toBe(0.63);
  });

  it('los extras no cambian el denominador', () => {
    const { score, items } = conciliar(rfq, [
      linea('Ventana V1 corrediza 1,50 × 1,10', 4),
      linea('Ventana V2 corrediza 1,20 × 1,50', 3),
      linea('Puerta placa P1 0,80 × 2,05', 5),
      linea('Mosquitero M1 corredizo 1,50 × 1,10', 4),
      linea('Flete y colocación', 1),
      linea('Sellador siliconado', 6),
    ]);

    expect(score).toBe(1);
    expect(items.filter((i) => i.match === 'extra')).toHaveLength(2);
  });

  it('un presupuesto vacío da score 0 y una repregunta por ítem', () => {
    const { score, repreguntas } = conciliar(rfq, []);

    expect(score).toBe(0);
    expect(repreguntas).toHaveLength(4);
  });

  it('un RFQ vacío no divide por cero', () => {
    expect(conciliar([], [linea('Flete', 1)]).score).toBe(0);
  });
});

describe('precio unitario de una línea', () => {
  it('usa el unitario si vino', () => {
    expect(precioUnitarioDe(linea('Ventana', 4, { precioUnitario: 250, precioTotal: 1000 }))).toBe(250);
  });

  it('lo deduce del total cuando falta', () => {
    expect(precioUnitarioDe(linea('Ventana', 4, { precioUnitario: null, precioTotal: 1000 }))).toBe(250);
  });

  it('sin total ni cantidad no inventa un precio', () => {
    expect(precioUnitarioDe(linea('Ventana', null, { precioUnitario: null, precioTotal: 1000 }))).toBeNull();
    expect(precioUnitarioDe(linea('Ventana', 4, { precioUnitario: null, precioTotal: null }))).toBeNull();
  });
});
