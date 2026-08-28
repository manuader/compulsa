/**
 * Checklists por rubro, editables por estudio (RF-405).
 *
 * Un **ítem de checklist** es la familia de un hallazgo: la clave del hallazgo
 * es `seco.altura_tabiques.T1` (única por obra, para idempotencia) y su
 * `checklistItem` es `seco.altura_tabiques` (la familia, común a todos los
 * tabiques sin altura). Las plantillas de rubro escriben ese campo desde F0;
 * lo que faltaba es que el estudio pueda decidir, para cada familia, si la
 * chequea y si frena la aprobación.
 *
 * ## Defaults + overrides, nunca un seed
 *
 * `CHECKLIST_DEFAULT` es lo que emiten las plantillas, con el `bloqueante` con
 * el que nacen. `checklists_estudio` guarda **solo lo que el estudio pisó**:
 * cero filas ⇒ el checklist de fábrica. Es la misma decisión que en
 * `estudios.config_json` (ver P1 §3): sembrar todas las filas al crear el
 * estudio obligaría a migrar datos cada vez que una plantilla agrega un chequeo,
 * y dejaría estudios viejos sin los ítems nuevos.
 *
 * ## Qué significa cada toggle
 *
 *  - `activo = false` ⇒ el estudio decidió que esa familia no se chequea. El
 *    hallazgo se sigue viendo en la bandeja (es información sobre la
 *    documentación, y borrarla sería mentir), pero **no frena la aprobación**.
 *  - `bloqueante = false` ⇒ se chequea y se avisa, pero tampoco frena.
 *
 * Ninguno de los dos borra ni oculta hallazgos: los dos actúan sobre el gate.
 *
 * ## Qué NO alcanza
 *
 * Las familias que no son de rubro —`escala` (bloqueo por escala, RF-201, que
 * administra el pipeline) y `sanity.*`— no están en ningún checklist y por eso
 * pasan intactas por `ajustarHallazgosAlChecklist`. Es a propósito: un estudio
 * no puede desactivar el bloqueo de una lámina que no se pudo medir.
 */
import { and, eq } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { checklistsEstudio, type ChecklistEstudio } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import type { HallazgoParaGate } from '@/lib/hallazgos/gate';
import { requireAccion, type UsuarioConRol } from '@/lib/plataforma/roles';
import { RUBROS, type RubroId } from '@/types/domain';

// ---------------------------------------------------------------------------
// Defaults: lo que emiten las plantillas
// ---------------------------------------------------------------------------

export interface ItemChecklistDefault {
  /** `checklistItem` del hallazgo: "seco.altura_tabiques". */
  itemId: string;
  /** Qué se chequea, en es-AR, para la pantalla de configuración. */
  descripcion: string;
  /** Con qué nace el hallazgo de esa familia en la plantilla. */
  bloqueante: boolean;
}

/**
 * Los ítems que hoy emiten las plantillas de `src/lib/rubros/*` más el
 * degradado por confianza que arma `taxonomia.ts` para todos los rubros.
 *
 * `tests/integration/plataforma.test.ts` lee los archivos de rubro y compara:
 * si una plantilla agrega un `checklistItem` y no se lo agrega acá, la suite lo
 * cuenta (y al revés también).
 */
