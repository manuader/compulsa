/**
 * De dónde sale el precio de un ítem del cómputo (§5.6).
 *
 * Módulo **puro**: sin base, sin reloj, sin red. Recibe las tres fuentes ya
 * leídas y devuelve el `PrecioEstimado` que va a `computo_items.precio_json`,
 * o `null` si no hay ninguna. El recompute lo recalcula en cada corrida, así
 * que esta función se llama una vez por ítem y no puede pegarle a la base.
 *
 * ## La cascada, en orden
 *
 *  1. **El precio manual del ítem.** Lo cargó el arquitecto: nada lo pisa.
 *  2. **La lista de referencia del estudio** (`precios_referencia`), por
 *     `clave_item` **exacta**. Sin fuzzy matching: una clave parecida es otro
 *     ítem, y ponerle el precio del vecino sería inventar (P4).
 *  3. **El índice de precios propio** (`price_index`): el `p50` del mes más
 *     reciente con `n ≥ 1`, de la zona de la obra. Quien llama es el que elige
 *     el mes y la zona; acá solo se chequea que la fila tenga al menos una
 *     muestra.
 *  4. **`null`.** No hay precio. Un cero se leería como "no cuesta nada", que
 *     es una afirmación que nadie hizo.
 *
 * ## La IA jamás pone un precio
 *
 * `PrecioEstimado.fuente` solo admite `'manual' | 'lista' | 'indice'` y esta
 * función es la única que arma el objeto: no hay camino por el que un número
 * salido de un modelo llegue a `precio_json`. Es una regla del plan, no una
 * preferencia de implementación.
 */
import type { PrecioEstimado } from '@/types/domain';

/**
 * La moneda del índice.
 *
 * `price_index` no guarda moneda: el índice se arma con las cotizaciones del
 * estudio, que en la práctica son pesos. La lista de referencia sí la guarda
 * (`precios_referencia.moneda`, default `ARS`) y esa viaja tal cual al ítem.
 * El día que el índice se abra por moneda, esta constante se cambia por un
 * campo de la fila y el `fuente: 'indice'` sigue igual.
 */
export const MONEDA_DEFAULT = 'ARS';

/** Lo que la cascada necesita saber del ítem que está costeando. */
export interface ItemAPreciar {
  claveItem: string;
  /**
   * El precio que cargó el arquitecto a mano, si lo hay. Gana siempre; un ítem
   * editado por el usuario conserva su precio a través de los recomputes.
   */
  precioManual?: PrecioEstimado | null;
}

/** Una fila de la lista del estudio, indexada por `claveItem`. */
export interface FilaLista {
  precio: number;
  moneda: string;
  /** `YYYY-MM-DD`: la fecha que declara la fila, no la de hoy. */
  fecha: string;
}

/** El corte del índice que se usa para costear: el p50 del mes elegido. */
export interface CorteIndice {
  p50: number;
  /** Mes calendario `YYYY-MM`, tal cual lo guarda `price_index`. */
  mes: string;
  n: number;
}

/**
 * El precio del ítem según la cascada, o `null`.
 *
 * `lista` es un `Map` y no un array porque el recompute la arma una vez por
 * obra y la consulta una vez por ítem: buscar linealmente en cada ítem sería
 * cuadrático sin ninguna ganancia.
 */
export function resolverPrecio(
  item: ItemAPreciar,
  lista: ReadonlyMap<string, FilaLista>,
  indice: CorteIndice | null,
): PrecioEstimado | null {
  const manual = item.precioManual;
  // El `fuente: 'manual'` se fuerza: quien llama ya decidió que este es el
  // precio que cargó el usuario, y una etiqueta vieja adentro del jsonb no
  // puede hacer que el ítem diga que su precio salió del índice.
  // Un unitario que no es un número finito no es un precio: se saltea y sigue
  // la cascada, en vez de escribir un NaN que después envenena los subtotales.
  if (manual && Number.isFinite(manual.unitario)) {
    return { ...manual, fuente: 'manual' };
  }

  const fila = lista.get(item.claveItem);
  if (fila && Number.isFinite(fila.precio)) {
    return {
      unitario: fila.precio,
      moneda: fila.moneda,
      fuente: 'lista',
      fechaPrecio: fila.fecha,
    };
  }

  if (indice && indice.n >= 1 && Number.isFinite(indice.p50)) {
    return {
      unitario: indice.p50,
      moneda: MONEDA_DEFAULT,
      fuente: 'indice',
      // El índice es mensual: la fecha del precio es el mes (`YYYY-MM`), sin
      // día. Completar un `-01` sería declarar una precisión que la fila no
      // tiene.
      fechaPrecio: indice.mes,
    };
  }

  return null;
}
