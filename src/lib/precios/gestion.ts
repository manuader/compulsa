/**
 * La lista de precios de referencia del estudio (`precios_referencia`, §5.6):
 * alta a mano, edición, borrado e import masivo desde CSV.
 *
 * ## Por qué esto NO vive en un archivo `'use server'`
 *
 * La misma razón que en `src/lib/proveedores/gestion.ts`: ahí **todo export es
 * un endpoint HTTP** con el payload que el cliente quiera. Estas funciones
 * reciben el actor —con su `estudioId` y su rol— por parámetro; expuestas como
 * endpoint, cualquiera podría escribirle la lista de precios a otro estudio
 * firmando con el rol que se le antoje. Los envoltorios `*Action` viven en
 * `src/app/estudio/precios/actions.ts` y sacan las dos cosas de la sesión.
 *
 * ## Upsert por `(estudio, clave_item)`
 *
 * La tabla tiene un `UNIQUE (estudio_id, clave_item)`: un ítem tiene **un**
 * precio de referencia por estudio. Volver a cargarlo lo pisa, no lo duplica.
 * Y si lo que llega es idéntico a lo que ya está, no se escribe ni se audita:
 * una auditoría que registra un no-cambio es ruido que después nadie sabe leer
 * (misma regla que `guardarConfig` y que `editarProveedor`).
 *
 * El precio se redondea a dos decimales **antes** de comparar, porque la
 * columna es `numeric(14,2)`: sin eso, cargar 12,555 escribiría 12,56 y la
 * corrida siguiente vería un cambio que no existió, para siempre.
 *
 * ## Roles (RF-1201)
 *
 * La lista de precios es configuración del estudio, así que pide lo mismo que
 * el resto de `/estudio`: `configurar_estudio`, o sea colaborador para arriba.
 * El chequeo va con `requireAccion` —el guard canónico de
 * `@/lib/plataforma/roles`— y está en el **core**, no solo en la pantalla.
 *
 * ## Sin reloj adentro
 *
 * Una fila del CSV sin fecha entra con la fecha que le pasa quien llama
 * (`fechaDefault`), no con la que este módulo lea del sistema. Así el test
 * pinnea la fecha y el import es reproducible; `fechaHoyIso()` está acá al lado
 * para que la pantalla la calcule en un solo lugar.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { preciosReferencia, type OrigenPrecio, type PrecioReferencia } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { esUuid } from '@/lib/auth/guards';
import { redondear2 } from '@/lib/computo/unidades';
import { requireAccion, type UsuarioConRol } from '@/lib/plataforma/roles';
import type { ErrorImportPrecio, FilaPrecio } from '@/lib/precios/import-csv';
import { MONEDA_DEFAULT, type FilaLista } from '@/lib/precios/resolver';
import { UNIDADES } from '@/types/domain';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/** Quién toca la lista: sesión resuelta, con su estudio y su rol. */
export interface ActorPrecios extends UsuarioConRol {
  usuarioId: string;
  email: string;
  estudioId: string;
}

export type ResultadoPrecio =
  | {
      ok: true;
      precio: PrecioReferencia;
      /** `true` si la fila no existía. */
      creado: boolean;
      /** Qué cambió, con antes y después. Vacío ⇒ no se escribió nada. */
      cambios: Record<string, { antes: unknown; despues: unknown }>;
    }
  | { ok: false; errores: Record<string, string> };

export interface ResumenImportPrecios {
  nuevos: number;
  actualizados: number;
  /** Filas que ya estaban tal cual: ni escritura ni auditoría. */
  sinCambios: number;
  /**
   * Filas que pasaron el parser pero rebotaron contra el schema del dominio
   * (topes de largo, moneda rara). Van con el número de línea del archivo.
   *
   * La cuenta cierra: `nuevos + actualizados + sinCambios + errores.length` es
   * siempre el total de filas que entraron.
   */
  errores: ErrorImportPrecio[];
}

