/**
 * Separación de un PDF subido en una lámina por página.
 *
 * El original es inmutable (CLAUDE.md §6): esto no lo toca, devuelve documentos
 * nuevos. Cada lámina queda como un PDF de una sola página, que es lo que el
 * pipeline guarda y lo que los providers de análisis reciben en `LaminaInput`.
 */
import { PDFDocument } from 'pdf-lib';

/**
 * Devuelve un PDF de una página por cada página del original, en orden.
 *
 * Lanza si los bytes no son un PDF legible; el pipeline lo captura y marca el
 * documento en `error`.
 */
export async function separarPaginas(pdfBytes: Uint8Array): Promise<Uint8Array[]> {
  const original = await PDFDocument.load(pdfBytes);
  const total = original.getPageCount();

  const laminas: Uint8Array[] = [];
  for (let indice = 0; indice < total; indice++) {
    const lamina = await PDFDocument.create();
    const [pagina] = await lamina.copyPages(original, [indice]);
    lamina.addPage(pagina);
    laminas.push(await lamina.save());
  }
  return laminas;
}
