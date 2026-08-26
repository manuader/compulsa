/**
 * El cuadro comparativo y el ranking multicriterio (RF-1101 / RF-1103).
 *
 * Lo que estos tests protegen, en orden de importancia:
 *
 *  1. **El pin del ranking:** A (total 100, fidelidad 1,0, plazo 10) contra B
 *     (total 90, fidelidad 0,8, plazo 15) da **0,95 contra 0,8733 y gana A**.
 *     Es el número que decide una adjudicación: si se mueve, se movió una regla
 *     de negocio, no un detalle de formato.
 *  2. **La celda es precio unitario × cantidad DEL RFQ**, no el importe que
 *     escribió el proveedor: comparar dos presupuestos que cotizaron cantidades
 *     distintas por el mismo ítem es comparar cualquier cosa.
 *  3. **Lo que no se puede comparar sale "—" y no suma.** Un sustituto tiene
 *     precio y aun así queda afuera del total comparable: es otro producto.
 *  4. **El benchmark solo aparece con n ≥ 3** (RF-1103) y usa el índice del mes
 *     corriente, con fallback al último mes con datos.
 *  5. **La validez se mide contra `created_at + validez_dias`**, con aviso a 3
 *     días.
 */
import { describe, expect, it } from 'vitest';

import {
  DIAS_AVISO_VALIDEZ,
  armarComparativa,
  entradasDeRanking,
  estadoValidez,
  formatearImporte,
  rankear,
  vencimientoDe,
  type CompulsaComparativa,
  type ConciliacionComparativa,
  type CotizacionComparativa,
  type FilaIndice,
} from '@/lib/compulsa/comparativa';
import type { ItemRfq, LineaPresupuesto, PesosRanking } from '@/types/domain';

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

/** 26 de agosto de 2026, 12:00 en Buenos Aires. Mes del índice: `2026-08`. */
const AHORA = new Date('2026-08-26T15:00:00Z');
const ZONA = 'Vicente López';

function item(claveItem: string, descripcion: string, unidad: ItemRfq['unidad'], cantidad: number): ItemRfq {
  return { claveItem, descripcion, unidad, cantidad, presentacion: '', specsCriticas: {} };
}

const ITEMS: ItemRfq[] = [
  item('seco.placas', 'Placa de roca de yeso 12,5 mm', 'm2', 10),
  item('seco.montantes', 'Montante 70 mm para tabique de durlock', 'ml', 20),
  item('seco.tornillos', 'Tornillos T2 para placa', 'u', 100),
];

const COMPULSA: CompulsaComparativa = {
  id: 'compulsa-1',
  rubro: 'seco',
  version: 1,
  items: ITEMS,
};

function linea(
  descripcion: string,
  precioUnitario: number | null,
  cantidad: number | null,
  precioTotal: number | null = null,
): LineaPresupuesto {
  return {
    descripcion,
    unidad: null,
    cantidad,
    precioUnitario,
    precioTotal,
    claveItemSugerida: null,
    notas: null,
  };
}

function cotizacion(
  id: string,
  nombre: string,
  lineas: LineaPresupuesto[],
  extra: Partial<CotizacionComparativa> = {},
): CotizacionComparativa {
  return {
    id,
    proveedorId: `prov-${id}`,
    proveedorNombre: nombre,
    moneda: 'ARS',
    incluyeIva: false,
    total: null,
    validezDias: 30,
    plazoDias: 10,
    scoreFidelidad: 1,
    lineas,
    createdAt: new Date('2026-08-20T12:00:00Z'),
    ...extra,
  };
}

/** Corralón: placas exactas, montantes parciales, tornillos sin cotizar. */
const COT_A = cotizacion(
  'cot-a',
  'Corralón San Martín',
  [linea('Placa de roca de yeso 12,5 mm', 1000, 10), linea('Montante 70 mm', 500, 25)],
  { total: 20000, plazoDias: 10, scoreFidelidad: 0.83 },
);

/** Ferretería: sustituye el montante y agrega un flete que nadie pidió. */
const COT_B = cotizacion(
  'cot-b',
  'Ferretería del Centro',
  [
    linea('Placa de roca de yeso 12,5 mm', 900, 10),
    linea('Montante para tabique de ladrillo', 400, 20),
    linea('Tornillos T2', 12, 100),
    linea('Flete a obra', null, null, 5000),
  ],
  { total: 15600, plazoDias: 15, scoreFidelidad: 0.67 },
);

