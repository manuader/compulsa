/**
 * `GET /api/obras/[obraId]/planilla-carpinterias` — baja la planilla de
 * carpinterías **derivada** en XLSX (RF-504).
 *
 * Una fila por entidad `abertura` de la obra, con el tag, la tipología, las
 * medidas, el material, el vidrio y —la columna que hace que el archivo sea
 * honesto— de dónde salió cada medida: explícita, deducida y validada, o
 * todavía pendiente.
 *
 * **Las deducciones propuestas no se escriben** (P4). Se usan solo para poder
 * decir "pendiente" con conocimiento de causa: la medida falta y hay una
 * propuesta esperando en la bandeja. El valor entra el día que alguien la valida.
 *
 * El middleware NO cubre `/api/*`: el handler valida sesión + `requireObraCore`,
 * la misma regla de aislamiento (RNF-4) que usan las páginas.
 */
import { and, eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { deducciones, entidades, laminas } from '@/db/schema';
import { ObraNoEncontradaError, requireObraCore } from '@/lib/auth/guards';
import { getSession } from '@/lib/auth/session';
import {
  generarPlanillaCarpinterias,
  nombreArchivoPlanilla,
  origenDeCarpinteria,
  type FilaCarpinteria,
} from '@/lib/export/planilla-carpinterias';
import { leerMedida, leerTexto } from '@/lib/hallazgos/taxonomia';
import { aplicarDeduccionesValidadas, comoEntidadPersistida } from '@/lib/pipeline/recomputar';
import type { Origen } from '@/types/domain';

/** exceljs es Node puro (zlib, streams): este handler no corre en el edge. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Las medidas sin las cuales la carpintería no se puede fabricar ni cotizar. */
const MEDIDAS = ['anchoM', 'altoM'] as const;

function problema(status: number, mensaje: string): Response {
  return Response.json({ error: mensaje }, { status });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ obraId: string }> },
): Promise<Response> {
  const sesion = await getSession();
  if (!sesion) return problema(401, 'Iniciá sesión para bajar la planilla.');

  const { obraId } = await params;
  const db = await getDb();

  let obra;
  try {
    obra = await requireObraCore(db, sesion.estudio.id, obraId);
  } catch (error) {
    if (error instanceof ObraNoEncontradaError) {
      return problema(404, 'Esa obra no existe o no es de tu estudio.');
    }
    throw error;
  }

  const [filas, decididas, planos] = await Promise.all([
    db
      .select()
      .from(entidades)
      .where(and(eq(entidades.obraId, obra.id), eq(entidades.tipo, 'abertura')))
      .orderBy(entidades.nombre),
    db.select().from(deducciones).where(eq(deducciones.obraId, obra.id)),
    db
      .select({ id: laminas.id, codigo: laminas.codigo, numeroPagina: laminas.numeroPagina })
      .from(laminas)
      .where(eq(laminas.obraId, obra.id)),
  ]);

  // La misma capa que usa el recompute: el dato validado vale aunque un
  // reanálisis lo haya borrado de `atributos_json`.
  const { entidades: aberturas, camposDeducidos } = aplicarDeduccionesValidadas(
    filas.map(comoEntidadPersistida),
    decididas,
  );

  const codigos = new Map(
    planos.map((fila) => [fila.id, fila.codigo ?? `Página ${fila.numeroPagina}`] as const),
  );
  const carpinterias: FilaCarpinteria[] = aberturas.map((abertura) => {
    const deducidos = camposDeducidos.get(abertura.id) ?? new Map<string, Origen>();
    const anchoM = leerMedida(abertura, 'anchoM');
    const altoM = leerMedida(abertura, 'altoM');

    const falta = MEDIDAS.some((campo) => leerMedida(abertura, campo) === null);
    const origen = origenDeCarpinteria(
      falta,
      MEDIDAS.map((campo) => deducidos.get(campo)).filter(
        (origen): origen is Origen => origen !== undefined,
      ),
    );

    // Las láminas: la de la entidad y, si la medida vino de una deducción, la
    // que la aportó (la deducción cita las dos, por eso alcanza con sus fuentes).
    const fuentes = decididas
      .filter(
        (fila) =>
          fila.entidadId === abertura.id && fila.estado === 'validada' && deducidos.has(fila.campo),
      )
      .flatMap((fila) => fila.fuentesJson);
    const citadas = [abertura.laminaId, ...fuentes.map((fuente) => fuente.laminaId)];

    return {
      tag: leerTexto(abertura, 'tag') ?? abertura.nombre,
      tipologia: leerTexto(abertura, 'tipologia'),
      anchoM,
      altoM,
      material: leerTexto(abertura, 'material'),
      vidrio: leerTexto(abertura, 'vidrio'),
      origen,
      laminas: [...new Set(citadas.map((id) => codigos.get(id) ?? id))].join(', '),
    };
  });

  // Una fila pendiente con propuesta esperando no cambia el archivo, pero sí el
  // orden: primero lo resuelto, y las pendientes al final, que es la lista de
  // lo que hay que ir a buscar.
  carpinterias.sort((a, b) => {
    if (a.origen === 'pendiente' !== (b.origen === 'pendiente')) {
      return a.origen === 'pendiente' ? 1 : -1;
    }
    return a.tag.localeCompare(b.tag, 'es-AR');
  });

  const fecha = new Date();
  const libro = await generarPlanillaCarpinterias(obra, carpinterias, { fecha });
  const archivo = nombreArchivoPlanilla(obra.nombre, fecha);

  return new Response(new Uint8Array(libro), {
    headers: {
      'content-type': MIME_XLSX,
      'content-disposition': `attachment; filename="${archivo}"`,
      'content-length': String(libro.byteLength),
      'cache-control': 'no-store',
    },
  });
}
