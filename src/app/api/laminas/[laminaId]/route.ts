/**
 * Una lámina.
 *
 *   GET   → su estado actual
 *   PATCH → clasificación manual (RF-104) y confirmación de escala (RF-201)
 *
 * El PATCH que confirma la escala de una lámina bloqueada re-dispara el
 * análisis: eso lo decide `actualizarLamina()`, no el handler.
 */
import { ZodError } from 'zod';

import { ErrorHttp, json, requireLaminaApi, responder } from '@/lib/pipeline/http';
import { actualizarLamina, zCambiosLamina } from '@/lib/pipeline/procesar';
import {
  requireAccion,
  RolInsuficienteError,
  UsuarioInactivoError,
  type AccionConRol,
} from '@/lib/plataforma/roles';
import type { RolUsuario } from '@/types/domain';

/** Confirmar la escala vuelve a analizar la lámina dentro del mismo request. */
export const maxDuration = 120;

/**
 * Rol mínimo para este endpoint (RF-1201), traducido a 403.
 *
 * El chequeo no puede vivir en `requireObraApi`/`requireLaminaApi`: los `GET`
 * de este mismo módulo son lectura y `lectura` tiene que poder hacerlos.
 */
function requireRolApi(sesion: { usuario: { rol: RolUsuario; activo: boolean } }, accion: AccionConRol): void {
  try {
    requireAccion(sesion.usuario, accion);
  } catch (error) {
    if (error instanceof RolInsuficienteError || error instanceof UsuarioInactivoError) {
      throw new ErrorHttp(403, error.message);
    }
    throw error;
  }
}

type Params = { params: Promise<{ laminaId: string }> };

/** El primer mensaje alcanza: el mini-form muestra uno solo. */
function primerMensaje(error: ZodError): string {
  return error.issues[0]?.message ?? 'Revisá los datos que mandaste.';
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { laminaId } = await params;
    const { lamina } = await requireLaminaApi(laminaId);
    return json({ lamina });
  });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { laminaId } = await params;
    const { db, sesion, lamina } = await requireLaminaApi(laminaId);
    requireRolApi(sesion, 'editar_lamina');

    const cuerpo = await request.json().catch(() => null);
    if (cuerpo === null || typeof cuerpo !== 'object') {
      throw new ErrorHttp(400, 'El cuerpo tiene que ser un objeto JSON.');
    }

    // El server nunca confía en el payload (src/app/CLAUDE.md §7): Zod deja
    // pasar solo los cuatro campos editables, y `escalaConfiable` solo en `true`.
    const parseo = zCambiosLamina.safeParse(cuerpo);
    if (!parseo.success) throw new ErrorHttp(400, primerMensaje(parseo.error));

    const actualizada = await actualizarLamina(db, lamina.id, parseo.data, {
      usuarioId: sesion.usuario.id,
      email: sesion.usuario.email,
    });

    return json({ lamina: actualizada });
  });
}