/** Maderera: no declaró total (la columna `total` es nullable). */
const COT_C = cotizacion('cot-c', 'Maderera Norte', [linea('Placa de roca de yeso', 950, 10)], {
  total: null,
  plazoDias: null,
  scoreFidelidad: 0.33,
  validezDias: null,
});

const COTIZACIONES = [COT_A, COT_B, COT_C];

function conc(
  cotizacionId: string,
  claveItem: string | null,
  lineaIdx: number | null,
  match: ConciliacionComparativa['match'],
  nota = 'motivo',
): ConciliacionComparativa {
  return { cotizacionId, claveItem, lineaIdx, match, nota };
}

const CONCILIACIONES: ConciliacionComparativa[] = [
  conc('cot-a', 'seco.placas', 0, 'exacto'),
  conc('cot-a', 'seco.montantes', 1, 'parcial', 'La cantidad cotizada difiere 25% de la pedida.'),
  conc('cot-a', 'seco.tornillos', null, 'no_cotizado', 'Nadie cotizó este ítem.'),
  conc('cot-b', 'seco.placas', 0, 'exacto'),
  conc('cot-b', 'seco.montantes', 1, 'sustituto', 'Se pidió durlock y la línea dice ladrillo.'),
  conc('cot-b', 'seco.tornillos', 2, 'exacto'),
  conc('cot-b', null, 3, 'extra', 'El proveedor cotizó algo que no se pidió.'),
  conc('cot-c', 'seco.placas', 0, 'exacto'),
  conc('cot-c', 'seco.montantes', null, 'no_cotizado'),
  conc('cot-c', 'seco.tornillos', null, 'no_cotizado'),
];

const INDICE: FilaIndice[] = [
  // Placas: mes corriente, 4 muestras ⇒ el semáforo se muestra.
  { claveItem: 'seco.placas', zona: ZONA, mes: '2026-08', p50: 950, p75: 1000, n: 4 },
  // Montantes: solo 2 muestras ⇒ sin_datos, aunque el precio esté carísimo.
  { claveItem: 'seco.montantes', zona: ZONA, mes: '2026-08', p50: 100, p75: 120, n: 2 },
  // Tornillos: sin fila de agosto; la de julio es el fallback.
  { claveItem: 'seco.tornillos', zona: ZONA, mes: '2026-07', p50: 11, p75: 13, n: 5 },
  // Misma clave, otra zona: no tiene que colarse.
  { claveItem: 'seco.placas', zona: 'CABA', mes: '2026-08', p50: 1, p75: 2, n: 9 },
];

function armar() {
  return armarComparativa(COMPULSA, COTIZACIONES, CONCILIACIONES, INDICE, {
    zona: ZONA,
    ahora: AHORA,
  });
}

function celda(claveItem: string, cotizacionId: string) {
  const fila = armar().filas.find((f) => f.claveItem === claveItem)!;
  return fila.celdas.find((c) => c.cotizacionId === cotizacionId)!;
}

function columna(cotizacionId: string) {
  return armar().columnas.find((c) => c.cotizacionId === cotizacionId)!;
}

// ---------------------------------------------------------------------------
// El cuadro
// ---------------------------------------------------------------------------

