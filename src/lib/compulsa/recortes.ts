/**
 * Recortes de plano para adjuntar al pedido de cotización (RF-703).
 *
 * El proveedor no necesita la lámina entera: necesita ver **su** ítem. Un
 * recorte es la misma lámina con el `CropBox` puesto sobre el bbox de la fuente
 * del ítem, más un margen para que el pedazo tenga contexto (una ventana sin
 * el muro alrededor no se entiende).
 *
 * La trampa del módulo es el eje Y. Los bbox del dominio son normalizados 0–1
 * con **origen arriba-izquierda** (así los devuelven los providers de análisis,
 * así los dibuja el visor); las cajas de un PDF son puntos PostScript con
 * **origen abajo-izquierda**. Convertir de uno a otro no es escalar: hay que dar
 * vuelta la coordenada (`abajo = alto − yInferiorDelBbox`). Sin eso el recorte
 * sale espejado en vertical y muestra el sector opuesto del plano.
 *
 * Se toca solo el `CropBox`, nunca el `MediaBox`: el contenido de la lámina
 * queda entero (CLAUDE.md §6, los originales no se modifican) y lo único que
 * cambia es qué parte se muestra e imprime.
 *
 * Transformación pura de bytes a bytes: sin DB, sin red, sin filesystem.
 */
import { PDFDocument } from 'pdf-lib';
import type { BBox, Fuente, ItemRfq } from '@/types/domain';

/** Margen default del recorte: 5 % de la lámina de cada lado (RF-703). */
export const MARGEN_RECORTE = 0.05;

/** Una lámina disponible para recortar, con sus bytes ya traídos del storage. */
export interface LaminaRecorte {
  laminaId: string;
  /** PDF de UNA página. */
  pdfBytes: Uint8Array;
}

/** El recorte de un ítem sobre una lámina puntual. */
export interface RecorteItem {
  claveItem: string;
  laminaId: string;
  bbox: BBox;
  pdfBytes: Uint8Array;
}

function acotar01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * La lámina con el `CropBox` sobre el bbox, ampliado `margen` (en unidades
 * normalizadas: `0,05` = 5 % del ancho y del alto de la página) hacia cada lado
 * y recortado contra el borde.
 */
export async function generarRecorte(
  pdfBytes: Uint8Array,
  bbox: BBox,
  margen: number = MARGEN_RECORTE,
): Promise<Uint8Array> {
  const [x, y, ancho, alto] = bbox;
  if (![x, y, ancho, alto].every((n) => Number.isFinite(n)) || ancho <= 0 || alto <= 0) {
    throw new RangeError(`El bbox del recorte tiene que tener ancho y alto mayores a 0 (recibí [${bbox.join(', ')}]).`);
  }

  const documento = await PDFDocument.load(pdfBytes);
  if (documento.getPageCount() !== 1) {
    throw new RangeError(
      `El recorte trabaja sobre una lámina de una sola página (recibí ${documento.getPageCount()}).`,
    );
  }

  const pagina = documento.getPage(0);
  const media = pagina.getMediaBox();
  const holgura = Math.max(0, margen);

  // Bordes del recorte en coordenadas normalizadas, con el eje Y todavía
  // apuntando para abajo (origen arriba-izquierda, como el bbox).
  const izquierda = acotar01(x - holgura);
  const derecha = acotar01(x + ancho + holgura);
  const arriba = acotar01(y - holgura);
  const abajo = acotar01(y + alto + holgura);

  pagina.setCropBox(
    media.x + izquierda * media.width,
    // Acá se da vuelta el eje: el borde de abajo del recorte está a
    // (1 − abajo) del piso de la página.
    media.y + (1 - abajo) * media.height,
    (derecha - izquierda) * media.width,
    (abajo - arriba) * media.height,
  );

  return documento.save();
}

function claveDeRecorte(laminaId: string, bbox: BBox): string {
  return `${laminaId}|${bbox.join(',')}`;
}

/**
 * Un recorte por cada fuente de cada ítem del RFQ, en el orden de los ítems.
 *
 * `ItemRfq` no lleva `fuentes` (el snapshot es lo que se cotiza, no de dónde
 * salió), así que la provenance llega aparte: `fuentesPorItem` es
 * `claveItem → fuentes del ItemComputo que lo originó`. Las fuentes cuya lámina
 * no está en `laminas` se saltean —el core decide qué láminas bajar del
 * storage— y las repetidas (misma lámina, mismo bbox) se recortan una sola vez.
 */
export async function generarRecortes(
  itemsRfq: readonly ItemRfq[],
  laminas: readonly LaminaRecorte[],
  fuentesPorItem: ReadonlyMap<string, readonly Fuente[]>,
  margen: number = MARGEN_RECORTE,
): Promise<RecorteItem[]> {
  const porId = new Map(laminas.map((lamina) => [lamina.laminaId, lamina.pdfBytes]));
  const recortes: RecorteItem[] = [];

  for (const item of itemsRfq) {
    const vistas = new Set<string>();
    for (const fuente of fuentesPorItem.get(item.claveItem) ?? []) {
      const bytes = porId.get(fuente.laminaId);
      if (bytes === undefined) continue;

      const clave = claveDeRecorte(fuente.laminaId, fuente.bbox);
      if (vistas.has(clave)) continue;
      vistas.add(clave);

      recortes.push({
        claveItem: item.claveItem,
        laminaId: fuente.laminaId,
        bbox: fuente.bbox,
        pdfBytes: await generarRecorte(bytes, fuente.bbox, margen),
      });
    }
  }

  return recortes;
}
