/**
 * El cuadro comparativo y el ranking multicriterio (RF-1101 / RF-1103).
 *
 * ## Qué problema resuelve
 *
 * Tres corralones contestan el mismo pedido con tres presupuestos que no se
 * parecen en nada: uno agrupa, otro cotiza de más, otro sustituye una
 * especificación y el tercero se olvida dos ítems. Compararlos "a ojo" es
 * comparar cualquier cosa. Este módulo los pone sobre **la grilla del pedido**:
 *
 *  - **Las filas son los ítems del snapshot** (`compulsas.items_json`), no las
 *    líneas del proveedor. El pedido es el eje fijo; lo que no lo respeta se ve.
 *  - **La celda es `precio unitario de la línea conciliada × cantidad del RFQ`.**
 *    Nunca el importe que escribió el proveedor: si cotizó 25 ml donde se
 *    pedían 20, el cuadro muestra lo que costarían los 20. Es la única forma de
 *    que dos columnas sean sumables entre sí.
 *  - **Lo que no se puede comparar sale `—` y no suma.** Un `sustituto` tiene
 *    precio y aun así queda afuera: es otro producto, y meterlo en el total
 *    haría ganar al que cambió la especificación. El motivo del match viaja en
 *    `detalle` para que la pantalla lo muestre como tooltip.
 *
 * ## Los tres números que decide cada columna
 *
 *  1. `totalComparable` — la suma de las celdas comparables. Es nuestro número.
 *  2. `totalDeclarado` — `cotizaciones.total`, lo que el proveedor dijo que sale.
 *     **Es nullable** (P5 §8: si el presupuesto no traía total, la columna quedó
 *     en `null`), y no se rellena con el comparable: son cosas distintas.
 *  3. `difiereDelDeclarado` — cuando los dos existen y no coinciden. No es un
 *     error: la diferencia suele ser el flete, el sustituto o un ítem extra. Es
 *     una marca para que nadie firme una orden de compra por el número
 *     equivocado.
 *
 * ## Benchmark (RF-1103)
 *
 * Cada celda comparable se mide contra el índice del estudio para
 * `(claveItem, zona de la obra, mes)`. **El mes es el corriente, con fallback al
 * último mes con datos anterior a él**: un rubro que no se cotizó en agosto se
 * compara contra julio, que es un dato viejo pero real, y la celda dice de qué
 * mes salió (`indice.mes`). Nunca se usa un mes futuro. El semáforo lo decide
 * `clasificarContraIndice` de P2b —no se reimplementa acá— y por lo tanto
 * respeta el `n ≥ 3` de `MIN_MUESTRAS_BENCHMARK`.
 *
 * Módulo **puro**: sin DB, sin red, sin `'use server'`. La pantalla y la route
 * del reporte le pasan las filas ya leídas.
 */
import { redondear2 } from '@/lib/computo/unidades';
import { formatearImporte, formatearMonto } from '@/lib/format/dinero';
import { precioUnitarioDe } from '@/lib/compulsa/conciliacion';
import {
  clasificarContraIndice,
  type ClaseBenchmark,
} from '@/lib/indice/percentiles';
import {
  PESOS_RANKING_DEFAULT,
  type ItemRfq,
  type LineaPresupuesto,
  type MatchConciliacion,
  type PesosRanking,
  type RubroId,
} from '@/types/domain';

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** Lo que el cuadro necesita de la compulsa. La fila de `compulsas` encaja. */
export interface CompulsaComparativa {
  id: string;
  rubro: RubroId;
  version: number;
  /** El snapshot congelado (RF-701): estas son las filas del cuadro. */
  items: readonly ItemRfq[];
}