describe('armarComparativa: las filas son el snapshot, no lo que cotizaron', () => {
  it('hay una fila por ítem del RFQ, en el orden del snapshot', () => {
    expect(armar().filas.map((f) => f.claveItem)).toEqual([
      'seco.placas',
      'seco.montantes',
      'seco.tornillos',
    ]);
  });

  it('hay una columna por cotización, en el orden en que se pasaron', () => {
    expect(armar().columnas.map((c) => c.proveedorNombre)).toEqual([
      'Corralón San Martín',
      'Ferretería del Centro',
      'Maderera Norte',
    ]);
  });

  it('la celda es precio unitario × cantidad del RFQ, no el importe del proveedor', () => {
    // La línea del montante cotiza 25 ml a 500; el RFQ pide 20. La celda vale
    // 500 × 20 = 10.000, no 500 × 25 = 12.500.
    const montantes = celda('seco.montantes', 'cot-a');

    expect(montantes.precioUnitario).toBe(500);
    expect(montantes.importe).toBe(10000);
    expect(montantes.match).toBe('parcial');
    expect(montantes.comparable).toBe(true);
  });

  it('un parcial entra al comparable y trae su motivo como detalle', () => {
    expect(celda('seco.montantes', 'cot-a').detalle).toBe(
      'La cantidad cotizada difiere 25% de la pedida.',
    );
  });

  it('un ítem no cotizado sale "—", sin importe y sin sumar', () => {
    const tornillos = celda('seco.tornillos', 'cot-a');

    expect(tornillos.texto).toBe('—');
    expect(tornillos.importe).toBeNull();
    expect(tornillos.comparable).toBe(false);
    expect(tornillos.detalle).toBe('Nadie cotizó este ítem.');
  });

  it('un sustituto sale "—" aunque tenga precio: es otro producto', () => {
    const montantes = celda('seco.montantes', 'cot-b');

    expect(montantes.match).toBe('sustituto');
    expect(montantes.precioUnitario).toBe(400);
    expect(montantes.importe).toBeNull();
    expect(montantes.comparable).toBe(false);
    expect(montantes.detalle).toBe('Se pidió durlock y la línea dice ladrillo.');
  });

  it('una cotización sin fila de conciliación para un ítem queda "sin conciliar"', () => {
    const cuadro = armarComparativa(COMPULSA, [COT_A], [], [], { zona: ZONA, ahora: AHORA });

    const celdas = cuadro.filas.map((f) => f.celdas[0]);
    expect(celdas.map((c) => c.match)).toEqual([
      'sin_conciliar',
      'sin_conciliar',
      'sin_conciliar',
    ]);
    expect(celdas[0].texto).toBe('—');
    expect(celdas[0].detalle).toBe('Esta cotización todavía no se concilió contra el pedido.');
  });

  it('las líneas extra no arman fila: quedan colgadas de su columna', () => {
    const cuadro = armar();

    expect(cuadro.filas.map((f) => f.claveItem)).not.toContain(null);
    expect(cuadro.columnas[1].extras).toEqual([
      { lineaIdx: 3, descripcion: 'Flete a obra', importe: 5000 },
    ]);
    expect(cuadro.columnas[0].extras).toEqual([]);
  });
});

