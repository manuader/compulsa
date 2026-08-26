/**
 * La orden de compra que sale de adjudicar (RF-1102).
 *
 * Es el documento que el estudio le manda al corralón y que después alguien
 * factura: los tests pinnean lo que no puede faltar ni cambiar de sentido —
 * quién la emite, para qué obra, qué ítems con qué cantidades y precios, el
 * total, las condiciones estándar del PRD §13 y el disclaimer profesional.
 *
 * El PDF se prueba por lo que se puede verificar sin un lector de PDF: que sea
 * un PDF, que pagine cuando el texto no entra en una página y que no reviente
 * con los caracteres que el castellano y el rubro usan todos los días (ñ, á,
 * m², el guion largo).
 */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import {
  generarOrdenCompra,
  ordenCompraPdf,
  type CondicionesOrdenCompra,
  type CotizacionOrdenCompra,
  type EstudioOrdenCompra,
  type ItemOrdenCompra,
  type ObraOrdenCompra,
  type ProveedorOrdenCompra,
} from '@/lib/compulsa/orden-compra';
import { CONDICIONES_RFQ_DEFAULT } from '@/types/domain';

const ESTUDIO: EstudioOrdenCompra = { nombre: 'Estudio Ader', mepReferencia: null };
const OBRA: ObraOrdenCompra = { nombre: 'Casa Peña', zona: 'Vicente López', moneda: 'ARS' };
const PROVEEDOR: ProveedorOrdenCompra = {
  nombre: 'Corralón San Martín',
  contacto: 'Marcelo — 11 5555 1234',
};
const COTIZACION: CotizacionOrdenCompra = {
  moneda: 'ARS',
  incluyeIva: false,
  validezDias: 15,
  plazoDias: 10,
  formaPago: '50% con la orden, 50% contra entrega',
};

const ITEMS: ItemOrdenCompra[] = [
  {
    claveItem: 'seco.placas',
    descripcion: 'Placa de roca de yeso 12,5 mm',
    unidad: 'm2',
    cantidad: 31.68,
    precioUnitario: 1000,
    importe: 31680,
  },
  {
    claveItem: 'seco.montantes',
    descripcion: 'Montante 70 mm para tabique de durlock',
    unidad: 'ml',
    cantidad: 26,
    precioUnitario: 500,
    importe: 13000,
  },
];

const CONDICIONES: CondicionesOrdenCompra = {
  rubro: 'seco',
  version: 1,
  total: 44680,
  condiciones: CONDICIONES_RFQ_DEFAULT,
  fecha: new Date('2026-08-26T15:00:00Z'),
  numero: 'OC-2026-0007',
  notas: null,
};

function texto(
  parches: {
    estudio?: Partial<EstudioOrdenCompra>;
    cotizacion?: Partial<CotizacionOrdenCompra>;
    condiciones?: Partial<CondicionesOrdenCompra>;
    items?: ItemOrdenCompra[];
  } = {},
): string {
  return generarOrdenCompra(
    { ...ESTUDIO, ...parches.estudio },
    OBRA,
    PROVEEDOR,
    { ...COTIZACION, ...parches.cotizacion },
    parches.items ?? ITEMS,
    { ...CONDICIONES, ...parches.condiciones },
  );
}

describe('generarOrdenCompra: quién, a quién y para qué obra', () => {
  it('se identifica como orden de compra del estudio, con su número y fecha', () => {
    const oc = texto();

    expect(oc).toContain('ORDEN DE COMPRA');
    expect(oc).toContain('OC-2026-0007');
    expect(oc).toContain('Estudio Ader');
    // Fecha del día de Buenos Aires, no el UTC del servidor.
    expect(oc).toContain('26/08/2026');
  });

  it('nombra al proveedor con su contacto y la obra con su zona', () => {
    const oc = texto();

    expect(oc).toContain('Corralón San Martín');
    expect(oc).toContain('Marcelo — 11 5555 1234');
    expect(oc).toContain('Casa Peña');
    expect(oc).toContain('Vicente López');
    expect(oc).toContain('Construcción en seco');
  });

  it('sin número de orden no inventa uno ni deja el rótulo colgado', () => {
    const oc = texto({ condiciones: { numero: null } });

    expect(oc).toContain('ORDEN DE COMPRA');
    expect(oc).not.toContain('Número:');
  });
});

