'use server';

/**
 * Endpoints de la bandeja de deducciones: sesión, obra, rol y revalidación.
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** que el
 * cliente puede invocar con el payload que quiera. Por eso acá no hay lógica de
 * dominio: los núcleos que escriben viven en `@/lib/deduccion/persistencia` y
 * este archivo exporta **solo** los envoltorios `*Action`, que aportan las
 * cuatro líneas que faltan:
 *
 *   1. `requireUser()` — hay sesión válida, y de ahí sale el rol (RF-1201: el
 *      rol nunca viaja en el payload).
 *   2. `requireObra()` — la obra es del estudio del usuario (RNF-4). El `obraId`
 *      que vale es el que devuelve el guard, no el del JSON.
 *   3. el núcleo, con el actor sacado de la sesión.
 *   4. `revalidatePath()` de las pantallas que cambian: la bandeja —sus dos
 *      solapas comparten ruta, y validar o rechazar mueve las dos—, la planilla
 *      y el tablero.
 */
import { z } from 'zod';

import { requireObra, requireUser } from '@/lib/auth/guards';
import {
  rechazarDeduccion,
  validarDeduccion,
  type ActorDeduccion,
  type EntradaDeduccion,
  type ResultadoAccion,
} from '@/lib/deduccion/persistencia';

const zObra = z.object({
  obraId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
});

const PAYLOAD_ILEGIBLE = 'No pude leer la obra de la deducción.';

/**
 * Validar una deducción escribe un dato en la entidad: cambia el cómputo, la
 * bandeja de consultas y los contadores del tablero. Las cuatro se releen.
 */
async function revalidar(obraId: string): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  // La pantalla es la bandeja: sus dos solapas comparten ruta (§5.8) y
  // `/obras/[obraId]/deducciones` es hoy una redirección.
  revalidatePath(`/obras/${obraId}/bandeja`);
  revalidatePath(`/obras/${obraId}/computo`);
  revalidatePath(`/obras/${obraId}`);
}

async function contexto(entrada: unknown): Promise<(ActorDeduccion & { obraId: string }) | null> {
  const parseo = zObra.safeParse(entrada);
  if (!parseo.success) return null;

  const { usuario } = await requireUser();
  const obra = await requireObra(parseo.data.obraId);
  return { obraId: obra.id, usuarioId: usuario.id, email: usuario.email, rol: usuario.rol };
}

export async function validarDeduccionAction(entrada: EntradaDeduccion): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  const { obraId, ...actor } = ctx;
  const resultado = await validarDeduccion({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}

export async function rechazarDeduccionAction(entrada: EntradaDeduccion): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  const { obraId, ...actor } = ctx;
  const resultado = await rechazarDeduccion({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}
