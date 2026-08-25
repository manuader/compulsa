import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { separarPaginas } from '@/lib/pdf/split';
import { extraerTexto } from '@/lib/pdf/texto';

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

describe('extraerTexto', () => {
  it('lee el rótulo de la primera lámina de obra-demo', async () => {
    const [p1] = await separarPaginas(OBRA_DEMO);

    expect(await extraerTexto(p1)).toContain('PLANTA PB');
  });

  it('devuelve el texto de todas las páginas de un PDF multipágina', async () => {
    const texto = await extraerTexto(OBRA_DEMO);

    expect(texto).toContain('PLANTA PB — 1:100');
    expect(texto).toContain('CORTE A-A — 1:100');
    expect(texto).toContain('PLANILLA DE CARPINTERÍAS');
  });

  it('cada lámina separada conserva solo su propio texto', async () => {
    const laminas = await separarPaginas(OBRA_DEMO);

    const corte = await extraerTexto(laminas[1]);
    expect(corte).toContain('CORTE A-A');
    expect(corte).toContain('Cielorraso Estar');
    expect(corte).not.toContain('PLANTA PB');
  });

  it('no consume los bytes de entrada: el mismo buffer se puede volver a leer', async () => {
    await extraerTexto(SIN_ESCALA);

    expect(await extraerTexto(SIN_ESCALA)).toContain('DETALLE CONSTRUCTIVO');
  });
});