/** Una columna en crudo. Los nombres son los de `cotizaciones` más el proveedor. */
export interface CotizacionComparativa {
  id: string;
  proveedorId: string;
  proveedorNombre: string;
  moneda: string;
  incluyeIva: boolean;
  /** Declarado por el proveedor. `null` ⇒ el presupuesto no traía total (P5 §8). */
  total: number | null;
  validezDias: number | null;
  plazoDias: number | null;
  /** RF-903. `null` ⇒ todavía sin conciliar. */
  scoreFidelidad: number | null;
  lineas: readonly LineaPresupuesto[];
  createdAt: Date;
}

/** Una fila de `conciliacion_items`. `lineaIdx` es 0-based, como la persiste P5. */
export interface ConciliacionComparativa {
  cotizacionId: string;
  claveItem: string | null;
  lineaIdx: number | null;
  match: MatchConciliacion;
  nota: string | null;
}

/** Una fila de `price_index` acotada a lo que el benchmark mira. */
export interface FilaIndice {
  claveItem: string;
  zona: string;
  /** `YYYY-MM`. */
  mes: string;
  p50: number;
  p75: number;
  n: number;
}

export interface OpcionesComparativa {
  /** Zona de la obra: el índice es por zona, no global. */
  zona?: string | null;
  /** Reloj inyectable (mes del benchmark y estado de validez). */
  ahora?: Date;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

/** `sin_conciliar` no es un match del dominio: es "todavía no se corrió la conciliación". */
export type MatchCelda = MatchConciliacion | 'sin_conciliar';

export interface IndiceCelda {
  p50: number;
  p75: number;
  n: number;
  /** De qué mes salió el índice usado (puede no ser el corriente). */
  mes: string;
}

export interface CeldaComparativa {
  cotizacionId: string;
  match: MatchCelda;
  /** Precio unitario de la línea conciliada, o `null`. */
  precioUnitario: number | null;
  /** `precioUnitario × cantidad del RFQ`. `null` ⇒ la celda no es comparable. */
  importe: number | null;
  comparable: boolean;
  /** El importe formateado, o `—`. Lo que se dibuja en la celda. */
  texto: string;
  /** Por qué quedó así, en es-AR. Va como tooltip. */
  detalle: string;
  benchmark: ClaseBenchmark;
  /** El índice contra el que se comparó; `null` si no hubo con qué. */
  indice: IndiceCelda | null;
}

export interface FilaComparativa {
  claveItem: string;
  item: ItemRfq;
  /** Una celda por columna, en el mismo orden que `columnas`. */
  celdas: CeldaComparativa[];
}

/** Una línea que el proveedor cotizó y nadie pidió (`match = 'extra'`). */
export interface ExtraColumna {
  lineaIdx: number;
  descripcion: string;
  /** `precioTotal`, o `precioUnitario × cantidad`. `null` si no se puede saber. */
  importe: number | null;
}

export type EstadoValidez = 'vigente' | 'por_vencer' | 'vencida' | 'sin_dato';

export interface ColumnaComparativa {
  cotizacionId: string;
  proveedorId: string;
  proveedorNombre: string;
  moneda: string;
  incluyeIva: boolean;
  /** Σ de las celdas comparables. */
  totalComparable: number;
  totalDeclarado: number | null;
  sinTotalDeclarado: boolean;
  /** Los dos existen y no coinciden. */
  difiereDelDeclarado: boolean;
  /** `totalDeclarado − totalComparable`. `null` si no hay declarado. */
  diferencia: number | null;
  itemsComparables: number;
  itemsExcluidos: number;
  /** RF-903; sin conciliar es 0 (no `null`: el ranking necesita un número). */
  scoreFidelidad: number;
  plazoDias: number | null;
  validezDias: number | null;
  venceAt: Date | null;
  validez: EstadoValidez;
  /** Días corridos hasta el vencimiento, redondeados hacia arriba. */
  diasParaVencer: number | null;
  extras: ExtraColumna[];
}

export interface Comparativa {
  compulsaId: string;
  rubro: RubroId;
  version: number;
  columnas: ColumnaComparativa[];
  filas: FilaComparativa[];
  /** Mes de referencia del benchmark, `YYYY-MM` en hora argentina. */
  mesActual: string;
  zona: string | null;
}

// ---------------------------------------------------------------------------
// Formato y fechas
// ---------------------------------------------------------------------------

/**
 * El formateador de plata vive en `@/lib/format/dinero` desde que el cómputo
 * también muestra precios: el cómputo no puede importar de la compulsa. Se
 * reexporta acá para no mover a los que ya lo importaban de este archivo.
 */
export { formatearImporte, formatearMonto };

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** A menos de esto, la oferta se muestra en ámbar: hay que cerrar o repedir. */
export const DIAS_AVISO_VALIDEZ = 3;

/**
 * Cuándo vence la oferta: `created_at + validez_dias` días corridos.
 *
 * Días corridos y no hábiles: es lo que dice un presupuesto de corralón
 * ("validez 7 días"), y contar hábiles nos haría dar por vigente algo que el
 * proveedor ya considera vencido.
 */
export function vencimientoDe(createdAt: Date, validezDias: number | null): Date | null {
  if (validezDias === null || !Number.isFinite(validezDias)) return null;
  return new Date(createdAt.getTime() + validezDias * MS_POR_DIA);
}

/** Días corridos que faltan, redondeados hacia arriba (medio día que falta, falta). */
export function diasHasta(vence: Date, ahora: Date): number {
  return Math.ceil((vence.getTime() - ahora.getTime()) / MS_POR_DIA);
}

export function estadoValidez(
  createdAt: Date,
  validezDias: number | null,
  ahora: Date,
): EstadoValidez {
  const vence = vencimientoDe(createdAt, validezDias);
  // Sin validez declarada no se supone nada: "sin dato" es información, un
  // "vigente" inventado es una trampa (P4, el sistema no rellena en silencio).
  if (!vence) return 'sin_dato';
  const dias = diasHasta(vence, ahora);
  if (dias <= 0) return 'vencida';
  return dias <= DIAS_AVISO_VALIDEZ ? 'por_vencer' : 'vigente';
}

/**
 * Mes calendario `YYYY-MM` **en hora argentina**.
 *
 * Misma regla —y por el mismo motivo— que `mesDe` de `@/lib/compulsa/flujo`: con
 * UTC, una compulsa abierta un 31 a la noche compararía contra el mes que viene.
 * Está duplicada a propósito: `flujo.ts` importa Drizzle y el esquema, y este
 * módulo es puro. Son cinco líneas y un `Intl`.
 */
const FORMATO_MES = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
});

