/**
 * Visor de una lámina.
 *
 * Contrato de highlight (API pública interna, `src/app/CLAUDE.md` §4): la
 * planilla, la bandeja de consultas y la de deducciones linkean a
 * `/obras/[obraId]/laminas/[laminaId]?highlight=<id>` y el visor resalta los
 * bbox de las **fuentes** de ese target. El id puede ser de una entidad, de un
 * ítem de cómputo, de un hallazgo o de una deducción: los cuatro llevan
 * `Fuente[]` y los cuatro los resuelve `resolverDestacado`
 * (`src/lib/pipeline/marcas.ts`). No renombres el parámetro sin buscar sus usos.
 */
import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { VisorLamina } from '@/components/viewer/visor-lamina';
import { getDb } from '@/db/client';
import { laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import { armarMarcasDeLamina, resolverDestacado } from '@/lib/pipeline/marcas';
import type { BBox, EstadoAnalisis, Fuente } from '@/types/domain';

import { FormConfirmarEscala } from './ui';

/** Misma forma que valida `requireObraCore`: un id mal formado es un 404, no un 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mismas etiquetas que el expediente (`expediente/ui.tsx`): el badge de una
 * lámina tiene que decir lo mismo en las dos pantallas. El detalle largo va en
 * `explicacionDelEstado`, que acá abajo se muestra completo.
 */
const ETIQUETA_ESTADO: Record<EstadoAnalisis, string> = {
  pendiente: 'Pendiente',
  procesando: 'Procesando',
  analizada: 'Analizada',
  bloqueada_escala: 'Falta la escala',
  error: 'Error',
};

const TONO_ESTADO: Record<EstadoAnalisis, BadgeTone> = {
  pendiente: 'neutral',
  procesando: 'info',
  analizada: 'ok',
  bloqueada_escala: 'warn',
  error: 'error',
};

/** Qué necesita una lámina que no se pudo analizar (nada de spinners mudos, §5). */
function explicacionDelEstado(estado: EstadoAnalisis, errorDetalle: string | null): string | null {
  switch (estado) {
    case 'bloqueada_escala':
      return (
        'No pude confirmar la escala de esta lámina, así que no computo medidas sobre ella. ' +
        'Indicá la escala en el rótulo o cargá una cota de referencia y volvé a analizarla.'
      );
    case 'error':
      return errorDetalle
        ? `El análisis falló: ${errorDetalle}`
        : 'El análisis falló y no quedó detalle del error. Volvé a correrlo desde el expediente.';
    case 'pendiente':
      return 'Todavía no la analicé: cuando corra el análisis van a aparecer acá las entidades detectadas.';
    case 'procesando':
      return 'La estoy analizando. Recargá en un rato para ver las entidades.';
    case 'analizada':
      return null;
  }
}

function primerParametro(valor: string | string[] | undefined): string | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}

/**
 * La lámina de la URL, o 404. Memoizado por request: `generateMetadata` y la
 * página la piden con los mismos ids y no tiene sentido leerla dos veces.
 * Siempre con `obra_id` en el `where` — una lámina de otra obra no existe (RNF-4).
 */
const cargarLamina = cache(async function cargarLamina(obraId: string, laminaId: string) {
  if (!UUID_RE.test(laminaId)) notFound();

  const db = await getDb();
  const [lamina] = await db
    .select()
    .from(laminas)
    .where(and(eq(laminas.id, laminaId), eq(laminas.obraId, obraId)));
  if (!lamina) notFound();
  return lamina;
});

/** "A-01 — PLANTA PB", el mismo encabezado que se ve arriba de la lámina. */
function nombreDeLamina(lamina: {
  codigo: string | null;
  titulo: string | null;
  numeroPagina: number;
}): string {
  const cuerpo = lamina.titulo ?? `Página ${lamina.numeroPagina}`;
  return lamina.codigo ? `${lamina.codigo} — ${cuerpo}` : cuerpo;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ obraId: string; laminaId: string }>;
}): Promise<Metadata> {
  const { obraId, laminaId } = await params;
  const obra = await requireObra(obraId);
  const lamina = await cargarLamina(obra.id, laminaId);
  return { title: nombreDeLamina(lamina) };
}

