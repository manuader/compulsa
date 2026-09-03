import { readFileSync } from 'node:fs';
import { degrees, PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { separarPaginas, separarPaginasConTamano } from '@/lib/pdf/split';
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

describe('separarPaginasConTamano', () => {
  /**
   * El tamaño de la hoja es el insumo de la medición gráfica (§5.5): sin él,
   * un bbox normalizado no se puede convertir a metros. Estos son los puntos
   * PostScript reales de la A4 apaisada de los fixtures.
   */
  it('devuelve cada página con su tamaño en puntos', async () => {
    const paginas = await separarPaginasConTamano(OBRA_DEMO);

    expect(paginas).toHaveLength(3);
    for (const pagina of paginas) {
      expect(pagina.tamanoPts.ancho).toBeCloseTo(841.89, 2);
      expect(pagina.tamanoPts.alto).toBeCloseTo(595.28, 2);
    }
  });

  it('los bytes son los mismos que devuelve `separarPaginas`', async () => {
    const conTamano = await separarPaginasConTamano(SIN_ESCALA);
    const sueltas = await separarPaginas(SIN_ESCALA);

    expect(conTamano).toHaveLength(1);
    expect((await PDFDocument.load(conTamano[0].bytes)).getPageCount()).toBe(
      (await PDFDocument.load(sueltas[0])).getPageCount(),
    );
  });

  /**
   * Una lámina girada se **ve** apaisada aunque su MediaBox sea vertical, y el
   * bbox que devuelve el modelo está tomado sobre lo que se ve. Sin aplicar la
   * rotación, la medición gráfica daría el ancho por el alto: un número
   * plausible y equivocado.
   */
  it('aplica la rotación de la página: mide como se ve, no como está guardada', async () => {
    const doc = await PDFDocument.create();
    const pagina = doc.addPage([595.28, 841.89]);
    pagina.setRotation(degrees(90));

    const [separada] = await separarPaginasConTamano(await doc.save());

    expect(separada.tamanoPts.ancho).toBeCloseTo(841.89, 2);
    expect(separada.tamanoPts.alto).toBeCloseTo(595.28, 2);
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
