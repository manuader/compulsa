/**
 * El paquete que recibe el proveedor: el texto del pedido y los recortes de plano.
 *
 * Los tests de `generarRecorte` viven acá —y no en `tests/unit/recortes.test.ts`—
 * porque el brief de la tarea acotó los archivos de test a crear. Son un bloque
 * `describe` independiente: si molesta, se muda entero, sin cambios.
 */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { MARGEN_RECORTE, generarRecorte, generarRecortes } from '@/lib/compulsa/recortes';
import { generarTextoRfq, type CompulsaParaTexto } from '@/lib/compulsa/texto-rfq';
import type { BBox, CondicionesRfq, Fuente, ItemRfq } from '@/types/domain';

const CONDICIONES: CondicionesRfq = {
  ivaDiscriminado: true,
  separarManoObraMateriales: true,
  validezMinimaDias: 7,
  plazoEntregaDias: 15,
  notas: null,
};

const VENTANA: ItemRfq = {
  claveItem: 'aberturas.V2',
  descripcion: 'Ventana V2 corrediza',
  unidad: 'u',
  cantidad: 3,
  presentacion: 'a medida',
  specsCriticas: { vidrio: 'DVH', material: 'aluminio' },
};

const PLACAS: ItemRfq = {
  claveItem: 'seco.placas',
  descripcion: 'Placa de yeso 12,5 mm',
  unidad: 'm2',
  cantidad: 31.68,
  presentacion: '11 placas de 2,88 m²',
  specsCriticas: {},
};

const COMPULSA: CompulsaParaTexto = {
  rubro: 'aberturas',
  zona: 'Vicente López',
  itemsRfq: [VENTANA, PLACAS],
  condiciones: CONDICIONES,
};

const ESTUDIO = 'Estudio Ader';

describe('generarTextoRfq — compliance PRD §13', () => {
  it('se identifica como asistente del estudio, con el nombre del estudio', () => {
    const texto = generarTextoRfq(COMPULSA, ESTUDIO);

    expect(texto).toContain('Estudio Ader');
    expect(texto).toContain('asistente');
  });

  it('exige el nombre del estudio: un pedido anónimo no cumple §13', () => {
    expect(() => generarTextoRfq(COMPULSA, '   ')).toThrow(/estudio/i);
  });

  it('pide la cotización por escrito', () => {
    expect(generarTextoRfq(COMPULSA, ESTUDIO)).toContain('por escrito');
  });

  it('está escrito en es-AR con voseo', () => {
    const texto = generarTextoRfq(COMPULSA, ESTUDIO);

    expect(texto).toContain('¿Nos pasás');
    expect(texto).toContain('Separá');
  });
});

describe('generarTextoRfq — qué dice del proyecto', () => {
  it('nombra el rubro y la zona, y nada más de la obra', () => {
    const texto = generarTextoRfq(COMPULSA, ESTUDIO);

    expect(texto).toContain('aberturas');
    expect(texto).toContain('Vicente López');
  });

  it('sin zona no escribe una zona vacía ni un "null"', () => {
    const texto = generarTextoRfq({ ...COMPULSA, zona: null }, ESTUDIO);

    expect(texto).toContain('para una obra');
    expect(texto).not.toMatch(/null|undefined/);
  });
});

describe('generarTextoRfq — la lista de ítems', () => {
  it('numera los ítems con cantidad, unidad, descripción y presentación', () => {
    const texto = generarTextoRfq(COMPULSA, ESTUDIO);

    expect(texto).toContain('1. 3 u — Ventana V2 corrediza');
    expect(texto).toContain('2. 31,68 m² — Placa de yeso 12,5 mm');
    expect(texto).toContain('11 placas de 2,88 m²');
  });

  it('escribe las specs críticas: sin eso una sustitución no se puede reclamar', () => {
    const texto = generarTextoRfq(COMPULSA, ESTUDIO);

    expect(texto).toContain('vidrio DVH');
    expect(texto).toContain('material aluminio');
  });

  it('un pedido sin ítems no se manda', () => {
    expect(() => generarTextoRfq({ ...COMPULSA, itemsRfq: [] }, ESTUDIO)).toThrow(/ítem/i);
  });
});

