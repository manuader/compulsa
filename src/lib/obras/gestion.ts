/**
 * Gestión de la obra: editar, archivar, desarchivar, eliminar — y eliminar un
 * documento de adentro de una obra viva.
 *
 * ## Por qué esto NO vive en un archivo `'use server'`
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** con el
 * payload que el cliente quiera. Estas funciones reciben `estudioId`, `obraId` y
 * `actor` como parámetros y borran filas: expuestas como endpoint, cualquiera
 * podría eliminar la obra de otro estudio firmándola con el actor que se le
 * antoje. Así que la división es la misma que en `src/lib/bandeja/resolver.ts`:
 * acá los núcleos, y en `src/app/obras/actions.ts` (+ el `actions.ts` del
 * expediente) **solo** los envoltorios `*Action` que sacan el estudio de la
 * sesión y la obra de `requireObra()`.
 *
 * ## El borrado físico y por qué es la excepción
 *
 * `src/db/CLAUDE.md` §7 dice que en datos de negocio no hay deletes físicos:
 * un ítem se anula, un hallazgo se descarta, y la auditoría referencia
 * registros que tienen que seguir existiendo. Eso vale **dentro de una obra
 * viva**, y por eso "borrar una obra" es, por defecto, archivarla.
 *
 * `eliminarObra` es la única salida del sistema y es explícita: solo corre sobre
 * una obra **ya archivada** y purga el universo entero —documentos, láminas,
 * entidades, cómputo, consultas, archivos y la propia auditoría de la obra—.
 * La regla no se rompe: no quedan registros huérfanos que auditar, porque no
 * queda nada a lo que referirse. Lo único que sobrevive es una fila de
 * `auditoria` con `obra_id` en `null` que dice qué se llevó puesto y quién lo
 * pidió. Sin ella, una obra desaparecida no dejaría ni una línea.
 *
 * ## Las cinco reglas del módulo
 *
 * 1. **Aislamiento primero (RNF-4).** Toda función arranca con
 *    `requireObraCore(db, estudioId, obraId)`: la obra es del estudio o no
 *    existe. Un id ajeno y un id inventado dan el mismo error — no se filtra
 *    existencia.
 * 2. **Nada se audita si nada cambió.** Archivar lo archivado, desarchivar lo
 *    activo y editar sin cambios reales son no-ops silenciosos: una auditoría
 *    que registra un no-cambio es ruido que después nadie sabe leer (§7.3 del
 *    HANDOFF, el problema de las auditorías fantasma).
 * 3. **Los ítems no se borran nunca por un documento.** Eliminar un documento
 *    se lleva sus láminas y sus entidades; los `computo_items` que dependían
 *    quedan **anulados** por el recompute, con `entidad_id` en `null`. Un ítem
 *    que el arquitecto editó a mano sobrevive: pierde el link, no la fila.
 * 4. **Toda mutación se audita** con actor `usuario` y diff (CLAUDE.md §4).
 * 5. **Toda mutación pide rol** (RF-1201): editar, archivar y borrar un
 *    documento son de colaborador para arriba; **eliminar una obra es del
 *    titular**, porque es la única salida irreversible del sistema. El chequeo
 *    va antes que el de aislamiento a propósito: a un usuario sin permiso hay
 *    que decirle que no tiene permiso, no que la obra no existe.
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import {
  auditoria,
  computoItems,
  computoRubros,
  documentos,
  entidades,
  hallazgos,
  laminas,
  obras,
  type EstadoObra,
  type Obra,
} from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { esUuid, requireObraCore } from '@/lib/auth/guards';
import { erroresPorCampo, zCambiosObra } from '@/lib/obras/schema';
import { claveEscala } from '@/lib/pipeline/claves';
import { desvincularItemsDeEntidades, recomputarObra } from '@/lib/pipeline/recomputar';
import { requireAccion, type UsuarioConRol } from '@/lib/plataforma/roles';
import type { StorageAdapter } from '@/lib/storage/index';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/**
 * Quién hace el cambio. Los `*Action` lo sacan de la sesión, nunca del payload.
 *
 * Lleva el **rol** y si está activo porque el enforcement de la matriz (RF-1201)
 * vive acá adentro, no en la pantalla: estas funciones son endpoints potenciales
 * si alguien las exporta mal, y un botón escondido no esconde nada. El core no
 * puede leer el rol por su cuenta —recibe la base por parámetro y no sabe de
 * sesiones—, así que se lo tienen que pasar.
 */
export interface ActorObra extends UsuarioConRol {
  usuarioId: string;
  email: string;
}

