/**
 * Parser de presupuestos: provider mock (fixture + heurística) y saneo.
 *
 * Las dos mitades que este archivo protege:
 *
 * 1. **La heurística de texto plano.** Es lo que hace que el flujo manual
 *    funcione sin fixtures: el usuario pega el presupuesto que le mandó el
 *    corralón y salen líneas. Es determinística y conservadora — una línea sin
 *    precio no es un ítem, un número sin unidad conocida no es una cantidad, y
 *    lo que no se leyó va `null` en vez de inventado (CLAUDE.md §3).
 * 2. **El saneo del cable laxo**, mismo patrón que `sanearAnalisis`: lo
 *    recuperable se limpia, lo inutilizable se descarta y se cuenta.
 *
 * Sin DB, sin red; el único I/O es leer los fixtures JSON del repo.
 */
import { describe, expect, it } from 'vitest';

import {
  crearProviderPresupuestoMock,
  parsearTextoPlano,
} from '@/lib/analysis/presupuesto-mock';
import { sanearPresupuesto } from '@/lib/analysis/presupuesto-tipos';

/**
 * Un presupuesto como lo manda un corralón: montos en es-AR (miles con punto,
 * decimales con coma), cantidades a veces adelante y a veces atrás, líneas de
 * subtotal / IVA / total, y las condiciones al pie.
 */
const TEXTO_PRESUPUESTO = [
  'CORRALÓN VICENTE LÓPEZ — Presupuesto N° 1234',
  '',
  '31,68 m2 Placa de roca de yeso 12,5 mm $ 8.500,50 $ 269.279,84',
  '14 u Montante 70 mm x 2,60 m $ 4.200 $ 58.800',
  'Cinta de papel para juntas 90 ml $ 45.000',
  'Masilla para juntas — 30 kg — $ 120.000,25',
  'Flete a obra (sin cargo)',
  '',
  'Subtotal $ 493.080,09',
  'IVA 21% $ 103.546,82',
  'TOTAL $ 596.626,91',
  '',
  'Validez de la oferta: 10 días',
  'Plazo de entrega: 15 días corridos desde la orden de compra',
  'Forma de pago: 50% anticipo y 50% contra entrega',
].join('\n');

describe('heurística de texto plano', () => {
  it('lee las cuatro líneas con precio y deja afuera encabezado, flete sin precio y subtotales', () => {
    const { lineas } = parsearTextoPlano(TEXTO_PRESUPUESTO);

    expect(lineas).toHaveLength(4);
    expect(lineas.map((l) => l.descripcion)).toEqual([
      'Placa de roca de yeso 12,5 mm',
      'Montante 70 mm x 2,60 m',
      'Cinta de papel para juntas',
      'Masilla para juntas',
    ]);
  });

  it('con dos montos, el primero es el unitario y el último el total', () => {
    const { lineas } = parsearTextoPlano(TEXTO_PRESUPUESTO);

    expect(lineas[0]).toEqual({
      descripcion: 'Placa de roca de yeso 12,5 mm',
      unidad: 'm2',
      cantidad: 31.68,
      precioUnitario: 8500.5,
      precioTotal: 269279.84,
      claveItemSugerida: null,
      notas: null,
    });
    expect(lineas[1].cantidad).toBe(14);
    expect(lineas[1].unidad).toBe('u');
    expect(lineas[1].precioUnitario).toBe(4200);
    expect(lineas[1].precioTotal).toBe(58800);
  });

  it('con un solo monto lo toma como total de la línea y no inventa el unitario', () => {
    const { lineas } = parsearTextoPlano(TEXTO_PRESUPUESTO);

    expect(lineas[2].precioUnitario).toBeNull();
    expect(lineas[2].precioTotal).toBe(45000);
    expect(lineas[3].precioUnitario).toBeNull();
    expect(lineas[3].precioTotal).toBe(120000.25);
  });

  it('lee la cantidad adelante o atrás de la descripción, siempre con unidad conocida', () => {
    const { lineas } = parsearTextoPlano(TEXTO_PRESUPUESTO);

    // Adelante: "31,68 m2 Placa…" y "14 u Montante…".
    expect([lineas[0].cantidad, lineas[1].cantidad]).toEqual([31.68, 14]);
    // Atrás: "…juntas 90 ml" y "…juntas — 30 kg —".
    expect([lineas[2].cantidad, lineas[2].unidad]).toEqual([90, 'ml']);
    expect([lineas[3].cantidad, lineas[3].unidad]).toEqual([30, 'kg']);
  });

  it('un número sin unidad conocida no es una cantidad (los "70 mm" no se cuentan)', () => {
    const { lineas } = parsearTextoPlano('Montante 70 mm $ 4.200');

    expect(lineas).toHaveLength(1);
    expect(lineas[0].descripcion).toBe('Montante 70 mm');
    expect(lineas[0].cantidad).toBeNull();
    expect(lineas[0].unidad).toBeNull();
  });

  it('saca del texto el total, el IVA, la validez, el plazo y la forma de pago', () => {
    const { metadatos } = parsearTextoPlano(TEXTO_PRESUPUESTO);

    expect(metadatos).toEqual({
      // El TOTAL declarado, no el subtotal ni la suma de las líneas.
      total: 596626.91,
      incluyeIva: false,
      validezDias: 10,
      plazoDias: 15,
      formaPago: '50% anticipo y 50% contra entrega',
    });
  });

  it('distingue "IVA incluido" de "más IVA" y de "IVA no incluido"', () => {
    expect(parsearTextoPlano('Precios con IVA incluido').metadatos.incluyeIva).toBe(true);
    expect(parsearTextoPlano('Precios más IVA').metadatos.incluyeIva).toBe(false);
    expect(parsearTextoPlano('IVA no incluido').metadatos.incluyeIva).toBe(false);
    expect(parsearTextoPlano('Precios sin IVA').metadatos.incluyeIva).toBe(false);
    // Sin mención del IVA no se asume nada: `null`, no `false`.
    expect(parsearTextoPlano('Cinta de papel $ 45.000').metadatos.incluyeIva).toBeNull();
  });

  it('un texto sin precios no produce líneas (no inventa un presupuesto)', () => {
    const { lineas, metadatos } = parsearTextoPlano('Hola, te paso el precio la semana que viene.');

    expect(lineas).toEqual([]);
    expect(metadatos.total).toBeNull();
  });
});

