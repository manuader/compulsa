'use server';

/**
 * Acciones de la planilla de cómputo.
 *
 * Tres reglas gobiernan este archivo:
 *
 * 1. **La cantidad de compra la calcula el server.** El cliente manda lo que el
 *    arquitecto escribió (descripción, cantidad neta, desperdicio) y nada más:
 *    `cantCompra` y `presentacion` se recalculan acá aplicando el desperdicio y
 *    redondeando HACIA ARRIBA a la presentación comercial con la que la
 *    plantilla del rubro armó el ítem (P2 del PRD, `src/lib/computo/CLAUDE.md`).
 * 2. **Aislamiento (RNF-4):** todo pasa por `requireObra()` y todo ítem se busca
 *    con `obra_id` en el `where`. Un `itemId` de otra obra no existe.
 * 3. **Toda mutación se audita** con actor y diff (CLAUDE.md §4), y nada se
 *    borra: anular es `estado = 'anulado'`.
 *
 * Sobre las firmas: en un archivo `'use server'` **todo export es un endpoint** y
 * tiene que ser `async`. Por eso los núcleos puros (`recalcularCompra`,
 * `parsearCantidad`, `diffDeItem`) —que no tocan base ni sesión y son los que
 * cubren los tests— también salen `async`: son funciones sin efectos, seguras de
 * exponer, y así se testean sin levantar una base.
 */
import { and, eq, like } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '@/db/client';
import { computoItems, computoRubros, hallazgos } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { requireObra, requireObraCore, requireUser } from '@/lib/auth/guards';
import { redondear2 } from '@/lib/computo/unidades';
import { puedeAprobarRubro } from '@/lib/hallazgos/gate';
import { igualJson } from '@/lib/pipeline/json';
import { ajustarHallazgosAlChecklist, checklistEfectivo } from '@/lib/plataforma/checklists';
import {
  requireAccion,
  RolInsuficienteError,
  UsuarioInactivoError,
  type AccionConRol,
} from '@/lib/plataforma/roles';
import { fechaHoyIso } from '@/lib/precios/gestion';
import { parsearPrecio } from '@/lib/precios/import-csv';
import { PLANTILLAS } from '@/lib/rubros/index';
import {
  numeroEsAr,
  recomputarCompra,
  type CompraCalculada,
  type EntradaCompra,
} from '@/lib/rubros/overrides';
import {
  RUBROS,
  UNIDADES,
  type PrecioEstimado,
  type RolUsuario,
  type RubroId,
} from '@/types/domain';

// ---------------------------------------------------------------------------
// Resultado que ven las pantallas
// ---------------------------------------------------------------------------

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccion = { ok: true } | { ok: false; error: string };

/** Presentación que se guarda en un ítem cargado a mano: el usuario no declaró bulto. */
const SIN_PRESENTACION = 'sin presentación';

// ---------------------------------------------------------------------------
// Núcleos puros (viven en `@/lib/rubros/overrides`)
//
// El recálculo de la compra es EXACTAMENTE el mismo que aplica el override de
// desperdicio configurado por el estudio (`plantillasConConfig`): si la edición
// inline de la planilla y la configuración del estudio no dieran el mismo
// número para la misma neta y el mismo porcentaje, uno de los dos estaría
// mintiendo. Por eso la lógica vive en un módulo puro y acá quedan solo los
// envoltorios `async` que el archivo `'use server'` exige.
// ---------------------------------------------------------------------------

/** La entrada del recálculo, tal como la define el núcleo. */
export type EntradaRecalculo = EntradaCompra;
/** Su salida. */
export type CompraRecalculada = CompraCalculada;

/**
 * Núcleo puro: cantidad válida (≥ 0, 2 decimales) o `null`.
 *
 * `null` es "no lo pude leer", nunca 0. **Y un negativo también da `null`**, no
 * un número negativo: acá adentro `-2` y `dos metros` son lo mismo, "esto no es
 * una cantidad". Quien lo llame no puede distinguirlos con un `<= 0` sobre el
 * resultado —lo intentó `leerCampos` en la bandeja y el negativo se le escapaba
 * al camino de texto—: el chequeo de "no es una medida" se hace sobre el `null`.
 */
export async function parsearCantidad(texto: string): Promise<number | null> {
  const valor = numeroEsAr(texto);
  if (valor === null || valor < 0) return null;
  return redondear2(valor);
}

