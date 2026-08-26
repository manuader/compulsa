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

import { getDb } from '@/db/client';
import { computoItems, computoRubros, hallazgos } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { requireObra, requireUser } from '@/lib/auth/guards';
import {
  ceilAPresentacion,
  describirLatas,
  describirPresentacion,
  latasParaLitros,
} from '@/lib/computo/presentacion';
import { ETIQUETA_UNIDAD, formatearNumero, redondear2 } from '@/lib/computo/unidades';
import { puedeAprobarRubro } from '@/lib/hallazgos/gate';
import { PLANTILLAS } from '@/lib/rubros/index';
import { RUBROS, UNIDADES, type Unidad } from '@/types/domain';

// ---------------------------------------------------------------------------
// Resultado que ven las pantallas
// ---------------------------------------------------------------------------

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccion = { ok: true } | { ok: false; error: string };

/** Presentación que se guarda en un ítem cargado a mano: el usuario no declaró bulto. */
const SIN_PRESENTACION = 'sin presentación';

// ---------------------------------------------------------------------------
// Núcleo puro: números en es-AR
// ---------------------------------------------------------------------------

/**
 * Lee un número escrito por una persona en Argentina: coma decimal y punto de
 * miles (`1.234,5`), o punto decimal si es lo único que hay (`30.5`). Devuelve
 * `null` si no hay número — el server nunca adivina un valor.
 */