describe('provider mock', () => {
  const mock = crearProviderPresupuestoMock();

  it('usa el fixture del pin RF-902 cuando el nombre matchea, aunque venga texto', async () => {
    const { lineas, metadatos } = await mock.parsear({
      nombre: 'Presupuesto Seco RF902.pdf',
      texto: 'esto no se parsea porque hay fixture $ 1',
    });

    expect(lineas).toHaveLength(9);
    expect(metadatos.total).toBe(953480);
    expect(metadatos.validezDias).toBe(10);
    // La línea de la sustitución: solera de ladrillo donde se pidió durlock.
    expect(lineas[1].descripcion).toBe('Solera para tabique de ladrillo');
  });

  it('sin fixture cae a la heurística sobre el texto', async () => {
    const { lineas } = await mock.parsear({
      nombre: 'presupuesto-que-no-existe.pdf',
      texto: '14 u Montante 70 mm x 2,60 m $ 4.200 $ 58.800',
    });

    expect(lineas).toHaveLength(1);
    expect(lineas[0].precioTotal).toBe(58800);
  });

  it('sin fixture y sin texto devuelve vacío: el mock no lee PDFs', async () => {
    const { lineas, metadatos } = await mock.parsear({
      nombre: 'escaneado.pdf',
      pdfBytes: new Uint8Array([1, 2, 3]),
    });

    expect(lineas).toEqual([]);
    expect(metadatos).toEqual({
      total: null,
      incluyeIva: null,
      validezDias: null,
      plazoDias: null,
      formaPago: null,
    });
  });
});

describe('saneo del cable laxo', () => {
  const linea = (extra: Record<string, unknown>) => ({
    descripcion: 'Placa de roca de yeso',
    unidad: 'm2',
    cantidad: 10,
    precioUnitario: 100,
    precioTotal: 1000,
    claveItemSugerida: null,
    notas: null,
    ...extra,
  });

  it('descarta la línea sin descripción y la cuenta', () => {
    const { presupuesto, lineasDescartadas } = sanearPresupuesto({
      lineas: [linea({}), linea({ descripcion: '   ' })],
      metadatos: { total: 1000, incluyeIva: true, validezDias: 7, plazoDias: 10, formaPago: null },
    });

    expect(presupuesto.lineas).toHaveLength(1);
    expect(lineasDescartadas).toBe(1);
  });

  it('un número imposible vuelve null en vez de envenenar el índice de precios', () => {
    const { presupuesto } = sanearPresupuesto({
      lineas: [linea({ cantidad: -3, precioUnitario: 0, precioTotal: Number.NaN })],
      metadatos: { total: -1, incluyeIva: null, validezDias: 0, plazoDias: -5, formaPago: '  ' },
    });

    expect(presupuesto.lineas[0].cantidad).toBeNull();
    expect(presupuesto.lineas[0].precioUnitario).toBeNull();
    expect(presupuesto.lineas[0].precioTotal).toBeNull();
    expect(presupuesto.metadatos).toEqual({
      total: null,
      incluyeIva: null,
      validezDias: null,
      plazoDias: null,
      formaPago: null,
    });
  });

  it('deja pasar lo válido sin tocarlo', () => {
    const { presupuesto, lineasDescartadas } = sanearPresupuesto({
      lineas: [linea({ claveItemSugerida: 'seco.placas', notas: 'entrega en 5 días' })],
      metadatos: { total: 1000, incluyeIva: false, validezDias: 7, plazoDias: 10, formaPago: 'contado' },
    });

    expect(lineasDescartadas).toBe(0);
    expect(presupuesto.lineas[0].claveItemSugerida).toBe('seco.placas');
    expect(presupuesto.metadatos.formaPago).toBe('contado');
  });
});
