/**
 * Notificaciones in-app: la campanita del header.
 *
 * Una notificación es un aviso **por usuario** con título, cuerpo y —si lleva a
 * algún lado— un link interno. No hay canal externo acá: mail y WhatsApp son
 * adapters de outreach (P5) y no comparten nada con esto.
 *
 * ## Quién las crea
 *
 * `crearNotificacion` es la única entrada de escritura y la usan los productores,
 * que van llegando por fase:
 *
 *  - **P7 (acá):** una invitación usada avisa a los titulares del estudio.
 *  - **P6:** deducciones nuevas propuestas sobre una obra. P7 expone la función;
 *    el disparo lo pone P6 en su motor.
 *  - **P8/P9:** cotización conciliada y compulsa sin respuesta a los 7 días.
 *
 * ## Destinatarios
 *
 * O una lista explícita de usuarios, o "todo el estudio" (opcionalmente acotado
 * por rol, que es como se le avisa solo a los titulares). En los dos casos
 * **los usuarios inactivos quedan afuera**: una baja lógica no tiene que seguir
 * juntando avisos que nadie va a leer.
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { notificaciones, usuarios, type Notificacion } from '@/db/schema';
import type { RolUsuario } from '@/types/domain';

/** Cuántas muestra el dropdown de la campanita. */
export const NOTIFICACIONES_EN_CAMPANITA = 10;

export interface DatosNotificacion {
  titulo: string;
  cuerpo: string;
  /** Ruta interna a la que lleva el click ("/estudio/usuarios"). */
  link?: string | null;
}

/** A quién avisarle: usuarios puntuales, o el estudio entero (por rol, si se acota). */
export type Destinatarios = readonly string[] | { estudioId: string; roles?: readonly RolUsuario[] };

/** Los ids activos a los que hay que escribirles. */
async function resolverDestinatarios(db: Db, destino: Destinatarios): Promise<string[]> {
  if (Array.isArray(destino)) {
    if (destino.length === 0) return [];
    const filas = await db
      .select({ id: usuarios.id })
      .from(usuarios)
      .where(and(inArray(usuarios.id, destino as string[]), eq(usuarios.activo, true)));
    return filas.map((fila) => fila.id);
  }

  const { estudioId, roles } = destino as { estudioId: string; roles?: readonly RolUsuario[] };
  if (roles && roles.length === 0) return [];

  const filas = await db
    .select({ id: usuarios.id })
    .from(usuarios)
    .where(
      and(
        eq(usuarios.estudioId, estudioId),
        eq(usuarios.activo, true),
        ...(roles ? [inArray(usuarios.rol, roles as RolUsuario[])] : []),
      ),
    );
  return filas.map((fila) => fila.id);
}

/**
 * Escribe una notificación por destinatario y devuelve cuántas escribió.
 *
 * No lanza si no hay a quién avisarle: cero destinatarios es un resultado
 * posible (un estudio de una sola persona al que se le avisa "a los demás"), no
 * un error del que llama.
 */
export async function crearNotificacion(
  db: Db,
  destino: Destinatarios,
  datos: DatosNotificacion,
): Promise<number> {
  const ids = await resolverDestinatarios(db, destino);
  if (ids.length === 0) return 0;

  await db.insert(notificaciones).values(
    ids.map((usuarioId) => ({
      usuarioId,
      titulo: datos.titulo,
      cuerpo: datos.cuerpo,
      link: datos.link ?? null,
    })),
  );
  return ids.length;
}

/** Las últimas del usuario, de la más nueva a la más vieja. */
export function listarNotificaciones(
  db: Db,
  usuarioId: string,
  limite: number = NOTIFICACIONES_EN_CAMPANITA,
): Promise<Notificacion[]> {
  return db
    .select()
    .from(notificaciones)
    .where(eq(notificaciones.usuarioId, usuarioId))
    .orderBy(desc(notificaciones.createdAt))
    .limit(limite);
}

export async function contarNoLeidas(db: Db, usuarioId: string): Promise<number> {
  const [fila] = await db
    .select({ total: count() })
    .from(notificaciones)
    .where(and(eq(notificaciones.usuarioId, usuarioId), eq(notificaciones.leida, false)));
  return fila?.total ?? 0;
}

/**
 * Marca una como leída. El `usuarioId` va en el `where`, no solo el id de la
 * notificación: sin eso, cualquiera podría marcar la notificación de otro
 * mandando un id que no es suyo. Devuelve si tocó algo.
 */
export async function marcarLeida(
  db: Db,
  usuarioId: string,
  notificacionId: string,
): Promise<boolean> {
  const tocadas = await db
    .update(notificaciones)
    .set({ leida: true })
    .where(
      and(
        eq(notificaciones.id, notificacionId),
        eq(notificaciones.usuarioId, usuarioId),
        eq(notificaciones.leida, false),
      ),
    )
    .returning({ id: notificaciones.id });
  return tocadas.length > 0;
}

/** Marca todas las del usuario y devuelve cuántas estaban sin leer. */
export async function marcarTodasLeidas(db: Db, usuarioId: string): Promise<number> {
  const tocadas = await db
    .update(notificaciones)
    .set({ leida: true })
    .where(and(eq(notificaciones.usuarioId, usuarioId), eq(notificaciones.leida, false)))
    .returning({ id: notificaciones.id });
  return tocadas.length;
}