/** La lista de obras del estudio más los dos contadores que la pantalla muestra. */
export interface ListadoObras {
  obras: Obra[];
  activas: number;
  archivadas: number;
}

export type ResultadoEdicion =
  | { ok: true; obra: Obra; cambios: Record<string, { antes: unknown; despues: unknown }> }
  | { ok: false; errores: Record<string, string> };

/** Qué se llevó puesto la eliminación de una obra, tabla por tabla. */
export interface ConteosObra {
  documentos: number;
  laminas: number;
  entidades: number;
  computoItems: number;
  computoRubros: number;
  hallazgos: number;
  auditoria: number;
  /** Archivos que la obra tenía en el storage: los que se intentó borrar. */
  archivos: number;
  /**
   * De esos, cuántos el storage no pudo borrar. Quedan huérfanos (basura, no
   * corrupción) y su lista está en la auditoría `obra_archivos_pendientes`.
   */
  archivosPendientes: number;
}

/** Qué se llevó puesto la eliminación de un documento. */
export interface ConteosDocumento {
  laminas: number;
  entidades: number;
  /** Ítems que perdieron el link con una entidad que desapareció. */
  itemsDesvinculados: number;
  /** Ítems que el recompute posterior dejó en `anulado`. */
  itemsAnulados: number;
  /** Consultas de bloqueo por escala cerradas a mano (el recompute no las cierra). */
  hallazgosEscala: number;
  archivos: number;
}

/** Respuesta con la que se cierran las consultas de escala de un documento borrado. */
export const RESPUESTA_DOCUMENTO_ELIMINADO = { auto: 'documento eliminado' } as const;

/**
 * Acción de la auditoría que lista los archivos que el storage no pudo borrar
 * al eliminar una obra. Es una **segunda** fila, después de `obra_eliminada`:
 * la obra ya no está, y lo que queda es una tarea de limpieza con nombre y
 * apellido de cada archivo.
 */
export const ACCION_ARCHIVOS_PENDIENTES = 'obra_archivos_pendientes';

/** Cuántas refs entran en el diff de esa fila. Más que esto no es una lista, es un volcado. */
const MAX_REFS_AUDITADAS = 50;

export class ObraNoArchivadaError extends Error {
  constructor(readonly obraId: string) {
    super(
      'Primero archivala: una obra activa no se puede eliminar. Archivala, fijate que no la necesites, y recién ahí eliminala.',
    );
    this.name = 'ObraNoArchivadaError';
  }
}

export class DocumentoNoEncontradoError extends Error {
  constructor(readonly documentoId: string) {
    super('No encontré ese documento en esta obra.');
    this.name = 'DocumentoNoEncontradoError';
  }
}

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

function auditar(
  obraId: string | undefined,
  actor: ActorObra,
  accion: string,
  targetRef: string,
  diff: Record<string, unknown>,
): Promise<void> {
  return registrarAuditoria({
    obraId,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion,
    targetRef,
    diff,
  });
}

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------

/**
 * Las obras del estudio. Por defecto **solo las activas**: archivar tiene que
 * sacar la obra de la vista, o no serviría de nada.
 *
 * Los contadores salen siempre completos (activas y archivadas), porque la
 * pantalla necesita saber cuántas archivadas hay para ofrecer verlas aunque
 * esté mostrando las activas.
 */
