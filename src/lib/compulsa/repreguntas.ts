/**
 * Las repreguntas: lo que hay que volver a preguntarle al proveedor.
 *
 * Un presupuesto que no cubre todo el pedido no es comparable, y un ítem que
 * falta no se completa con el precio de otro proveedor: se pregunta. Son los
 * dos únicos casos (RF-902/RF-903):
 *
 * - **ítem no cotizado**: está en el RFQ y no aparece en el presupuesto;
 * - **línea ambigua**: vino sin precio o sin cantidad, así que no se puede
 *   comparar ni alimentar el índice de precios.
 *
 * Los textos son de gremio, en es-AR y con voseo, y se mandan tal cual: la
 * repregunta la manda el usuario por el canal manual (nunca contacto frío).
 * Cada una lleva `clave` estable para que repetir la conciliación no genere
 * dos veces la misma pregunta.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import { ETIQUETA_UNIDAD, formatearNumero } from '@/lib/computo/unidades';
import type { ItemRfq, LineaPresupuesto } from '@/types/domain';

export type MotivoRepregunta = 'no_cotizada' | 'ambigua';

/** Qué le falta a una línea para ser comparable. */
export type FaltaEnLinea = 'cantidad' | 'precio';

export type SujetoRepregunta =
  | { tipo: 'no_cotizada'; item: ItemRfq }
  | { tipo: 'ambigua'; linea: LineaPresupuesto; falta: readonly FaltaEnLinea[] };

export interface Repregunta {
  /** Estable por ítem o por posición de línea: repreguntar dos veces lo mismo es ruido. */
  clave: string;
  motivo: MotivoRepregunta;
  texto: string;
}

const ARTICULO: Record<FaltaEnLinea, string> = { cantidad: 'la cantidad', precio: 'el precio' };
const PRONOMBRE: Record<FaltaEnLinea, string> = { cantidad: 'la', precio: 'lo' };

/**
 * Qué le falta a la línea para entrar a la comparativa.
 *
 * El precio unitario **no** hace falta si vino el total: se deduce dividiendo
 * por la cantidad (`precioUnitarioDe` en `conciliacion.ts`). Falta el precio
 * solo cuando no vino ninguno de los dos.
 */
export function faltantesDeLinea(linea: LineaPresupuesto): FaltaEnLinea[] {
  const falta: FaltaEnLinea[] = [];
  if (linea.cantidad === null || !Number.isFinite(linea.cantidad)) falta.push('cantidad');
  if (linea.precioUnitario === null && linea.precioTotal === null) falta.push('precio');
  return falta;
}

function textoNoCotizada(item: ItemRfq): string {
  const cantidad = `${formatearNumero(item.cantidad)} ${ETIQUETA_UNIDAD[item.unidad]}`;
  const presentacion = item.presentacion.trim() === '' ? '' : ` (${item.presentacion})`;

  const specs = Object.entries(item.specsCriticas).map(([clave, valor]) => `${clave} ${valor}`);
  const aclaracion = specs.length === 0 ? '' : ` La especificación no sustituible es: ${specs.join(', ')}.`;

  return (
    `¿Nos pasás precio de ${cantidad} de ${item.descripcion}${presentacion}? ` +
    `No lo encontramos en tu presupuesto.${aclaracion}`
  );
}

function textoAmbigua(linea: LineaPresupuesto, falta: readonly FaltaEnLinea[]): string {
  const cita = linea.descripcion.trim() === '' ? 'esa línea' : `"${linea.descripcion.trim()}"`;

  if (falta.length === 0) return `¿Nos confirmás ${cita}?`;
  if (falta.length === 1) {
    const unico = falta[0]!;
    return `En ${cita} nos falta ${ARTICULO[unico]}. ¿Nos ${PRONOMBRE[unico]} pasás?`;
  }

  const listado = falta.map((f) => ARTICULO[f]).join(' y ');
  return `En ${cita} nos faltan ${listado}. ¿Nos los pasás?`;
}

/** El texto de la repregunta, listo para mandar. */
export function generarRepregunta(sujeto: SujetoRepregunta): string {
  return sujeto.tipo === 'no_cotizada'
    ? textoNoCotizada(sujeto.item)
    : textoAmbigua(sujeto.linea, sujeto.falta);
}

/** Repregunta por un ítem del RFQ que el proveedor no cotizó. */
export function repreguntaPorItemNoCotizado(item: ItemRfq): Repregunta {
  return {
    clave: `repregunta.no_cotizada.${item.claveItem}`,
    motivo: 'no_cotizada',
    texto: generarRepregunta({ tipo: 'no_cotizada', item }),
  };
}

/**
 * Repregunta por una línea sin precio o sin cantidad. `null` si la línea está
 * completa — no hay nada que preguntar.
 *
 * `indice` es la posición 0-based de la línea en el presupuesto; la clave lo
 * guarda 1-based, que es como se la cita en la UI ("línea 5").
 */
export function repreguntaPorLineaAmbigua(linea: LineaPresupuesto, indice: number): Repregunta | null {
  const falta = faltantesDeLinea(linea);
  if (falta.length === 0) return null;

  return {
    clave: `repregunta.ambigua.${indice + 1}`,
    motivo: 'ambigua',
    texto: generarRepregunta({ tipo: 'ambigua', linea, falta }),
  };
}
