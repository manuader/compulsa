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
import { json, requireLaminaApi, responder } from '@/lib/pipeline/http';
import { procesarLamina } from '@/lib/pipeline/procesar';

export const maxDuration = 120;

type Params = { params: Promise<{ laminaId: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { laminaId } = await params;
    const { db, lamina } = await requireLaminaApi(laminaId);

    await procesarLamina(lamina.id);

    const [actualizada] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    return json({ lamina: actualizada });
  });
}
