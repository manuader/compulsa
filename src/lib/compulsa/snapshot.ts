/**
 * Snapshot de compulsa: el cómputo aprobado, congelado como pedido de cotización.
 *
 * Es la pieza que sostiene RF-701: **lo que se le manda al proveedor tiene que
 * ser exactamente lo que el estudio aprobó**. Para poder probarlo meses después
 * —cuando la planilla ya se editó tres veces— el snapshot viaja con un hash de
 * su contenido; recalcularlo sobre los ítems guardados y compararlo contra el
 * de la compulsa responde "¿esto es lo que mandamos?" sin depender de la
 * auditoría. Una edición posterior da otro hash, y otro hash es una versión
 * nueva de la compulsa, nunca una corrección silenciosa de la vieja.
 *
 * Dos decisiones que el módulo hace cumplir:
 *
 * - **Se cotiza la cantidad de COMPRA, no la neta** (P2 del PRD): al corralón se
 *   le piden las 11 placas, no los 26 m² que consume el tabique.
 * - **`specsCriticas` es lo no sustituible**: si el proveedor cambia el DVH por
 *   float, la conciliación lo marca `sustituto` y escala al usuario. Sin esa
 *   spec en el snapshot, la sustitución pasa desapercibida.
 *
 * Módulo puro: sin I/O, sin DB, sin red (`node:crypto` es cómputo local).
 */
import { createHash } from 'node:crypto';
import { canonicalizar } from '@/lib/pipeline/json';
import type { CondicionesRfq, ItemComputo, ItemRfq, RubroId } from '@/types/domain';

/**
 * Qué atributo de la entidad de origen es **no sustituible** en cada rubro.
 *
 * Es dato, no lógica: agregar un rubro o una spec es tocar esta tabla. Las
 * claves son las del contrato de atributos de `EntidadDetectada`
 * (`domain.ts`): `vidrio`/`material` en aberturas, `tipo` en tabiques y muros.
 * Pintura no tiene spec crítica — el látex de una marca u otra no es una
 * sustitución que haya que escalar, es una diferencia de precio.
 */
export const SPECS_CRITICAS_POR_RUBRO: Record<RubroId, readonly string[]> = {
  aberturas: ['vidrio', 'material'],
  seco: ['tipo'],
  gruesa: ['tipo'],
  pintura: [],
  // Sanitaria es el caso más claro de spec crítica: cambiar el material de una
  // cañería no es un descuento, es otra instalación. El `sistema` no está: la
  // cañería de agua fría y la de caliente son el mismo caño (lo que cambia es
  // el material), y además el sistema ya viaja en la clave y en la descripción
  // del ítem — `sanitaria.canieria.ac.20`, "Cañería de agua caliente Ø 20".
  sanitaria: ['material', 'diametro'],
  terminaciones: ['material'],
  // Eléctrica no tiene spec de compra: el tipo de boca ES el ítem y el circuito
  // es información de proyecto, no algo que el proveedor pueda sustituir.
  electrica: [],
  demolicion: [],
};

/** Atributos de una entidad, tal como los guarda `entidades.atributos_json`. */
export type AtributosEntidad = Record<string, unknown>;

export interface SnapshotRfq {
  /** Los ítems del pedido, **ordenados por `claveItem`** (igual que el hash). */
  itemsRfq: ItemRfq[];
  /** sha256 hex del snapshot (RF-701). */
  hash: string;
}

/** Orden determinístico, sin locale: dos máquinas tienen que dar el mismo hash. */
function porClaveItem(a: { claveItem: string }, b: { claveItem: string }): number {
  if (a.claveItem < b.claveItem) return -1;
  if (a.claveItem > b.claveItem) return 1;
  return 0;
}

/**
 * Un atributo de entidad como valor de spec: texto no vacío.
 * Un `null`, un objeto o un string en blanco **no** son una spec — el sistema no
 * inventa lo que no está (CLAUDE.md §3).
 */
function specDeAtributo(valor: unknown): string | null {
  if (typeof valor === 'string') {
    const limpio = valor.trim();
    return limpio === '' ? null : limpio;
  }
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  if (typeof valor === 'boolean') return String(valor);
  return null;
}

function specsCriticasDe(item: ItemComputo, atributos: AtributosEntidad | undefined): Record<string, string> {
  const specs: Record<string, string> = {};
  if (!atributos) return specs;

  for (const clave of SPECS_CRITICAS_POR_RUBRO[item.rubro]) {
    const valor = specDeAtributo(atributos[clave]);
    if (valor !== null) specs[clave] = valor;
  }
  return specs;
}

/**
 * El cómputo aprobado, convertido en ítems de RFQ.
 *
 * `atributosPorEntidad` es opcional porque el dominio no lee la base: el core
 * de F1 (P5) trae los atributos de las entidades de origen y los pasa acá. La
 * clave del mapa es **`entidadRef`** cuando el ítem sale de una sola entidad
 * (una abertura, un tabique) y **`claveItem`** cuando es agregado (las placas
 * de todos los tabiques juntas), que es el único gancho estable que tiene un
 * ítem sin entidad única. Sin mapa, `specsCriticas` queda vacío: preferimos un
 * RFQ sin spec a un RFQ con una spec inventada.
 */
export function crearSnapshot(
  items: readonly ItemComputo[],
  condiciones: CondicionesRfq,
  atributosPorEntidad?: ReadonlyMap<string, AtributosEntidad>,
): SnapshotRfq {
  const vistas = new Set<string>();
  const itemsRfq: ItemRfq[] = items.map((item) => {
    if (vistas.has(item.claveItem)) {
      throw new RangeError(
        `El snapshot tiene dos ítems con la clave "${item.claveItem}": no se puede cotizar ni conciliar un pedido ambiguo.`,
      );
    }
    vistas.add(item.claveItem);

    const atributos =
      (item.entidadRef === undefined ? undefined : atributosPorEntidad?.get(item.entidadRef)) ??
      atributosPorEntidad?.get(item.claveItem);

    return {
      claveItem: item.claveItem,
      descripcion: item.descripcion,
      unidad: item.unidad,
      cantidad: item.cantCompra,
      presentacion: item.presentacion,
      specsCriticas: specsCriticasDe(item, atributos),
    };
  });

  itemsRfq.sort(porClaveItem);
  return { itemsRfq, hash: hashSnapshot(itemsRfq, condiciones) };
}

/**
 * Hash del snapshot (RF-701): `sha256` hex sobre la forma canónica de
 * `{ items ordenados por claveItem, condiciones }`.
 *
 * Va con `canonicalizar()` —el mismo de la comparación de `jsonb`— porque el
 * hash se recalcula sobre ítems que **volvieron de Postgres**, que reordena las
 * claves de un `jsonb`. Sin canonizar, el mismo snapshot daría otro hash apenas
 * hace el viaje de ida y vuelta a la base.
 */
export function hashSnapshot(itemsRfq: readonly ItemRfq[], condiciones: CondicionesRfq): string {
  const items = [...itemsRfq].sort(porClaveItem);
  const payload = JSON.stringify(canonicalizar({ items, condiciones }));
  return createHash('sha256').update(payload).digest('hex');
}