export async function listarObras(
  db: Db,
  estudioId: string,
  opciones: { archivadas?: boolean } = {},
): Promise<ListadoObras> {
  const estado: EstadoObra = opciones.archivadas ? 'archivada' : 'activa';

  const lista = await db
    .select()
    .from(obras)
    .where(and(eq(obras.estudioId, estudioId), eq(obras.estado, estado)))
    .orderBy(desc(obras.createdAt));

  const totales = await db
    .select({ estado: obras.estado, total: count() })
    .from(obras)
    .where(eq(obras.estudioId, estudioId))
    .groupBy(obras.estado);

  const porEstado = new Map(totales.map((fila) => [fila.estado, fila.total]));
  return {
    obras: lista,
    activas: porEstado.get('activa') ?? 0,
    archivadas: porEstado.get('archivada') ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Edición
// ---------------------------------------------------------------------------

type CamposEditables = Pick<Obra, 'nombre' | 'zona' | 'tipo' | 'moneda'>;

/**
 * Edita los datos de la obra. Valida con el mismo schema que el alta
 * (`@/lib/obras/schema`) y audita **solo los campos que efectivamente
 * cambiaron**, con su antes y su después.
 */
export async function editarObra(
  db: Db,
  estudioId: string,
  obraId: string,
  cambios: unknown,
  actor: ActorObra,
): Promise<ResultadoEdicion> {
  requireAccion(actor, 'editar_obra');
  const obra = await requireObraCore(db, estudioId, obraId);

  const parseo = zCambiosObra.safeParse(cambios);
  if (!parseo.success) return { ok: false, errores: erroresPorCampo(parseo.error) };
  const datos = parseo.data;

  const set: Partial<CamposEditables> = {};
  const diff: Record<string, { antes: unknown; despues: unknown }> = {};

  function proponer<K extends keyof CamposEditables>(
    campo: K,
    valor: CamposEditables[K] | undefined,
  ): void {
    if (valor === undefined || valor === obra[campo]) return;
    set[campo] = valor;
    diff[campo] = { antes: obra[campo], despues: valor };
  }

  proponer('nombre', datos.nombre);
  proponer('zona', datos.zona);
  proponer('tipo', datos.tipo);
  proponer('moneda', datos.moneda);

  // Guardar sin haber tocado nada es lo más común de un formulario de edición:
  // ni escritura ni auditoría (regla 2).
  if (Object.keys(set).length === 0) return { ok: true, obra, cambios: {} };

  const [actualizada] = await db.update(obras).set(set).where(eq(obras.id, obra.id)).returning();
  await auditar(obra.id, actor, 'obra_editada', `obras:${obra.id}`, diff);

  return { ok: true, obra: actualizada, cambios: diff };
}

// ---------------------------------------------------------------------------
// Archivar / desarchivar
// ---------------------------------------------------------------------------

async function cambiarEstado(
  db: Db,
  estudioId: string,
  obraId: string,
  estado: EstadoObra,
  actor: ActorObra,
): Promise<Obra> {
  requireAccion(actor, 'archivar_obra');
  const obra = await requireObraCore(db, estudioId, obraId);
  if (obra.estado === estado) return obra; // idempotente y sin auditar (regla 2)

  const [actualizada] = await db
    .update(obras)
    .set({ estado })
    .where(eq(obras.id, obra.id))
    .returning();

  await auditar(
    obra.id,
    actor,
    estado === 'archivada' ? 'obra_archivada' : 'obra_desarchivada',
    `obras:${obra.id}`,
    { estado: { antes: obra.estado, despues: estado } },
  );

  return actualizada;
}

/**
 * Saca la obra del listado sin tocar un solo dato: es lo que en el producto
 * significa "borrar una obra". Reversible con `desarchivarObra`.
 */
export function archivarObra(
  db: Db,
  estudioId: string,
  obraId: string,
  actor: ActorObra,
): Promise<Obra> {
  return cambiarEstado(db, estudioId, obraId, 'archivada', actor);
}

export function desarchivarObra(
  db: Db,
  estudioId: string,
  obraId: string,
  actor: ActorObra,
): Promise<Obra> {
  return cambiarEstado(db, estudioId, obraId, 'activa', actor);
}

// ---------------------------------------------------------------------------
// Eliminación definitiva de la obra
// ---------------------------------------------------------------------------

/**
 * Borra la obra y todo su universo. **Irreversible.**
 *
 * Tres cosas que el orden de este cuerpo resuelve:
 *
 *  - **Solo sobre una obra archivada.** Es la única puerta que hace falta para
 *    que nadie elimine sin haber pasado antes por un estado intermedio y
 *    visible.
 *  - **Las FKs mandan el orden del borrado:** `hallazgos` y `computo_items`
 *    antes que `entidades` (los ítems apuntan a la entidad), `entidades` antes
 *    que `laminas`, `laminas` antes que `documentos`, y la obra al final. No se
 *    usa `desvincularItemsDeEntidades` acá porque los ítems se van igual: la
 *    desvinculación existe para cuando la fila sobrevive.
 *  - **Primero la base, después los archivos.** Si el storage falla a mitad de
 *    camino quedan archivos huérfanos —basura, recuperable a mano—; al revés
 *    quedaría una obra visible con sus PDF ya borrados, que es peor.
 *
 * ## Por qué el rastro se escribe ANTES de tocar el storage
 *
 * La fila `obra_eliminada` es lo único que sobrevive a la purga: sin ella, una
 * obra desaparecida no deja ni una línea. Los deletes de la base ya
 * commitearon cuando arranca la limpieza de archivos, así que si el rastro se
 * escribiera al final, un `EACCES` cualquiera en un solo archivo —permisos, un
 * disco lleno, el volumen desmontado— dejaría la obra borrada de la base y
 * **cero** auditoría. El orden correcto es: purgar, dejar el rastro, y recién
 * después barrer los archivos.
 *
 * Por lo mismo, un archivo que no se puede borrar **no aborta la limpieza del
 * resto**: cada ref va en su propio try, los que fallan se juntan y salen en
 * una segunda fila de auditoría (`obra_archivos_pendientes`) con la lista, que
 * es lo que convierte "algo quedó colgado" en una tarea accionable. La función
 * no lanza: la obra se eliminó de verdad, y avisarle al usuario que falló sería
 * mentirle sobre lo que pasó.
 */
export async function eliminarObra(
  db: Db,
  storage: StorageAdapter,
  estudioId: string,
  obraId: string,
  actor: ActorObra,
): Promise<ConteosObra> {
  // Eliminar una obra es una de las cinco acciones que la matriz le saca al
  // colaborador: es la única salida irreversible del sistema.
  requireAccion(actor, 'eliminar_obra');
  const obra = await requireObraCore(db, estudioId, obraId);
  if (obra.estado !== 'archivada') throw new ObraNoArchivadaError(obra.id);

  // Las refs se leen antes: después del delete no hay de dónde sacarlas.
  const refsDocumentos = await db
    .select({ ref: documentos.archivoRef })
    .from(documentos)
    .where(eq(documentos.obraId, obra.id));
  const refsLaminas = await db
    .select({ ref: laminas.archivoRef })
    .from(laminas)
    .where(eq(laminas.obraId, obra.id));
  const refs = [...refsDocumentos.map((f) => f.ref), ...refsLaminas.map((f) => f.ref)];

  const hallazgosBorrados = await db
    .delete(hallazgos)
    .where(eq(hallazgos.obraId, obra.id))
    .returning({ id: hallazgos.id });
  const itemsBorrados = await db
    .delete(computoItems)
    .where(eq(computoItems.obraId, obra.id))
    .returning({ id: computoItems.id });
  const rubrosBorrados = await db
    .delete(computoRubros)
    .where(eq(computoRubros.obraId, obra.id))
    .returning({ id: computoRubros.id });
  const entidadesBorradas = await db
    .delete(entidades)
    .where(eq(entidades.obraId, obra.id))
    .returning({ id: entidades.id });
  const laminasBorradas = await db
    .delete(laminas)
    .where(eq(laminas.obraId, obra.id))
    .returning({ id: laminas.id });
  const documentosBorrados = await db
    .delete(documentos)
    .where(eq(documentos.obraId, obra.id))
    .returning({ id: documentos.id });
  const auditoriaBorrada = await db
    .delete(auditoria)
    .where(eq(auditoria.obraId, obra.id))
    .returning({ id: auditoria.id });
  await db.delete(obras).where(eq(obras.id, obra.id));

  const purgado = {
    documentos: documentosBorrados.length,
    laminas: laminasBorradas.length,
    entidades: entidadesBorradas.length,
    computoItems: itemsBorrados.length,
    computoRubros: rubrosBorrados.length,
    hallazgos: hallazgosBorrados.length,
    auditoria: auditoriaBorrada.length,
    archivos: refs.length,
  };

  // La fila que queda: sin `obra_id` (la obra ya no existe y la FK la rechazaría)
  // y con el nombre en el `target_ref`, que es lo único con lo que una persona
  // puede reconocer después qué se eliminó. Va acá, con la base ya purgada y el
  // storage sin tocar: es el único punto del cuerpo en el que no se puede
  // perder (ver el encabezado).
  await auditar(undefined, actor, 'obra_eliminada', `obras:${obra.nombre}`, {
    obraId: obra.id,
    nombre: obra.nombre,
    zona: obra.zona,
    tipo: obra.tipo,
    ...purgado,
  });

  // Secuencial a propósito: son decenas de refs y el adapter local no gana nada
  // en paralelo. Si algún día el storage es remoto y esto pesa, el lugar del
  // batch es acá — no cambia nada de lo de arriba.
  const pendientes: string[] = [];
  let ultimoDetalle: string | null = null;
  for (const ref of refs) {
    try {
      await storage.eliminar(ref);
    } catch (error) {
      pendientes.push(ref);
      ultimoDetalle = error instanceof Error ? error.message : String(error);
    }
  }

  if (pendientes.length > 0) {
    await auditar(undefined, actor, ACCION_ARCHIVOS_PENDIENTES, `obras:${obra.nombre}`, {
      obraId: obra.id,
      nombre: obra.nombre,
      pendientes: pendientes.length,
      refs: pendientes.slice(0, MAX_REFS_AUDITADAS),
      truncado: pendientes.length > MAX_REFS_AUDITADAS,
      detalle: ultimoDetalle,
      motivo: 'La obra se eliminó; estos archivos quedaron en el storage y hay que borrarlos a mano.',
    });
  }

  return { ...purgado, archivosPendientes: pendientes.length };
}

// ---------------------------------------------------------------------------
// Eliminación de un documento
// ---------------------------------------------------------------------------

/**
 * Borra **una versión** de un documento (los documentos se versionan por
 * `nombre_archivo`: subir el mismo nombre otra vez crea otra fila, y esto se
 * lleva solo la que se le pide) con sus láminas, sus entidades y sus archivos.
 *
 * Qué pasa con lo que dependía:
 *
 *  - Los `computo_items` de esas entidades **no se borran**: primero pierden el
 *    link (`desvincularItemsDeEntidades`, que audita ítem por ítem) y después el
 *    recompute los deja en `anulado`, porque el motor ya no los emite.
 *  - Los hallazgos del motor se cierran solos en el recompute: sus claves dejan
 *    de emitirse.
 *  - Los hallazgos `escala.<laminaId>` **no**: `esClaveDelMotor()` los cerca a
 *    propósito para que el recompute no cierre un bloqueo que administra el
 *    pipeline (`src/lib/pipeline/claves.ts`). Si no los cerráramos acá, la
 *    bandeja quedaría con una consulta bloqueante sobre una lámina que ya no
 *    existe, y ningún rubro se podría aprobar nunca más.
 */
export async function eliminarDocumento(
  db: Db,
  storage: StorageAdapter,
  estudioId: string,
  obraId: string,
  documentoId: string,
  actor: ActorObra,
): Promise<ConteosDocumento> {
  requireAccion(actor, 'eliminar_documento');
  const obra = await requireObraCore(db, estudioId, obraId);
  if (!esUuid(documentoId)) throw new DocumentoNoEncontradoError(documentoId);

  const [documento] = await db
    .select()
    .from(documentos)
    .where(and(eq(documentos.id, documentoId), eq(documentos.obraId, obra.id)));
  if (!documento) throw new DocumentoNoEncontradoError(documentoId);

  const lams = await db.select().from(laminas).where(eq(laminas.documentoId, documento.id));
  const laminaIds = lams.map((lamina) => lamina.id);

  let itemsDesvinculados = 0;
  let entidadesBorradas = 0;
  let hallazgosEscala = 0;

  if (laminaIds.length > 0) {
    const ents = await db
      .select({ id: entidades.id })
      .from(entidades)
      .where(and(eq(entidades.obraId, obra.id), inArray(entidades.laminaId, laminaIds)));
    const entidadIds = ents.map((entidad) => entidad.id);

    if (entidadIds.length > 0) {
      itemsDesvinculados = await desvincularItemsDeEntidades(db, obra.id, entidadIds);
      entidadesBorradas = (
        await db.delete(entidades).where(inArray(entidades.id, entidadIds)).returning({
          id: entidades.id,
        })
      ).length;
    }

    // El hallazgo se cierra ANTES del recompute, igual que en la bandeja: si no,
    // quedaría abierto para siempre sobre una lámina inexistente.
    const cerrados = await db
      .update(hallazgos)
      .set({ estado: 'descartado', respuestaJson: { ...RESPUESTA_DOCUMENTO_ELIMINADO } })
      .where(
        and(
          eq(hallazgos.obraId, obra.id),
          eq(hallazgos.estado, 'abierto'),
          inArray(hallazgos.clave, laminaIds.map(claveEscala)),
        ),
      )
      .returning({ clave: hallazgos.clave });
    hallazgosEscala = cerrados.length;
    for (const { clave } of cerrados) {
      await auditar(obra.id, actor, 'hallazgo_descartado', `hallazgos:${clave}`, {
        ...RESPUESTA_DOCUMENTO_ELIMINADO,
      });
    }

    await db.delete(laminas).where(eq(laminas.documentoId, documento.id));
  }

  await db.delete(documentos).where(eq(documentos.id, documento.id));

  const refs = [documento.archivoRef, ...lams.map((lamina) => lamina.archivoRef)];
  for (const ref of refs) await storage.eliminar(ref);

  const resumen = await recomputarObra(obra.id, { db });

  const conteos: ConteosDocumento = {
    laminas: laminaIds.length,
    entidades: entidadesBorradas,
    itemsDesvinculados,
    itemsAnulados: resumen.itemsAnulados,
    hallazgosEscala,
    archivos: refs.length,
  };

  await auditar(obra.id, actor, 'documento_eliminado', `documentos:${documento.id}`, {
    nombreArchivo: documento.nombreArchivo,
    version: documento.version,
    ...conteos,
  });

  return conteos;
}
