/**
 * Conciliación: el presupuesto del proveedor contra el pedido del estudio.
 *
 * Un proveedor nunca contesta con el pedido: contesta con SU planilla, con sus
 * palabras, su orden y a veces su producto. Conciliar es decidir, línea por
 * línea, a qué ítem del RFQ corresponde cada una y qué tan fiel es la
 * respuesta. De acá salen tres cosas que usa toda la comparativa (RF-902/903):
 * la clasificación de cada ítem, el **score de fidelidad** —que es lo que
 * impide comparar por precio dos presupuestos que no cotizaron lo mismo— y las
 * repreguntas que hay que mandar antes de comparar nada.
 *
 * Es determinístico y sin IA a propósito. Un match que no se puede explicar no
 * se puede defender frente al usuario ("¿por qué me dice que esto es la V2?"),
 * y las reglas —solapamiento de tokens, ±5 % de cantidad, spec contradicha—
 * son las mismas para todos los proveedores de la compulsa.
 *
 * Lo que NO hace: no elige proveedor, no negocia y no toca precios. Una línea
 * `sustituto` es un semáforo rojo que escala al usuario (RF-1002: una
 * sustitución nunca entra a la negociación automática).
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import {
  repreguntaPorItemNoCotizado,
  repreguntaPorLineaAmbigua,
  type Repregunta,
} from '@/lib/compulsa/repreguntas';
import { redondear2 } from '@/lib/computo/unidades';
import type { ItemRfq, LineaPresupuesto, MatchConciliacion } from '@/types/domain';

// ---------------------------------------------------------------------------
// Constantes de la regla (pinneadas en contratos-y-formulas.md)
// ---------------------------------------------------------------------------

/** Solapamiento mínimo de tokens para considerar que dos descripciones hablan de lo mismo. */
export const UMBRAL_SOLAPAMIENTO = 0.5;

/** Tolerancia de cantidad para que un match sea `exacto`: ±5 %. */
export const TOLERANCIA_CANTIDAD = 0.05;

/**
 * Palabras que no distinguen nada en una descripción de obra y ensucian el
 * solapamiento ("puerta de madera" vs "puerta madera" es la misma puerta).
 */
const STOPWORDS = new Set(['de', 'la', 'el', 'con', 'para', 'x']);

/**
 * Los valores conocidos de cada spec crítica: el diccionario que permite decir
 * "esto **contradice** lo pedido" en vez de "esto no lo dice".
 *
 * Es **dato**, no lógica: la lista sale del vocabulario del gremio (vidrio DVH
 * / float / laminado; carpintería de aluminio, PVC, madera o chapa; tabiques de
 * durlock contra mampostería de ladrillo). Un valor que no está en esta tabla
 * no genera sustitución — preferimos no marcar una sustitución antes que
 * inventarla, porque una sustitución escala al usuario y frena la negociación.
 *
 * Ojo con los sinónimos: "durlock" y "placa de yeso" son lo mismo y NO están
 * emparentados acá; lo que evita el falso positivo es el umbral de
 * solapamiento, que primero decide si las dos líneas hablan del mismo ítem.
 */
export const ALTERNATIVAS_POR_SPEC: Record<string, readonly string[]> = {
  vidrio: ['dvh', 'float', 'laminado'],
  material: ['aluminio', 'pvc', 'madera', 'chapa'],
  tipo: ['durlock', 'mamposteria', 'ladrillo'],
};

/** Sinónimos de unidad que escriben los proveedores, ya sin puntos ni acentos. */
const SINONIMOS_UNIDAD: Record<string, string> = {
  u: 'u', un: 'u', uni: 'u', unid: 'u', unidad: 'u', unidades: 'u', cu: 'u',
  m2: 'm2', mts2: 'm2', metro2: 'm2', metros2: 'm2',
  m3: 'm3', mts3: 'm3', metro3: 'm3', metros3: 'm3',
  ml: 'ml', metrolineal: 'ml', metroslineales: 'ml',
  m: 'm', mt: 'm', mts: 'm', metro: 'm', metros: 'm',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg',
};

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/**
 * Texto normalizado: `NFKD` (que además pasa `m²` a `m2`), sin tildes, en
 * minúsculas y con todo lo no alfanumérico como separador.
 */
