/**
 * Redondeos y formateo de cantidades del motor de cómputo.
 *
 * Todo el motor trabaja con `number` (punto flotante binario), así que
 * `26 × 1,12` da `29.120000000000005` y `11 × 2,88` da `31.680000000000003`.
 * Esas colas de ruido no pueden llegar ni a la planilla ni a un assert: cada
 * cantidad se redondea con `redondear2()` **en el borde de emisión** (al armar
 * el ítem), nunca a mitad de una cadena de cuentas.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import type { Unidad } from '@/types/domain';

/** Decimales con los que se emite toda cantidad neta o de compra. */
export const DECIMALES_NETOS = 2;

/**
 * Redondea a 2 decimales (medio hacia arriba) matando el ruido binario.
 *
 * `toPrecision(15)` descarta los dígitos que ya son basura de la representación
 * antes de redondear: sin eso `1.005 * 100` (= `100.49999999999999`) caería a
 * `1.00` y `31.680000000000003` subiría a `31.69`.
 */
export function redondear2(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(Number((n * 100).toPrecision(15))) / 100;
}

/**
 * Redondea al entero más cercano (medio hacia arriba), limpiando el mismo ruido.
 * Para cantidades que son enteras por naturaleza (montantes, aberturas).
 * Ojo: NO es el redondeo de compra — para eso está `ceilAPresentacion()`, que
 * siempre va hacia arriba.
 */
export function redondearEntero(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(Number(n.toPrecision(15)));
}

/** Cómo se escribe cada unidad en la planilla. */
export const ETIQUETA_UNIDAD: Record<Unidad, string> = {
  u: 'u',
  m: 'm',
  ml: 'ml',
  m2: 'm²',
  m3: 'm³',
  l: 'L',
  kg: 'kg',
};

/**
 * Número en formato es-AR (coma decimal).
 * Sin `decimales`: hasta 2, sin ceros de relleno (`14`, `31,68`).
 * Con `decimales`: fijo, útil para el detalle comercial (`2,60 m`).
 */
export function formatearNumero(n: number, decimales?: number): string {
  const texto = decimales === undefined ? String(redondear2(n)) : n.toFixed(decimales);
  return texto.replace('.', ',');
}

/** Cantidad + unidad, listo para mostrar: `31,68 m²`. */
export function formatearCantidad(n: number, unidad: Unidad): string {
  return `${formatearNumero(n)} ${ETIQUETA_UNIDAD[unidad]}`;
}
