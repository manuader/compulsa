/**
 * `GET /api/obras/[obraId]/export?rubro=<id|todos>` — baja el cómputo en XLSX.
 *
 * El middleware NO cubre `/api/*` (ver el `matcher` en `src/middleware.ts`):
 * cada handler valida por su cuenta. Acá eso es sesión + `requireObraCore`, que
 * es la misma regla de aislamiento (RNF-4) que usan las páginas, sin el
 * `notFound()` de Next de por medio — una API contesta con status, no navega.
 *
 * El contrato de la URL es público hacia adentro: la planilla y el tablero
 * linkean a `?rubro=<id|todos>`. No lo renombres sin buscar sus usos.
 */
import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { computoItems, computoRubros, laminas } from '@/db/schema';
import { ObraNoEncontradaError, requireObraCore } from '@/lib/auth/guards';
import { getSession } from '@/lib/auth/session';
import { generarXlsx, nombreArchivoXlsx, type EstadosRubro } from '@/lib/export/xlsx';
import { RUBROS, type RubroId } from '@/types/domain';

/** exceljs es Node puro (zlib, streams): este handler no corre en el edge. */
export const runtime = 'nodejs';
/** Depende de la cookie de sesión y de la base: nunca se prerenderiza. */
export const dynamic = 'force-dynamic';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function problema(status: number, mensaje: string): Response {
  return Response.json({ error: mensaje }, { status });
}

function esRubro(valor: string): valor is RubroId {
  return (RUBROS as readonly string[]).includes(valor);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ obraId: string }> },
): Promise<Response> {
  const sesion = await getSession();
  if (!sesion) return problema(401, 'Iniciá sesión para bajar el cómputo.');

  // `?rubro=` vacío es "no lo especifiqué", igual que no mandar el parámetro.
  const crudo = new URL(request.url).searchParams.get('rubro')?.trim() || 'todos';
  if (crudo !== 'todos' && !esRubro(crudo)) {
    // No degradamos a "todos" en silencio: pediste un rubro que no existe y el
    // archivo que bajarías no sería el que creés.
    return problema(400, `No conozco el rubro "${crudo}".`);
  }
  const rubro: RubroId | 'todos' = crudo;

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

  const [items, estadosFilas, laminasObra] = await Promise.all([
    db
      .select({
        rubro: computoItems.rubro,
        claveItem: computoItems.claveItem,
        descripcion: computoItems.descripcion,
        unidad: computoItems.unidad,
        cantNeta: computoItems.cantNeta,
        desperdicioPct: computoItems.desperdicioPct,
        cantCompra: computoItems.cantCompra,
        presentacion: computoItems.presentacion,
        origen: computoItems.origen,
        confianza: computoItems.confianza,
        estado: computoItems.estado,
        fuentesJson: computoItems.fuentesJson,
      })
      .from(computoItems)
      .where(
        and(
          eq(computoItems.obraId, obra.id),
          // `generarXlsx` vuelve a filtrar los anulados; el filtro acá es para no
          // traer de la base filas que el libro va a tirar igual.
          eq(computoItems.estado, 'activo'),
          rubro === 'todos' ? undefined : eq(computoItems.rubro, rubro),
        ),
      )
      // Orden estable: dos exports de la misma obra tienen que dar el mismo libro.
      .orderBy(asc(computoItems.rubro), asc(computoItems.claveItem)),
    db
      .select({ rubro: computoRubros.rubro, estado: computoRubros.estado })
      .from(computoRubros)
      .where(eq(computoRubros.obraId, obra.id)),
    db
      .select({ id: laminas.id, codigo: laminas.codigo, titulo: laminas.titulo })
      .from(laminas)
      .where(eq(laminas.obraId, obra.id)),
  ]);

  const estadosRubro: EstadosRubro = Object.fromEntries(
    estadosFilas.map((fila) => [fila.rubro, fila.estado]),
  );

  const fecha = new Date();
  const libro = await generarXlsx(obra, items, estadosRubro, laminasObra, { rubro, fecha });
  // `nombreArchivoXlsx` sale siempre en ASCII (`[a-z0-9-]` + fecha), así que no
  // hace falta el `filename*=UTF-8''` que algunos navegadores manejan a su modo.
  const archivo = nombreArchivoXlsx(obra.nombre, fecha);

  // `Buffer` no entra en `BodyInit` (su `ArrayBufferLike` puede ser compartido);
  // la copia a `Uint8Array` es de decenas de KB y deja el tipo bien.
  return new Response(new Uint8Array(libro), {
    headers: {
      'content-type': MIME_XLSX,
      'content-disposition': `attachment; filename="${archivo}"`,
      'content-length': String(libro.byteLength),
      // Aprobar un rubro cambia el archivo: que no quede uno viejo cacheado.
      'cache-control': 'no-store',
    },
  });
}
