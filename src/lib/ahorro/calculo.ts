/**
 * Contador de ahorro por compulsa adjudicada (RF-1104).
 *
 * `ahorro = (mediana de totales comparables − total adjudicado) + Σ mejoras de
 * negociación aceptadas`. La mediana es **nearest-rank** (la misma de
 * `src/lib/indice/percentiles.ts`): con [100, 120] vale 100, no 110, así que el
 * ahorro se mide contra una oferta que existió.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import { redondear2 } from '@/lib/computo/unidades';
import { percentilesNearestRank } from '@/lib/indice/percentiles';

function exigirFinito(n: number, que: string): void {
  if (!Number.isFinite(n)) {
    throw new Error(`${que} tiene que ser un número finito: ${String(n)}.`);
  }
}

/**
 * Ahorro de una compulsa adjudicada.
 *
 * `totalesComparables` son los totales normalizados de las cotizaciones que
 * entraron a la comparativa (incluida la adjudicada). `mejorasNegociacion` son
 * las bajas conseguidas en las rondas aceptadas: van sumadas aparte porque la
 * mediana ya se movió cuando el proveedor mejoró su número.
 *
 * Puede dar negativo: si se adjudicó por encima de la mediana, el tablero lo
 * muestra tal cual en vez de esconderlo en un cero.
 */
export function calcularAhorro(
  totalesComparables: number[],
  totalAdjudicado: number,
  mejorasNegociacion: number[],
): number {
  if (totalesComparables.length === 0) {
    throw new Error('No se puede calcular el ahorro sin ningún total comparable.');
  }
  totalesComparables.forEach((t) => exigirFinito(t, 'Un total comparable'));
  exigirFinito(totalAdjudicado, 'El total adjudicado');
  mejorasNegociacion.forEach((m) => {
    exigirFinito(m, 'Una mejora de negociación');
    if (m < 0) {
      throw new Error(`Una mejora de negociación no puede ser negativa: ${String(m)}.`);
    }
  });

  const { p50: mediana } = percentilesNearestRank(totalesComparables);
  const mejoras = mejorasNegociacion.reduce((acc, m) => acc + m, 0);
  return redondear2(mediana - totalAdjudicado + mejoras);
}

/**
 * Ahorro acumulado por obra o por estudio (el tablero).
 * Suma con redondeo al borde para que 15 + 0,1 + 0,2 dé 15,3 y no 15,299999….
 */
export function acumularAhorros(ahorros: number[]): number {
  return redondear2(ahorros.reduce((acc, a) => acc + a, 0));
}
