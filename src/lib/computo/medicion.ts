/**
 * Medición gráfica sobre el dibujo: el último respaldo de un campo de medida.
 *
 * Cuando la documentación no escribe la cota en ningún lado —ni en la planta, ni
 * en el corte, ni en la planilla— queda una sola fuente: el dibujo mismo. Si la
 * lámina declara una escala usable, el rectángulo que ocupa una entidad se puede
 * convertir a metros de obra. Un PDF mide todo en **puntos PostScript** (1 pt =
 * 1/72"), así que la cuenta completa es:
 *
 *     metros = puntos / 72 × 0,0254 × N        (para una escala 1:N)
 *
 * Es la inferencia más débil del sistema y el código lo trata como tal: el dato
 * que sale de acá nace con confianza fija 0,5 y deja el ítem en `origen:
 * 'inferido'` (§5.5), nunca en `deducido`. Que el número exista no lo vuelve
 * documentación: lo vuelve una medición, con su método escrito al lado.
 *
 * Módulo puro: sin I/O, sin DB, sin red. Solo aritmética y una regla —**sin
 * escala no se mide**—, que es la que evita que una lámina con «esc. gráfica»
 * en el rótulo produzca un cómputo entero de números inventados.
 */
import { redondear2 } from '@/lib/computo/unidades';
import type { BBox } from '@/types/domain';

/** Puntos PostScript por pulgada: la unidad en la que un PDF mide todo. */
const PUNTOS_POR_PULGADA = 72;

/** Metros que tiene una pulgada, exactos por definición. */
const METROS_POR_PULGADA = 0.0254;

/** El tamaño real de la hoja, en puntos PostScript (lo que devuelve pdfjs). */
export interface TamanoPagina {
  ancho: number;
  alto: number;
}

/** Lo que mide en la obra el rectángulo medido en la lámina. */
export interface MedidaGrafica {
  anchoM: number;
  altoM: number;
}

/**
 * Una escala usable es exactamente `1:N`, con o sin espacios alrededor de los
 * dos puntos. Nada más: ni `Esc. 1:50` (el rótulo suele traer la palabra, pero
 * el dato que llega acá ya viene normalizado), ni `2:100`, ni la escala gráfica.
 */
const ESCALA_1_EN_N = /^1\s*:\s*(\d+)$/;

/**
 * El `N` de una escala `1:N`, o `null` si el texto no es una escala con la que
 * se pueda medir.
 *
 * Existe aparte de `medidaGrafica` porque el pipeline necesita la pregunta sola:
 * «¿esta lámina se puede medir?» se responde antes de tener un bbox, y sin
 * inventarle un rectángulo a la lámina para averiguarlo.
 */
export function denominadorDeEscala(escala: string): number | null {
  const encontrado = ESCALA_1_EN_N.exec(escala.trim());
  if (encontrado === null) return null;
  const n = Number(encontrado[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** ¿Es un número que se puede medir? (finito, y no negativo si es una medida). */
function medible(n: number, positivo: boolean): boolean {
  if (!Number.isFinite(n)) return false;
  return positivo ? n > 0 : n >= 0;
}

/**
 * Cuánto mide en la obra el rectángulo `bbox` de una lámina a escala `escala`.
 *
 * `bbox` es el rectángulo normalizado 0–1 de siempre (`[x, y, ancho, alto]`), así
 * que primero vuelve a puntos multiplicando por el tamaño de la hoja: el bbox no
 * sabe en qué hoja está dibujado y una A1 no mide lo mismo que una A4.
 *
 * Devuelve `null` —y no un número— cuando la escala no es un `1:N` o cuando la
 * página o el bbox no son medibles. Es la mitad importante de la función: medir
 * con una escala que no se conoce es la forma más cara de inventar un dato.
 *
 * Un bbox de área cero sí mide cero: es aritmética honesta, y quien llama decide
 * si un 0 le sirve (el pipeline solo escribe medidas mayores que cero).
 */
export function medidaGrafica(
  bbox: BBox,
  paginaPts: TamanoPagina,
  escala: string,
): MedidaGrafica | null {
  const n = denominadorDeEscala(escala);
  if (n === null) return null;
  if (!medible(paginaPts.ancho, true) || !medible(paginaPts.alto, true)) return null;

  const [, , anchoNorm, altoNorm] = bbox;
  if (!medible(anchoNorm, false) || !medible(altoNorm, false)) return null;

  const enMetros = (puntos: number): number =>
    redondear2((puntos / PUNTOS_POR_PULGADA) * METROS_POR_PULGADA * n);

  return {
    anchoM: enMetros(anchoNorm * paginaPts.ancho),
    altoM: enMetros(altoNorm * paginaPts.alto),
  };
}
