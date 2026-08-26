'use server';

/**
 * Endpoints de las conversaciones con proveedores (PRD §8.7).
 *
 * Mismo reparto que el resto del workspace: en un archivo `'use server'` todo
 * export es un endpoint, así que la lógica del hilo vive en
 * `@/lib/outreach/threads` (lectura, P5) y `@/lib/compulsa/flujo` (escritura,
 * P5). Acá van los envoltorios —sesión, obra del estudio, actor con el rol de la
 * sesión, revalidación— y **un** núcleo propio, `cambiarEstadoContactoCore`,
 * porque el estado del contacto a mano no lo cubre ningún core existente.
 */
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '@/db/client';
import { contactosCompulsa, cotizaciones, type ContactoCompulsa } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { esUuid, ObraNoEncontradaError, requireObra, requireUser } from '@/lib/auth/guards';
import {
  registrarMensajeEntrante,
  requireRolCore,
  RolInsuficienteError,
  type ActorCompulsa,
} from '@/lib/compulsa/flujo';
import { ContactoNoEncontradoError, requireContactoCore } from '@/lib/outreach/threads';
import type { EstadoContacto } from '@/types/domain';

export type ResultadoAccionConversacion = { ok: true } | { ok: false; error: string };

/**
 * Los estados que una persona puede poner a mano.
 *
 * Los otros tres los pone el flujo y no tiene sentido tocarlos desde acá:
 * `pendiente` es como nace el contacto, `contactado` lo pone `registrarEnvio` y
 * `negociando` lo pone `proponerNegociacion`. Volver atrás a mano dejaría el
 * estado diciendo una cosa y el hilo otra.
 */
const ESTADOS_A_MANO = ['cotizo', 'cerrado', 'sin_respuesta'] as const;

export type EstadoAMano = (typeof ESTADOS_A_MANO)[number];

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');
const PAYLOAD_ILEGIBLE = 'No pude leer de qué conversación se trata.';

async function contexto(obraId: string): Promise<{ db: Db; obraId: string; actor: ActorCompulsa }> {
  const { usuario, estudio } = await requireUser();
  const obra = await requireObra(obraId);
  return {
    db: await getDb(),
    obraId: obra.id,
    actor: { usuarioId: usuario.id, email: usuario.email, rol: usuario.rol, estudioId: estudio.id },
  };
}

function mensajeDeDominio(error: unknown): string | null {
  if (
    error instanceof RolInsuficienteError ||
    error instanceof ContactoNoEncontradoError ||
    error instanceof ObraNoEncontradaError ||
    error instanceof RangeError
  ) {
    return error.message;
  }
  return null;
}

async function revalidar(obraId: string, contactoId: string, compulsaId: string): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath(`/obras/${obraId}/conversaciones`);
  revalidatePath(`/obras/${obraId}/conversaciones/${contactoId}`);
  revalidatePath(`/obras/${obraId}/compulsas/${compulsaId}`);
}

// ---------------------------------------------------------------------------
// Núcleo: el estado del contacto, a mano
// ---------------------------------------------------------------------------

export class EstadoContactoInvalidoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'EstadoContactoInvalidoError';
  }
}

/**
 * Cambia el estado del contacto a mano.
 *
 * ## Por qué «cotizó» pide una cotización registrada
 *
 * El estado del contacto es lo que leen el tablero y la comparativa. Dejar
 * marcar `cotizo` sin que exista una fila en `cotizaciones` pone la pantalla a
 * afirmar algo que la base no sostiene: el proveedor figuraría como que cotizó y
 * no habría ni precio, ni score, ni conciliación detrás. Así que se puede
 * marcar **solo si ya hay una cotización** —que es el caso real: volver a
 * `cotizo` un contacto que se había cerrado o que quedó en `negociando`—. Para
 * el otro caso, el camino es registrar la respuesta, que es un botón que existe.
 *
 * `cerrado` y `sin_respuesta` no piden nada: son decisiones del estudio sobre un
 * proveedor, no afirmaciones sobre datos que tendrían que estar.
 */
export async function cambiarEstadoContactoCore(
  db: Db,
  actor: ActorCompulsa,
  contactoId: string,
  estado: EstadoAMano,
): Promise<ContactoCompulsa> {
  requireRolCore(actor, 'colaborador');
  const hilo = await requireContactoCore(db, actor.estudioId, contactoId);

  if (estado === 'cotizo') {
    const [cuantas] = await db
      .select({ total: count() })
      .from(cotizaciones)
      .where(eq(cotizaciones.contactoId, contactoId));
    if (Number(cuantas?.total ?? 0) === 0) {
      throw new EstadoContactoInvalidoError(
        `${hilo.proveedor.nombre} no tiene ninguna cotización registrada: registrá la respuesta ` +
          'con el presupuesto en la mano y el estado se pone solo.',
      );
    }
  }

  if (hilo.contacto.estado === estado) return hilo.contacto;

  const [actualizado] = await db
    .update(contactosCompulsa)
    .set({ estado })
    .where(eq(contactosCompulsa.id, contactoId))
    .returning();

  await registrarAuditoria({
    obraId: hilo.obra.id,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'contacto_estado_cambiado',
    targetRef: `contactos_compulsa:${contactoId}`,
    diff: {
      compulsaId: hilo.compulsa.id,
      proveedor: hilo.proveedor.nombre,
      estado: { antes: hilo.contacto.estado, despues: estado },
    },
  });

  return actualizado;
}

// ---------------------------------------------------------------------------
// Server Actions
// ---------------------------------------------------------------------------

const zEntrante = z.object({
  obraId: zUuid,
  contactoId: zUuid,
  cuerpo: z
    .string()
    .min(1, 'Escribí lo que contestó el proveedor.')
    .max(200_000, 'El mensaje es demasiado largo.'),
});

/**
 * Registra lo que contestó el proveedor, tal cual lo escribió.
 *
 * El core guarda el texto **crudo** y no cambia el estado del contacto: que haya
 * escrito no es que haya cotizado (P5).
 */
export async function registrarMensajeEntranteAction(
  entrada: unknown,
): Promise<ResultadoAccionConversacion> {
  const parseo = zEntrante.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? PAYLOAD_ILEGIBLE };
  }

  const ctx = await contexto(parseo.data.obraId);
  try {
    const { contacto } = await registrarMensajeEntrante(
      ctx.db,
      ctx.actor,
      parseo.data.contactoId,
      parseo.data.cuerpo,
    );
    await revalidar(ctx.obraId, contacto.id, contacto.compulsaId);
    return { ok: true };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}

const zEstado = z.object({
  obraId: zUuid,
  contactoId: zUuid,
  estado: z.enum(ESTADOS_A_MANO),
});

export async function cambiarEstadoContactoAction(
  entrada: unknown,
): Promise<ResultadoAccionConversacion> {
  const parseo = zEstado.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };

  const ctx = await contexto(parseo.data.obraId);
  try {
    const contacto = await cambiarEstadoContactoCore(
      ctx.db,
      ctx.actor,
      parseo.data.contactoId,
      parseo.data.estado,
    );
    await revalidar(ctx.obraId, contacto.id, contacto.compulsaId);
    return { ok: true };
  } catch (error) {
    if (error instanceof EstadoContactoInvalidoError) return { ok: false, error: error.message };
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}