describe('generarTextoRfq — condiciones estándar', () => {
  it('el IVA va siempre discriminado', () => {
    expect(generarTextoRfq(COMPULSA, ESTUDIO)).toContain('IVA discriminado');
  });

  it('pide separar mano de obra, materiales y flete solo si la compulsa lo pide', () => {
    const con = generarTextoRfq(COMPULSA, ESTUDIO);
    const sin = generarTextoRfq(
      { ...COMPULSA, condiciones: { ...CONDICIONES, separarManoObraMateriales: false } },
      ESTUDIO,
    );

    expect(con).toContain('mano de obra, materiales y flete');
    expect(sin).not.toContain('mano de obra, materiales y flete');
  });

  it('dice la validez mínima y el plazo de entrega pedidos', () => {
    const texto = generarTextoRfq(COMPULSA, ESTUDIO);

    expect(texto).toContain('7 días');
    expect(texto).toContain('15 días');
  });

  it('sin plazo pedido, se lo pregunta al proveedor', () => {
    const texto = generarTextoRfq(
      { ...COMPULSA, condiciones: { ...CONDICIONES, plazoEntregaDias: null } },
      ESTUDIO,
    );

    expect(texto).toMatch(/plazo de entrega/i);
    expect(texto).not.toContain('15 días');
  });

  it('suma las notas del estudio cuando las hay', () => {
    const texto = generarTextoRfq(
      { ...COMPULSA, condiciones: { ...CONDICIONES, notas: 'Entrega en obra, con descarga.' } },
      ESTUDIO,
    );

    expect(texto).toContain('Entrega en obra, con descarga.');
  });
});

// ---------------------------------------------------------------------------
// Recortes de plano (RF-703)
// ---------------------------------------------------------------------------

/** A4 vertical en puntos PostScript, que es lo que devuelve pdf-lib por default. */
const A4_ANCHO = 595.28;
const A4_ALTO = 841.89;

async function paginaA4(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([A4_ANCHO, A4_ALTO]);
  return doc.save();
}

async function cropBoxDe(bytes: Uint8Array): Promise<{ x: number; y: number; width: number; height: number }> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPage(0).getCropBox();
}