export default async function LaminaPage({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string; laminaId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ obraId, laminaId }, query] = await Promise.all([params, searchParams]);
  const obra = await requireObra(obraId);
  const lamina = await cargarLamina(obra.id, laminaId);

  const db = await getDb();
  const highlight = primerParametro(query.highlight);

  // El armado de las marcas es compartido con el panel embebido
  // (`src/lib/pipeline/marcas.ts`): las dos vistas dibujan exactamente lo mismo.
  const [marcas, destacado] = await Promise.all([
    armarMarcasDeLamina(db, obra.id, lamina.id),
    highlight ? resolverDestacado(db, obra.id, highlight) : Promise.resolve(null),
  ]);
  // `cargarLamina` ya la resolvió contra la obra; esto es una carrera con un
  // borrado, no un caso normal.
  if (!marcas) notFound();

  const deEstaLamina = (fuentes: readonly Fuente[]): Fuente[] =>
    fuentes.filter((fuente) => fuente.laminaId === lamina.id);

  const fuentesDestacadas = destacado ? deEstaLamina(destacado.fuentes) : [];
  const destacados: BBox[] = fuentesDestacadas.map((fuente) => fuente.bbox);
  const enOtraLamina =
    destacado && fuentesDestacadas.length === 0
      ? (destacado.fuentes[0] ?? null)
      : null;

  const explicacion = explicacionDelEstado(lamina.estadoAnalisis, lamina.errorDetalle);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-neutral-900">{nombreDeLamina(lamina)}</h2>
          <Badge tone={TONO_ESTADO[lamina.estadoAnalisis]}>
            {ETIQUETA_ESTADO[lamina.estadoAnalisis]}
          </Badge>
          {lamina.escala ? (
            <Badge tone={lamina.escalaConfiable ? 'neutral' : 'warn'}>
              Escala {lamina.escala}
              {lamina.escalaConfiable ? '' : ' (a confirmar)'}
            </Badge>
          ) : (
            <Badge tone="warn">Sin escala</Badge>
          )}
        </div>

        <div className="flex items-center gap-3 text-sm">
          <Link href={`/obras/${obra.id}/expediente`} className="text-neutral-600 hover:text-neutral-900">
            Expediente
          </Link>
          <Link href={`/obras/${obra.id}/computo`} className="text-neutral-600 hover:text-neutral-900">
            Planilla de cómputo
          </Link>
        </div>
      </div>

      {explicacion ? (
        <Card>
          <CardContent className="text-sm text-neutral-700">{explicacion}</CardContent>
        </Card>
      ) : null}

      {/* Escala declarada pero sin verificar: el badge lo decía y no había forma
          de confirmarla desde acá, que es la pantalla donde se lee el rótulo. */}
      {lamina.escala && !lamina.escalaConfiable ? (
        <FormConfirmarEscala laminaId={lamina.id} escalaDeclarada={lamina.escala} />
      ) : null}

      {highlight && !destacado ? (
        <Card>
          <CardContent className="text-sm text-neutral-700">
            No encontré en esta obra el elemento que querías resaltar. Puede que lo hayan anulado o
            recomputado: volvé a la planilla y probá de nuevo.
          </CardContent>
        </Card>
      ) : null}

      {enOtraLamina ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-1 text-sm text-neutral-700">
            <span>
              <strong className="font-medium text-neutral-900">{destacado?.nombre}</strong> no está
              citado en esta lámina.
            </span>
            <Link
              href={`/obras/${obra.id}/laminas/${enOtraLamina.laminaId}?highlight=${highlight}`}
              className="font-medium text-neutral-900 underline"
            >
              Verlo en la lámina donde sí está
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {destacados.length > 0 ? (
        <p className="text-sm text-neutral-600">
          Resaltado en rojo: <strong className="font-medium text-neutral-900">{destacado?.nombre}</strong>{' '}
          ({destacados.length === 1 ? '1 zona citada' : `${destacados.length} zonas citadas`}).
        </p>
      ) : null}

      <VisorLamina
        archivoUrl={marcas.archivoUrl}
        entidades={marcas.entidades}
        hallazgos={marcas.hallazgos}
        deducciones={marcas.deducciones}
        destacados={destacados}
      />
    </div>
  );
}
