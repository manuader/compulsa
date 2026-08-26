/**
 * Expediente de la obra: documentos subidos y sus láminas (PRD §8).
 *
 * Server Component: acá se resuelve la pertenencia y se lee la base; la parte
 * interactiva (upload, selects, reproceso) vive en `ui.tsx`.
 */
import { asc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';

import { getDb } from '@/db/client';
import { documentos, laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';

import { Expediente, type DocumentoVista, type LaminaVista } from './ui';

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
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

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-neutral-900">Expediente</h2>
        <p className="text-sm text-neutral-600">
          Subí la documentación y revisá cómo quedó cada lámina. Las que no tienen escala
          verificable esperan que se la indiques: sin escala no se computa nada.
        </p>
      </div>

      <Expediente obraId={obra.id} documentos={vistas} />
    </section>
  );
}
