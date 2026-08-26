/**
 * Visor de una lámina.
 *
 * Contrato de highlight (API pública interna, `src/app/CLAUDE.md` §4): la
 * planilla, la bandeja de consultas y la de deducciones linkean a
 * `/obras/[obraId]/laminas/[laminaId]?highlight=<id>` y el visor resalta los
 * bbox de las **fuentes** de ese target. El id puede ser de una entidad, de un
 * ítem de cómputo, de un hallazgo o de una deducción: los cuatro llevan
 * `Fuente[]` y los cuatro se resuelven acá. No renombres el parámetro sin
 * buscar sus usos.
 */
import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { MarcaDeduccion, MarcaEntidad, MarcaHallazgo } from '@/components/viewer/overlay';
import { VisorLamina } from '@/components/viewer/visor-lamina';
import { getDb, type Db } from '@/db/client';
import { computoItems, deducciones, entidades, hallazgos, laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import { TITULO_REGLA } from '@/lib/deduccion/memoria';
import { describirValor, etiquetaCampo } from '@/lib/deduccion/motor';
import { valorDeDeduccion } from '@/lib/deduccion/persistencia';
import type { BBox, EstadoAnalisis, Fuente } from '@/types/domain';

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

interface Destacado {
  /** Cómo nombrarlo en el aviso: "el ítem Placa de roca de yeso". */
  nombre: string;
  fuentes: Fuente[];
}

/**
 * Resuelve `?highlight=` contra las tres tablas que llevan provenance. Siempre
 * con `obra_id` en el `where`: un id de otra obra no existe (RNF-4).
 */
async function resolverDestacado(
  db: Db,
  obraId: string,
  highlight: string,
): Promise<Destacado | null> {
  if (!UUID_RE.test(highlight)) return null;

  const [entidad] = await db
    .select({ nombre: entidades.nombre, fuentes: entidades.fuentesJson })
    .from(entidades)
    .where(and(eq(entidades.id, highlight), eq(entidades.obraId, obraId)));
  if (entidad) return { nombre: entidad.nombre, fuentes: entidad.fuentes };

  const [item] = await db
    .select({ nombre: computoItems.descripcion, fuentes: computoItems.fuentesJson })
    .from(computoItems)
    .where(and(eq(computoItems.id, highlight), eq(computoItems.obraId, obraId)));
  if (item) return { nombre: item.nombre, fuentes: item.fuentes };

  const [hallazgo] = await db
    .select({ nombre: hallazgos.descripcion, fuentes: hallazgos.laminasJson })
    .from(hallazgos)
    .where(and(eq(hallazgos.id, highlight), eq(hallazgos.obraId, obraId)));
  if (hallazgo) return { nombre: hallazgo.nombre, fuentes: hallazgo.fuentes };

  const [deduccion] = await db
    .select({
      campo: deducciones.campo,
      valorJson: deducciones.valorJson,
      fuentes: deducciones.fuentesJson,
    })
    .from(deducciones)
    .where(and(eq(deducciones.id, highlight), eq(deducciones.obraId, obraId)));
  if (deduccion) {
    const valor = valorDeDeduccion(deduccion);
    const nombre =
      valor === null
        ? `deducción de ${etiquetaCampo(deduccion.campo)}`
        : `${etiquetaCampo(deduccion.campo)} deducido: ${describirValor(deduccion.campo, valor)}`;
    return { nombre, fuentes: deduccion.fuentes };
  }

  return null;
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

  const [filasEntidades, filasHallazgos, filasDeducciones, destacado] = await Promise.all([
    db
      .select({
        id: entidades.id,
        tipo: entidades.tipo,
        nombre: entidades.nombre,
        fuentes: entidades.fuentesJson,
      })
      .from(entidades)
      .where(and(eq(entidades.obraId, obra.id), eq(entidades.laminaId, lamina.id))),
    db
      .select({
        id: hallazgos.id,
        descripcion: hallazgos.descripcion,
        bloqueante: hallazgos.bloqueante,
        estado: hallazgos.estado,
        fuentes: hallazgos.laminasJson,
      })
      .from(hallazgos)
      .where(eq(hallazgos.obraId, obra.id)),
    // La marca va sobre la entidad que la deducción COMPLETARÍA, que es la que
    // hoy está sin acotar: por eso el join es contra `entidades.laminaId`.
    db
      .select({
        id: deducciones.id,
        campo: deducciones.campo,
        regla: deducciones.regla,
        valorJson: deducciones.valorJson,
        fuentesEntidad: entidades.fuentesJson,
      })
      .from(deducciones)
      .innerJoin(entidades, eq(deducciones.entidadId, entidades.id))
      .where(
        and(
          eq(deducciones.obraId, obra.id),
          eq(deducciones.estado, 'propuesta'),
          eq(entidades.laminaId, lamina.id),
        ),
      ),
    highlight ? resolverDestacado(db, obra.id, highlight) : Promise.resolve(null),
  ]);

  const deEstaLamina = (fuentes: readonly Fuente[]): Fuente[] =>
    fuentes.filter((fuente) => fuente.laminaId === lamina.id);

  const marcasEntidades: MarcaEntidad[] = filasEntidades.flatMap((fila) =>
    deEstaLamina(fila.fuentes).map((fuente) => ({
      id: fila.id,
      tipo: fila.tipo,
      nombre: fila.nombre,
      ...(fuente.detalle === undefined ? {} : { detalle: fuente.detalle }),
      bbox: fuente.bbox,
    })),
  );

  const marcasHallazgos: MarcaHallazgo[] = filasHallazgos
    .filter((fila) => fila.estado !== 'descartado')
    .flatMap((fila) =>
      deEstaLamina(fila.fuentes).map((fuente) => ({
        id: fila.id,
        descripcion: fila.descripcion,
        bloqueante: fila.bloqueante,
        bbox: fuente.bbox,
      })),
    );

  const marcasDeducciones: MarcaDeduccion[] = filasDeducciones.flatMap((fila) => {
    const valor = valorDeDeduccion(fila);
    return deEstaLamina(fila.fuentesEntidad).map((fuente) => ({
      id: fila.id,
      campo: etiquetaCampo(fila.campo),
      valor: valor === null ? '—' : describirValor(fila.campo, valor),
      regla: TITULO_REGLA[fila.regla],
      bbox: fuente.bbox,
    }));
  });

  const fuentesDestacadas = destacado ? deEstaLamina(destacado.fuentes) : [];
  const destacados: BBox[] = fuentesDestacadas.map((fuente) => fuente.bbox);
  const enOtraLamina =
    destacado && fuentesDestacadas.length === 0
      ? (destacado.fuentes[0] ?? null)
      : null;

  // La ref es una ruta relativa POSIX del storage: cada segmento se codifica por
  // separado para no romper la barra que separa carpetas.
  const archivoUrl = `/api/archivos/${lamina.archivoRef.split('/').map(encodeURIComponent).join('/')}`;
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
        archivoUrl={archivoUrl}
        entidades={marcasEntidades}
        hallazgos={marcasHallazgos}
        deducciones={marcasDeducciones}
        destacados={destacados}
      />
    </div>
  );
}
