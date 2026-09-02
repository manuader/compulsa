/**
 * Reintento del cruce del expediente (botón del expediente cuando el análisis
 * quedó en `error` o colgado).
 *
 * El cruce es la fase cara y la única que manda el expediente entero a la red,
 * así que es la más probable de caerse — y hasta acá era **la única sin
 * reintento**: `cruzarTolerante` la atrapaba, la obra quedaba con sus huecos y
 * el único llamador de `cruzarObra` era `procesarDocumento`, o sea que
 * reintentar exigía volver a subir el PDF. El botón de reprocesar de una lámina
 * re-extrae esa lámina y nada más.
 *
 * `reintentarCruce()` rehace las tres fases de obra —cruce, relectura y cómputo
 * final— y es idempotente: apretar dos veces sobre una obra quieta no escribe
 * ni audita nada nuevo. El handler es fino a propósito; toda la lógica está en
 * `src/lib/pipeline/procesar.ts`, testeada contra la base sin pasar por HTTP.
 */
import { ErrorHttp, json, requireObraApi, responder } from '@/lib/pipeline/http';
import {
  AnalisisEnCursoError,
  ObraInexistenteError,
  reintentarCruce,
} from '@/lib/pipeline/procesar';
import {
  requireAccion,
  RolInsuficienteError,
  UsuarioInactivoError,
  type AccionConRol,
} from '@/lib/plataforma/roles';
import type { RolUsuario } from '@/types/domain';

/** El cruce corre dentro del request, igual que en el upload: un legajo grande tarda. */
export const maxDuration = 300;

/**
 * Rol mínimo para este endpoint (RF-1201), traducido a 403.
 *
 * El chequeo no puede vivir en `requireObraApi`: los `GET` de otros módulos son
 * lectura y `lectura` tiene que poder hacerlos.
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

type Params = { params: Promise<{ obraId: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { obraId } = await params;
    const { sesion, obra } = await requireObraApi(obraId);
    requireRolApi(sesion, 'reprocesar_lamina');

    try {
      const { fase, relecturas } = await reintentarCruce(obra.id);
      return json({ fase, relecturas });
    } catch (error) {
      // 409: no es un error del pedido ni nuestro, es que ya hay una corrida
      // encima. Reintentar mientras el upload todavía analiza dejaría dos
      // recomputes sobre la misma obra, que es como se duplican los ítems.
      if (error instanceof AnalisisEnCursoError) throw new ErrorHttp(409, error.message);
      if (error instanceof ObraInexistenteError) throw new ErrorHttp(404, 'Esa obra no existe.');
      throw error;
    }
  });
}
