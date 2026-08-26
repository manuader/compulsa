/**
 * Export XLSX (RF-405): el workbook que se baja del tablero y de la planilla.
 *
 * El test genera el libro con ítems conocidos, lo **relee con exceljs** (no mira
 * la estructura interna del generador) y pinnea celdas exactas: es la única
 * forma de garantizar que las cantidades viajan como números y no como texto,
 * que es lo que rompe un cómputo cuando el corralón lo abre en Excel.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import {
  COLUMNAS_ITEM,
  DISCLAIMER,
  generarXlsx,
  nombreArchivoXlsx,
  type EstadosRubro,
  type ItemExport,
  type LaminaExport,
  type ObraExport,
} from '@/lib/export/xlsx';
import { PLANTILLAS } from '@/lib/rubros';

const OBRA: ObraExport = {
  nombre: 'Casa Pérez',
  zona: 'Villa Crespo, CABA',
  tipo: 'reforma',
  moneda: 'ARS',
};

const LAMINAS: LaminaExport[] = [
  { id: 'lam-1', codigo: 'A-01', titulo: 'Planta baja' },
  // Sin código: el export cae al título, que es lo que el arquitecto reconoce.
  { id: 'lam-2', codigo: null, titulo: 'Corte A-A' },
];

const PLACAS: ItemExport = {
  rubro: 'seco',
  claveItem: 'seco.placas',
  descripcion: 'Placas de roca de yeso 12,5 mm (durlock)',
  unidad: 'm2',
  cantNeta: 31.68,
  desperdicioPct: 10,
  cantCompra: 34.85,
  presentacion: '13 placas de 2,88 m²',
  origen: 'deducido',
  confianza: 0.86,
  estado: 'activo',
  fuentesJson: [
    { laminaId: 'lam-1', bbox: [0.1, 0.2, 0.3, 0.4] },
    { laminaId: 'lam-2', bbox: [0.5, 0.1, 0.2, 0.2] },
  ],
};

const LATEX: ItemExport = {
  rubro: 'pintura',
  claveItem: 'pintura.latex_interior',
  descripcion: 'Látex interior, 2 manos',
  unidad: 'l',
  cantNeta: 24.5,
  desperdicioPct: 5,
  cantCompra: 25.73,
  presentacion: '1 lata de 20 L + 1 lata de 4 L + 2 latas de 1 L',
  origen: 'supuesto',
  confianza: 0.72,
  estado: 'activo',
  fuentesJson: [{ laminaId: 'lam-1', bbox: [0.1, 0.6, 0.4, 0.3] }],
};

/** Anulado (no se borra: `src/db/CLAUDE.md` §7). Jamás puede aparecer en el export. */
const MONTANTES_ANULADO: ItemExport = {
  rubro: 'seco',
  claveItem: 'seco.montantes',
  descripcion: 'Montantes 70 mm',
  unidad: 'u',
  cantNeta: 26,
  desperdicioPct: 0,
  cantCompra: 26,
  presentacion: '26 barras de 2,60 m',
  origen: 'deducido',
  confianza: 0.9,
  estado: 'anulado',
  fuentesJson: [{ laminaId: 'lam-1', bbox: [0.1, 0.2, 0.3, 0.4] }],
};

const ITEMS: ItemExport[] = [PLACAS, MONTANTES_ANULADO, LATEX];

const ESTADOS: EstadosRubro = { seco: 'aprobado', pintura: 'revision' };

const FECHA = new Date('2026-08-25T15:30:00.000Z');

const HOJA_SECO = PLANTILLAS.seco.nombre;
const HOJA_PINTURA = PLANTILLAS.pintura.nombre;