/**
 * Núcleo puro: cantidad de compra y presentación después de una edición.
 *
 * `cantCompra = ceilAPresentacion(cantNeta × (1 + desperdicio/100))` con la
 * presentación del ítem. Si no la reconozco, la compra es la neta con
 * desperdicio redondeada a 2 decimales y la presentación queda como estaba —
 * antes que inventar un bulto, se muestra el número honesto.
 */
export async function recalcularCompra(entrada: EntradaRecalculo): Promise<CompraRecalculada> {
  return recomputarCompra(entrada);
}

// ---------------------------------------------------------------------------
// Núcleo puro: diff para la auditoría
// ---------------------------------------------------------------------------

export interface ValoresItem {
  descripcion: string;
  cantNeta: number;
  desperdicioPct: number;
  cantCompra: number;
  presentacion: string;
}

/** Núcleo puro: solo los campos que cambiaron, con su antes y su después. */
export async function diffDeItem(
  antes: ValoresItem,
  despues: ValoresItem,
): Promise<Record<string, { antes: unknown; despues: unknown }>> {
  const diff: Record<string, { antes: unknown; despues: unknown }> = {};
  for (const campo of Object.keys(despues) as (keyof ValoresItem)[]) {
    if (antes[campo] !== despues[campo]) {
      diff[campo] = { antes: antes[campo], despues: despues[campo] };
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Validación de payloads (el server nunca confía en el cliente)
// ---------------------------------------------------------------------------

/** Forma 8-4-4-4-12, igual criterio que `requireObraCore`: se chequea la forma. */
const zUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Identificador inválido.');

const zEdicion = z.object({
  obraId: zUuid,
  itemId: zUuid,
  descripcion: z.string().trim().min(1, 'La descripción no puede quedar vacía.').max(200).optional(),
  cantNeta: z.string().optional(),
  desperdicioPct: z.string().optional(),
  /**
   * El precio unitario que carga el arquitecto, en es-AR (`12.500,50`).
   *
   * Ausente ⇒ no se toca. Vacío ⇒ se borra el precio manual y se recompone la
   * cascada en el acto (lista del estudio → índice). Es la **única**
   * puerta por la que entra un `precio_json` con `fuente: 'manual'`: el resto
   * de los precios los pone `sincronizarPrecios` desde tablas que cargó una
   * persona, y la IA no participa en ninguno de los dos caminos (§5.6).
   */
  precioUnitario: z.string().optional(),
});

const zAnulacion = z.object({ obraId: zUuid, itemId: zUuid });

const zItemManual = z.object({
  obraId: zUuid,
  rubro: z.enum(RUBROS, { error: 'Elegí un rubro válido.' }),
  descripcion: z
    .string()
    .trim()
    .min(1, 'Poné una descripción para el ítem.')
    .max(200, 'La descripción no puede pasar de 200 caracteres.'),
  unidad: z.enum(UNIDADES, { error: 'Elegí la unidad del ítem.' }),
  cantNeta: z.string(),
  desperdicioPct: z.string().optional(),
});

const zAprobacion = z.object({ obraId: zUuid, rubro: z.enum(RUBROS, { error: 'Elegí un rubro válido.' }) });

function primerError(error: z.ZodError, porDefecto: string): string {
  return error.issues[0]?.message ?? porDefecto;
}

/**
 * Aplica la matriz de roles (RF-1201) y traduce el rechazo a un `ResultadoAccion`.
 *
 * Editar el cómputo es de colaborador para arriba; **aprobar un rubro es del
 * titular**, porque es una de las cinco acciones que la matriz le saca al
 * colaborador (y porque sin cómputo aprobado no arranca ninguna compulsa).
 * El chequeo va en el server: que el botón esté deshabilitado en la pantalla no
 * es una verificación, estos exports son endpoints HTTP.
 */
function chequearRol(usuario: { rol: RolUsuario; activo: boolean }, accion: AccionConRol): ResultadoAccion {
  try {
    requireAccion(usuario, accion);
    return { ok: true };
  } catch (error) {
    if (error instanceof RolInsuficienteError || error instanceof UsuarioInactivoError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/** La planilla es una pantalla del server: tras mutar hay que revalidarla. */
async function revalidarPlanilla(obraId: string): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath(`/obras/${obraId}/computo`);
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

/**
 * Edición inline de un ítem: descripción, cantidad neta y/o desperdicio.
 * Recalcula la compra, marca `editado_por` (el recómputo del pipeline ya no lo
 * pisa) y audita el diff.
 */
export async function editarItemAction(entrada: unknown): Promise<ResultadoAccion> {
  const parseo = zEdicion.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer los datos del ítem.') };
  }
  const { obraId, itemId, descripcion, cantNeta, desperdicioPct, precioUnitario } = parseo.data;

  const { usuario } = await requireUser();
  const permiso = chequearRol(usuario, 'editar_computo');
  if (!permiso.ok) return permiso;
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [item] = await db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.id, itemId), eq(computoItems.obraId, obra.id)));

  if (!item) return { ok: false, error: 'No encontré ese ítem en esta obra.' };
  if (item.estado === 'anulado') {
    return { ok: false, error: 'Ese ítem está anulado: no se edita. Si lo necesitás, agregá uno nuevo.' };
  }

  let nuevaCantNeta = item.cantNeta;
  if (cantNeta !== undefined) {
    const valor = await parsearCantidad(cantNeta);
    if (valor === null) {
      return { ok: false, error: 'La cantidad neta tiene que ser un número de 0 para arriba (ej.: 30,5).' };
    }
    nuevaCantNeta = valor;
  }

  let nuevoDesperdicio = item.desperdicioPct;
  if (desperdicioPct !== undefined) {
    const valor = await parsearCantidad(desperdicioPct);
    if (valor === null || valor > 100) {
      return { ok: false, error: 'El desperdicio va de 0 a 100 (ej.: 12).' };
    }
    nuevoDesperdicio = valor;
  }

  const compra = await recalcularCompra({
    unidad: item.unidad,
    cantNeta: nuevaCantNeta,
    desperdicioPct: nuevoDesperdicio,
    presentacion: item.presentacion,
    cantCompraActual: item.cantCompra,
  });

  const antes: ValoresItem = {
    descripcion: item.descripcion,
    cantNeta: item.cantNeta,
    desperdicioPct: item.desperdicioPct,
    cantCompra: item.cantCompra,
    presentacion: item.presentacion,
  };
  const despues: ValoresItem = {
    descripcion: descripcion ?? item.descripcion,
    cantNeta: nuevaCantNeta,
    desperdicioPct: nuevoDesperdicio,
    cantCompra: compra.cantCompra,
    presentacion: compra.presentacion,
  };

  // El precio va aparte de las cantidades a propósito. Editar una cantidad es
  // el arquitecto afirmando algo sobre la obra, y por eso marca `editado_por` y
  // congela la fila para el recompute; poner un precio no dice nada de la obra,
  // así que no la congela — lo que sí hace es ganarle a la cascada para siempre
  // (`resolverPrecio`, primer escalón).
  let precioNuevo: PrecioEstimado | null | undefined;
  if (precioUnitario !== undefined) {
    const limpio = precioUnitario.trim();
    if (limpio === '') {
      precioNuevo = null; // volver a la lista: el próximo recompute lo repone
    } else {
      const valor = parsearPrecio(limpio);
      if (valor === null || valor <= 0) {
        return { ok: false, error: 'El precio unitario tiene que ser un número mayor que cero (ej.: 12.500,50).' };
      }
      precioNuevo = {
        unitario: redondear2(valor),
        moneda: obra.moneda,
        fuente: 'manual',
        fechaPrecio: fechaHoyIso(),
      };
    }
  }
  const cambiaPrecio = precioNuevo !== undefined && !igualJson(item.precioJson, precioNuevo);

  const diff = await diffDeItem(antes, despues);
  const cambiaItem = Object.keys(diff).length > 0;
  if (!cambiaItem && !cambiaPrecio) return { ok: true };

  await db
    .update(computoItems)
    .set({
      ...despues,
      ...(cambiaItem ? { editadoPor: usuario.id } : {}),
      ...(cambiaPrecio ? { precioJson: precioNuevo ?? null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(computoItems.id, item.id));

  await registrarAuditoria({
    obraId: obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'computo_item_editado',
    targetRef: `computo_items:${item.claveItem}`,
    diff: cambiaPrecio
      ? { ...diff, precio: { antes: item.precioJson, despues: precioNuevo ?? null } }
      : diff,
  });

  // Borrar el precio manual es pedir explícitamente «volvé a la lista»: sin
  // esto el ítem se quedaba sin precio hasta que algo más disparara un
  // recompute, y el arquitecto veía un guion donde esperaba el precio de la
  // lista. Solo en ese caso: recomputar en cada edición de precio sería pagar
  // una corrida entera para escribir un número que ya tenemos.
  if (precioNuevo === null && cambiaPrecio) {
    const { recomputarObra } = await import('@/lib/pipeline/recomputar');
    await recomputarObra(obra.id, { db });
  }

  await revalidarPlanilla(obra.id);
  return { ok: true };
}

/** Anula un ítem (no se borra nada: `estado = 'anulado'`, `src/db/CLAUDE.md` §7). */
export async function anularItemAction(entrada: unknown): Promise<ResultadoAccion> {
  const parseo = zAnulacion.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer los datos del ítem.') };
  }
  const { obraId, itemId } = parseo.data;

  const { usuario } = await requireUser();
  const permiso = chequearRol(usuario, 'editar_computo');
  if (!permiso.ok) return permiso;
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [item] = await db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.id, itemId), eq(computoItems.obraId, obra.id)));

  if (!item) return { ok: false, error: 'No encontré ese ítem en esta obra.' };
  if (item.estado === 'anulado') return { ok: true };

  await db
    .update(computoItems)
    .set({ estado: 'anulado', editadoPor: usuario.id, updatedAt: new Date() })
    .where(eq(computoItems.id, item.id));

  await registrarAuditoria({
    obraId: obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'computo_item_anulado',
    targetRef: `computo_items:${item.claveItem}`,
    diff: { estado: { antes: 'activo', despues: 'anulado' }, descripcion: item.descripcion },
  });

  await revalidarPlanilla(obra.id);
  return { ok: true };
}

/** Slug estable para la clave de un ítem manual: "seco.manual.zocalo-de-madera". */
function slugDe(descripcion: string): string {
  const slug = descripcion
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'item' : slug;
}

/**
 * Ítem cargado a mano por el arquitecto. Es el **único** caso legítimo de
 * `fuentes_json: []` (CLAUDE.md §2): no sale de ninguna lámina, lo declara una
 * persona, y por eso nace con `editado_por` seteado — el recómputo no lo toca.
 */
export async function crearItemManualAction(entrada: unknown): Promise<ResultadoAccion> {
  const parseo = zItemManual.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer los datos del ítem.') };
  }
  const { obraId, rubro, descripcion, unidad, cantNeta, desperdicioPct } = parseo.data;

  const cantidad = await parsearCantidad(cantNeta);
  if (cantidad === null) {
    return { ok: false, error: 'La cantidad neta tiene que ser un número de 0 para arriba (ej.: 30,5).' };
  }

  const desperdicio = desperdicioPct === undefined ? 0 : await parsearCantidad(desperdicioPct);
  if (desperdicio === null || desperdicio > 100) {
    return { ok: false, error: 'El desperdicio va de 0 a 100 (ej.: 12).' };
  }

  const { usuario } = await requireUser();
  const permiso = chequearRol(usuario, 'editar_computo');
  if (!permiso.ok) return permiso;
  const obra = await requireObra(obraId);
  const db = await getDb();

  const base = `${rubro}.manual.${slugDe(descripcion)}`;
  const tomadas = new Set(
    (
      await db
        .select({ claveItem: computoItems.claveItem })
        .from(computoItems)
        .where(and(eq(computoItems.obraId, obra.id), like(computoItems.claveItem, `${base}%`)))
    ).map((fila) => fila.claveItem),
  );
  let claveItem = base;
  for (let n = 2; tomadas.has(claveItem); n += 1) claveItem = `${base}-${n}`;

  const cantCompra = redondear2(cantidad * (1 + desperdicio / 100));

  const [item] = await db
    .insert(computoItems)
    .values({
      obraId: obra.id,
      rubro,
      claveItem,
      descripcion,
      unidad,
      cantNeta: cantidad,
      desperdicioPct: desperdicio,
      cantCompra,
      presentacion: SIN_PRESENTACION,
      origen: 'explicito',
      fuentesJson: [],
      confianza: 1,
      editadoPor: usuario.id,
    })
    .returning();

  await registrarAuditoria({
    obraId: obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'computo_item_creado',
    targetRef: `computo_items:${claveItem}`,
    diff: {
      rubro,
      descripcion,
      unidad,
      cantNeta: cantidad,
      desperdicioPct: desperdicio,
      cantCompra,
      origen: 'explicito',
      itemId: item?.id ?? null,
    },
  });

  await revalidarPlanilla(obra.id);
  return { ok: true };
}

