/**
 * Documentos de una obra.
 *
 *   GET   → el expediente entero (documentos con sus láminas)
 *   POST  → upload multipart, y el análisis arranca solo
 *
 * El handler es fino a propósito: subir es `subirDocumento()` y analizar es
 * `procesarDocumento()`, las dos en `src/lib/pipeline/` y testeadas contra la
 * base sin pasar por HTTP.
 */
import { asc, eq } from 'drizzle-orm';

import { documentos, laminas } from '@/db/schema';
import { ErrorHttp, json, requireObraApi, responder } from '@/lib/pipeline/http';
import {
  ArchivoInvalidoError,
  marcarAnalisisFallido,
  procesarDocumento,
  subirDocumento,
} from '@/lib/pipeline/procesar';
import { getStorage } from '@/lib/storage/index';
import {
  requireAccion,
  RolInsuficienteError,
  UsuarioInactivoError,
  type AccionConRol,
} from '@/lib/plataforma/roles';
import type { RolUsuario } from '@/types/domain';

/** El análisis corre dentro del request: un legajo grande tarda. */
export const maxDuration = 300;

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

type Params = { params: Promise<{ obraId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { obraId } = await params;
    const { db, obra } = await requireObraApi(obraId);

    const [docs, lams] = await Promise.all([
      db
        .select()
        .from(documentos)
        .where(eq(documentos.obraId, obra.id))
        .orderBy(asc(documentos.createdAt)),
      db
        .select()
        .from(laminas)
        .where(eq(laminas.obraId, obra.id))
        .orderBy(asc(laminas.numeroPagina)),
    ]);

    return json({
      documentos: docs.map((documento) => ({
        ...documento,
        laminas: lams.filter((lamina) => lamina.documentoId === documento.id),
      })),
    });
  });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { obraId } = await params;
    const { db, sesion, obra } = await requireObraApi(obraId);
    requireRolApi(sesion, 'subir_documento');

    const formulario = await request.formData().catch(() => null);
    const archivo = formulario?.get('archivo');
    if (!(archivo instanceof File)) {
      throw new ErrorHttp(400, 'Adjuntá el PDF en el campo "archivo".');
    }

    let documento;
    try {
      documento = await subirDocumento(db, getStorage(), obra.id, sesion.usuario.id, archivo);
    } catch (error) {
      if (error instanceof ArchivoInvalidoError) throw new ErrorHttp(400, error.message);
      throw error;
    }

    // El archivo ya está guardado y auditado: si el análisis falla, el documento
    // queda en el expediente con la explicación, no se pierde el upload.
    try {
      await procesarDocumento(documento.id);
    } catch (error) {
      console.error('[api] no pude separar el documento en láminas:', error);
      // Sin esto, `obras.analisis_json` quedaba clavado en la fase que estuviera
      // en curso cuando la corrida se cortó, y el expediente decía «Analizando
      // las láminas · 12 de 25» para siempre, pidiendo un refresh cada cuatro
      // segundos. El detalle técnico va al log del server; acá va lo que el
      // arquitecto necesita saber.
      await marcarAnalisisFallido(
        obra.id,
        'el documento se guardó pero no se pudo analizar. Probá subirlo de nuevo; ' +
          'si vuelve a fallar, revisá que sea un PDF válido',
        { db },
      );
      return json(
        {
          documento,
          laminas: [],
          advertencia: 'Guardé el archivo, pero no lo pude separar en láminas. ¿Es un PDF válido?',
        },
        201,
      );
    }

    const lams = await db
      .select()
      .from(laminas)
      .where(eq(laminas.documentoId, documento.id))
      .orderBy(asc(laminas.numeroPagina));

    return json({ documento, laminas: lams }, 201);
  });
}
