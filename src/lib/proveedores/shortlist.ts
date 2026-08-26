/**
 * Shortlist de proveedores para un rubro y una zona (RF-802).
 *
 * Dominio **puro**: entra la agenda del estudio y sale el orden en el que hay
 * que ofrecerla. Sin base, sin `Date.now()`, sin azar — dos corridas con el
 * mismo input dan la misma lista, que es lo que permite testear el orden con
 * ids concretos en vez de "el primero es alguno de los buenos".
 *
 * ## `opt_out` es un filtro, no un criterio de orden
 *
 * Un proveedor que dijo "no me contacten" **no entra a la lista**, y no hay
 * combinación de score, historial ni zona que lo vuelva a meter (PRD §13). Está
 * escrito como el primer paso del pipeline y no como un peso del ranking a
 * propósito: un peso se puede empatar, un filtro no. La UI, del otro lado, no
 * ofrece revertirlo.
 *
 * ## Los cuatro grupos, en orden
 *
 * 1. `red_con_historial` — opt-in de WhatsApp **y** al menos una cotización con
 *    el estudio. Son los que ya respondieron alguna vez: el mejor predictor de
 *    que vuelvan a responder.
 * 2. `red` — opt-in, todavía sin historial. Se les puede escribir hoy.
 * 3. `zona` — sin opt-in, pero de la zona de la obra. Hay que conseguirles el
 *    consentimiento antes de escribirles (o llamarlos, que es el canal manual).
 * 4. `resto` — el resto de la agenda del rubro.
 *
 * Dentro de cada grupo: score descendente (el `null` —todavía no cotizó nada—
 * va último, no primero) y, a igual score, el nombre. El desempate por nombre
 * es lo que hace determinística la salida.
 */
import { normalizarNombre } from '@/lib/proveedores/import-csv';
import type { RubroId } from '@/types/domain';

/**
 * Lo que la shortlist necesita saber de un proveedor. Es un subconjunto
 * estructural de la fila `proveedores` (P1): una `Proveedor` de la base entra
 * acá sin adaptador, y un objeto armado a mano en un test también.
 */
export interface ProveedorShortlist {
  id: string;
  nombre: string;
  rubros: readonly RubroId[];
  zona: string;
  optInWa: boolean;
  optOut: boolean;
  /** Reputación del estudio; `null` ⇒ todavía no cotizó nada (va último). */
  score: number | null;
}

export type GrupoShortlist = 'red_con_historial' | 'red' | 'zona' | 'resto';

export interface ProveedorRankeado<T extends ProveedorShortlist = ProveedorShortlist> {
  proveedor: T;
  grupo: GrupoShortlist;
  /** Cotizaciones previas con el estudio; sale del `historico` que entró. */
  cotizaciones: number;
}

const ORDEN_GRUPOS: Record<GrupoShortlist, number> = {
  red_con_historial: 0,
  red: 1,
  zona: 2,
  resto: 3,
};

/** Comparación de nombres con reglas del castellano (Á antes que B, ñ entre n y o). */
const COLACION = new Intl.Collator('es-AR', { sensitivity: 'base' });

/**
 * Arma la shortlist.
 *
 * @param proveedores agenda del estudio (ya aislada por `estudio_id`).
 * @param rubro solo entran los proveedores que trabajan ese rubro.
 * @param zona zona de la obra; el match es normalizado (`'caba'` = `'CABA '`).
 * @param historico `proveedorId` → cuántas cotizaciones mandó al estudio.
 */
export function armarShortlist<T extends ProveedorShortlist>(
  proveedores: readonly T[],
  rubro: RubroId,
  zona: string,
  historico: ReadonlyMap<string, number>,
): ProveedorRankeado<T>[] {
  const zonaBuscada = normalizarNombre(zona);

  const rankeados = proveedores
    // Primero el filtro de compliance, después todo lo demás.
    .filter((proveedor) => !proveedor.optOut)
    .filter((proveedor) => proveedor.rubros.includes(rubro))
    .map((proveedor): ProveedorRankeado<T> => {
      const cotizaciones = historico.get(proveedor.id) ?? 0;
      const grupo: GrupoShortlist = proveedor.optInWa
        ? cotizaciones > 0
          ? 'red_con_historial'
          : 'red'
        : normalizarNombre(proveedor.zona) === zonaBuscada
          ? 'zona'
          : 'resto';
      return { proveedor, grupo, cotizaciones };
    });

  return rankeados.sort((a, b) => {
    const porGrupo = ORDEN_GRUPOS[a.grupo] - ORDEN_GRUPOS[b.grupo];
    if (porGrupo !== 0) return porGrupo;

    // `null` último: `Infinity` acá lo pondría primero, que es exactamente el
    // error que este orden tiene que evitar (un proveedor sin historial no es
    // el mejor del grupo, es el que menos sabemos).
    const scoreA = a.proveedor.score ?? Number.NEGATIVE_INFINITY;
    const scoreB = b.proveedor.score ?? Number.NEGATIVE_INFINITY;
    if (scoreA !== scoreB) return scoreB - scoreA;

    return COLACION.compare(a.proveedor.nombre, b.proveedor.nombre);
  });
}