/**
 * Aprueba el cómputo de un rubro (RF-404).
 *
 * Tres cosas pasan acá, en este orden:
 *
 * 1. **Rol de titular** (RF-1201): aprobar un rubro es una de las cinco
 *    acciones que la matriz le saca al colaborador. Sin cómputo aprobado no
 *    arranca ninguna compulsa, así que la firma es del titular.
 * 2. **El checklist del estudio decide qué frena** (RF-405): un ítem que el
 *    estudio desactivó, o que marcó como no bloqueante, deja de contar para el
 *    gate. Los hallazgos siguen en la bandeja: lo que cambia es si frenan.
 *    Las familias que no son de checklist —`escala`, que administra el
 *    pipeline, y los `sanity.*`— pasan intactas.
 * 3. **El gate se verifica en el server**: que el botón esté habilitado en la
 *    pantalla no alcanza, este export es un endpoint HTTP.
 */
export async function aprobarRubroAction(entrada: unknown): Promise<ResultadoAccion> {
  const parseo = zAprobacion.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer el rubro.') };
  }
  const { obraId, rubro } = parseo.data;

  const { usuario, estudio } = await requireUser();
  const permiso = chequearRol(usuario, 'aprobar_rubro');
  if (!permiso.ok) return permiso;
  const obra = await requireObra(obraId);
  const db = await getDb();

  const resultado = await aprobarRubroCore(
    db,
    { usuarioId: usuario.id, email: usuario.email, estudioId: estudio.id },
    obra.id,
    rubro,
  );
  if (!resultado.ok) return resultado;

  await revalidarPlanilla(obra.id);
  return { ok: true };
}

