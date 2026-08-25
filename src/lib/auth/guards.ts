/**
 * Guards de las pantallas del workspace.
 *
 * `requireObraCore` es la regla de aislamiento (RNF-4) sin Next adentro: dado un
 * estudio y una obra, o la obra es de ese estudio o no existe. Los envoltorios
 * traducen "no existe" al `redirect()` / `notFound()` que espera el App Router.
 */
import { and, eq } from 'drizzle-orm';

import { getDb, type Db } from '@/db/client';
import { obras, type Obra } from '@/db/schema';

import { getSession, type SesionActiva } from './session';

export class ObraNoEncontradaError extends Error {
  constructor(readonly obraId: string) {
    super(`La obra ${obraId} no existe o no pertenece a este estudio.`);
    this.name = 'ObraNoEncontradaError';
  }
}

export async function requireObraCore(db: Db, estudioId: string, obraId: string): Promise<Obra> {
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

/** Obra del estudio de la sesión, o 404. Nunca consultes una obra sin pasar por acá. */
export async function requireObra(obraId: string): Promise<Obra> {
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
}
