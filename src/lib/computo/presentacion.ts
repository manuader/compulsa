/**
 * Presentación comercial y armado de ítems de cómputo.
 *
 * Acá vive el principio P2 del PRD: **cantidad neta ≠ cantidad de compra**.
 * La neta es lo que la obra consume; la de compra sale de aplicarle el
 * desperdicio del material y redondear HACIA ARRIBA a lo que efectivamente
 * vende el corralón (placa, barra, caja, balde, rollo, bolsa, pallet, lata).
 * Nunca se redondea hacia abajo, y nunca se compra sin desperdicio.
 *
 * También es el borde de emisión del motor: `armarItem()` es el único lugar
 * donde una cuenta se convierte en `ItemComputo`, con sus `fuentes` heredadas
 * (P1: un ítem sin fuentes es un bug) y su confianza.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { ETIQUETA_UNIDAD, formatearNumero, redondear2 } from '@/lib/computo/unidades';
import type { Fuente, ItemComputo, Origen, RubroId, Unidad } from '@/types/domain';

/** Un bulto comercial: cuánto trae y cómo se lo nombra en la planilla. */
export interface Presentacion {
  /** "placa", "barra", "caja"… */
  singular: string;
  /** "placas", "barras", "cajas"… */
  plural: string;
  /** Contenido de cada bulto, en la unidad del ítem (2,88 m² la placa). */
  contenido: number;
  /** Ese contenido ya formateado para leer: "2,88 m²", "500 u". */
  detalle: string;
}

/** Cómo se compra un ítem. */
export type ModoCompra =
  /** Por bulto cerrado: se redondea hacia arriba a la próxima unidad entera. */
  | { tipo: 'bulto'; presentacion: Presentacion }
  /** A granel en múltiplos (arena: camión/metro cúbico en pasos de 0,5 m³). */
  | { tipo: 'granel'; multiplo: number }
  /** Pintura: latas de 20/10/4/1 L. */
  | { tipo: 'latas' }
  /** Tareas que se contratan globales (demolición, retiros): sin bulto. */
  | { tipo: 'global' }
  /** Carpintería a medida: la unidad se fabrica, no se compra en bulto. */
  | { tipo: 'medida' };

/**
 * Tolerancia para el redondeo hacia arriba. Sin esto, `31.68 / 2.88` da
 * `11.000000000000002` y compraríamos una placa de más por ruido binario.
 */
const EPSILON_COMPRA = 1e-9;

/**
 * Redondeo a presentación comercial: `unidades = ceil(cantidad / contenido)`,
 * `cantCompra = round2(unidades × contenido)`.
 */
export function ceilAPresentacion(
  cantidad: number,
  contenido: number,
): { unidades: number; cantCompra: number } {
  if (!Number.isFinite(contenido) || contenido <= 0) {
    throw new RangeError(`El contenido de la presentación tiene que ser mayor a 0 (recibí ${contenido}).`);
  }
  const neta = redondear2(Math.max(0, cantidad));
  const unidades = neta === 0 ? 0 : Math.ceil(neta / contenido - EPSILON_COMPRA);
  return { unidades, cantCompra: redondear2(unidades * contenido) };
}

/** Latas de látex que vende el corralón, de mayor a menor. */
export const TAMANOS_LATA = [20, 10, 4, 1] as const;

/**
 * Reparte litros en latas: greedy de mayor a menor con `floor` en cada tamaño;
 * el remanente final se cubre con latas de 1 L redondeando hacia arriba.
 * Los tamaños que no se usan no aparecen en el resultado.
 */
export function latasParaLitros(litros: number): {
  latas: Record<number, number>;
  litrosTotales: number;
} {
  const latas: Record<number, number> = {};
  let resto = redondear2(Math.max(0, litros));

  for (const tamano of TAMANOS_LATA) {
    if (resto <= 0) break;
    const cantidad = tamano === 1 ? Math.ceil(resto) : Math.floor(resto / tamano);
    if (cantidad <= 0) continue;
    latas[tamano] = cantidad;
    resto = redondear2(resto - cantidad * tamano);
  }

  const litrosTotales = redondear2(
    TAMANOS_LATA.reduce((total, tamano) => total + tamano * (latas[tamano] ?? 0), 0),
  );
  return { latas, litrosTotales };
}

/** "1 lata 4 L + 3 latas 1 L". */
export function describirLatas(latas: Record<number, number>): string {
  const partes = TAMANOS_LATA.filter((tamano) => (latas[tamano] ?? 0) > 0).map((tamano) => {
    const cantidad = latas[tamano] as number;
    return `${cantidad} ${cantidad === 1 ? 'lata' : 'latas'} ${formatearNumero(tamano)} L`;
  });
  return partes.length > 0 ? partes.join(' + ') : 'sin compra';
}