/**
 * El núcleo de la aprobación: gate + escritura + auditoría, sin sesión y sin
 * revalidación de rutas.
 *
 * Vive separado del action para que lo pueda usar quien no tiene cookies —hoy
 * `scripts/seed.ts`, que necesita un rubro aprobado para lanzar la compulsa de
 * demo—. **El chequeo de rol NO está acá** sino en el llamador: el action lo
 * hace con la sesión, y el seed corre como el titular que crea. Cualquier
 * llamador nuevo tiene que hacer lo mismo (la matriz de roles de P7 es la
 * fuente: `aprobar_rubro` es de titular).
 *
 * ## El aislamiento SÍ está acá, y no es una duda de estilo
 *
 * Este archivo es `'use server'`: **todo export es un endpoint HTTP** con el
 * payload que el cliente quiera. Sin el `requireObraCore` de abajo, un
 * `obraId` de otro estudio aprobaba el rubro de esa obra —y aprobar un rubro es
 * la llave de `lanzarCompulsa`—, porque `actor.estudioId` solo se usaba para
 * leer el checklist y ninguna de las tres queries tenía al estudio en el
 * `where`. El guard va **adentro** del núcleo y no en el action por eso mismo:
 * el action es uno de los llamadores, no el único.
 *
 * Lanza `ObraNoEncontradaError` (no devuelve `{ ok: false }`): una obra que no
 * es de este estudio no existe, y un id ajeno y un id inventado dan el mismo
 * error — no se filtra existencia (RNF-4).
 */