export class PrecioNoEncontradoError extends Error {
  constructor(readonly precioId: string) {
    super('No encontré ese precio en la lista de este estudio.');
    this.name = 'PrecioNoEncontradoError';
  }
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

export const zDatosPrecio = z.object({
  claveItem: z
    .string()
    .trim()
    .min(1, 'Poné la clave del ítem (por ejemplo aberturas.ventana.dvh).')
    .max(160, 'La clave del ítem no puede pasar de 160 caracteres.'),
  descripcion: z
    .string()
    .trim()
    .min(1, 'Poné una descripción del ítem.')
    .max(240, 'La descripción no puede pasar de 240 caracteres.'),
  unidad: z.enum(UNIDADES, { error: 'Elegí una unidad válida.' }),
  precio: z
    .number({ error: 'El precio tiene que ser un número.' })
    .finite('El precio tiene que ser un número.')
    .positive('El precio tiene que ser mayor que cero.')
    .max(99_999_999_999.99, 'Ese precio no entra en la columna.'),
  moneda: z
    .string()
    .trim()
    .min(1)
    .max(8, 'La moneda va con su código corto (ARS, USD).')
    .default(MONEDA_DEFAULT),
  fecha: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha del precio va como 2026-08-26.'),
});

export type DatosPrecio = z.input<typeof zDatosPrecio>;

function erroresPorCampo(error: z.ZodError): Record<string, string> {
  const errores: Record<string, string> = {};
  for (const issue of error.issues) {
    const campo = String(issue.path[0] ?? 'form');
    if (!(campo in errores)) errores[campo] = issue.message;
  }
  return errores;
}

/** Los mensajes de un formulario en una sola línea: el import no tiene dónde ponerlos por campo. */
function motivoDeCampos(errores: Record<string, string>): string {
  return Object.values(errores).join(' ');
}

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

/**
 * Auditoría de plataforma: sin `obra_id` (la lista es del estudio, no de una
 * obra), con la fila en el `target_ref`.
 */
function auditar(
  actor: ActorPrecios,
  accion: string,
  targetRef: string,
  diff: Record<string, unknown>,
): Promise<void> {
  return registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion,
    targetRef,
    diff,
  });
}

/** Cuántos errores del import entran en el diff de la auditoría. Más que esto es un volcado. */
const MAX_ERRORES_AUDITADOS = 50;

const COLACION = new Intl.Collator('es-AR', { sensitivity: 'base' });

/** Hoy en `YYYY-MM-DD`, hora local. El único lugar del módulo que mira el reloj. */
export function fechaHoyIso(hoy: Date = new Date()): string {
  const dosDigitos = (n: number) => String(n).padStart(2, '0');
  return `${hoy.getFullYear()}-${dosDigitos(hoy.getMonth() + 1)}-${dosDigitos(hoy.getDate())}`;
}