async function releer(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs tipa `load` con su propio `Buffer` (que extiende `ArrayBuffer`), pero
  // en runtime digiere el Buffer de Node sin chistar: el cast es por la firma.
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

function fila(hoja: ExcelJS.Worksheet, n: number): unknown[] {
  const valores = hoja.getRow(n).values as unknown[];
  return valores.slice(1); // exceljs deja el índice 0 vacío
}

describe('generarXlsx', () => {
  it('arma una hoja por rubro, la consolidada y las referencias', async () => {
    const wb = await releer(await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA }));

    expect(wb.worksheets.map((h) => h.name)).toEqual([
      PLANTILLAS.aberturas.nombre,
      HOJA_SECO,
      HOJA_PINTURA,
      PLANTILLAS.gruesa.nombre,
      'Consolidado',
      'Referencias',
    ]);
  });

  it('escribe las columnas exactas del contrato', async () => {
    const wb = await releer(await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA }));

    expect(COLUMNAS_ITEM).toEqual([
      'Clave',
      'Descripción',
      'Unidad',
      'Cant. neta',
      'Desp. %',
      'Cant. compra',
      'Presentación',
      'Origen',
      'Confianza',
      'Estado rubro',
      'Lámina(s) fuente',
    ]);
    expect(fila(wb.getWorksheet(HOJA_SECO)!, 1)).toEqual([...COLUMNAS_ITEM]);
  });

  it('pinnea las celdas del ítem y manda los números como números', async () => {
    const wb = await releer(await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA }));
    const seco = wb.getWorksheet(HOJA_SECO)!;

    expect(seco.getCell('A2').value).toBe('seco.placas');
    expect(seco.getCell('B2').value).toBe('Placas de roca de yeso 12,5 mm (durlock)');
    expect(seco.getCell('C2').value).toBe('m²');
    expect(seco.getCell('D2').value).toBe(31.68);
    expect(typeof seco.getCell('D2').value).toBe('number');
    expect(seco.getCell('D2').numFmt).toBe('0.00');
    expect(seco.getCell('E2').value).toBe(10);
    expect(seco.getCell('F2').value).toBe(34.85);
    expect(typeof seco.getCell('F2').value).toBe('number');
    expect(seco.getCell('F2').numFmt).toBe('0.00');
    expect(seco.getCell('G2').value).toBe('13 placas de 2,88 m²');
    expect(seco.getCell('H2').value).toBe('Deducido');
    expect(seco.getCell('I2').value).toBe(0.86);
    expect(seco.getCell('J2').value).toBe('Aprobado');
    // Código si lo hay, título si no: nunca el uuid crudo cuando se lo puede nombrar.
    expect(seco.getCell('K2').value).toBe('A-01, Corte A-A');
  });

  it('deja el rubro sin estado en borrador y traduce el estado de revisión', async () => {
    const wb = await releer(await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA }));

    expect(wb.getWorksheet(HOJA_PINTURA)!.getCell('J2').value).toBe('En revisión');
    // `aberturas` no tiene fila en `computo_rubros`: el default es borrador.
    expect(wb.getWorksheet('Consolidado')!.getCell('K2').value).toBe('Aprobado');
  });

  it('NO exporta el ítem anulado', async () => {
    const wb = await releer(await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA }));
    const seco = wb.getWorksheet(HOJA_SECO)!;

    expect(seco.rowCount).toBe(2); // encabezado + placas, nada más
    expect(seco.getCell('A3').value).toBeNull();

    const claves: unknown[] = [];
    wb.getWorksheet('Consolidado')!.eachRow((row) => claves.push(row.getCell(2).value));
    expect(claves).toEqual(['Clave', 'seco.placas', 'pintura.latex_interior']);
  });

  it('la consolidada suma la columna Rubro adelante y mantiene el resto', async () => {
    const wb = await releer(await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA }));
    const cons = wb.getWorksheet('Consolidado')!;

    expect(fila(cons, 1)).toEqual(['Rubro', ...COLUMNAS_ITEM]);
    expect(cons.getCell('A2').value).toBe(HOJA_SECO);
    expect(cons.getCell('C2').value).toBe('Placas de roca de yeso 12,5 mm (durlock)');
    expect(cons.getCell('E2').value).toBe(31.68);
    expect(cons.getCell('G2').value).toBe(34.85);
    expect(cons.getCell('A3').value).toBe(HOJA_PINTURA);
    expect(cons.rowCount).toBe(3);
  });

  it('deja el disclaimer profesional, la obra y la leyenda de orígenes en Referencias', async () => {
    const wb = await releer(await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA }));
    const ref = wb.getWorksheet('Referencias')!;

    const texto: string[] = [];
    ref.eachRow((row) => {
      row.eachCell((cell) => texto.push(String(cell.value ?? '')));
    });
    const plano = texto.join('\n');

    expect(DISCLAIMER).toBe(
      'Cómputo asistido por Compulsa — sujeto a validación del profesional responsable',
    );
    expect(plano).toContain(DISCLAIMER);
    expect(plano).toContain('Casa Pérez');
    expect(plano).toContain('Villa Crespo, CABA');
    expect(plano).toContain('25/08/2026');
    expect(plano).toContain('Explícito');
    expect(plano).toContain('Deducido');
    expect(plano).toContain('Supuesto');
  });

  it('con un rubro pedido exporta solo esa hoja y las referencias', async () => {
    const wb = await releer(
      await generarXlsx(OBRA, ITEMS, ESTADOS, LAMINAS, { fecha: FECHA, rubro: 'pintura' }),
    );

    expect(wb.worksheets.map((h) => h.name)).toEqual([HOJA_PINTURA, 'Referencias']);
    expect(wb.getWorksheet(HOJA_PINTURA)!.getCell('B2').value).toBe('Látex interior, 2 manos');
    expect(wb.getWorksheet(HOJA_PINTURA)!.rowCount).toBe(2);
  });

  it('un ítem manual sin fuentes deja la celda de láminas vacía, no un invento', async () => {
    const manual: ItemExport = { ...LATEX, claveItem: 'pintura.manual', fuentesJson: [] };
    const wb = await releer(
      await generarXlsx(OBRA, [manual], ESTADOS, LAMINAS, { fecha: FECHA, rubro: 'pintura' }),
    );

    expect(wb.getWorksheet(HOJA_PINTURA)!.getCell('K2').value).toBeNull();
  });

  it('cae al id de la lámina cuando no la puede nombrar', async () => {
    const huerfano: ItemExport = {
      ...LATEX,
      fuentesJson: [{ laminaId: 'lam-borrada', bbox: [0, 0, 1, 1] }],
    };
    const wb = await releer(
      await generarXlsx(OBRA, [huerfano], ESTADOS, LAMINAS, { fecha: FECHA, rubro: 'pintura' }),
    );

    expect(wb.getWorksheet(HOJA_PINTURA)!.getCell('K2').value).toBe('lam-borrada');
  });

  it('un rubro sin ítems queda como hoja vacía con encabezado, no desaparece', async () => {
    const wb = await releer(await generarXlsx(OBRA, [], ESTADOS, LAMINAS, { fecha: FECHA }));
    const aberturas = wb.getWorksheet(PLANTILLAS.aberturas.nombre)!;

    expect(fila(aberturas, 1)).toEqual([...COLUMNAS_ITEM]);
    expect(aberturas.rowCount).toBe(1);
  });
});

describe('nombreArchivoXlsx', () => {
  it('arma computo-<slug>-<yyyy-mm-dd>.xlsx sin acentos', () => {
    expect(nombreArchivoXlsx('Casa Pérez', FECHA)).toBe('computo-casa-perez-2026-08-25.xlsx');
  });

  it('colapsa separadores y no deja guiones colgando', () => {
    expect(nombreArchivoXlsx('  Ampliación // Dpto 3º "B"  ', FECHA)).toBe(
      'computo-ampliacion-dpto-3-b-2026-08-25.xlsx',
    );
  });

  it('usa el día de Buenos Aires, no el UTC', () => {
    // 00:30 UTC del 26 son las 21:30 del 25 en Buenos Aires (UTC-3).
    expect(nombreArchivoXlsx('Obra', new Date('2026-08-26T00:30:00.000Z'))).toBe(
      'computo-obra-2026-08-25.xlsx',
    );
  });

  it('sobrevive a un nombre que queda vacío al normalizarlo', () => {
    expect(nombreArchivoXlsx('◆◆◆', FECHA)).toBe('computo-obra-2026-08-25.xlsx');
  });
});
