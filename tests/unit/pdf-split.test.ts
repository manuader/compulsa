import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { separarPaginas } from '@/lib/pdf/split';

const OBRA_DEMO = new Uint8Array(readFileSync(new URL('../fixtures/pdfs/obra-demo.pdf', import.meta.url)));
const SIN_ESCALA = new Uint8Array(readFileSync(new URL('../fixtures/pdfs/sin-escala.pdf', import.meta.url)));

describe('separarPaginas', () => {
  it('parte un PDF de 3 páginas en 3 PDFs de una página cada uno', async () => {
    const laminas = await separarPaginas(OBRA_DEMO);

    expect(laminas).toHaveLength(3);
    for (const bytes of laminas) {
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
    }
  });

  it('conserva el tamaño A4 apaisado de la lámina original', async () => {
    const [primera] = await separarPaginas(OBRA_DEMO);

    const { width, height } = (await PDFDocument.load(primera)).getPage(0).getSize();
    expect(Math.round(width)).toBe(842);
    expect(Math.round(height)).toBe(595);
  });

  it('un PDF de una sola página devuelve una sola lámina', async () => {
    expect(await separarPaginas(SIN_ESCALA)).toHaveLength(1);
  });

  it('no consume los bytes de entrada: se puede volver a separar el mismo PDF', async () => {
    await separarPaginas(OBRA_DEMO);

    expect(await separarPaginas(OBRA_DEMO)).toHaveLength(3);
  });
});