function normalizar(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Tokens significativos de una descripción, sin repetidos ni stopwords. */
export function tokens(texto: string): Set<string> {
  const partes = normalizar(texto)
    .split(/[^a-z0-9]+/)
    .filter((parte) => parte !== '' && !STOPWORDS.has(parte));
  return new Set(partes);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let comunes = 0;
  for (const token of a) if (b.has(token)) comunes += 1;
  return comunes / (a.size + b.size - comunes);
}

/**
 * Solapamiento de dos descripciones: tokens en común sobre tokens totales
 * (Jaccard). Es la métrica del pin: ≥ 0,5 ⇒ hablan del mismo ítem.
 */
export function solapamientoTokens(a: string, b: string): number {
  return jaccard(tokens(a), tokens(b));
}

/** La unidad del proveedor, llevada al vocabulario del dominio. `null` si no la declaró. */
export function normalizarUnidad(unidad: string | null): string | null {
  if (unidad === null) return null;

  const limpio = normalizar(unidad).replace(/[^a-z0-9]/g, '');
  if (limpio === '') return null;
  return SINONIMOS_UNIDAD[limpio] ?? limpio;
}

/**
 * Precio unitario de la línea: el que declaró el proveedor o, si no lo declaró,
 * el que sale del total. Es lo que alimenta el índice de precios (RF-1103).
 */
export function precioUnitarioDe(linea: LineaPresupuesto): number | null {
  if (linea.precioUnitario !== null && Number.isFinite(linea.precioUnitario)) {
    return linea.precioUnitario;
  }
  if (linea.precioTotal === null || linea.cantidad === null || linea.cantidad <= 0) return null;
  return redondear2(linea.precioTotal / linea.cantidad);
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export interface DesvioCantidad {
  cantidadRfq: number;
  cantidadCotizada: number | null;
  /** `null` si la línea no declaró cantidad. */
  desvioPct: number | null;
}

export interface SpecContradicha {
  spec: string;
  /** Lo que pidió el RFQ, tal cual está en `specsCriticas`. */
  pedido: string;
  /** El valor que aparece en la descripción de la línea, normalizado. */
  cotizado: string;
}

export interface ConciliacionItem {
  /** `null` en las líneas `extra`: no corresponden a ningún ítem del pedido. */
  claveItem: string | null;
  match: MatchConciliacion;
  itemRfq: ItemRfq | null;
  linea: LineaPresupuesto | null;
  /** Posición 1-based de la línea en el presupuesto, para citarla en la UI. */
  lineaIndice: number | null;
  /** Por qué cayó en esa clase, en es-AR y para mostrar. */
  motivo: string;
  desvio: DesvioCantidad | null;
  specContradicha: SpecContradicha | null;
}

export interface AlertaConciliacion {
  nivel: 'rojo';
  clave: string;
  mensaje: string;
}

export interface ResultadoConciliacion {
  /** Los ítems del RFQ en su orden, y al final las líneas `extra`. */
  items: ConciliacionItem[];
  /** Fidelidad del presupuesto al pedido (RF-903), 0–1 con 2 decimales. */
  score: number;
  sustituciones: ConciliacionItem[];
  repreguntas: Repregunta[];
  alertas: AlertaConciliacion[];
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

interface LineaNumerada {
  linea: LineaPresupuesto;
  /** 0-based, como vino en el presupuesto. */
  indice: number;
  tokens: Set<string>;
}

function unidadCompatible(item: ItemRfq, linea: LineaPresupuesto): boolean {
  const unidad = normalizarUnidad(linea.unidad);
  // Sin unidad declarada no hay contradicción: la línea queda a merced de la
  // descripción, y si además le falta algo, la repregunta la levanta.
  return unidad === null || unidad === item.unidad;
}

function dentroDeTolerancia(cantidadRfq: number, cantidadCotizada: number | null): boolean {
  if (cantidadCotizada === null || !Number.isFinite(cantidadCotizada)) return false;
  if (cantidadRfq === 0) return cantidadCotizada === 0;
  return Math.abs(cantidadCotizada - cantidadRfq) <= Math.abs(cantidadRfq) * TOLERANCIA_CANTIDAD + 1e-9;
}

function desvioDe(item: ItemRfq, linea: LineaPresupuesto): DesvioCantidad {
  const cotizada = linea.cantidad !== null && Number.isFinite(linea.cantidad) ? linea.cantidad : null;
  const desvioPct =
    cotizada === null || item.cantidad === 0
      ? null
      : redondear2(((cotizada - item.cantidad) / item.cantidad) * 100);

  return { cantidadRfq: item.cantidad, cantidadCotizada: cotizada, desvioPct };
}

/**
 * La primera spec crítica del ítem que la línea **contradice**: no nombra lo
 * pedido y sí nombra otra alternativa conocida de esa misma spec.
 */
function buscarSpecContradicha(item: ItemRfq, tokensLinea: ReadonlySet<string>): SpecContradicha | null {
  for (const [spec, pedido] of Object.entries(item.specsCriticas)) {
    const alternativas = ALTERNATIVAS_POR_SPEC[spec];
    if (alternativas === undefined) continue;

    const pedidoTokens = tokens(pedido);
    if ([...pedidoTokens].some((token) => tokensLinea.has(token))) continue;

    const cotizado = alternativas.find((alt) => !pedidoTokens.has(alt) && tokensLinea.has(alt));
    if (cotizado !== undefined) return { spec, pedido, cotizado };
  }
  return null;
}

function clasificar(
  item: ItemRfq,
  candidata: LineaNumerada,
): { match: MatchConciliacion; motivo: string; desvio: DesvioCantidad; specContradicha: SpecContradicha | null } {
  const desvio = desvioDe(item, candidata.linea);
  const specContradicha = buscarSpecContradicha(item, candidata.tokens);

  // La sustitución le gana al desvío de cantidad: es lo que hay que escalar.
  if (specContradicha !== null) {
    return {
      match: 'sustituto',
      motivo: `Cotizaron ${specContradicha.spec} ${specContradicha.cotizado} donde se pidió ${specContradicha.pedido}.`,
      desvio,
      specContradicha,
    };
  }

  if (dentroDeTolerancia(item.cantidad, candidata.linea.cantidad)) {
    return { match: 'exacto', motivo: 'Cotizado como se pidió.', desvio, specContradicha: null };
  }

  const motivo =
    desvio.desvioPct === null
      ? 'La línea no aclara la cantidad: no se puede verificar contra el pedido.'
      : `La cantidad cotizada se va ${desvio.desvioPct > 0 ? '+' : ''}${desvio.desvioPct} % de la pedida.`;
  return { match: 'parcial', motivo, desvio, specContradicha: null };
}

// ---------------------------------------------------------------------------
// Conciliación
// ---------------------------------------------------------------------------

/**
 * Concilia un presupuesto contra el snapshot del RFQ.
 *
 * El matching corre en dos pasadas, y el orden importa: primero las líneas que
 * **citan el código del ítem** (si el proveedor se tomó el trabajo de citarlo,
 * manda sobre cualquier parecido de texto), y recién después el resto por
 * descripción. Al revés, un match difuso podría robarle el ítem a la línea que
 * lo nombró.
 *
 * En la segunda pasada cada línea se queda con el ítem **disponible** más
 * parecido (mayor solapamiento; a igualdad, el primero del pedido). Es greedy,
 * no una asignación óptima global: es determinístico, explicable y alcanza
 * porque el pedido de un rubro no tiene ítems intercambiables.
 */
export function conciliar(
  itemsRfq: readonly ItemRfq[],
  lineas: readonly LineaPresupuesto[],
): ResultadoConciliacion {
  const porClave = new Map(itemsRfq.map((item) => [item.claveItem, item]));
  const asignadas = new Map<string, LineaNumerada>();
  const pendientes: LineaNumerada[] = [];

  // Pasada 1: el proveedor citó el código del ítem.
  lineas.forEach((linea, indice) => {
    const numerada: LineaNumerada = { linea, indice, tokens: tokens(linea.descripcion) };
    const clave = linea.claveItemSugerida?.trim();

    if (clave !== undefined && clave !== '' && porClave.has(clave) && !asignadas.has(clave)) {
      asignadas.set(clave, numerada);
    } else {
      pendientes.push(numerada);
    }
  });

  // Pasada 2: por descripción, con unidad compatible y solapamiento suficiente.
  const tokensPorItem = new Map(itemsRfq.map((item) => [item.claveItem, tokens(item.descripcion)]));
  const extras: LineaNumerada[] = [];

  for (const candidata of pendientes) {
    let mejor: { item: ItemRfq; solapamiento: number } | null = null;

    for (const item of itemsRfq) {
      if (asignadas.has(item.claveItem)) continue;
      if (!unidadCompatible(item, candidata.linea)) continue;

      const solapamiento = jaccard(tokensPorItem.get(item.claveItem)!, candidata.tokens);
      if (solapamiento < UMBRAL_SOLAPAMIENTO) continue;
      if (mejor === null || solapamiento > mejor.solapamiento) mejor = { item, solapamiento };
    }

    if (mejor === null) extras.push(candidata);
    else asignadas.set(mejor.item.claveItem, candidata);
  }

  // Clasificación, en el orden del pedido; las extras van al final.
  const items: ConciliacionItem[] = itemsRfq.map((item) => {
    const candidata = asignadas.get(item.claveItem);
    if (candidata === undefined) {
      return {
        claveItem: item.claveItem,
        match: 'no_cotizado',
        itemRfq: item,
        linea: null,
        lineaIndice: null,
        motivo: 'No aparece en el presupuesto.',
        desvio: null,
        specContradicha: null,
      };
    }

    const { match, motivo, desvio, specContradicha } = clasificar(item, candidata);
    return {
      claveItem: item.claveItem,
      match,
      itemRfq: item,
      linea: candidata.linea,
      lineaIndice: candidata.indice + 1,
      motivo,
      desvio,
      specContradicha,
    };
  });

  for (const extra of extras) {
    items.push({
      claveItem: null,
      match: 'extra',
      itemRfq: null,
      linea: extra.linea,
      lineaIndice: extra.indice + 1,
      motivo: 'No estaba en el pedido: el proveedor la agregó.',
      desvio: null,
      specContradicha: null,
    });
  }

  // Score, sustituciones, alertas y repreguntas.
  const exactos = items.filter((i) => i.match === 'exacto').length;
  const parciales = items.filter((i) => i.match === 'parcial').length;
  const score = itemsRfq.length === 0 ? 0 : redondear2((exactos + 0.5 * parciales) / itemsRfq.length);

  const sustituciones = items.filter((i) => i.match === 'sustituto');
  const alertas: AlertaConciliacion[] = sustituciones.map((sustitucion) => ({
    nivel: 'rojo',
    clave: `sustitucion.${sustitucion.claveItem}`,
    mensaje:
      `${sustitucion.itemRfq!.descripcion}: pediste ${sustitucion.specContradicha!.spec} ` +
      `${sustitucion.specContradicha!.pedido} y cotizaron ${sustitucion.specContradicha!.cotizado}. ` +
      'Una sustitución no entra a la negociación automática: decidila vos.',
  }));

  const repreguntas: Repregunta[] = [];
  for (const conciliado of items) {
    if (conciliado.match === 'no_cotizado') {
      repreguntas.push(repreguntaPorItemNoCotizado(conciliado.itemRfq!));
      continue;
    }
    if (conciliado.linea === null || conciliado.lineaIndice === null) continue;

    const ambigua = repreguntaPorLineaAmbigua(conciliado.linea, conciliado.lineaIndice - 1);
    if (ambigua !== null) repreguntas.push(ambigua);
  }

  return { items, score, sustituciones, repreguntas, alertas };
}
