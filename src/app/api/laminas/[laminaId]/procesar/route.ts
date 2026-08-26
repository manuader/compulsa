/**
 * Re-análisis de una lámina (botón "Reprocesar" del expediente).
 *
 * `procesarLamina()` es idempotente: volver a apretar el botón no duplica
 * entidades ni ítems. Tampoco lanza — si el análisis falla, la lámina vuelve
 * con `estado_analisis: 'error'` y su `error_detalle`, que es justo lo que la
 * pantalla necesita mostrar.
 */
import { eq } from 'drizzle-orm';

import { laminas } from '@/db/schema';
import { ErrorHttp, json, requireLaminaApi, responder } from '@/lib/pipeline/http';
import { procesarLamina } from '@/lib/pipeline/procesar';
import {
  requireAccion,
  RolInsuficienteError,
  UsuarioInactivoError,
  type AccionConRol,
} from '@/lib/plataforma/roles';
import type { RolUsuario } from '@/types/domain';

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

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { laminaId } = await params;
    const { db, sesion, lamina } = await requireLaminaApi(laminaId);
    requireRolApi(sesion, 'reprocesar_lamina');

    await procesarLamina(lamina.id);

    const [actualizada] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    return json({ lamina: actualizada });
  });
}
