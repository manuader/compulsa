/**
 * Expediente de la obra: documentos subidos y sus láminas (PRD §8).
 *
 * Server Component: acá se resuelve la pertenencia y se lee la base; la parte
 * interactiva (upload, selects, reproceso) vive en `ui.tsx`.
 */
import { asc, desc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';

import { getDb } from '@/db/client';
import { documentos, laminas, recomputos } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import type { DiffDeRevision, MotivoRecomputo } from '@/lib/pipeline/procesar';
import { leerResumen } from '@/lib/pipeline/resumen';

import { CambiosDeRevision, type RevisionVista } from './cambios-ui';
import { ProgresoAnalisis } from './progreso-ui';
import { PanelQa } from './qa-ui';
import { ResumenEjecutivo } from './resumen-ui';
import { Expediente, type DocumentoVista, type LaminaVista } from './ui';

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const FECHA_Y_HORA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const metadata: Metadata = { title: 'Expediente' };

export default async function ExpedientePage({
  params,
}: {
  params: Promise<{ obraId: string }>;
}) {
  const { obraId } = await params;
  // Aislamiento RNF-4: nunca se consulta una obra por id sin pasar por acá.
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [docs, lams, ultimoRecomputo] = await Promise.all([
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
    // "Qué cambió" (RF-308): la corrida más nueva, que es la que alguien acaba
    // de provocar subiendo una revisión.
    db
      .select()
      .from(recomputos)
      .where(eq(recomputos.obraId, obra.id))
      .orderBy(desc(recomputos.at))
      .limit(1),
  ]);

  const porDocumento = new Map<string, LaminaVista[]>();
  for (const lamina of lams) {
    const vista: LaminaVista = {
      id: lamina.id,
      numeroPagina: lamina.numeroPagina,
      codigo: lamina.codigo,
      titulo: lamina.titulo,
      disciplina: lamina.disciplina,
      tipo: lamina.tipo,
      escala: lamina.escala,
      escalaConfiable: lamina.escalaConfiable,
      estadoAnalisis: lamina.estadoAnalisis,
      errorDetalle: lamina.errorDetalle,
      archivoRef: lamina.archivoRef,
    };
    const previas = porDocumento.get(lamina.documentoId);
    if (previas) previas.push(vista);
    else porDocumento.set(lamina.documentoId, [vista]);
  }

  const vistas: DocumentoVista[] = docs.map((documento) => ({
    id: documento.id,
    nombreArchivo: documento.nombreArchivo,
    version: documento.version,
    subidoEl: FECHA.format(documento.createdAt),
    laminas: porDocumento.get(documento.id) ?? [],
  }));

  const [fila] = ultimoRecomputo;
  // El `diff_json` va primero y los campos de la fila después: la columna es
  // `jsonb` y lo que manda sobre el motivo y la fecha es la fila, no el JSON.
  const revision: RevisionVista | null = fila
    ? {
        ...(fila.diffJson as unknown as DiffDeRevision),
        motivo: fila.motivo as MotivoRecomputo,
        cuando: FECHA_Y_HORA.format(fila.at),
      }
    : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-neutral-900">Expediente</h2>
        <p className="text-sm text-neutral-600">
          Subí la documentación y revisá cómo quedó cada lámina. Las que no tienen escala
          verificable esperan que se la indiques: sin escala no se computa nada.
        </p>
      </div>

      {/* Arriba de todo: mientras el pipeline corre, es lo único que el
          arquitecto quiere saber. El resumen y la lista de láminas de abajo
          están a medio hacer hasta que la fase dice «listo». */}
      <ProgresoAnalisis fase={obra.analisisJson} />

      <ResumenEjecutivo obraId={obra.id} resumen={leerResumen(obra)} />

      <PanelQa
        obraId={obra.id}
        laminasConTexto={lams.filter((lamina) => lamina.textoExtraido !== null).length}
      />

      <CambiosDeRevision revision={revision} />

      <Expediente obraId={obra.id} documentos={vistas} />
    </section>
  );
}
