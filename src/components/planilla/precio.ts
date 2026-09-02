/**
 * Lo que la planilla muestra del precio y del nivel de evidencia de un ítem.
 *
 * Módulo **puro** al lado de `escala-asumida.ts` y por la misma razón: la
 * pantalla es un Server Component y le pasa a la grilla datos ya formateados
 * (§8 de `src/app/CLAUDE.md`), así que las decisiones —qué se muestra, qué se
 * calla, cómo se escribe una fecha en es-AR— tienen que poder testearse sin
 * levantar React ni una base.
 *
 * Dos reglas gobiernan todo el archivo:
 *
 *  1. **Sin precio no es cero.** Un ítem al que la cascada del §5.6 no le
 *     encontró precio no cuesta nada, no se sabe cuánto cuesta. Devuelve `null`
 *     y la fila muestra un guion.
 *  2. **Un total dice qué no está contando.** Sumar solo lo que tiene precio y
 *     no aclararlo es la forma más prolija de hacer comprar de menos.
 */
import { formatearMonto } from '@/lib/format/dinero';
import { redondear2 } from '@/lib/computo/unidades';
import type { Origen, PrecioEstimado } from '@/types/domain';

/** El precio de una fila, formateado. Todo texto: cruza al cliente y se muestra tal cual. */
export interface PrecioPlanilla {
  unitario: string;
  subtotal: string;
  /** "Lista de precios del estudio · 20/08/2026" — el texto largo, para el title. */
  detalle: string;
  /**
   * Lo mismo en corto: "Lista", "Índice", "A mano".
   *
   * De dónde salió un precio y de cuándo es no puede vivir **solo** en un
   * `title`: un tooltip no existe en una pantalla táctil ni en una impresión, y
   * un número sin fecha en un país con esta inflación no es un precio. Va a la
   * celda, chico, debajo del unitario.
   */
  fuenteCorta: string;
  /** "20/08/2026" para la lista y lo manual; "08/2026" para el índice, que es mensual. */
  fecha: string;
}

/** El subtotal de un conjunto de ítems, calculado y formateado en el server. */
export interface SubtotalRubro {
  /** `$ 1.234.500` — la suma de los subtotales de los ítems con precio. */
  monto: string;
  /** Cuántos ítems del conjunto quedaron sin precio (0 ⇒ el subtotal es completo). */
  sinPrecio: number;
}

/** Lo mínimo que hay que saber de un ítem para valorizarlo. */
export interface ItemValorizable {
  cantCompra: number;
  precioJson: PrecioEstimado | null;
}

/** De dónde salió el precio, para el tooltip de la fila (§5.6). */
export const ETIQUETA_FUENTE_PRECIO: Record<PrecioEstimado['fuente'], string> = {
  manual: 'Precio cargado a mano',
  lista: 'Lista de precios del estudio',
  indice: 'Índice de precios del estudio',
};

/** Lo mismo, en una palabra: es lo que entra en la celda de la planilla. */
export const ETIQUETA_FUENTE_PRECIO_CORTA: Record<PrecioEstimado['fuente'], string> = {
  manual: 'A mano',
  lista: 'Lista',
  indice: 'Índice',
};

/**
 * La fecha del precio, como se escribe en es-AR.
 *
 * Viene de dos formas y las dos son ciertas: la lista y el precio manual traen
 * el día (`2026-08-20`), y el índice es mensual (`2026-08`) — completarle un
 * `-01` sería declarar una precisión que la fila no tiene (§5.6, decisión de
 * `resolverPrecio`). Se muestran distinto porque **son** distintas.
 */
export function fechaDePrecio(iso: string): string {
  const partes = iso.split('-');
  if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;
  if (partes.length === 2) return `${partes[1]}/${partes[0]}`;
  return iso;
}

/**
 * El precio como hay que meterlo en el input: coma decimal y **sin separador de
 * miles**. Mismo criterio (y misma razón) que `/estudio/precios`: `parsearPrecio`
 * lee un separador solo, una vez, como decimal, así que abrir la fila de un
 * precio de 145.000 y guardarla sin tocarla lo dejaría en 145.
 */
export function precioEditable(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

/**
 * El subtotal del ítem: precio unitario × cantidad de **compra**.
 *
 * Sobre la compra y no sobre la neta porque es lo que va a salir la factura del
 * corralón: el desperdicio se paga.
 */
export function subtotalDeItem(item: ItemValorizable): number | null {
  const precio = item.precioJson;
  if (precio === null || !Number.isFinite(precio.unitario)) return null;
  return redondear2(precio.unitario * item.cantCompra);
}

/** El precio de la fila, listo para la grilla. `null` ⇒ no hay con qué valorizarla. */
export function precioDeFila(item: ItemValorizable): PrecioPlanilla | null {
  const precio = item.precioJson;
  const subtotal = subtotalDeItem(item);
  if (precio === null || subtotal === null) return null;
  const fecha = fechaDePrecio(precio.fechaPrecio);
  return {
    unitario: formatearMonto(precio.moneda, precio.unitario),
    subtotal: formatearMonto(precio.moneda, subtotal),
    detalle: `${ETIQUETA_FUENTE_PRECIO[precio.fuente]} · ${fecha}`,
    fuenteCorta: ETIQUETA_FUENTE_PRECIO_CORTA[precio.fuente],
    fecha,
  };
}

/**
 * Lo que suman los ítems **con precio** de un conjunto, y cuántos quedaron sin.
 *
 * Los dos números van juntos siempre. `null` ⇒ ninguno tiene precio, y entonces
 * no hay total que mostrar: el cero sería una afirmación falsa.
 */
export function totalizar(
  filas: readonly ItemValorizable[],
  moneda: string,
): SubtotalRubro | null {
  let suma = 0;
  let conPrecio = 0;
  let sinPrecio = 0;
  for (const fila of filas) {
    const subtotal = subtotalDeItem(fila);
    if (subtotal === null) {
      sinPrecio += 1;
      continue;
    }
    suma = redondear2(suma + subtotal);
    conPrecio += 1;
  }
  if (conPrecio === 0) return null;
  return { monto: formatearMonto(moneda, suma), sinPrecio };
}

/**
 * Por qué un ítem no es explícito, con lo que lo respalda.
 *
 * Es el tooltip del badge: un `deducido` sin decir de dónde salió obliga a
 * abrir la bandeja para entenderlo, y un `inferido` sin decir que se midió
 * sobre el dibujo parece un dato leído.
 *
 * El método de una medición gráfica todavía no se persiste por ítem —el dato
 * vive en la deducción que la produjo—, así que el texto es el fijo del §5.5.
 * Cuando haya método guardado, se lee de ahí.
 */
export function detalleDeOrigen(origen: Origen, laminas: readonly string[]): string | null {
  if (origen === 'explicito') return null;
  const citadas = laminas.length === 0 ? '' : ` Láminas: ${laminas.join(', ')}.`;
  if (origen === 'deducido') {
    return `Se dedujo cruzando la documentación; el dato no está escrito en una sola lámina.${citadas}`;
  }
  if (origen === 'inferido') {
    return `Se midió sobre el dibujo a escala (medición gráfica): es la más débil de las evidencias.${citadas}`;
  }
  return `Ninguna lámina lo dice: se computó sobre un supuesto declarado, que queda a la vista para que lo confirmes.${citadas}`;
}
