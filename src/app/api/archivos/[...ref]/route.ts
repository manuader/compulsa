/**
 * Bytes de un archivo del storage, con control de acceso.
 *
 * El storage local es una carpeta del server: nada de esto se sirve como
 * estático. Toda lectura pasa por acá y por dos filtros independientes:
 *
 *  1. **La ref se lee.** La convención de rutas arranca por el estudio y la
 *     obra —`estudios/<estudioId>/obras/<obraId>/documentos/<docId>/…`— así que
 *     la pertenencia se decide antes de tocar el disco, con `requireObraCore`
 *     (el mismo núcleo de aislamiento RNF-4 que usan las pantallas).
 *  2. **La ref se confirma contra la base.** Que la ruta tenga la forma
 *     correcta no prueba que ese archivo sea de esta obra: tiene que existir un
 *     `documentos.archivo_ref` o un `laminas.archivo_ref` que la nombre. Sin
 *     eso, adivinar un uuid ajeno alcanzaría para pedir un archivo que no está
 *     en el expediente.
 *
 * Cualquier fallo de cualquiera de los dos es un 404: no se le confirma a nadie
 * que un archivo existe si no le corresponde verlo.
 */
import { and, eq } from 'drizzle-orm';

import { documentos, laminas } from '@/db/schema';
import { ErrorHttp, errorJson, requireObraApi, responder } from '@/lib/pipeline/http';
import { MIME_PDF, parsearRefArchivo } from '@/lib/pipeline/refs';
import { getStorage } from '@/lib/storage/index';

type Params = { params: Promise<{ ref: string[] }> };

const NO_EXISTE = 'Ese archivo no existe.';

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { ref: segmentos } = await params;
    const ref = (segmentos ?? []).join('/');

    const partes = parsearRefArchivo(ref);
    if (!partes) throw new ErrorHttp(404, NO_EXISTE);

    const { db, sesion, obra } = await requireObraApi(partes.obraId);
    // La ref nombra un estudio: tiene que ser el de la sesión. `requireObraApi`
    // ya cubre el caso, pero el chequeo explícito deja la invariante escrita.
    if (partes.estudioId !== sesion.estudio.id) throw new ErrorHttp(404, NO_EXISTE);

    const [documento] = await db
      .select({ id: documentos.id })
      .from(documentos)
      .where(and(eq(documentos.obraId, obra.id), eq(documentos.archivoRef, ref)));

    if (!documento) {
      const [lamina] = await db
        .select({ id: laminas.id })
        .from(laminas)
        .where(and(eq(laminas.obraId, obra.id), eq(laminas.archivoRef, ref)));
      if (!lamina) throw new ErrorHttp(404, NO_EXISTE);
    }

    let bytes: Uint8Array;
    try {
      bytes = await getStorage().leer(ref);
    } catch (error) {
      // El registro está pero el archivo no: para quien pide, es un 404 igual.
      console.error('[api] no pude leer el archivo del storage:', ref, error);
      return errorJson(NO_EXISTE, 404);
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': MIME_PDF,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': 'inline',
        // Es documentación privada de un estudio: nunca en una caché compartida.
        'Cache-Control': 'private, max-age=0, must-revalidate',
      },
    });
  });
}
