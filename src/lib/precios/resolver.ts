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
 *     `clave_item` **exacta y misma unidad**. Sin fuzzy matching: una clave
 *     parecida es otro ítem, y ponerle el precio del vecino sería inventar (P4).
 *     La unidad se chequea porque el subtotal multiplica por `cantCompra`, que
 *     está en la unidad **del ítem**: una fila que declara `u` contra un ítem en
 *     `m²` da un número que se ve bien y está mal, y ese número entra al «Total
 *     estimado de la obra» y al XLSX. Se saltea y sigue la cascada.
 *  3. **El índice de precios propio** (`price_index`): el `p50` del mes más
 *     reciente con `n ≥ 1`, de la zona de la obra. Quien llama es el que elige
 *     el mes y la zona; acá solo se chequea que la fila tenga al menos una
 *     muestra **y que la clave del ítem sea de las que se pueden comparar entre
 *     obras** (ver `CLAVES_CON_INDICE`).
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
import type { PrecioEstimado, Unidad } from '@/types/domain';

/**
 * La moneda por defecto del estudio: la del índice y la de una fila nueva de
 * la lista.
 *
 * `price_index` no guarda moneda —el índice se arma con las cotizaciones del
 * estudio, que en la práctica son pesos—, así que el `fuente: 'indice'` usa
 * esta. La lista de referencia sí la guarda (`precios_referencia.moneda`) y esa
 * viaja tal cual al ítem. El día que el índice se abra por moneda, esta
 * constante se cambia por un campo de la fila y la cascada no se entera.
 */
export const MONEDA_DEFAULT = 'ARS';

/** Lo que la cascada necesita saber del ítem que está costeando. */
export interface ItemAPreciar {
  claveItem: string;
  /**
   * La unidad del ítem: la del `cantCompra` por el que se multiplica el
   * unitario. Un precio en otra unidad no es un precio de este ítem.
   */
  unidad: Unidad;
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
  /**
   * La unidad en la que está expresado el precio (`precios_referencia.unidad`).
   *
   * Estaba guardada, importada y en pantalla, y se caía acá: la cascada tomaba
   * `{precio, moneda, fecha}` y multiplicaba por la cantidad del ítem sin
   * mirarla. Un CSV con `seco.placas / u / 45000` producía en silencio un
   * subtotal equivocado.
   */
  unidad: Unidad;
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

// ---------------------------------------------------------------------------
// Qué claves se pueden costear con el índice del estudio
// ---------------------------------------------------------------------------

/**
 * Las claves de ítem que el índice puede costear: **las que valen lo mismo en
 * cualquier obra**.
 *
 * `price_index` es único por `(estudio, clave_item, zona, mes)` y se alimenta de
 * las adjudicaciones, que usan las **mismas claves que emiten las plantillas**.
 * Y una parte de esas claves no identifica un material sino una cosa de ESTA
 * obra: `aberturas.V1` es la ventana que en esta obra se llama V1 —1,50 × 1,10
 * de aluminio con DVH—, y en la obra de al lado V1 es una puerta ventana de
 * 2,40. Adjudicar la primera le ponía precio a la segunda, y la planilla lo
 * mostraba con `fuente: 'indice'` y una fecha, como si fuera evidencia.
 *
 * El índice es viejo; lo nuevo de esta ola es haberlo enchufado a
 * `computo_items.precio_json` y al total de cabecera. Así que la puerta se cierra
 * del lado de la lectura, con una lista blanca **enumerada**: solo entra la
 * clave que la plantilla emite como literal, o parametrizada sobre un enum
 * cerrado del código. Todo lo que lleva un tag de entidad (`aberturas.<tag>`),
 * un slug de material de texto libre (`terminaciones.<familia>.<slug>`,
 * `sanitaria.artefacto.<slug>`) o un diámetro leído de la documentación
 * (`sanitaria.canieria.*`, `sanitaria.accesorio.*`) queda afuera.
 *
 * Los diámetros son el caso dudoso —`sanitaria.canieria.cloacal.110` sí describe
 * un producto— y quedan afuera igual: el segmento sale de normalizar texto de la
 * lámina, no de un enum, y ante la duda un precio que falta es honesto y uno
 * equivocado no. Ampliar la lista es agregar una línea acá y su caso en
 * `tests/unit/precios.test.ts`; ninguna de las dos cosas se hace sola.
 *
 * Un precio **manual** o de la **lista del estudio** no pasa por este filtro: los
 * dos los cargó una persona sabiendo a qué ítem se los ponía.
 */
export const CLAVES_CON_INDICE: ReadonlySet<string> = new Set([
  // seco: los seis materiales del rubro, todos literales.
  'seco.placas',
  'seco.soleras',
  'seco.montantes',
  'seco.tornillos',
  'seco.masilla',
  'seco.cinta',
  // pintura
  'pintura.latex_paredes',
  'pintura.latex_cielorrasos',
  // gruesa
  'gruesa.ladrillos',
  'gruesa.cemento',
  'gruesa.cal',
  'gruesa.arena',
  // terminaciones: solo lo que va debajo del solado, que no depende del material
  // que se pise. Las familias con slug (`terminaciones.<familia>.<slug>`) no.
  'terminaciones.contrapiso',
  'terminaciones.carpeta',
  // demolición
  'demolicion.muros',
  'demolicion.carpinterias',
  'demolicion.solados',
  // eléctrica: `electrica.boca.<tipo>` sobre el enum cerrado `TIPOS_BOCA`.
  'electrica.boca.toma',
  'electrica.boca.luz',
  'electrica.boca.caja',
  'electrica.boca.tablero',
  'electrica.boca.datos',
]);

/** `true` si el índice del estudio puede costear esta clave (§5.6). */
export function admiteIndice(claveItem: string): boolean {
  return CLAVES_CON_INDICE.has(claveItem);
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

  // Misma clave **y** misma unidad. Un precio por unidad contra un ítem por m²
  // no se corrige multiplicando: no es el precio de este ítem, y un `null` que
  // la planilla dibuja como un guion es más honesto que un número inventado.
  const fila = lista.get(item.claveItem);
  if (fila && fila.unidad === item.unidad && Number.isFinite(fila.precio)) {
    return {
      unitario: fila.precio,
      moneda: fila.moneda,
      fuente: 'lista',
      fechaPrecio: fila.fecha,
    };
  }

  if (admiteIndice(item.claveItem) && indice && indice.n >= 1 && Number.isFinite(indice.p50)) {
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
