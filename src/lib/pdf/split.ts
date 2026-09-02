/**
 * Separación de un PDF subido en una lámina por página.
 *
 * El original es inmutable (CLAUDE.md §6): esto no lo toca, devuelve documentos
 * nuevos. Cada lámina queda como un PDF de una sola página, que es lo que el
 * pipeline guarda y lo que los providers de análisis reciben en `LaminaInput`.
 *
 * Además del PDF de cada página, esto devuelve **cuánto mide esa página en
 * puntos PostScript**. No es un detalle del formato: es el insumo de la
 * medición gráfica (§5.5), que convierte el bbox normalizado de una entidad a
 * metros de obra y para eso necesita saber en qué hoja está dibujada — una A1 y
 * una A4 con el mismo bbox y la misma escala no miden lo mismo.
 */
import { PDFDocument } from 'pdf-lib';

import type { TamanoPagina } from '@/lib/computo/medicion';

/**
 * El tamaño de la hoja en puntos, tal como lo pide `medidaGrafica()`. Se
 * re-exporta el tipo del dominio en vez de declarar uno igual: si algún día el
 * contrato de la medición cambia, no hay dos definiciones que puedan discrepar.
 */
export type { TamanoPagina };

/** Una página del original: su PDF de una hoja y cuánto mide esa hoja. */
export interface PaginaSeparada {
  bytes: Uint8Array;
  /** Tamaño **visible** de la hoja, con la rotación ya aplicada. */
  tamanoPts: TamanoPagina;
}

/**
 * Devuelve un PDF de una página por cada página del original, en orden.
 *
 * Lanza si los bytes no son un PDF legible; el pipeline lo captura y marca el
 * documento en `error`.
 */
export async function separarPaginas(pdfBytes: Uint8Array): Promise<Uint8Array[]> {
  return (await separarPaginasConTamano(pdfBytes)).map((pagina) => pagina.bytes);
}

/**
 * Lo mismo que `separarPaginas`, pero con el tamaño de cada hoja.
 *
 * Es la entrada que usa el pipeline: separa una sola vez y se queda con las dos
 * cosas que necesita (los bytes para guardar y analizar, el tamaño para medir
 * sobre el dibujo). Volver a abrir el PDF más tarde solo para preguntarle
 * cuánto mide sería parsearlo dos veces.
 */
export async function separarPaginasConTamano(pdfBytes: Uint8Array): Promise<PaginaSeparada[]> {
  const original = await PDFDocument.load(pdfBytes);
  const total = original.getPageCount();

  const paginas: PaginaSeparada[] = [];
  for (let indice = 0; indice < total; indice++) {
    const tamanoPts = tamanoVisible(original, indice);
    const lamina = await PDFDocument.create();
    const [pagina] = await lamina.copyPages(original, [indice]);
    lamina.addPage(pagina);
    paginas.push({ bytes: await lamina.save(), tamanoPts });
  }
  return paginas;
}

/**
 * Cuánto mide la página `indice` **como se ve**, en puntos.
 *
 * `getSize()` devuelve el MediaBox crudo, que ignora la rotación: una A1
 * apaisada guardada como A1 vertical + `/Rotate 90` mediría al revés, y el bbox
 * normalizado que el modelo devuelve está tomado sobre la lámina **renderizada**
 * (pdf.js sí aplica la rotación). Sin este swap, medir sobre una lámina rotada
 * daría el ancho por el alto — un número plausible y equivocado, que es la peor
 * clase de error que puede producir esto.
 */
function tamanoVisible(documento: PDFDocument, indice: number): TamanoPagina {
  const pagina = documento.getPage(indice);
  const { width, height } = pagina.getSize();
  const giro = Math.abs(pagina.getRotation().angle % 180);
  return giro === 90 ? { ancho: height, alto: width } : { ancho: width, alto: height };
}
