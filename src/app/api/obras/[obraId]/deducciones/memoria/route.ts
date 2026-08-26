/**
 * `GET /api/obras/[obraId]/deducciones/memoria` — baja la memoria de deducciones
 * (RF-505) como markdown.
 *
 * El documento que el estudio adjunta al expediente: qué se dedujo, de dónde
 * salió, quién lo validó o lo rechazó y cuándo. Van **todas las decididas**
 * —validadas y rechazadas—: la memoria es el registro de lo que se decidió, y
 * una deducción rechazada explica por qué ese dato no está tanto como una
 * validada explica por qué está. Las propuestas todavía no son historia y no
 * entran.
 *
 * El middleware NO cubre `/api/*` (ver el `matcher` en `src/middleware.ts`): el
 * handler valida sesión + `requireObraCore`, la misma regla de aislamiento
 * (RNF-4) que usan las páginas, sin el `notFound()` de Next de por medio.
 *
 * ## De dónde sale la fecha
 *
 * `deducciones` no tiene columna "decidido_at" —`created_at` es cuándo se
 * propuso—, así que la fecha de la decisión sale de `auditoria`, que es
 * justamente el registro de quién escribió qué y cuándo (CLAUDE.md §4). Si por
 * lo que fuera no hubiera fila de auditoría, se cae a la fecha de la propuesta:
 * preferimos una fecha aproximada y trazable a una celda vacía.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { auditoria, deducciones, laminas, usuarios } from '@/db/schema';
import { ObraNoEncontradaError, requireObraCore } from '@/lib/auth/guards';
import { getSession } from '@/lib/auth/session';
import { generarMemoria, type DeduccionRegistrada } from '@/lib/deduccion/memoria';
import type { LaminaResumen } from '@/lib/deduccion/motor';
import { explicarDeduccion, valorDeDeduccion } from '@/lib/deduccion/persistencia';
import { fechaIso, fechaLegible, slugObra } from '@/lib/export/xlsx';

/** Lee la base y depende de la cookie de sesión: nunca se prerenderiza. */
export const dynamic = 'force-dynamic';

const MIME_MARKDOWN = 'text/markdown; charset=utf-8';

/** Las dos acciones que fechan una decisión sobre una deducción. */
const ACCIONES_DECISION = ['deduccion_validada', 'deduccion_rechazada'];

function problema(status: number, mensaje: string): Response {
  return Response.json({ error: mensaje }, { status });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ obraId: string }> },
): Promise<Response> {
  const sesion = await getSession();
  if (!sesion) return problema(401, 'Iniciá sesión para bajar la memoria.');

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

  const [filas, planos, decisiones] = await Promise.all([
    db
      .select({
        deduccion: deducciones,
        // `left join`: un usuario dado de baja sigue nombrado en la memoria.
        firmante: { nombre: usuarios.nombre, email: usuarios.email },
      })
      .from(deducciones)
      .leftJoin(usuarios, eq(deducciones.validadoPor, usuarios.id))
      .where(and(eq(deducciones.obraId, obra.id), inArray(deducciones.estado, ['validada', 'rechazada'])))
      .orderBy(deducciones.createdAt),
    db
      .select({ id: laminas.id, tipo: laminas.tipo, codigo: laminas.codigo })
      .from(laminas)
      .where(eq(laminas.obraId, obra.id)),
    db
      .select({ targetRef: auditoria.targetRef, at: auditoria.at })
      .from(auditoria)
      .where(and(eq(auditoria.obraId, obra.id), inArray(auditoria.accion, ACCIONES_DECISION)))
      .orderBy(auditoria.at),
  ]);

  // El último registro por target manda: si una deducción se decidió dos veces
  // (no debería, pero la auditoría es append-only), vale la decisión vigente.
  const fechaPorTarget = new Map<string, Date>();
  for (const fila of decisiones) {
    if (fila.targetRef === null) continue;
    fechaPorTarget.set(fila.targetRef, fila.at);
  }

  const codigos = new Map(
    planos.map((fila) => [fila.id, fila.codigo ?? 'sin código'] as const),
  );
  const resumenLaminas: LaminaResumen[] = planos;

  const registradas: DeduccionRegistrada[] = filas.map(({ deduccion, firmante }) => {
    const at = fechaPorTarget.get(`deducciones:${deduccion.entidadId}.${deduccion.campo}`);
    return {
      entidadId: deduccion.entidadId,
      campo: deduccion.campo,
      regla: deduccion.regla,
      valor: valorDeDeduccion(deduccion) ?? '—',
      confianza: deduccion.confianza,
      fuentes: deduccion.fuentesJson,
      explicacion: explicarDeduccion(deduccion, codigos),
      estado: deduccion.estado,
      ...(firmante ? { validadoPor: firmante.nombre || firmante.email } : {}),
      fecha: fechaLegible(at ?? deduccion.createdAt),
    };
  });

  const fecha = new Date();
  const markdown = generarMemoria(registradas, resumenLaminas);
  const archivo = `memoria-deducciones-${slugObra(obra.nombre) || 'obra'}-${fechaIso(fecha)}.md`;

  return new Response(markdown, {
    headers: {
      'content-type': MIME_MARKDOWN,
      'content-disposition': `attachment; filename="${archivo}"`,
      // Validar una deducción cambia el documento: que no quede uno cacheado.
      'cache-control': 'no-store',
    },
  });
}