export const CHECKLIST_DEFAULT: Record<RubroId, readonly ItemChecklistDefault[]> = {
  aberturas: [
    {
      itemId: 'aberturas.medidas_vano',
      descripcion: 'Cada abertura tiene ancho y alto de vano (planilla de carpinterías o acotado en planta).',
      bloqueante: true,
    },
    {
      itemId: 'aberturas.cantidad_planilla',
      descripcion:
        'Cada carpintería está dibujada en alguna planta (si solo está en la planilla, se computa una sola).',
      // Nace en `false`: la cantidad es un supuesto declarado, no un freno —
      // mismo criterio que `pintura.vanos_sin_descontar`.
      bloqueante: false,
    },
    {
      itemId: 'aberturas.baja_confianza',
      descripcion: 'Ningún ítem de aberturas se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
  seco: [
    {
      itemId: 'seco.sistema_tabique',
      descripcion: 'Los tabiques declaran su sistema constructivo y es durlock.',
      bloqueante: true,
    },
    {
      itemId: 'seco.altura_tabiques',
      descripcion: 'Cada tabique tiene altura (acotada en corte o declarada).',
      bloqueante: true,
    },
    {
      itemId: 'seco.largo_tabiques',
      descripcion: 'Cada tabique tiene largo acotado en planta.',
      bloqueante: true,
    },
    {
      itemId: 'seco.baja_confianza',
      descripcion: 'Ningún ítem de construcción en seco se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
  pintura: [
    {
      itemId: 'pintura.altura_ambiente',
      descripcion: 'Cada ambiente a pintar tiene altura.',
      bloqueante: true,
    },
    {
      itemId: 'pintura.perimetro_ambiente',
      descripcion: 'Cada ambiente a pintar tiene perímetro.',
      bloqueante: true,
    },
    {
      itemId: 'pintura.vanos_sin_descontar',
      descripcion: 'Los vanos de cada ambiente están declarados (si no, se pinta sin descontarlos).',
      bloqueante: false,
    },
    {
      itemId: 'pintura.superficie_ambiente',
      descripcion: 'Cada ambiente a pintar tiene superficie (para el cielorraso).',
      bloqueante: true,
    },
    {
      itemId: 'pintura.baja_confianza',
      descripcion: 'Ningún ítem de pintura se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
  gruesa: [
    {
      itemId: 'gruesa.sistema_muro',
      descripcion: 'Los muros declaran su sistema constructivo y es mampostería.',
      bloqueante: true,
    },
    {
      itemId: 'gruesa.altura_muros',
      descripcion: 'Cada muro tiene altura (acotada en corte o declarada).',
      bloqueante: true,
    },
    {
      itemId: 'gruesa.largo_muros',
      descripcion: 'Cada muro tiene largo acotado en planta.',
      bloqueante: true,
    },
    {
      itemId: 'gruesa.baja_confianza',
      descripcion: 'Ningún ítem de obra gruesa se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
  // Terminaciones y demolición siguen en stub y traen **solo** el degradado por
  // confianza, que no lo emite la plantilla sino `taxonomia.ts` para todo
  // rubro. El resto de sus ítems entra con el cómputo real (TODO T6), y
  // declararlos antes sería prometer un chequeo que hoy nadie hace.
  terminaciones: [
    {
      itemId: 'terminaciones.baja_confianza',
      descripcion: 'Ningún ítem de terminaciones se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
  sanitaria: [
    {
      itemId: 'sanitaria.sistema_tramos',
      descripcion:
        'Cada tramo de cañería declara su sistema (agua fría, agua caliente, cloacal o pluvial).',
      bloqueante: true,
    },
    {
      itemId: 'sanitaria.diametro_tramos',
      descripcion: 'Cada tramo de cañería tiene diámetro.',
      bloqueante: true,
    },
    {
      itemId: 'sanitaria.longitud_tramos',
      descripcion: 'Cada tramo de cañería tiene longitud acotada.',
      bloqueante: true,
    },
    {
      itemId: 'sanitaria.tipo_accesorios',
      descripcion: 'Cada accesorio declara qué pieza es (codo 90°, codo 45°, te o válvula).',
      bloqueante: true,
    },
    {
      itemId: 'sanitaria.diametro_accesorios',
      descripcion: 'Cada accesorio tiene diámetro.',
      bloqueante: true,
    },
    {
      itemId: 'sanitaria.correspondencia',
      descripcion: 'Cada artefacto tiene un tramo de desagüe cloacal en su mismo ambiente.',
      // Nace en `false`: el desagüe puede estar dibujado en otra lámina, y
      // frenar el rubro entero por un aviso de coherencia sería un cepo.
      bloqueante: false,
    },
    {
      itemId: 'sanitaria.baja_confianza',
      descripcion:
        'Ningún ítem de instalación sanitaria se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
  electrica: [
    {
      itemId: 'electrica.tipo_bocas',
      descripcion: 'Cada boca declara de qué tipo es (toma, luz, caja, tablero o datos).',
      bloqueante: true,
    },
    {
      itemId: 'electrica.baja_confianza',
      descripcion:
        'Ningún ítem de instalación eléctrica se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
  demolicion: [
    {
      itemId: 'demolicion.baja_confianza',
      descripcion: 'Ningún ítem de demolición se apoya en datos por debajo del umbral de confianza.',
      bloqueante: true,
    },
  ],
};

export class ItemChecklistDesconocidoError extends Error {
  constructor(readonly itemId: string) {
    super(`El ítem de checklist «${itemId}» no existe en la plantilla del rubro.`);
    this.name = 'ItemChecklistDesconocidoError';
  }
}

function buscarDefault(rubro: RubroId, itemId: string): ItemChecklistDefault {
  const item = CHECKLIST_DEFAULT[rubro].find((candidato) => candidato.itemId === itemId);
  if (!item) throw new ItemChecklistDesconocidoError(itemId);
  return item;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** Estado de un ítem para el gate. */
export interface EstadoChecklist {
  activo: boolean;
  bloqueante: boolean;
}

/** El estado del ítem más lo que la pantalla de configuración necesita mostrar. */
export interface ItemChecklistEfectivo extends EstadoChecklist, ItemChecklistDefault {
  /** `true` si el estudio lo pisó (hay fila en `checklists_estudio`). */
  personalizado: boolean;
}

async function filasDelEstudio(
  db: Db,
  estudioId: string,
  rubro: RubroId,
): Promise<Map<string, ChecklistEstudio>> {
  const filas = await db
    .select()
    .from(checklistsEstudio)
    .where(and(eq(checklistsEstudio.estudioId, estudioId), eq(checklistsEstudio.rubro, rubro)));
  return new Map(filas.map((fila) => [fila.itemId, fila]));
}

/**
 * El checklist del rubro tal como quedó para este estudio: los defaults de la
 * plantilla con las filas guardadas encima.
 */
export async function listarChecklist(
  db: Db,
  estudioId: string,
  rubro: RubroId,
): Promise<ItemChecklistEfectivo[]> {
  const guardadas = await filasDelEstudio(db, estudioId, rubro);

  return CHECKLIST_DEFAULT[rubro].map((item) => {
    const fila = guardadas.get(item.itemId);
    return {
      ...item,
      activo: fila?.activo ?? true,
      bloqueante: fila?.bloqueante ?? item.bloqueante,
      personalizado: fila !== undefined,
    };
  });
}

/**
 * Lo mismo, indexado, que es lo que el gate necesita.
 *
 * **Fallback a plantilla:** un ítem sin fila en la base sale con el estado de
 * `CHECKLIST_DEFAULT`, así que un estudio que nunca abrió la pantalla se
 * comporta exactamente como antes de que existiera esta tabla.
 */
export async function checklistEfectivo(
  db: Db,
  estudioId: string,
  rubro: RubroId,
): Promise<Map<string, EstadoChecklist>> {
  const lista = await listarChecklist(db, estudioId, rubro);
  return new Map(
    lista.map((item) => [item.itemId, { activo: item.activo, bloqueante: item.bloqueante }]),
  );
}

/**
 * Los checklists de **los cuatro rubros** en un solo mapa.
 *
 * Es lo que necesita cualquier pantalla que cuente bloqueantes de la obra
 * entera (el tablero, la bandeja) y no de un rubro: los `itemId` están
 * namespaceados por rubro (`seco.altura_tabiques`), así que no chocan entre sí.
 */
export async function checklistEfectivoDeTodos(
  db: Db,
  estudioId: string,
): Promise<Map<string, EstadoChecklist>> {
  const listas = await Promise.all(RUBROS.map((rubro) => listarChecklist(db, estudioId, rubro)));
  return new Map(
    listas
      .flat()
      .map((item) => [item.itemId, { activo: item.activo, bloqueante: item.bloqueante }]),
  );
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export interface CambiosItemChecklist {
  activo?: boolean;
  bloqueante?: boolean;
}

/**
 * Persiste el estado de un ítem. Upsert por `(estudio, rubro, item)`: la
 * unicidad ya está en el esquema, así que volver a guardar el mismo ítem
 * actualiza la fila en lugar de agregar otra.
 *
 * La descripción se guarda desde el default, no desde el payload: es texto del
 * producto, no del usuario, y guardarlo hace que la tabla se pueda leer sola
 * (una fila que dice `activo=false` sin decir de qué no sirve para nada).
 */
export async function guardarItemChecklist(
  db: Db,
  actor: { usuarioId: string; email: string; estudioId: string } & UsuarioConRol,
  rubro: RubroId,
  itemId: string,
  cambios: CambiosItemChecklist,
): Promise<ItemChecklistEfectivo> {
  requireAccion(actor, 'editar_checklists');
  const porDefecto = buscarDefault(rubro, itemId);

  const guardadas = await filasDelEstudio(db, actor.estudioId, rubro);
  const previa = guardadas.get(itemId);
  const antes: EstadoChecklist = {
    activo: previa?.activo ?? true,
    bloqueante: previa?.bloqueante ?? porDefecto.bloqueante,
  };
  const despues: EstadoChecklist = {
    activo: cambios.activo ?? antes.activo,
    bloqueante: cambios.bloqueante ?? antes.bloqueante,
  };

  await db
    .insert(checklistsEstudio)
    .values({
      estudioId: actor.estudioId,
      rubro,
      itemId,
      descripcion: porDefecto.descripcion,
      activo: despues.activo,
      bloqueante: despues.bloqueante,
    })
    .onConflictDoUpdate({
      target: [checklistsEstudio.estudioId, checklistsEstudio.rubro, checklistsEstudio.itemId],
      set: { activo: despues.activo, bloqueante: despues.bloqueante, descripcion: porDefecto.descripcion },
    });

  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'checklist_item_actualizado',
    targetRef: `checklists_estudio:${rubro}.${itemId}`,
    diff: {
      activo: { antes: antes.activo, despues: despues.activo },
      bloqueante: { antes: antes.bloqueante, despues: despues.bloqueante },
    },
  });

  return { ...porDefecto, ...despues, personalizado: true };
}

// ---------------------------------------------------------------------------
// El puente con el gate
// ---------------------------------------------------------------------------

/** Un hallazgo leído de la base, con su familia de checklist. */
export type HallazgoConChecklist = HallazgoParaGate & { checklistItem?: string | null };

/**
 * Aplica el checklist del estudio a los hallazgos **antes** de pasarlos al gate.
 *
 * El gate (`src/lib/hallazgos/gate.ts`) es puro y no sabe de estudios ni de
 * bases: sigue contando bloqueantes abiertos. Lo que cambia acá es qué cuenta
 * como bloqueante, que es exactamente lo que el estudio configuró.
 *
 * Un hallazgo sin `checklistItem`, o con uno que no está en el checklist del
 * rubro (`escala`, `sanity.*`), pasa **tal cual**.
 */
export function ajustarHallazgosAlChecklist(
  hallazgos: readonly HallazgoConChecklist[],
  efectivo: ReadonlyMap<string, EstadoChecklist>,
): HallazgoParaGate[] {
  return hallazgos.map((hallazgo) => ({
    rubro: hallazgo.rubro,
    bloqueante: esBloqueanteEfectivo(hallazgo, efectivo),
    estado: hallazgo.estado,
  }));
}

/**
 * ¿Este hallazgo, en concreto, frena la aprobación hoy?
 *
 * Es la regla de una fila —lo que `ajustarHallazgosAlChecklist` aplica a la
 * lista entera—, expuesta aparte porque hay un lugar que necesita **filtrar** y
 * no puede usar la versión de lista: `ajustarHallazgosAlChecklist` devuelve
 * `HallazgoParaGate`, que se queda con `rubro`, `bloqueante` y `estado` y tira
 * la identidad de la fila, así que no sirve para decidir qué mostrar.
 *
 * Ese lugar es el filtro «solo bloqueantes» de la bandeja, que hasta acá miraba
 * el `bloqueante` crudo de la fila mientras el contador de al lado ya miraba el
 * checklist: en un estudio que desactivó un chequeo, el encabezado decía «0
 * bloqueantes» y el filtro seguía mostrando la consulta.
 */
export function esBloqueanteEfectivo(
  hallazgo: HallazgoConChecklist,
  efectivo: ReadonlyMap<string, EstadoChecklist>,
): boolean {
  // Un hallazgo sin `checklistItem`, o con uno que no está en el checklist del
  // rubro (`escala`, `sanity.*`), pasa tal cual.
  const estado = hallazgo.checklistItem ? efectivo.get(hallazgo.checklistItem) : undefined;
  if (!estado) return hallazgo.bloqueante;
  return hallazgo.bloqueante && estado.activo && estado.bloqueante;
}

/**
 * Cuántas consultas **abiertas** frenan hoy la aprobación, con el checklist del
 * estudio aplicado.
 *
 * Es el número que muestran el tablero ("N bloquean la aprobación") y la bandeja
 * ("N bloqueantes"), y tiene que ser el mismo que decide el gate: contar el
 * `bloqueante` crudo de la fila haría que un estudio que desactivó
 * `seco.altura_tabiques` viera "1 bloquea la aprobación" con el rubro
 * perfectamente aprobable.
 */
export function contarBloqueantes(
  hallazgos: readonly HallazgoConChecklist[],
  efectivo: ReadonlyMap<string, EstadoChecklist>,
): number {
  return ajustarHallazgosAlChecklist(hallazgos, efectivo).filter(
    (hallazgo) => hallazgo.bloqueante && hallazgo.estado === 'abierto',
  ).length;
}