export function mesDeFecha(fecha: Date): string {
  return FORMATO_MES.format(fecha);
}

// ---------------------------------------------------------------------------
// El cuadro
// ---------------------------------------------------------------------------

/** Los dos matches que se pueden sumar en la misma columna. */
const COMPARABLES: ReadonlySet<MatchCelda> = new Set<MatchCelda>(['exacto', 'parcial']);

const DETALLE_POR_MATCH: Record<MatchCelda, string> = {
  exacto: 'La línea cotizada coincide con el ítem pedido.',
  parcial: 'La línea coincide, pero la cantidad cotizada no es la pedida.',
  sustituto: 'El proveedor cambió una especificación no sustituible: no entra al comparable.',
  no_cotizado: 'El proveedor no cotizó este ítem.',
  extra: 'Línea cotizada que no corresponde a ningún ítem del pedido.',
  sin_conciliar: 'Esta cotización todavía no se concilió contra el pedido.',
};

/** Cómo se nombra cada match en pantalla y en el reporte. */
export const ETIQUETA_MATCH: Record<MatchCelda, string> = {
  exacto: 'Exacto',
  parcial: 'Parcial',
  sustituto: 'Sustituto',
  no_cotizado: 'No cotizado',
  extra: 'Extra',
  sin_conciliar: 'Sin conciliar',
};

