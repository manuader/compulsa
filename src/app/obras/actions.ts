'use server';

/**
 * Alta de obra.
 *
 * `crearObraCore` es el núcleo testeable: recibe la base y el `estudioId` ya
 * resueltos y no sabe nada de Next ni de cookies. `crearObraAction` es el
 * envoltorio que la pantalla usa — resuelve la sesión, arma el payload desde el
 * `FormData` y audita.
 *
 * Nota sobre el `db: Db` como primer parámetro de `crearObraCore`: en un archivo
 * `'use server'` **todo export es un endpoint**. Pedir el handle de la base por
 * parámetro hace que una llamada de afuera falle cerrada (no hay forma de
 * serializar un cliente de Drizzle en el body de una request), y evita la
 * versión peligrosa de la firma —`(estudioId, payload)` leyendo `getDb()` por su
 * cuenta— que sí dejaría crear obras en un estudio ajeno.
 */
import { z } from 'zod';

import { getDb, type Db } from '@/db/client';
import { obras, type Obra } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { esUuid, requireObra, requireUser } from '@/lib/auth/guards';
import {
  archivarObra,
  desarchivarObra,
  editarObra,
  eliminarObra,
  ObraNoArchivadaError,
  type ActorObra,
} from '@/lib/obras/gestion';
// El schema de los campos de la obra vive afuera a propósito: el alta y la
// edición tienen que aceptar exactamente lo mismo (ver `@/lib/obras/schema`), y
// en un archivo `'use server'` solo pueden salir funciones async.
import { erroresPorCampo, zDatosObra } from '@/lib/obras/schema';
import { requireAccion, RolInsuficienteError, UsuarioInactivoError } from '@/lib/plataforma/roles';
import { getStorage } from '@/lib/storage/index';

export type ResultadoCrearObra =
  | { ok: true; obra: Obra }
  | { ok: false; errores: Record<string, string> };

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccionObra = { ok: true } | { ok: false; error: string };

/** Estado que `useActionState` devuelve al formulario. Todo serializable. */
export interface EstadoNuevaObra {
  errores?: Record<string, string>;
  valores?: Record<string, string>;
}

/**
 * Igual, más los dos avisos que el formulario de edición necesita y el de alta
 * no: el de edición no navega al terminar, así que tiene que decir en la misma
 * pantalla que guardó (`guardado`) o que algo falló fuera de un campo concreto
 * (`mensaje`).
 */
export interface EstadoEdicionObra extends EstadoNuevaObra {
  guardado?: string;
  mensaje?: string;
}

const zNuevaObra = zDatosObra;

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);
  return typeof valor === 'string' ? valor : '';
}

/**
 * Valida y persiste. El `estudioId` lo pone el server desde la sesión y el
 * `estado` lo pone la base: Zod devuelve solo los cuatro campos del formulario,
 * así que nada de lo que venga de más en el payload llega al insert.
 */
export async function crearObraCore(
  db: Db,
  estudioId: string,
  payload: unknown,
): Promise<ResultadoCrearObra> {
  const parseo = zNuevaObra.safeParse(payload);
  if (!parseo.success) return { ok: false, errores: erroresPorCampo(parseo.error) };

  const [obra] = await db
    .insert(obras)
    .values({ estudioId, ...parseo.data })
    .returning();

  return { ok: true, obra };
}

export async function crearObraAction(
  _estadoPrevio: EstadoNuevaObra,
  formData: FormData,
): Promise<EstadoNuevaObra> {
  const { usuario, estudio } = await requireUser();
  try {
    requireAccion(usuario, 'crear_obra');
  } catch (error) {
    const mensaje = mensajeDeRol(error);
    if (mensaje) return { errores: { form: mensaje } };
    throw error;
  }

  const valores = {
    nombre: texto(formData, 'nombre'),
    zona: texto(formData, 'zona'),
    tipo: texto(formData, 'tipo'),
    moneda: texto(formData, 'moneda'),
  };

  const resultado = await crearObraCore(await getDb(), estudio.id, valores);
  if (!resultado.ok) return { errores: resultado.errores, valores };

  await registrarAuditoria({
    obraId: resultado.obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'obra_creada',
    targetRef: `obras:${resultado.obra.id}`,
    diff: {
      nombre: resultado.obra.nombre,
      zona: resultado.obra.zona,
      tipo: resultado.obra.tipo,
      moneda: resultado.obra.moneda,
    },
  });

  const [{ revalidatePath }, { redirect }] = await Promise.all([
    import('next/cache'),
    import('next/navigation'),
  ]);
  revalidatePath('/obras');
  return redirect(`/obras/${resultado.obra.id}`);
}

// ---------------------------------------------------------------------------
// Gestión de la obra: editar, archivar, eliminar
//
// Los núcleos viven en `@/lib/obras/gestion` —reciben estudio, obra y actor
// explícitos y no saben quién los llama—; acá abajo están **solo** los
// envoltorios, que son las tres líneas que faltan: `requireUser()` (hay sesión),
// `requireObra()` (la obra es del estudio de la sesión, RNF-4) y la
// revalidación de las pantallas que muestran la obra.
//
// El `obraId` que vale es SIEMPRE el que devuelve `requireObra`, nunca el que
// vino en el payload — aunque valgan lo mismo, el que pasó por el guard es el
// único del que sabemos que es del estudio correcto.
// ---------------------------------------------------------------------------

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');

const PAYLOAD_ILEGIBLE = 'No pude leer de qué obra se trata.';