export async function aprobarRubroCore(
  db: Db,
  actor: { usuarioId: string; email: string; estudioId: string },
  obraId: string,
  rubro: RubroId,
): Promise<ResultadoAccion> {
  await requireObraCore(db, actor.estudioId, obraId);

  const abiertos = await db
    .select({
      rubro: hallazgos.rubro,
      bloqueante: hallazgos.bloqueante,
      estado: hallazgos.estado,
      checklistItem: hallazgos.checklistItem,
    })
    .from(hallazgos)
    .where(eq(hallazgos.obraId, obraId));

  const checklist = await checklistEfectivo(db, actor.estudioId, rubro);
  const gate = puedeAprobarRubro(rubro, ajustarHallazgosAlChecklist(abiertos, checklist));
  if (!gate.ok) {
    const una = gate.bloqueantes === 1;
    const consultas = una
      ? 'queda 1 consulta bloqueante abierta'
      : `quedan ${gate.bloqueantes} consultas bloqueantes abiertas`;
    const resolver = una ? 'Respondela o descartala' : 'Respondelas o descartalas';
    return {
      ok: false,
      error: `No puedo aprobar ${PLANTILLAS[rubro].nombre.toLowerCase()}: ${consultas} en la bandeja. ${resolver} y volvé a intentar.`,
    };
  }

  // Un rubro sin ítems no es un rubro aprobado: es un rubro vacío, y aprobado
  // es la llave de `lanzarCompulsa` — la compulsa saldría sin una sola línea.
  // El caso que importa no es la obra que no tiene el rubro sino la que **sí**
  // lo tiene y no se pudo computar: faltó un dato, la planilla quedó en cero y
  // el botón aprobaba igual.
  const activos = await contarItemsActivos(db, obraId, rubro);
  if (activos === 0) {
    return {
      ok: false,
      error:
        `No puedo aprobar ${PLANTILLAS[rubro].nombre.toLowerCase()}: no hay ningún ítem computado en el rubro. ` +
        'Si el expediente tiene esos elementos, mirá la bandeja: falta un dato para poder computarlos. ' +
        'Si la obra no incluye el rubro, no hace falta aprobarlo para lanzar la compulsa de los demás.',
    };
  }

  const [previo] = await db
    .select({ estado: computoRubros.estado })
    .from(computoRubros)
    .where(and(eq(computoRubros.obraId, obraId), eq(computoRubros.rubro, rubro)));
  if (previo?.estado === 'aprobado') return { ok: true }; // idempotente: ni escribe ni audita

  await db
    .insert(computoRubros)
    .values({
      obraId,
      rubro,
      estado: 'aprobado',
      aprobadoPor: actor.usuarioId,
      aprobadoAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [computoRubros.obraId, computoRubros.rubro],
      set: { estado: 'aprobado', aprobadoPor: actor.usuarioId, aprobadoAt: new Date() },
    });

  // Con qué se está aprobando, y no como decoración: desde §5.4 lo deducido y
  // lo inferido entran solos al cómputo, así que un rubro puede aprobarse con
  // cero bloqueantes y aun así apoyarse en datos que no están escritos en
  // ninguna lámina. Cuántos eran queda registrado en la aprobación —es lo que
  // convierte «aprobé el rubro» en «aprobé el rubro con 3 medidas deducidas y
  // 1 medida sacada del dibujo»— y no cambia el gate: la solapa «Para revisar»
  // informa, no bloquea (§5.8).
  const porOrigen = await contarPorOrigen(db, obraId, rubro);

  await registrarAuditoria({
    obraId,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'rubro_aprobado',
    targetRef: `computo_rubros:${rubro}`,
    diff: { estado: { antes: previo?.estado ?? 'borrador', despues: 'aprobado' }, ...porOrigen },
  });

  return { ok: true };
}

/** Cuántos ítems del rubro quedaron en la planilla (los anulados no cuentan). */
async function contarItemsActivos(db: Db, obraId: string, rubro: RubroId): Promise<number> {
  const filas = await db
    .select({ id: computoItems.id })
    .from(computoItems)
    .where(
      and(
        eq(computoItems.obraId, obraId),
        eq(computoItems.rubro, rubro),
        eq(computoItems.estado, 'activo'),
      ),
    );
  return filas.length;
}

/** Cuántos ítems activos del rubro salieron `deducido` y cuántos `inferido`. */
async function contarPorOrigen(
  db: Db,
  obraId: string,
  rubro: RubroId,
): Promise<{ deducidos: number; inferidos: number }> {
  const filas = await db
    .select({ origen: computoItems.origen })
    .from(computoItems)
    .where(
      and(
        eq(computoItems.obraId, obraId),
        eq(computoItems.rubro, rubro),
        eq(computoItems.estado, 'activo'),
      ),
    );
  return {
    deducidos: filas.filter((fila) => fila.origen === 'deducido').length,
    inferidos: filas.filter((fila) => fila.origen === 'inferido').length,
  };
}