export const ETIQUETA_VALIDEZ: Record<EstadoValidez, string> = {
  vigente: 'Vigente',
  por_vencer: 'Por vencer',
  vencida: 'Vencida',
  sin_dato: 'Sin validez declarada',
};

function importeDeLinea(linea: LineaPresupuesto): number | null {
  if (linea.precioTotal !== null && Number.isFinite(linea.precioTotal)) {
    return redondear2(linea.precioTotal);
  }
  const unitario = precioUnitarioDe(linea);
  if (unitario === null || linea.cantidad === null) return null;
  return redondear2(unitario * linea.cantidad);
}

/**
 * El índice a usar para `(claveItem, zona)`: el del mes corriente y, si no hay,
 * el más nuevo **anterior** a él. Un mes futuro no se usa nunca: sería comparar
 * contra un precio que todavía no existe.
 */
function indiceDe(
  porClave: ReadonlyMap<string, FilaIndice[]>,
  claveItem: string,
  zona: string | null,
  mesActual: string,
): FilaIndice | null {
  if (zona === null) return null;
  const filas = porClave.get(`${claveItem}::${zona}`);
  if (!filas) return null;

  let elegida: FilaIndice | null = null;
  for (const fila of filas) {
    if (fila.mes > mesActual) continue;
    // `YYYY-MM` ordena bien como texto: no hace falta parsear la fecha.
    if (elegida === null || fila.mes > elegida.mes) elegida = fila;
  }
  return elegida;
}

/**
 * Arma el cuadro normalizado.
 *
 * @param compulsa       El snapshot: define las filas y su orden.
 * @param cotizaciones   Las columnas, en el orden en que se quieren mostrar.
 * @param conciliaciones Filas de `conciliacion_items` de todas las cotizaciones.
 * @param indice         Filas de `price_index` del estudio (puede venir vacío).
 * @param opciones       Zona de la obra y reloj.
 */
