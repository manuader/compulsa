/**
 * Índice de precios propio del estudio (RF-1103): percentiles por
 * `(claveItem, zona, mes)` calculados con **nearest-rank**.
 *
 * Nearest-rank en vez de interpolación por una razón de dominio: el p50 de una
 * serie de precios tiene que ser **un precio que alguien cotizó de verdad**, no
 * un promedio entre dos. Con [10, 20, 30, 40, 50] los percentiles son 20 / 30 /
 * 40 (pin del plan), y con [100, 120] la mediana es 100, no 110.
 *
 * Por eso `price_index` guarda `muestras_json`: los percentiles no se pueden
 * recalcular al sumar una muestra si solo se guardaron p25/p50/p75.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import { redondear2 } from '@/lib/computo/unidades';

/** Los tres cortes que persiste `price_index`. */
export interface Percentiles {
  p25: number;
  p50: number;
  p75: number;
}

/** Serie del mes más sus percentiles, listo para escribir la fila. */
export interface MuestraAcumulada extends Percentiles {
  /** La serie completa, ordenada de menor a mayor. */
  muestras: number[];
  /** `muestras.length`, materializado en la columna `n`. */
  n: number;
}

/** Debajo de esto el benchmark de la comparativa no se muestra (RF-1103). */
export const MIN_MUESTRAS_BENCHMARK = 3;

/** Semáforo del benchmark en la comparativa. */
export type ClaseBenchmark = 'verde' | 'amarillo' | 'rojo' | 'sin_datos';

/**
 * Valor de la serie en el rango nearest-rank de `p` (0–1).
 *
 * `rango = ceil(p × n)`, mínimo 1; el índice es `rango − 1`. La serie ya viene
 * ordenada de menor a mayor.
 */
function porRango(ordenadas: number[], p: number): number {
  const rango = Math.max(1, Math.ceil(Number((p * ordenadas.length).toPrecision(15))));
  return redondear2(ordenadas[Math.min(rango, ordenadas.length) - 1]);
}

/**
 * p25 / p50 / p75 de una serie por nearest-rank.
 *
 * El orden de entrada no importa (se ordena acá). Lanza si la serie está vacía:
 * un índice sin muestras no tiene percentiles, y devolver ceros sería inventar
 * un precio de mercado.
 */
export function percentilesNearestRank(valores: number[]): Percentiles {
  if (valores.length === 0) {
    throw new Error('No se pueden calcular percentiles sobre una serie vacía.');
  }
  for (const v of valores) {
    if (!Number.isFinite(v)) {
      throw new Error(`La serie del índice tiene un valor que no es finito: ${String(v)}.`);
    }
  }
  const ordenadas = [...valores].sort((a, b) => a - b);
  return {
    p25: porRango(ordenadas, 0.25),
    p50: porRango(ordenadas, 0.5),
    p75: porRango(ordenadas, 0.75),
  };
}

/**
 * Suma un precio unitario cotizado a la serie del mes y devuelve la fila nueva.
 *
 * Los repetidos se conservan (dos proveedores al mismo precio son dos muestras:
 * pesan doble en el percentil, que es justamente lo que querés). La serie que
 * entra no se muta.
 */
export function acumularMuestra(muestras: number[], nueva: number): MuestraAcumulada {
  if (!Number.isFinite(nueva) || nueva <= 0) {
    throw new Error(`Una muestra del índice de precios tiene que ser un número positivo: ${String(nueva)}.`);
  }
  const serie = [...muestras, nueva].sort((a, b) => a - b);
  return { muestras: serie, ...percentilesNearestRank(serie), n: serie.length };
}

/**
 * Semáforo del precio unitario contra el índice (RF-1103): verde hasta el p50,
 * amarillo hasta el p75, rojo arriba. Con menos de `MIN_MUESTRAS_BENCHMARK`
 * muestras no se compara: `sin_datos`.
 */
export function clasificarContraIndice(
  precioUnitario: number,
  indice: { p50: number; p75: number; n: number },
): ClaseBenchmark {
  if (indice.n < MIN_MUESTRAS_BENCHMARK) return 'sin_datos';
  if (precioUnitario <= indice.p50) return 'verde';
  if (precioUnitario <= indice.p75) return 'amarillo';
  return 'rojo';
}
