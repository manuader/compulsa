/**
 * Piso común de los route handlers del pipeline.
 *
 * Las pantallas usan `requireUser()` / `requireObra()`, que resuelven "no hay
 * sesión" con un `redirect('/login')` y "no es tu obra" con un `notFound()`.
 * Para una API eso está mal: un `fetch()` del cliente recibiría un 307 al HTML
 * del login en vez de un 401 que la UI pueda mostrar. Así que acá se usa el
 * mismo núcleo de aislamiento (`requireObraCore`, RNF-4) con la traducción que
 * corresponde a una API: 401 y 404 en JSON.
 *
 * La regla de oro se mantiene intacta: **ninguna fila se consulta por id sin
 * pasar por el estudio de la sesión.**
 */
import { eq } from 'drizzle-orm';

import { getDb, type Db } from '@/db/client';
import { laminas, type Lamina, type Obra } from '@/db/schema';
import { ObraNoEncontradaError, requireObraCore } from '@/lib/auth/guards';
import { getSession, type SesionActiva } from '@/lib/auth/session';

/** Forma canónica 8-4-4-4-12: un id de la URL es texto arbitrario hasta que se valida. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(valor: string): boolean {
  return UUID_RE.test(valor);
}

/** Un error con su código HTTP. Lo traduce `responder()`. */
export class ErrorHttp extends Error {
  constructor(
    readonly status: number,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorHttp';
  }
}

export function json(datos: unknown, status = 200): Response {
  return Response.json(datos, { status });
}

export function errorJson(mensaje: string, status: number): Response {
  return Response.json({ error: mensaje }, { status });
}

/**
 * Envuelve un handler: los `ErrorHttp` salen con su código y todo lo demás es
 * un 500 con un mensaje genérico (el detalle va al log del server, no al
 * cliente).
 */
export async function responder(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof ErrorHttp) return errorJson(error.message, error.status);
    console.error('[api] fallo no contemplado:', error);
    return errorJson('Algo se rompió de nuestro lado. Probá de nuevo en un rato.', 500);
  }
}

export async function requireSesionApi(): Promise<SesionActiva> {
  const sesion = await getSession();
  if (!sesion) throw new ErrorHttp(401, 'Iniciá sesión para seguir.');
  return sesion;
}

export interface ContextoObra {
  db: Db;
  sesion: SesionActiva;
  obra: Obra;
}

/** Sesión válida + obra del estudio de la sesión. Cualquier otra cosa es un 404. */
export async function requireObraApi(obraId: string): Promise<ContextoObra> {
  const sesion = await requireSesionApi();
  const db = await getDb();
  try {
    return { db, sesion, obra: await requireObraCore(db, sesion.estudio.id, obraId) };
  } catch (error) {
    if (error instanceof ObraNoEncontradaError) throw new ErrorHttp(404, 'Esa obra no existe.');
    throw error;
  }
}

export interface ContextoLamina extends ContextoObra {
  lamina: Lamina;
}

/**
 * Igual que `requireObraApi`, pero entrando por la lámina: se resuelve su obra
 * y recién ahí se decide la pertenencia. Una lámina de otro estudio no existe.
 */
export async function requireLaminaApi(laminaId: string): Promise<ContextoLamina> {
  const sesion = await requireSesionApi();
  const db = await getDb();

  if (!esUuid(laminaId)) throw new ErrorHttp(404, 'Esa lámina no existe.');
  const [lamina] = await db.select().from(laminas).where(eq(laminas.id, laminaId));
  if (!lamina) throw new ErrorHttp(404, 'Esa lámina no existe.');

  try {
    const obra = await requireObraCore(db, sesion.estudio.id, lamina.obraId);
    return { db, sesion, obra, lamina };
  } catch (error) {
    if (error instanceof ObraNoEncontradaError) throw new ErrorHttp(404, 'Esa lámina no existe.');
    throw error;
  }
}
