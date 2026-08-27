/**
 * Las marcas de una lámina, en JSON.
 *
 *   GET → `{ laminaId, archivoUrl, entidades, hallazgos, deducciones }`
 *
 * Es lo que le da de comer al `PanelVisor` embebido: la bandeja de consultas y
 * la de deducciones muestran el plano al lado de la pregunta y necesitan las
 * marcas **sin navegar** a la página del visor. El armado es el mismo que usa
 * esa página (`armarMarcasDeLamina`), así que las dos dibujan lo mismo.
 *
 * Lectura pura: no pide rol (`lectura` tiene que poder ver el plano), pero sí
 * pasa por `requireLaminaApi` — sin sesión es 401 y una lámina de otro estudio
 * no existe (404, RNF-4).
 *
 * Este archivo solo exporta `GET` (CLAUDE.md §9).
 */
import { ErrorHttp, json, requireLaminaApi, responder } from '@/lib/pipeline/http';
import { armarMarcasDeLamina } from '@/lib/pipeline/marcas';

type Params = { params: Promise<{ laminaId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return responder(async () => {
    const { laminaId } = await params;
    const { db, obra, lamina } = await requireLaminaApi(laminaId);

    const marcas = await armarMarcasDeLamina(db, obra.id, lamina.id);
    // `requireLaminaApi` ya resolvió la lámina contra su obra, así que esto es
    // una carrera con un borrado, no un caso normal. La respuesta es la misma
    // que la de una lámina ajena: no existe.
    if (!marcas) throw new ErrorHttp(404, 'Esa lámina no existe.');

    return json(marcas);
  });
}
