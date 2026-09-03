/**
 * Plata escrita en es-AR: miles con punto, decimales con coma.
 *
 * Vivía en `src/lib/compulsa/comparativa.ts` porque los primeros que mostraron
 * plata fueron la comparativa y la orden de compra. Desde que el cómputo tiene
 * precios (§5.6) la planilla también la escribe, y **el cómputo no puede
 * depender de la compulsa**: son dos dominios, y el que va primero es el
 * cómputo. Así que el formateador vive acá, en un módulo hoja que los dos
 * pueden importar, y `comparativa.ts` lo reexporta para no mover los llamadores
 * que ya existen.
 *
 * (`src/lib/negociacion/motor.ts` tiene todavía su propia copia privada, con
 * otra firma. Unificarla es un cambio de ese archivo, no de este.)
 *
 * Módulo puro: sin I/O, sin `Intl` —el formato es fijo y no depende del locale
 * de quien corre el server—.
 */
import { redondear2 } from '@/lib/computo/unidades';

/**
 * Monto en es-AR: miles con punto, decimales con coma, sin ceros de relleno.
 *
 * `145000` ⇒ `145.000`; `12500,5` ⇒ `12.500,50`. Los enteros no llevan
 * decimales: un precio de lista se escribe como lo escribió quien lo cargó.
 */
export function formatearImporte(n: number): string {
  const valor = redondear2(n);
  const texto = Number.isInteger(valor) ? String(valor) : valor.toFixed(2).replace('.', ',');
  const [entera, decimal] = texto.split(',');
  const conMiles = entera.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return decimal === undefined ? conMiles : `${conMiles},${decimal}`;
}

/**
 * El importe con su símbolo adelante: `-$ 79.840`, no `$ -79.840`.
 *
 * El único monto del producto que puede ser negativo es el ahorro (RF-1104):
 * adjudicar por encima de la mediana da negativo y el tablero lo muestra tal
 * cual en vez de esconderlo en un cero. Pegar el símbolo y el número sin más
 * dejaba el menos en el medio, que en es-AR no se escribe así.
 */
export function formatearMonto(moneda: string, n: number): string {
  const simbolo = moneda === 'ARS' ? '$' : moneda;
  const signo = redondear2(n) < 0 ? '-' : '';
  return `${signo}${simbolo} ${formatearImporte(Math.abs(n))}`;
}