async function buscarPorClave(
  db: Db,
  estudioId: string,
  claveItem: string,
): Promise<PrecioReferencia | undefined> {
  const [fila] = await db
    .select()
    .from(preciosReferencia)
    .where(
      and(
        eq(preciosReferencia.estudioId, estudioId),
        eq(preciosReferencia.claveItem, claveItem),
      ),
    );
  return fila;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** La lista del estudio, ordenada por clave de ítem con colación es-AR. */
export async function listarPrecios(db: Db, estudioId: string): Promise<PrecioReferencia[]> {
  const filas = await db
    .select()
    .from(preciosReferencia)
    .where(eq(preciosReferencia.estudioId, estudioId));
  return filas.sort((a, b) => COLACION.compare(a.claveItem, b.claveItem));
}

/**
 * La lista indexada por `clave_item`, que es lo que come `resolverPrecio`.
 *
 * El recompute la lee **una vez por obra** y la consulta una vez por ítem: por
 * eso es un `Map` y no un array.
 */
export async function listaDelEstudio(
  db: Db,
  estudioId: string,
): Promise<Map<string, FilaLista>> {
  const filas = await listarPrecios(db, estudioId);
  return new Map(
    filas.map((fila) => [
      fila.claveItem,
      { precio: fila.precio, moneda: fila.moneda, fecha: fila.fecha },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Alta y edición (upsert)
// ---------------------------------------------------------------------------

/**
 * Alta o pisada del precio de referencia de un ítem.
 *
 * `origen` distingue de dónde salió la fila: `'manual'` es el formulario,
 * `'csv'` el import. Un ítem que se cargó a mano y después vino en un CSV
 * **queda como `'csv'`**: el origen describe la última escritura, que es lo que
 * la pantalla necesita mostrar para explicar de dónde salió el número.
 */
export async function guardarPrecio(
  db: Db,
  actor: ActorPrecios,
  datos: unknown,
  origen: OrigenPrecio,
): Promise<ResultadoPrecio> {
  requireAccion(actor, 'configurar_estudio');

  const parseo = zDatosPrecio.safeParse(datos);
  if (!parseo.success) return { ok: false, errores: erroresPorCampo(parseo.error) };
  const validos = { ...parseo.data, precio: redondear2(parseo.data.precio) };

  const existente = await buscarPorClave(db, actor.estudioId, validos.claveItem);

  if (!existente) {
    const [precio] = await db
      .insert(preciosReferencia)
      .values({ estudioId: actor.estudioId, ...validos, origen })
      .returning();

    await auditar(actor, 'precio_referencia_creado', `precios_referencia:${precio.id}`, {
      claveItem: precio.claveItem,
      descripcion: precio.descripcion,
      unidad: precio.unidad,
      precio: precio.precio,
      moneda: precio.moneda,
      fecha: precio.fecha,
      origen,
    });

    return { ok: true, precio, creado: true, cambios: {} };
  }

  const diff: Record<string, { antes: unknown; despues: unknown }> = {};
  const set: Partial<typeof preciosReferencia.$inferInsert> = {};

  const campos = ['descripcion', 'unidad', 'precio', 'moneda', 'fecha'] as const;
  for (const campo of campos) {
    if (existente[campo] === validos[campo]) continue;
    diff[campo] = { antes: existente[campo], despues: validos[campo] };
    set[campo] = validos[campo] as never;
  }
  if (existente.origen !== origen) {
    diff.origen = { antes: existente.origen, despues: origen };
    set.origen = origen;
  }

  // Nada cambió: ni escritura ni auditoría.
  if (Object.keys(diff).length === 0) {
    return { ok: true, precio: existente, creado: false, cambios: {} };
  }

  const [precio] = await db
    .update(preciosReferencia)
    .set(set)
    .where(eq(preciosReferencia.id, existente.id))
    .returning();

  await auditar(actor, 'precio_referencia_editado', `precios_referencia:${precio.id}`, {
    claveItem: precio.claveItem,
    ...diff,
  });

  return { ok: true, precio, creado: false, cambios: diff };
}

// ---------------------------------------------------------------------------
// Borrado
// ---------------------------------------------------------------------------

/**
 * Saca un ítem de la lista de referencia.
 *
 * Los ítems del cómputo que se estaban costeando con esta fila pierden su
 * precio en el próximo recompute y pasan a la fuente que siga en la cascada
 * (el índice) o a ninguna. No hay copia: la lista es la fuente.
 *
 * Un id de otro estudio y un id inventado dan el mismo error: no se filtra
 * existencia (RNF-4).
 */
export async function eliminarPrecio(
  db: Db,
  actor: ActorPrecios,
  precioId: string,
): Promise<void> {
  requireAccion(actor, 'configurar_estudio');
  if (!esUuid(precioId)) throw new PrecioNoEncontradoError(precioId);

  const [fila] = await db
    .select()
    .from(preciosReferencia)
    .where(eq(preciosReferencia.id, precioId));
  if (!fila || fila.estudioId !== actor.estudioId) throw new PrecioNoEncontradoError(precioId);

  await db.delete(preciosReferencia).where(eq(preciosReferencia.id, fila.id));

  await auditar(actor, 'precio_referencia_eliminado', `precios_referencia:${fila.id}`, {
    claveItem: fila.claveItem,
    descripcion: fila.descripcion,
    precio: fila.precio,
    moneda: fila.moneda,
    fecha: fila.fecha,
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Persiste las filas que `importarCsvPrecios` dio por buenas.
 *
 * Cada fila pasa por `guardarPrecio`, así que hereda el upsert, la validación
 * del dominio y la auditoría por fila. El resumen distingue `actualizados` de
 * `sinCambios` para que la pantalla no mienta con un «2 actualizados» cuando no
 * tocó nada.
 *
 * ## Ninguna fila desaparece en silencio
 *
 * El parser valida el **formato** (columnas, unidad que existe, precio con
 * forma de número) y no los **topes de largo**, que son del dominio y viven en
 * `zDatosPrecio`. Una fila puede pasar el parser y rebotar acá: sale en
 * `errores` con su número de línea y el motivo en castellano.
 *
 * `fechaDefault` es la fecha con la que entra una fila que no traía columna
 * `fecha` — la pantalla pasa `fechaHoyIso()`. Este módulo no mira el reloj.
 */
export async function persistirImportPrecios(
  db: Db,
  actor: ActorPrecios,
  filas: readonly FilaPrecio[],
  fechaDefault: string,
): Promise<ResumenImportPrecios> {
  requireAccion(actor, 'configurar_estudio');

  const resumen: ResumenImportPrecios = {
    nuevos: 0,
    actualizados: 0,
    sinCambios: 0,
    errores: [],
  };
  if (filas.length === 0) return resumen;

  for (const fila of filas) {
    const resultado = await guardarPrecio(
      db,
      actor,
      {
        claveItem: fila.claveItem,
        descripcion: fila.descripcion,
        unidad: fila.unidad,
        precio: fila.precio,
        moneda: MONEDA_DEFAULT,
        fecha: fila.fecha ?? fechaDefault,
      },
      'csv',
    );

    if (!resultado.ok) {
      resumen.errores.push({ linea: fila.linea, motivo: motivoDeCampos(resultado.errores) });
      continue;
    }

    if (resultado.creado) resumen.nuevos += 1;
    else if (Object.keys(resultado.cambios).length > 0) resumen.actualizados += 1;
    else resumen.sinCambios += 1;
  }

  await auditar(actor, 'precios_importados', 'precios_referencia:import', {
    filas: filas.length,
    nuevos: resumen.nuevos,
    actualizados: resumen.actualizados,
    sinCambios: resumen.sinCambios,
    // Las filas rechazadas también quedan en el rastro: si alguien pregunta
    // después por qué su precio no está, la respuesta está en la auditoría y no
    // solo en una pantalla que ya se cerró.
    rechazados: resumen.errores.length,
    errores: resumen.errores.slice(0, MAX_ERRORES_AUDITADOS),
  });

  return resumen;
}