describe('generarOrdenCompra: el detalle y el total', () => {
  it('lista cada ítem con cantidad, unidad, precio unitario e importe', () => {
    const oc = texto();

    expect(oc).toContain('1. 31,68 m² — Placa de roca de yeso 12,5 mm');
    expect(oc).toContain('Precio unitario: $ 1.000 — Importe: $ 31.680');
    expect(oc).toContain('2. 26 ml — Montante 70 mm para tabique de durlock');
    expect(oc).toContain('Precio unitario: $ 500 — Importe: $ 13.000');
  });

  it('cierra con el total en la moneda de la cotización', () => {
    expect(texto()).toContain('TOTAL: $ 44.680');
  });

  it('con otra moneda usa su símbolo y no el peso', () => {
    const oc = texto({ cotizacion: { moneda: 'USD' } });

    expect(oc).toContain('TOTAL: US$ 44.680');
  });

  it('una orden sin ítems no se emite', () => {
    expect(() => texto({ items: [] })).toThrow(/ítem/i);
  });

  it('una orden sin estudio que la firme no se emite (PRD §13)', () => {
    expect(() => texto({ estudio: { nombre: '  ' } })).toThrow(/estudio/i);
  });
});

describe('generarOrdenCompra: las condiciones del PRD §13', () => {
  it('dice que el IVA va discriminado cuando los precios son netos', () => {
    const oc = texto();

    expect(oc).toContain('IVA discriminado');
    expect(oc).toContain('no incluyen IVA');
  });

  it('lo dice al revés cuando el proveedor cotizó con IVA adentro', () => {
    const oc = texto({ cotizacion: { incluyeIva: true } });

    expect(oc).toContain('incluyen IVA');
    expect(oc).not.toContain('no incluyen IVA');
  });

  it('trae plazo de entrega, forma de pago y validez de la oferta', () => {
    const oc = texto();

    expect(oc).toContain('Plazo de entrega: 10 días corridos');
    expect(oc).toContain('50% con la orden, 50% contra entrega');
    expect(oc).toContain('validez de 15 días');
  });

  it('cuando el proveedor no declaró plazo ni forma de pago, lo dice', () => {
    const oc = texto({ cotizacion: { plazoDias: null, formaPago: null, validezDias: null } });

    expect(oc).toContain('Plazo de entrega: a confirmar con el proveedor');
    expect(oc).toContain('Forma de pago: a convenir');
    expect(oc).not.toContain('validez de');
  });

  it('recuerda que mano de obra, materiales y flete van separados', () => {
    expect(texto()).toContain('mano de obra, materiales y flete');
  });

  it('suma las notas del estudio cuando las hay', () => {
    const oc = texto({ condiciones: { notas: 'Entregar por la calle lateral.' } });

    expect(oc).toContain('Entregar por la calle lateral.');
  });
});

describe('generarOrdenCompra: MEP y disclaimer', () => {
  it('sin MEP configurado no menciona el dólar', () => {
    expect(texto()).not.toContain('MEP');
  });

  it('con MEP del estudio lo pone como referencia, con su fecha', () => {
    const oc = texto({ estudio: { mepReferencia: { valor: 1450.5, fecha: '2026-08-25' } } });

    expect(oc).toContain('dólar MEP de referencia del estudio: $ 1.450,50 al 25/08/2026');
  });

  it('cierra con el disclaimer profesional', () => {
    expect(texto()).toContain('sujeto a validación del profesional responsable');
  });
});

describe('ordenCompraPdf', () => {
  it('devuelve bytes que son un PDF', async () => {
    const bytes = await ordenCompraPdf(texto());

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('una orden corta entra en una página', async () => {
    const doc = await PDFDocument.load(await ordenCompraPdf(texto()));

    expect(doc.getPageCount()).toBe(1);
  });

  it('una orden de 300 ítems pagina sola', async () => {
    const muchos = Array.from({ length: 300 }, (_, i) => ({
      ...ITEMS[0],
      claveItem: `seco.item_${i}`,
      descripcion: `Ítem ${i + 1} del pedido`,
    }));

    const doc = await PDFDocument.load(await ordenCompraPdf(texto({ items: muchos })));

    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('no revienta con los caracteres del rubro (ñ, á, m², guion largo)', async () => {
    const bytes = await ordenCompraPdf(
      'Corralón San Martín — 31,68 m² de placa · Casa Peña ≥ 3 días “entrega”',
    );

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('una línea larguísima se parte en vez de salirse de la hoja', async () => {
    const largo = 'palabra '.repeat(2000);
    const doc = await PDFDocument.load(await ordenCompraPdf(largo));

    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});