export function armarComparativa(
  compulsa: CompulsaComparativa,
  cotizaciones: readonly CotizacionComparativa[],
  conciliaciones: readonly ConciliacionComparativa[],
  indice: readonly FilaIndice[] = [],
  opciones: OpcionesComparativa = {},
): Comparativa {
  const zona = opciones.zona ?? null;
  const ahora = opciones.ahora ?? new Date();
  const mesActual = mesDeFecha(ahora);

  // (cotizacionId, claveItem) → conciliación. Las `extra` van aparte: no tienen
  // clave y por lo tanto no son de ninguna fila.
  const porCotizacionYClave = new Map<string, ConciliacionComparativa>();
  const extrasPorCotizacion = new Map<string, ConciliacionComparativa[]>();
  for (const fila of conciliaciones) {
    if (fila.claveItem === null) {
      const lista = extrasPorCotizacion.get(fila.cotizacionId) ?? [];
      lista.push(fila);
      extrasPorCotizacion.set(fila.cotizacionId, lista);
      continue;
    }
    porCotizacionYClave.set(`${fila.cotizacionId}::${fila.claveItem}`, fila);
  }

  const indicePorClave = new Map<string, FilaIndice[]>();
  for (const fila of indice) {
    const clave = `${fila.claveItem}::${fila.zona}`;
    const lista = indicePorClave.get(clave) ?? [];
    lista.push(fila);
    indicePorClave.set(clave, lista);
  }

  const comparablesPorCotizacion = new Map<string, { suma: number; items: number }>();
  for (const cotizacion of cotizaciones) {
    comparablesPorCotizacion.set(cotizacion.id, { suma: 0, items: 0 });
  }

  const filas: FilaComparativa[] = compulsa.items.map((item) => ({
    claveItem: item.claveItem,
    item,
    celdas: cotizaciones.map((cotizacion) => {
      const conciliacion = porCotizacionYClave.get(`${cotizacion.id}::${item.claveItem}`);
      const match: MatchCelda = conciliacion?.match ?? 'sin_conciliar';
      const linea =
        conciliacion && conciliacion.lineaIdx !== null
          ? (cotizacion.lineas[conciliacion.lineaIdx] ?? null)
          : null;
      const precioUnitario = linea ? precioUnitarioDe(linea) : null;

      const comparable =
        COMPARABLES.has(match) && precioUnitario !== null && Number.isFinite(precioUnitario);
      const importe = comparable ? redondear2(precioUnitario! * item.cantidad) : null;

      if (comparable && importe !== null) {
        const acumulado = comparablesPorCotizacion.get(cotizacion.id)!;
        acumulado.suma += importe;
        acumulado.items += 1;
      }

      const filaIndice = comparable
        ? indiceDe(indicePorClave, item.claveItem, zona, mesActual)
        : null;
      const benchmark: ClaseBenchmark =
        filaIndice && precioUnitario !== null
          ? clasificarContraIndice(precioUnitario, filaIndice)
          : 'sin_datos';

      return {
        cotizacionId: cotizacion.id,
        match,
        precioUnitario,
        importe,
        comparable,
        texto: importe === null ? '—' : formatearImporte(importe),
        // El motivo que escribió la conciliación gana sobre el genérico: es el
        // que explica *este* caso ("difiere 25% de la pedida").
        detalle: conciliacion?.nota?.trim() || DETALLE_POR_MATCH[match],
        benchmark,
        // Con menos de 3 muestras `clasificarContraIndice` ya devuelve
        // `sin_datos`; la celda tampoco muestra el índice, para no sugerir que
        // hubo comparación.
        indice:
          filaIndice && benchmark !== 'sin_datos'
            ? { p50: filaIndice.p50, p75: filaIndice.p75, n: filaIndice.n, mes: filaIndice.mes }
            : null,
      };
    }),
  }));

  const columnas: ColumnaComparativa[] = cotizaciones.map((cotizacion) => {
    const acumulado = comparablesPorCotizacion.get(cotizacion.id)!;
    const totalComparable = redondear2(acumulado.suma);
    const totalDeclarado =
      cotizacion.total !== null && Number.isFinite(cotizacion.total) ? cotizacion.total : null;
    const diferencia = totalDeclarado === null ? null : redondear2(totalDeclarado - totalComparable);

    const venceAt = vencimientoDe(cotizacion.createdAt, cotizacion.validezDias);

    return {
      cotizacionId: cotizacion.id,
      proveedorId: cotizacion.proveedorId,
      proveedorNombre: cotizacion.proveedorNombre,
      moneda: cotizacion.moneda,
      incluyeIva: cotizacion.incluyeIva,
      totalComparable,
      totalDeclarado,
      sinTotalDeclarado: totalDeclarado === null,
      difiereDelDeclarado: diferencia !== null && diferencia !== 0,
      diferencia,
      itemsComparables: acumulado.items,
      itemsExcluidos: compulsa.items.length - acumulado.items,
      scoreFidelidad: cotizacion.scoreFidelidad ?? 0,
      plazoDias: cotizacion.plazoDias,
      validezDias: cotizacion.validezDias,
      venceAt,
      validez: estadoValidez(cotizacion.createdAt, cotizacion.validezDias, ahora),
      diasParaVencer: venceAt ? diasHasta(venceAt, ahora) : null,
      extras: (extrasPorCotizacion.get(cotizacion.id) ?? [])
        .filter((fila) => fila.lineaIdx !== null)
        .map((fila) => {
          const linea = cotizacion.lineas[fila.lineaIdx!];
          return {
            lineaIdx: fila.lineaIdx!,
            descripcion: linea?.descripcion ?? '(línea que ya no está en el presupuesto)',
            importe: linea ? importeDeLinea(linea) : null,
          };
        }),
    };
  });

  return {
    compulsaId: compulsa.id,
    rubro: compulsa.rubro,
    version: compulsa.version,
    columnas,
    filas,
    mesActual,
    zona,
  };
}