/**
 * El mensaje del guard de rol, si el error es de rol.
 *
 * La matriz (RF-1201) la aplican los cores de `@/lib/obras/gestion`: eliminar
 * una obra es del titular, editar y archivar son de colaborador para arriba.
 * Acá esos errores se traducen a texto de pantalla — un 500 no le dice al
 * usuario que le falta permiso.
 */
function mensajeDeRol(error: unknown): string | null {
  if (error instanceof RolInsuficienteError || error instanceof UsuarioInactivoError) {
    return error.message;
  }
  return null;
}

interface ContextoObra {
  obraId: string;
  nombre: string;
  estudioId: string;
  actor: ActorObra;
}

/** Sesión válida + obra del estudio. `null` si el payload ni siquiera se lee. */
async function contexto(entrada: unknown): Promise<ContextoObra | null> {
  const parseo = z.object({ obraId: zUuid }).safeParse(entrada);
  if (!parseo.success) return null;
  return contextoDeObra(parseo.data.obraId);
}

/**
 * La misma resolución, para quien ya validó la forma del id y no quiere
 * parsearla dos veces.
 *
 * El actor sale entero de la sesión —incluidos `rol` y `activo`—, porque el
 * enforcement de la matriz (RF-1201) lo aplica el core: ver `ActorObra` en
 * `@/lib/obras/gestion`.
 */
async function contextoDeObra(obraId: string): Promise<ContextoObra> {
  const { usuario, estudio } = await requireUser();
  const obra = await requireObra(obraId);
  return {
    obraId: obra.id,
    nombre: obra.nombre,
    estudioId: estudio.id,
    actor: {
      usuarioId: usuario.id,
      email: usuario.email,
      rol: usuario.rol,
      activo: usuario.activo,
    },
  };
}

/** La obra se ve en el listado, en su tablero y en su configuración. */
async function revalidarObra(obraId: string): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath('/obras');
  revalidatePath(`/obras/${obraId}`);
  revalidatePath(`/obras/${obraId}/config`);
}

/**
 * Edición de los datos de la obra. Es un formulario, así que la firma es la de
 * `useActionState`; el `obraId` viaja en un campo oculto y pasa por el guard.
 */
export async function editarObraAction(
  _estadoPrevio: EstadoEdicionObra,
  formData: FormData,
): Promise<EstadoEdicionObra> {
  const valores = {
    nombre: texto(formData, 'nombre'),
    zona: texto(formData, 'zona'),
    tipo: texto(formData, 'tipo'),
    moneda: texto(formData, 'moneda'),
  };

  const ctx = await contexto({ obraId: texto(formData, 'obraId') });
  if (!ctx) return { mensaje: PAYLOAD_ILEGIBLE, valores };

  let resultado;
  try {
    resultado = await editarObra(await getDb(), ctx.estudioId, ctx.obraId, valores, ctx.actor);
  } catch (error) {
    const mensaje = mensajeDeRol(error);
    if (mensaje) return { mensaje, valores };
    throw error;
  }
  if (!resultado.ok) return { errores: resultado.errores, valores };

  await revalidarObra(ctx.obraId);
  return {
    valores,
    guardado:
      Object.keys(resultado.cambios).length === 0
        ? 'No había nada que cambiar.'
        : 'Listo, guardamos los cambios.',
  };
}

/** Archiva y vuelve al listado: la obra ya no está donde el usuario estaba parado. */
export async function archivarObraAction(entrada: unknown): Promise<ResultadoAccionObra> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };

  try {
    await archivarObra(await getDb(), ctx.estudioId, ctx.obraId, ctx.actor);
  } catch (error) {
    const mensaje = mensajeDeRol(error);
    if (mensaje) return { ok: false, error: mensaje };
    throw error;
  }
  await revalidarObra(ctx.obraId);

  const { redirect } = await import('next/navigation');
  return redirect('/obras');
}

export async function desarchivarObraAction(entrada: unknown): Promise<ResultadoAccionObra> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };

  try {
    await desarchivarObra(await getDb(), ctx.estudioId, ctx.obraId, ctx.actor);
  } catch (error) {
    const mensaje = mensajeDeRol(error);
    if (mensaje) return { ok: false, error: mensaje };
    throw error;
  }
  await revalidarObra(ctx.obraId);
  return { ok: true };
}

/**
 * Eliminación definitiva.
 *
 * La pantalla pide escribir el nombre exacto de la obra para habilitar el botón;
 * el server **vuelve a exigirlo** (`src/app/CLAUDE.md` §7: el server nunca
 * confía en el payload). Que el botón esté habilitado no es una verificación:
 * este endpoint se puede invocar sin pasar por la pantalla.
 */
export async function eliminarObraAction(entrada: unknown): Promise<ResultadoAccionObra> {
  const parseo = z
    .object({ obraId: zUuid, confirmacion: z.string() })
    .safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };

  // El id ya pasó por `zUuid` acá arriba: `contextoDeObra` no lo vuelve a parsear.
  const ctx = await contextoDeObra(parseo.data.obraId);

  if (parseo.data.confirmacion.trim() !== ctx.nombre) {
    return {
      ok: false,
      error: `Para eliminarla escribí el nombre exacto de la obra: «${ctx.nombre}».`,
    };
  }

  try {
    await eliminarObra(await getDb(), getStorage(), ctx.estudioId, ctx.obraId, ctx.actor);
  } catch (error) {
    if (error instanceof ObraNoArchivadaError) return { ok: false, error: error.message };
    const mensaje = mensajeDeRol(error);
    if (mensaje) return { ok: false, error: mensaje };
    throw error;
  }

  const { revalidatePath } = await import('next/cache');
  revalidatePath('/obras');

  const { redirect } = await import('next/navigation');
  return redirect('/obras');
}