function numeroEsAr(texto: string): number | null {
  const limpio = texto.replace(/[\s\u00a0]/g, '');
  if (limpio === '') return null;

  // Con coma presente, los puntos son separadores de miles; sin coma, un punto
  // solo es el separador decimal.
  const normalizado = limpio.includes(',')
    ? limpio.replace(/\./g, '').replace(',', '.')
    : limpio;

  if (!/^[+-]?\d*\.?\d+$/.test(normalizado)) return null;
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

/**
 * Núcleo puro: cantidad válida (≥ 0, 2 decimales) o `null`.
 * `null` es "no lo pude leer", nunca 0.
 */
export async function parsearCantidad(texto: string): Promise<number | null> {
  const valor = numeroEsAr(texto);
  if (valor === null || valor < 0) return null;
  return redondear2(valor);
}

// ---------------------------------------------------------------------------
// Núcleo puro: recálculo de la cantidad de compra
// ---------------------------------------------------------------------------

export interface EntradaRecalculo {
  unidad: Unidad;
  /** Cantidad neta ya editada. */
  cantNeta: number;
  /** Desperdicio ya editado, en porcentaje. */
  desperdicioPct: number;
  /** La presentación con la que se emitió el ítem ("11 placas de 2,88 m²"). */
  presentacion: string;
  /** La compra vigente: de ella sale cuánto trae cada bulto. */
  cantCompraActual: number;
}

export interface CompraRecalculada {
  cantCompra: number;
  presentacion: string;
}

/**
 * Cómo se compra el ítem, deducido de su propia presentación. Las plantillas
 * (`src/lib/rubros/*`) escriben esos textos con `describirPresentacion()`,
 * `describirLatas()` y el formato de granel de `presentacion.ts`: acá se hace el
 * camino inverso para no duplicar los números de las plantillas en la UI.
 */
type ModoCompra =
  | { tipo: 'bulto'; singular: string; plural: string; detalle: string; contenido: number }
  | { tipo: 'granel'; multiplo: number }
  | { tipo: 'latas' }
  | { tipo: 'global' }
  | { tipo: 'medida' }
  /** No reconocí la presentación: se aplica desperdicio y se deja el texto como está. */
  | { tipo: 'desconocido' };

/** "11 placas de 2,88 m²" → unidades, nombre del bulto y detalle. */
const BULTO_RE = /^([\d.,]+)\s+(\p{L}+)\s+de\s+(.+)$/u;
/** "4,5 m³ a granel (múltiplos de 0,5 m³)". */
const GRANEL_RE = /múltiplos de\s+([\d.,]+)/u;
/** "1 lata 20 L + 2 latas 1 L". */
const LATAS_RE = /\blatas?\b/u;
/** "2,88 m²" → contenido y etiqueta de unidad del bulto. */
const DETALLE_RE = /^([\d.,]+)\s*(\S+)$/u;

function inferirModoCompra(entrada: EntradaRecalculo): ModoCompra {
  const texto = entrada.presentacion.trim();
  if (texto === 'global') return { tipo: 'global' };
  if (texto === 'a medida') return { tipo: 'medida' };
  if (entrada.unidad === 'l' && (LATAS_RE.test(texto) || texto === 'sin compra')) {
    return { tipo: 'latas' };
  }

  const granel = GRANEL_RE.exec(texto);
  if (granel) {
    const multiplo = numeroEsAr(granel[1]!);
    if (multiplo !== null && multiplo > 0) return { tipo: 'granel', multiplo };
    return { tipo: 'desconocido' };
  }

  const bulto = BULTO_RE.exec(texto);
  if (!bulto) return { tipo: 'desconocido' };

  const unidades = numeroEsAr(bulto[1]!);
  const nombre = bulto[2]!;
  const detalle = bulto[3]!;
  const contenido = contenidoDelBulto(unidades, detalle, entrada);
  if (contenido === null) return { tipo: 'desconocido' };

  // El plural es regular en todos los bultos del corralón (placa/placas,
  // caja/cajas, pallet/pallets): con la forma que ya está escrita alcanza.
  const singular = unidades === 1 ? nombre : nombre.replace(/s$/u, '');
  const plural = unidades === 1 ? `${nombre}s` : nombre;
  return { tipo: 'bulto', singular, plural, detalle, contenido };
}

/**
 * Cuánto trae el bulto. La fuente de verdad es la compra vigente dividida por
 * los bultos que se compraron: el detalle es texto comercial y puede no ser el
 * contenido (una tira de montante son 2,60 m pero el ítem se compra por unidad).
 * Recién si no hay compra vigente se mira el detalle, y solo cuando su unidad
 * coincide con la del ítem.
 */
function contenidoDelBulto(
  unidades: number | null,
  detalle: string,
  entrada: EntradaRecalculo,
): number | null {
  if (unidades !== null && unidades > 0 && entrada.cantCompraActual > 0) {
    const contenido = redondear2(entrada.cantCompraActual / unidades);
    if (contenido > 0) return contenido;
  }

  const partes = DETALLE_RE.exec(detalle.trim());
  if (!partes || partes[2] !== ETIQUETA_UNIDAD[entrada.unidad]) return null;
  const contenido = numeroEsAr(partes[1]!);
  return contenido !== null && contenido > 0 ? contenido : null;
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
  const cantNeta = redondear2(Math.max(0, entrada.cantNeta));
  const conDesperdicio = redondear2(cantNeta * (1 + entrada.desperdicioPct / 100));
  const modo = inferirModoCompra(entrada);

  switch (modo.tipo) {
    case 'bulto': {
      const { unidades, cantCompra } = ceilAPresentacion(conDesperdicio, modo.contenido);
      return {
        cantCompra,
        presentacion: describirPresentacion(unidades, {
          singular: modo.singular,
          plural: modo.plural,
          contenido: modo.contenido,
          detalle: modo.detalle,
        }),
      };
    }
    case 'granel': {
      const { cantCompra } = ceilAPresentacion(conDesperdicio, modo.multiplo);
      const etiqueta = ETIQUETA_UNIDAD[entrada.unidad];
      return {
        cantCompra,
        presentacion: `${formatearNumero(cantCompra)} ${etiqueta} a granel (múltiplos de ${formatearNumero(modo.multiplo)} ${etiqueta})`,
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
    case 'desconocido':
      return { cantCompra: conDesperdicio, presentacion: entrada.presentacion };
  }
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
  const { obraId, itemId, descripcion, cantNeta, desperdicioPct } = parseo.data;

  const { usuario } = await requireUser();
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

  const diff = await diffDeItem(antes, despues);
  if (Object.keys(diff).length === 0) return { ok: true };

  await db
    .update(computoItems)
    .set({ ...despues, editadoPor: usuario.id, updatedAt: new Date() })
    .where(eq(computoItems.id, item.id));

  await registrarAuditoria({
    obraId: obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'computo_item_editado',
    targetRef: `computo_items:${item.claveItem}`,
    diff,
  });

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
 * Aprueba el cómputo de un rubro (RF-404). El gate se verifica **en el server**:
 * que el botón esté habilitado en la pantalla no alcanza — mientras quede un
 * hallazgo bloqueante abierto del rubro, la aprobación se rechaza con el número
 * de consultas pendientes.
 */
export async function aprobarRubroAction(entrada: unknown): Promise<ResultadoAccion> {
  const parseo = zAprobacion.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer el rubro.') };
  }
  const { obraId, rubro } = parseo.data;

  const { usuario } = await requireUser();
  const obra = await requireObra(obraId);
  const db = await getDb();

  const abiertos = await db
    .select({
      rubro: hallazgos.rubro,
      bloqueante: hallazgos.bloqueante,
      estado: hallazgos.estado,
    })
    .from(hallazgos)
    .where(eq(hallazgos.obraId, obra.id));

  const gate = puedeAprobarRubro(rubro, abiertos);
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

  const [previo] = await db
    .select({ estado: computoRubros.estado })
    .from(computoRubros)
    .where(and(eq(computoRubros.obraId, obra.id), eq(computoRubros.rubro, rubro)));

  await db
    .insert(computoRubros)
    .values({
      obraId: obra.id,
      rubro,
      estado: 'aprobado',
      aprobadoPor: usuario.id,
      aprobadoAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [computoRubros.obraId, computoRubros.rubro],
      set: { estado: 'aprobado', aprobadoPor: usuario.id, aprobadoAt: new Date() },
    });

  await registrarAuditoria({
    obraId: obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'rubro_aprobado',
    targetRef: `computo_rubros:${rubro}`,
    diff: { estado: { antes: previo?.estado ?? 'borrador', despues: 'aprobado' } },
  });

  await revalidarPlanilla(obra.id);
  return { ok: true };
}
