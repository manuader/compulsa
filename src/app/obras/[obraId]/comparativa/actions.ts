'use server';

/**
 * Endpoints de la comparativa.
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** que el
 * cliente invoca con el payload que quiera, así que acá no hay lógica de
 * dominio: el núcleo es `adjudicarCompulsa` (`@/lib/compulsa/adjudicar`), que
 * recibe la base y el actor por parámetro y no sabe nada de cookies. Este
 * archivo aporta las cuatro líneas que faltan:
 *
 *   1. `requireUser()` — hay sesión, y de ahí sale el rol (RF-1201: el rol
 *      nunca viaja en el payload; adjudicar es del titular).
 *   2. `requireObra()` — la obra es del estudio del usuario (RNF-4). El
 *      `obraId` que vale es el que devuelve el guard, no el del JSON.
 *   3. el núcleo, con el actor sacado de la sesión.
 *   4. `revalidatePath()` de todo lo que cambia al adjudicar: la comparativa,
 *      el tablero (el ahorro acumulado), las compulsas y las conversaciones
 *      (los contactos quedan cerrados).
 */
import { z } from 'zod';

import { esUuid, requireObra, requireUser } from '@/lib/auth/guards';
import {
  AdjudicacionSinItemsError,
  AdjudicacionSinTotalError,
  CompulsaYaAdjudicadaError,
  CotizacionNoConciliadaError,
  adjudicarCompulsa,
} from '@/lib/compulsa/adjudicar';
import {
  CompulsaNoEncontradaError,
  ContactoNoEncontradoError,
  CotizacionNoEncontradaError,
} from '@/lib/outreach/threads';
import { RolInsuficienteError, UsuarioInactivoError } from '@/lib/plataforma/roles';
import { getDb } from '@/db/client';

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAdjudicar =
  | { ok: true; ordenCompra: string; ahorro: number | null }
  | { ok: false; error: string };

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');

const zAdjudicar = z.object({
  obraId: zUuid,
  cotizacionId: zUuid,
  /** Solo hace falta cuando la cotización no traía total (P5 §8). */
  total: z.number().positive().nullable().optional(),
  numero: z.string().trim().max(40).nullable().optional(),
  notas: z.string().trim().max(500).nullable().optional(),
});

const PAYLOAD_ILEGIBLE = 'No pude leer qué cotización querés adjudicar.';

/**
 * Los errores del núcleo que son **conversación con el usuario** y no un bug:
 * le falta rol, la compulsa ya se adjudicó, la cotización no tiene total. Todos
 * traen su mensaje en es-AR; suben como texto, no como un 500.
 */
const ESPERABLES = [
  RolInsuficienteError,
  UsuarioInactivoError,
  CompulsaYaAdjudicadaError,
  CotizacionNoConciliadaError,
  AdjudicacionSinTotalError,
  AdjudicacionSinItemsError,
  CotizacionNoEncontradaError,
  CompulsaNoEncontradaError,
  ContactoNoEncontradoError,
] as const;

function mensajeEsperable(error: unknown): string | null {
  for (const clase of ESPERABLES) {
    if (error instanceof clase) return error.message;
  }
  return null;
}

export async function adjudicarAction(entrada: unknown): Promise<ResultadoAdjudicar> {
  const parseo = zAdjudicar.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };

  const { usuario, estudio } = await requireUser();
  // El guard es el que decide de qué obra se trata; el id del payload solo
  // sirve para preguntarle.
  const obra = await requireObra(parseo.data.obraId);

  let resultado;
  try {
    resultado = await adjudicarCompulsa(
      await getDb(),
      {
        usuarioId: usuario.id,
        email: usuario.email,
        rol: usuario.rol,
        activo: usuario.activo,
        estudioId: estudio.id,
      },
      {
        cotizacionId: parseo.data.cotizacionId,
        total: parseo.data.total ?? null,
        numero: parseo.data.numero ?? null,
        notas: parseo.data.notas ?? null,
      },
    );
  } catch (error) {
    const mensaje = mensajeEsperable(error);
    if (mensaje) return { ok: false, error: mensaje };
    throw error;
  }

  const { revalidatePath } = await import('next/cache');
  revalidatePath(`/obras/${obra.id}/comparativa`);
  revalidatePath(`/obras/${obra.id}`);
  revalidatePath(`/obras/${obra.id}/compulsas`);
  revalidatePath(`/obras/${obra.id}/conversaciones`);

  return {
    ok: true,
    ordenCompra: resultado.ordenCompra,
    ahorro: resultado.ahorro?.ahorro ?? null,
  };
}