/** "11 placas de 2,88 m²". */
export function describirPresentacion(unidades: number, presentacion: Presentacion): string {
  const nombre = unidades === 1 ? presentacion.singular : presentacion.plural;
  return `${formatearNumero(unidades)} ${nombre} de ${presentacion.detalle}`;
}

// ---------------------------------------------------------------------------
// Provenance (P1): las fuentes del ítem salen de las entidades que lo generaron.
// ---------------------------------------------------------------------------

/** La entidad, vista como fuente: su lámina, su zona del plano y su nombre. */
export function fuenteDeEntidad(entidad: EntidadPersistida): Fuente {
  return { laminaId: entidad.laminaId, bbox: entidad.bbox, detalle: entidad.nombre };
}

function claveDeFuente(fuente: Fuente): string {
  return `${fuente.laminaId}|${fuente.bbox.join(',')}`;
}

/** Concatena fuentes sin repetir las que apuntan a la misma lámina y bbox. */
export function unirFuentes(...listas: readonly (readonly Fuente[])[]): Fuente[] {
  const vistas = new Set<string>();
  const fuentes: Fuente[] = [];
  for (const lista of listas) {
    for (const fuente of lista) {
      const clave = claveDeFuente(fuente);
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      fuentes.push(fuente);
    }
  }
  return fuentes;
}

/** Fuentes de un conjunto de entidades, deduplicadas por lámina + bbox. */
export function fuentesDeEntidades(entidades: readonly EntidadPersistida[]): Fuente[] {
  return unirFuentes(entidades.map(fuenteDeEntidad));
}

/**
 * Confianza de un dato compuesto: la peor de sus partes. Un ítem no puede ser
 * más confiable que la entidad más dudosa que usó.
 */
export function confianzaMinima(entidades: readonly EntidadPersistida[]): number {
  if (entidades.length === 0) return 0;
  return entidades.reduce((peor, entidad) => Math.min(peor, entidad.confianza), 1);
}

// ---------------------------------------------------------------------------
// Armado del ítem
// ---------------------------------------------------------------------------

export interface EntradaItem {
  rubro: RubroId;
  /** Clave estable para diff/golden: "seco.placas", "aberturas.V2". */
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  /** Lo que consume la obra, sin desperdicio. */
  cantNeta: number;
  /** Default del material, definido en la plantilla del rubro. */
  desperdicioPct: number;
  compra: ModoCompra;
  /** Entidades de las que sale el ítem: aportan fuentes y confianza. */
  entidades: readonly EntidadPersistida[];
  /** Default `explicito`; la plantilla lo degrada si computó sobre un supuesto. */
  origen?: Origen;
}

function resolverCompra(
  compra: ModoCompra,
  conDesperdicio: number,
  unidad: Unidad,
): { cantCompra: number; presentacion: string } {
  switch (compra.tipo) {
    case 'bulto': {
      const { unidades, cantCompra } = ceilAPresentacion(conDesperdicio, compra.presentacion.contenido);
      return { cantCompra, presentacion: describirPresentacion(unidades, compra.presentacion) };
    }
    case 'granel': {
      const { cantCompra } = ceilAPresentacion(conDesperdicio, compra.multiplo);
      const etiqueta = ETIQUETA_UNIDAD[unidad];
      return {
        cantCompra,
        presentacion: `${formatearNumero(cantCompra)} ${etiqueta} a granel (múltiplos de ${formatearNumero(compra.multiplo)} ${etiqueta})`,
      };
    }
    case 'latas': {
      const { latas, litrosTotales } = latasParaLitros(conDesperdicio);
      return { cantCompra: litrosTotales, presentacion: describirLatas(latas) };
    }
    case 'global':
      return { cantCompra: conDesperdicio, presentacion: 'global' };
    case 'medida':
      return { cantCompra: conDesperdicio, presentacion: 'a medida' };
  }
}

/**
 * Único constructor de `ItemComputo` del motor: aplica desperdicio, redondea a
 * presentación comercial y hereda provenance y confianza de las entidades.
 */
export function armarItem(entrada: EntradaItem): ItemComputo {
  const cantNeta = redondear2(entrada.cantNeta);
  const conDesperdicio = redondear2(cantNeta * (1 + entrada.desperdicioPct / 100));
  const { cantCompra, presentacion } = resolverCompra(entrada.compra, conDesperdicio, entrada.unidad);

  return {
    rubro: entrada.rubro,
    descripcion: entrada.descripcion,
    unidad: entrada.unidad,
    cantNeta,
    desperdicioPct: entrada.desperdicioPct,
    cantCompra,
    presentacion,
    origen: entrada.origen ?? 'explicito',
    fuentes: fuentesDeEntidades(entrada.entidades),
    confianza: redondear2(confianzaMinima(entrada.entidades)),
    ...(entrada.entidades.length === 1 ? { entidadRef: entrada.entidades[0]!.id } : {}),
    claveItem: entrada.claveItem,
  };
}