describe('armarComparativa: los totales', () => {
  it('el total comparable es la suma de las celdas comparables', () => {
    // 1000 × 10 + 500 × 20 = 20.000 (los tornillos no cotizados no suman).
    expect(columna('cot-a').totalComparable).toBe(20000);
    // 900 × 10 + 12 × 100 = 10.200 (el sustituto no suma).
    expect(columna('cot-b').totalComparable).toBe(10200);
  });

  it('cuenta cuántos ítems entraron y cuántos quedaron afuera', () => {
    expect(columna('cot-a').itemsComparables).toBe(2);
    expect(columna('cot-a').itemsExcluidos).toBe(1);
    expect(columna('cot-b').itemsComparables).toBe(2);
    expect(columna('cot-b').itemsExcluidos).toBe(1);
  });

  it('marca la columna cuando el total declarado no coincide con el comparable', () => {
    const a = columna('cot-a');
    expect(a.totalDeclarado).toBe(20000);
    expect(a.difiereDelDeclarado).toBe(false);
    expect(a.diferencia).toBe(0);

    const b = columna('cot-b');
    expect(b.totalDeclarado).toBe(15600);
    expect(b.difiereDelDeclarado).toBe(true);
    // 15.600 declarados − 10.200 comparables = 5.400 (el flete y el sustituto).
    expect(b.diferencia).toBe(5400);
  });

  it('marca la columna sin total declarado y no la inventa desde el comparable', () => {
    const c = columna('cot-c');

    expect(c.totalDeclarado).toBeNull();
    expect(c.sinTotalDeclarado).toBe(true);
    expect(c.difiereDelDeclarado).toBe(false);
    expect(c.diferencia).toBeNull();
    expect(c.totalComparable).toBe(9500);
  });

  it('el score de fidelidad viaja tal cual; sin conciliar es 0', () => {
    expect(columna('cot-a').scoreFidelidad).toBe(0.83);
    expect(
      armarComparativa(COMPULSA, [cotizacion('x', 'X', [], { scoreFidelidad: null })], [], [], {
        zona: ZONA,
        ahora: AHORA,
      }).columnas[0].scoreFidelidad,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Benchmark (RF-1103)
// ---------------------------------------------------------------------------

describe('armarComparativa: el benchmark contra el índice del estudio', () => {
  it('con n ≥ 3 pinta el semáforo: verde ≤ p50, amarillo ≤ p75, rojo arriba', () => {
    // p50 = 950, p75 = 1000.
    expect(celda('seco.placas', 'cot-b').benchmark).toBe('verde'); // 900
    expect(celda('seco.placas', 'cot-c').benchmark).toBe('verde'); // 950, el borde
    expect(celda('seco.placas', 'cot-a').benchmark).toBe('amarillo'); // 1000, el otro borde
  });

  it('con menos de 3 muestras no compara, por más caro que esté', () => {
    // 500 contra un p75 de 120 sería rojo furioso, pero el índice tiene n = 2.
    expect(celda('seco.montantes', 'cot-a').benchmark).toBe('sin_datos');
    expect(celda('seco.montantes', 'cot-a').indice).toBeNull();
  });

  it('sin fila del mes corriente cae al último mes con datos y lo dice', () => {
    const tornillos = celda('seco.tornillos', 'cot-b');

    expect(tornillos.benchmark).toBe('amarillo'); // 12 contra p50 11 / p75 13
    expect(tornillos.indice).toEqual({ p50: 11, p75: 13, n: 5, mes: '2026-07' });
  });

  it('no mezcla zonas: el índice de CABA no toca a una obra de Vicente López', () => {
    // La fila de CABA tiene p50 = 1: si se colara, todo sería rojo.
    expect(celda('seco.placas', 'cot-b').indice).toEqual({
      p50: 950,
      p75: 1000,
      n: 4,
      mes: '2026-08',
    });
  });

  it('sin índice no hay semáforo y el cuadro sale igual', () => {
    const cuadro = armarComparativa(COMPULSA, COTIZACIONES, CONCILIACIONES, [], {
      zona: ZONA,
      ahora: AHORA,
    });

    expect(cuadro.filas[0].celdas[0].benchmark).toBe('sin_datos');
    expect(cuadro.columnas[0].totalComparable).toBe(20000);
  });

  it('el mes del cuadro es el de Buenos Aires, no el UTC', () => {
    // 1 de septiembre 00:30 UTC son las 21:30 del 31 de agosto en Buenos Aires.
    const cuadro = armarComparativa(COMPULSA, COTIZACIONES, CONCILIACIONES, INDICE, {
      zona: ZONA,
      ahora: new Date('2026-09-01T00:30:00Z'),
    });

    expect(cuadro.mesActual).toBe('2026-08');
  });
});

// ---------------------------------------------------------------------------
// Validez
// ---------------------------------------------------------------------------

describe('validez de la oferta: created_at + validez_dias', () => {
  const emitida = new Date('2026-08-20T12:00:00Z');

  it('calcula el vencimiento sumando días corridos', () => {
    expect(vencimientoDe(emitida, 7)?.toISOString()).toBe('2026-08-27T12:00:00.000Z');
    expect(vencimientoDe(emitida, null)).toBeNull();
  });

  it('vigente mientras falten más de 3 días', () => {
    expect(estadoValidez(emitida, 30, AHORA)).toBe('vigente');
  });

  it(`por vencer con ${DIAS_AVISO_VALIDEZ} días o menos por delante`, () => {
    // Vence el 27; el 26 al mediodía falta 1 día.
    expect(estadoValidez(emitida, 7, AHORA)).toBe('por_vencer');
    // Vence el 29: faltan 3 días justos, el borde del aviso.
    expect(estadoValidez(emitida, 9, AHORA)).toBe('por_vencer');
    // Vence el 30: 4 días, todavía vigente.
    expect(estadoValidez(emitida, 10, AHORA)).toBe('vigente');
  });

  it('vencida cuando la fecha ya pasó', () => {
    expect(estadoValidez(emitida, 3, AHORA)).toBe('vencida');
  });

  it('sin validez declarada no se inventa una fecha', () => {
    expect(estadoValidez(emitida, null, AHORA)).toBe('sin_dato');
  });

  it('la columna trae el estado y los días que faltan', () => {
    expect(columna('cot-a').validez).toBe('vigente');
    expect(columna('cot-a').diasParaVencer).toBe(24);
    expect(columna('cot-c').validez).toBe('sin_dato');
    expect(columna('cot-c').diasParaVencer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ranking (RF-1101) — el pin
// ---------------------------------------------------------------------------

describe('rankear: el pin de RF-1101', () => {
  const A = { id: 'A', total: 100, fidelidad: 1, plazoDias: 10 };
  const B = { id: 'B', total: 90, fidelidad: 0.8, plazoDias: 15 };

  it('A = 0,95 y B = 0,8733: gana A aunque B sea más barato', () => {
    const ranking = rankear([A, B]);

    expect(ranking.map((p) => p.id)).toEqual(['A', 'B']);
    expect(ranking[0].puntaje).toBe(0.95);
    expect(ranking[1].puntaje).toBe(0.8733);
    expect(ranking[0].posicion).toBe(1);
    expect(ranking[1].posicion).toBe(2);
  });

  it('el desglose muestra de dónde salió cada décima', () => {
    const [a, b] = rankear([A, B]);

    expect(a.componentes.total).toEqual({ ratio: 0.9, peso: 0.5, aporte: 0.45 });
    expect(a.componentes.fidelidad).toEqual({ ratio: 1, peso: 0.3, aporte: 0.3 });
    expect(a.componentes.plazo).toEqual({ ratio: 1, peso: 0.2, aporte: 0.2 });

    expect(b.componentes.total).toEqual({ ratio: 1, peso: 0.5, aporte: 0.5 });
    expect(b.componentes.fidelidad).toEqual({ ratio: 0.8, peso: 0.3, aporte: 0.24 });
    expect(b.componentes.plazo.ratio).toBe(0.6667);
    expect(b.componentes.plazo.aporte).toBe(0.1333);
  });

  it('el orden de entrada no cambia el resultado', () => {
    expect(rankear([B, A]).map((p) => p.id)).toEqual(['A', 'B']);
  });

  it('un plazo sin declarar hace cero el tercer término, no lo saltea', () => {
    const [sinPlazo] = rankear([{ id: 'sin', total: 100, fidelidad: 1, plazoDias: null }]);

    // Único: gana el término de total (1) y el de fidelidad (1); el plazo, 0.
    expect(sinPlazo.componentes.plazo).toEqual({ ratio: 0, peso: 0.2, aporte: 0 });
    expect(sinPlazo.puntaje).toBe(0.8);
  });

  it('un plazo 0 tampoco divide por cero: cuenta como sin declarar', () => {
    const [cero] = rankear([{ id: 'cero', total: 100, fidelidad: 1, plazoDias: 0 }]);
    expect(cero.componentes.plazo.aporte).toBe(0);
  });

  it('con pesos del estudio usa esos y no los del PRD', () => {
    const pesos: PesosRanking = { total: 0.8, fidelidad: 0.2, plazo: 0 };
    const [a, b] = rankear([A, B], pesos);

    // A: 0,8 × 0,9 + 0,2 × 1 = 0,92. B: 0,8 × 1 + 0,2 × 0,8 = 0,96 ⇒ gana B.
    expect(a.id).toBe('B');
    expect(a.puntaje).toBe(0.96);
    expect(b.puntaje).toBe(0.92);
  });

  it('empate: desempata el total más bajo y después el id, para que sea estable', () => {
    const uno = { id: 'zeta', total: 100, fidelidad: 1, plazoDias: 10 };
    const otro = { id: 'alfa', total: 100, fidelidad: 1, plazoDias: 10 };

    expect(rankear([uno, otro]).map((p) => p.id)).toEqual(['alfa', 'zeta']);
  });

  it('un total que no sirve para comparar revienta en vez de rankear cualquier cosa', () => {
    expect(() => rankear([{ id: 'x', total: 0, fidelidad: 1, plazoDias: 5 }])).toThrow(
      /total/i,
    );
  });

  it('sin filas devuelve una lista vacía, no un error', () => {
    expect(rankear([])).toEqual([]);
  });
});

describe('entradasDeRanking: qué total entra al ranking', () => {
  it('usa el total declarado y cae al comparable solo si no hay declarado', () => {
    const entradas = entradasDeRanking(armar());

    expect(entradas).toEqual([
      { id: 'cot-a', total: 20000, fidelidad: 0.83, plazoDias: 10 },
      { id: 'cot-b', total: 15600, fidelidad: 0.67, plazoDias: 15 },
      { id: 'cot-c', total: 9500, fidelidad: 0.33, plazoDias: null },
    ]);
  });

  it('deja afuera a la que no tiene ningún total utilizable', () => {
    const cuadro = armarComparativa(COMPULSA, [cotizacion('vacia', 'Vacía', [])], [], [], {
      zona: ZONA,
      ahora: AHORA,
    });

    expect(cuadro.columnas[0].totalComparable).toBe(0);
    expect(entradasDeRanking(cuadro)).toEqual([]);
  });
});

describe('formatearImporte: es-AR', () => {
  it('miles con punto y decimales con coma', () => {
    expect(formatearImporte(1875400.5)).toBe('1.875.400,50');
    expect(formatearImporte(20000)).toBe('20.000');
    expect(formatearImporte(0)).toBe('0');
  });
});
