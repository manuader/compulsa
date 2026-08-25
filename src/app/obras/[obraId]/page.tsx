import { count, eq } from 'drizzle-orm';
import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { documentos, laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * Métrica del tablero. `valor` en `null` significa "todavía no hay de dónde
 * sacarlo": se muestra un guion y se explica qué falta, nunca un cero que
 * parezca un dato (P4: el sistema no inventa).
 */
function Metrica({
  titulo,
  valor,
  detalle,
}: {
  titulo: string;
  valor: number | null;
  detalle: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{titulo}</p>
        <p className="text-2xl font-semibold tabular-nums text-neutral-900">{valor ?? '—'}</p>
        <p className="text-xs text-neutral-500">{detalle}</p>
      </CardContent>
    </Card>
  );
}

export default async function TableroPage({ params }: { params: Promise<{ obraId: string }> }) {
  const { obraId } = await params;
  // El layout ya lo hizo, pero la página no puede depender de eso: nunca se
  // consulta una obra por id sin pasar por `requireObra` (src/app/CLAUDE.md §3).
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [[docs], [lams]] = await Promise.all([
    db.select({ total: count() }).from(documentos).where(eq(documentos.obraId, obra.id)),
    db.select({ total: count() }).from(laminas).where(eq(laminas.obraId, obra.id)),
  ]);

  const sinDocumentacion = docs.total === 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Metrica
          titulo="Documentos"
          valor={docs.total}
          detalle={sinDocumentacion ? 'Todavía no subiste ninguno.' : 'Archivos originales subidos.'}
        />
        <Metrica
          titulo="Láminas"
          valor={lams.total}
          detalle={
            lams.total === 0 ? 'Salen de separar los PDF por página.' : 'Páginas listas para analizar.'
          }
        />
        <Metrica
          titulo="Rubros aprobados"
          valor={null}
          detalle="Se completa cuando haya planilla de cómputo."
        />
        <Metrica
          titulo="Consultas abiertas"
          valor={null}
          detalle="Se completa cuando corra el análisis."
        />
      </section>

      {sinDocumentacion ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-2 py-8">
            <p className="text-sm font-medium text-neutral-900">Esta obra todavía está vacía.</p>
            <p className="text-sm text-neutral-600">
              Subí la documentación —plantas, cortes, vistas, planillas— y el análisis arranca solo.
            </p>
            <Link
              href={`/obras/${obra.id}/expediente`}
              className="text-sm font-medium text-neutral-900 underline"
            >
              Ir al expediente
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">Datos de la obra</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-neutral-500">Zona</dt>
              <dd className="text-neutral-900">{obra.zona}</dd>
              <dt className="text-neutral-500">Moneda</dt>
              <dd className="text-neutral-900">{obra.moneda}</dd>
              <dt className="text-neutral-500">Estado</dt>
              <dd className="text-neutral-900">
                {obra.estado === 'activa' ? 'Activa' : 'Archivada'}
              </dd>
              <dt className="text-neutral-500">Creada</dt>
              <dd className="text-neutral-900">{FECHA.format(obra.createdAt)}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">Estado por rubro</h2>
            <p className="text-sm text-neutral-600">
              Aberturas, seco, pintura y gruesa aparecen acá con su avance y sus consultas abiertas
              en cuanto haya cómputo.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
