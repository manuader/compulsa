/**
 * Guards de las pantallas del workspace.
 *
 * `requireObraCore` es la regla de aislamiento (RNF-4) sin Next adentro: dado un
 * estudio y una obra, o la obra es de ese estudio o no existe. Los envoltorios
 * traducen "no existe" al `redirect()` / `notFound()` que espera el App Router.
 */
import { and, eq } from 'drizzle-orm';
import { cache } from 'react';

import { getDb, type Db } from '@/db/client';
import { obras, type Obra } from '@/db/schema';

import { getSession, type SesionActiva } from './session';

export class ObraNoEncontradaError extends Error {
  constructor(readonly obraId: string) {
    super(`La obra ${obraId} no existe o no pertenece a este estudio.`);
    this.name = 'ObraNoEncontradaError';
  }
}

/**
 * Forma canónica 8-4-4-4-12. No exige la versión 4: Postgres tampoco la exige, y lo que se
 * chequea acá es la *forma*, no la procedencia del id.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `true` si el texto tiene forma de uuid. Cualquier id que venga de una URL o de
 * un payload pasa por acá antes de tocar la base: sin el chequeo, `no-es-uuid`
 * no es un "no existe" sino un error del driver que sube como 500.
 */
export function esUuid(valor: string): boolean {
  return UUID_RE.test(valor);
}

export async function requireObraCore(db: Db, estudioId: string, obraId: string): Promise<Obra> {
  // Un `[obraId]` de la URL es texto arbitrario. Sin este chequeo, `not-a-uuid` no llega a ser un
  // "no existe" sino un error del driver ("invalid input syntax for type uuid") que sube como 500;
  // un id mal formado nombra tan poco una obra como uno que no está en la tabla, así que es 404.
  if (!esUuid(obraId)) throw new ObraNoEncontradaError(obraId);

  const [obra] = await db
    .select()
    .from(obras)
    .where(and(eq(obras.id, obraId), eq(obras.estudioId, estudioId)));

  if (!obra) throw new ObraNoEncontradaError(obraId);
  return obra;
}

/** Sesión válida o `/login`. */
export async function requireUser(): Promise<SesionActiva> {
  const sesion = await getSession();
  if (sesion) return sesion;

  const { redirect } = await import('next/navigation');
  return redirect('/login');
}

/**
 * Obra del estudio de la sesión, o 404. Nunca consultes una obra sin pasar por acá.
 *
 * Memoizado por request con `cache()` de React: en una pantalla de obra esto se
 * llama al menos tres veces con el mismo id —`generateMetadata`, el layout y la
 * página— y las tres tienen que hacerlo (`src/app/CLAUDE.md` §3: ninguna confía
 * en que otra ya validó). Sin el memo serían tres lecturas de sesión y tres
 * `select` idénticos. El memo es por request: no cachea nada entre usuarios.
 */
export const requireObra = cache(async function requireObra(obraId: string): Promise<Obra> {
  const { estudio } = await requireUser();
  try {
    return await requireObraCore(await getDb(), estudio.id, obraId);
  } catch (error) {
    if (error instanceof ObraNoEncontradaError) {
      const { notFound } = await import('next/navigation');
      return notFound();
    }
    throw error;
  }
});