// ---------------------------------------------------------------------------
// Sustituciones de especificación (RF-1002 / PRD §12)
// ---------------------------------------------------------------------------

/** Un ítem que el proveedor cotizó cambiando una especificación no sustituible. */
export interface SustitucionCelda {
  claveItem: string;
  /** La descripción del ítem **del pedido**, que es lo que se pidió y no vino. */
  descripcion: string;
  /** El motivo que escribió la conciliación, en es-AR. */
  detalle: string;
}

/**
 * Los ítems que esta cotización **sustituyó**.
 *
 * El §12 del PRD pide que una sustitución se vea en rojo y que adjudicar con
 * una encima sea una decisión explícita. En el cuadro, `sustituto` y
 * `no_cotizado` comparten la celda `—` y solo se distinguían por el tooltip: una
 * spec cambiada es exactamente lo que nadie mira cuando mira precios, así que
 * la pantalla, el XLSX y el diálogo de adjudicar la nombran los tres.
 *
 * Vive acá y no en la pantalla porque la usan las tres, y porque una función
 * pura es lo único de esto que se puede pinnear en un test sin renderizar.
 */
export function sustitucionesDe(
  comparativa: Comparativa,
  cotizacionId: string,
): SustitucionCelda[] {
  const salida: SustitucionCelda[] = [];
  for (const fila of comparativa.filas) {
    const celda = fila.celdas.find((c) => c.cotizacionId === cotizacionId);
    if (celda?.match !== 'sustituto') continue;
    salida.push({
      claveItem: fila.claveItem,
      descripcion: fila.item.descripcion,
      detalle: celda.detalle,
    });
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Ranking multicriterio (RF-1101)
// ---------------------------------------------------------------------------

/**
 * `puntaje = 0,5×(totalMínimo/total) + 0,3×fidelidad + 0,2×(plazoMínimo/plazo)`.
 *
 * Pin del PRD, verificado en `tests/unit/comparativa.test.ts`:
 * A (total 100, fidelidad 1,0, plazo 10) ⇒ **0,95**;
 * B (total 90, fidelidad 0,8, plazo 15) ⇒ 0,8733 ⇒ **gana A**, que es más caro.
 * Ese es el punto del ranking: el precio pesa la mitad, no todo.
 */
export interface EntradaRanking {
  id: string;
  /** El total contra el que se compara. Tiene que ser > 0. */
  total: number;
  /** Score de fidelidad 0–1 (RF-903). */
  fidelidad: number;
  /** `null` ⇒ el proveedor no declaró plazo: el término vale 0, no se saltea. */
  plazoDias: number | null;
}

export interface ComponenteRanking {
  /** El cociente del término, 0–1. */
  ratio: number;
  peso: number;
  /** `peso × ratio`. */
  aporte: number;
}

export interface PuestoRanking {
  id: string;
  /** 1 es el mejor. */
  posicion: number;
  puntaje: number;
  componentes: {
    total: ComponenteRanking;
    fidelidad: ComponenteRanking;
    plazo: ComponenteRanking;
  };
}

/** Cuatro decimales: dos no alcanzan para distinguir 0,8733 de 0,8734. */
function redondear4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function componente(ratio: number, peso: number): ComponenteRanking {
  return { ratio: redondear4(ratio), peso, aporte: redondear4(peso * ratio) };
}

/**
 * Ordena las cotizaciones por puntaje, de la mejor a la peor, con el desglose
 * de cada término para que la pantalla pueda explicar el número.
 *
 * Los `pesos` salen de la configuración del estudio (`leerConfig(...).pesosRanking`,
 * validados ahí para que sumen 1); sin ellos se usan los del PRD.
 *
 * **Lanza si un total no sirve para comparar** (0, negativo o no finito). No se
 * degrada a "último puesto": un total en 0 haría que `totalMínimo/total` fuera
 * infinito y ese proveedor ganaría siempre. Quien llama tiene que decidir qué
 * hace con una cotización sin total — `entradasDeRanking` la deja afuera.
 */
export function rankear(
  filas: readonly EntradaRanking[],
  pesos: PesosRanking = PESOS_RANKING_DEFAULT,
): PuestoRanking[] {
  if (filas.length === 0) return [];

  for (const fila of filas) {
    if (!Number.isFinite(fila.total) || fila.total <= 0) {
      throw new RangeError(
        `La cotización ${fila.id} no tiene un total comparable (recibí ${String(fila.total)}): no se puede rankear.`,
      );
    }
  }

  const totalMinimo = Math.min(...filas.map((f) => f.total));
  const plazos = filas
    .map((f) => f.plazoDias)
    .filter((p): p is number => p !== null && Number.isFinite(p) && p > 0);
  const plazoMinimo = plazos.length > 0 ? Math.min(...plazos) : null;

  const puestos = filas.map((fila) => {
    // Plazo `null` o 0 ⇒ el término vale 0 (RF-1101). Un plazo 0 no es "entrega
    // instantánea": es un dato que nadie cargó, y premiarlo con ratio infinito
    // haría ganar al que no contestó la pregunta.
    const plazoUtil =
      fila.plazoDias !== null && Number.isFinite(fila.plazoDias) && fila.plazoDias > 0
        ? fila.plazoDias
        : null;
    const ratioPlazo = plazoUtil !== null && plazoMinimo !== null ? plazoMinimo / plazoUtil : 0;

    const componentes = {
      total: componente(totalMinimo / fila.total, pesos.total),
      fidelidad: componente(fila.fidelidad, pesos.fidelidad),
      plazo: componente(ratioPlazo, pesos.plazo),
    };

    // El puntaje se suma sobre los ratios crudos y se redondea una sola vez:
    // sumar aportes ya redondeados arrastra el error tres veces.
    const puntaje = redondear4(
      pesos.total * (totalMinimo / fila.total) + pesos.fidelidad * fila.fidelidad + pesos.plazo * ratioPlazo,
    );

    return { id: fila.id, total: fila.total, puntaje, componentes };
  });

  // Desempate estable: puntaje, después el total más bajo, después el id. Sin
  // el último criterio, dos cotizaciones idénticas cambiarían de orden entre
  // dos renders y el "ganador" dependería del orden de la query.
  puestos.sort((a, b) => b.puntaje - a.puntaje || a.total - b.total || a.id.localeCompare(b.id));

  return puestos.map(({ id, puntaje, componentes }, i) => ({
    id,
    posicion: i + 1,
    puntaje,
    componentes,
  }));
}

/**
 * Las entradas del ranking a partir del cuadro.
 *
 * **Qué total entra:** el declarado por el proveedor y, solo si no hay, el
 * comparable. El declarado es el número que va a la orden de compra y el que
 * usan la negociación y el contador de ahorro (RF-1104); rankear por el
 * comparable mientras se firma por el declarado sería comparar una cosa y
 * comprar otra. La columna marca `difiereDelDeclarado` para que la diferencia
 * esté a la vista.
 *
 * Una cotización sin ningún total utilizable **queda afuera del ranking** (no
 * hay con qué medirla); la pantalla la muestra igual, pidiendo que carguen el
 * total.
 */
export function entradasDeRanking(comparativa: Comparativa): EntradaRanking[] {
  return comparativa.columnas
    .map((columna) => ({
      id: columna.cotizacionId,
      total: columna.totalDeclarado ?? columna.totalComparable,
      fidelidad: columna.scoreFidelidad,
      plazoDias: columna.plazoDias,
    }))
    .filter((entrada) => Number.isFinite(entrada.total) && entrada.total > 0);
}