describe('generarRecorte — el bbox normalizado al CropBox del PDF', () => {
  it('invierte el eje Y: el bbox va de arriba-izquierda y el PDF de abajo-izquierda', async () => {
    // bbox [0,10 · 0,20 · 0,30 · 0,40] + 5 % de margen ⇒ x 0,05–0,45 · y(top) 0,15–0,65.
    const bbox: BBox = [0.1, 0.2, 0.3, 0.4];

    const crop = await cropBoxDe(await generarRecorte(await paginaA4(), bbox));

    expect(crop.x).toBeCloseTo(0.05 * A4_ANCHO, 2); //  29,76 pt
    expect(crop.width).toBeCloseTo(0.4 * A4_ANCHO, 2); // 238,11 pt
    // el borde inferior del recorte está a (1 − 0,65) del piso de la página
    expect(crop.y).toBeCloseTo(0.35 * A4_ALTO, 2); // 294,66 pt
    expect(crop.height).toBeCloseTo(0.5 * A4_ALTO, 2); // 420,95 pt
  });

  it('el margen default es el 5 % de la lámina', async () => {
    expect(MARGEN_RECORTE).toBe(0.05);

    const conDefault = await cropBoxDe(await generarRecorte(await paginaA4(), [0.4, 0.4, 0.2, 0.2]));
    const explicito = await cropBoxDe(
      await generarRecorte(await paginaA4(), [0.4, 0.4, 0.2, 0.2], 0.05),
    );

    expect(conDefault).toEqual(explicito);
  });

  it('un margen más grande agranda el recorte para los dos lados', async () => {
    const crop = await cropBoxDe(await generarRecorte(await paginaA4(), [0.4, 0.4, 0.2, 0.2], 0.1));

    expect(crop.x).toBeCloseTo(0.3 * A4_ANCHO, 2);
    expect(crop.width).toBeCloseTo(0.4 * A4_ANCHO, 2);
    expect(crop.y).toBeCloseTo(0.3 * A4_ALTO, 2);
    expect(crop.height).toBeCloseTo(0.4 * A4_ALTO, 2);
  });

  it('recorta contra el borde: el margen no se sale de la página', async () => {
    const crop = await cropBoxDe(await generarRecorte(await paginaA4(), [0, 0, 1, 1]));

    expect(crop.x).toBeCloseTo(0, 2);
    expect(crop.y).toBeCloseTo(0, 2);
    expect(crop.width).toBeCloseTo(A4_ANCHO, 2);
    expect(crop.height).toBeCloseTo(A4_ALTO, 2);
  });

  it('no toca el MediaBox: el original de la lámina queda entero', async () => {
    const recorte = await generarRecorte(await paginaA4(), [0.1, 0.2, 0.3, 0.4]);

    const media = (await PDFDocument.load(recorte)).getPage(0).getMediaBox();
    expect(media.width).toBeCloseTo(A4_ANCHO, 2);
    expect(media.height).toBeCloseTo(A4_ALTO, 2);
  });

  it('rechaza un bbox degenerado y un PDF de más de una página', async () => {
    await expect(generarRecorte(await paginaA4(), [0.1, 0.2, 0, 0.4])).rejects.toThrow(/bbox/i);

    const doble = await PDFDocument.create();
    doble.addPage([A4_ANCHO, A4_ALTO]);
    doble.addPage([A4_ANCHO, A4_ALTO]);
    await expect(generarRecorte(await doble.save(), [0.1, 0.2, 0.3, 0.4])).rejects.toThrow(/página/i);
  });
});

describe('generarRecortes — un recorte por fuente del ítem', () => {
  const fuente = (laminaId: string, bbox: BBox): Fuente => ({ laminaId, bbox });

  it('recorta la lámina de cada fuente y devuelve el ítem al que corresponde', async () => {
    const laminas = [
      { laminaId: 'lam-1', pdfBytes: await paginaA4() },
      { laminaId: 'lam-2', pdfBytes: await paginaA4() },
    ];
    const fuentes = new Map<string, Fuente[]>([
      ['aberturas.V2', [fuente('lam-1', [0.1, 0.2, 0.3, 0.4]), fuente('lam-2', [0.5, 0.5, 0.2, 0.2])]],
      ['seco.placas', [fuente('lam-1', [0.6, 0.1, 0.2, 0.2])]],
    ]);

    const recortes = await generarRecortes([VENTANA, PLACAS], laminas, fuentes);

    expect(recortes.map((r) => [r.claveItem, r.laminaId])).toEqual([
      ['aberturas.V2', 'lam-1'],
      ['aberturas.V2', 'lam-2'],
      ['seco.placas', 'lam-1'],
    ]);
    expect(await cropBoxDe(recortes[0]!.pdfBytes)).toMatchObject({
      width: expect.closeTo(0.4 * A4_ANCHO, 2),
    });
  });

  it('no repite el mismo recorte dos veces ni inventa el de una lámina que no tiene', async () => {
    const laminas = [{ laminaId: 'lam-1', pdfBytes: await paginaA4() }];
    const fuentes = new Map<string, Fuente[]>([
      [
        'aberturas.V2',
        [
          fuente('lam-1', [0.1, 0.2, 0.3, 0.4]),
          fuente('lam-1', [0.1, 0.2, 0.3, 0.4]),
          fuente('lam-9', [0.1, 0.2, 0.3, 0.4]),
        ],
      ],
    ]);

    const recortes = await generarRecortes([VENTANA], laminas, fuentes);

    expect(recortes).toHaveLength(1);
    expect(recortes[0]!.laminaId).toBe('lam-1');
  });

  it('un ítem sin fuentes no genera recortes (y no rompe)', async () => {
    const recortes = await generarRecortes([VENTANA], [], new Map());

    expect(recortes).toEqual([]);
  });
});
