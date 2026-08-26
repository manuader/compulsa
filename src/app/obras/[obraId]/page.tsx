import { and, asc, count, eq, sql } from 'drizzle-orm';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { getDb } from '@/db/client';
import { computoItems, computoRubros, deducciones, documentos, hallazgos, laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import { resumenCompulsasObra } from '@/lib/compulsa/adjudicar';
import { formatearImporte } from '@/lib/compulsa/comparativa';
import { checklistEfectivoDeTodos, contarBloqueantes } from '@/lib/plataforma/checklists';
import { PLANTILLAS } from '@/lib/rubros';
import { RUBROS, type EstadoRubro } from '@/types/domain';

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * Copia deliberada del `DISCLAIMER` de `src/lib/export/xlsx.ts`. Importarlo de
 * ahí arrastraría exceljs al server bundle del tablero para leer un string.
 */
const DISCLAIMER = 'Cómputo asistido por Compulsa — sujeto a validación del profesional responsable';

const ETIQUETA_ESTADO_RUBRO: Record<EstadoRubro, string> = {
  borrador: 'Borrador',
  revision: 'En revisión',
  aprobado: 'Aprobado',
};

// Mismos tonos que la planilla (`computo/page.tsx`): el mismo estado no puede
// ser ámbar en una pantalla y celeste en la de al lado.
const TONO_ESTADO_RUBRO: Record<EstadoRubro, BadgeTone> = {
  borrador: 'neutral',
  revision: 'info',
  aprobado: 'ok',
};

/** Concordancia de número: "1 bloqueada por escala" y no "1 bloqueadas por escala". */
function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * Métrica del tablero. `valor` en `null` significa "todavía no hay de dónde
 * sacarlo": se muestra un guion y se explica qué falta, nunca un cero que
 * parezca un dato (P4: el sistema no inventa).
 */
function Metrica({
  titulo,
  valor,
  detalle,
  children,
}: {
  titulo: string;
  valor: number | string | null;
  detalle: string;
  children?: ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-1">
        <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{titulo}</p>
        <p className="text-2xl font-semibold tabular-nums text-neutral-900">{valor ?? '—'}</p>
        <p className="text-xs text-neutral-500">{detalle}</p>
        {children}
      </CardContent>
    </Card>
  );
}

/** Acceso a una de las cuatro pantallas de la obra. Sin destino, no es un link muerto. */
function Acceso({
  href,
  titulo,
  detalle,
}: {
  href: string | null;
  titulo: string;
  detalle: string;
}) {
  const cuerpo = (
    <CardContent className="flex h-full flex-col gap-1">
      <p className="text-sm font-medium text-neutral-900">{titulo}</p>
      <p className="text-xs text-neutral-500">{detalle}</p>
    </CardContent>
  );

  if (!href) return <Card className="h-full bg-neutral-50">{cuerpo}</Card>;

  return (
    <Link href={href} className="block h-full">
      <Card className="h-full transition-colors hover:border-neutral-400">{cuerpo}</Card>
    </Link>
  );
}

export default async function TableroPage({ params }: { params: Promise<{ obraId: string }> }) {
  const { obraId } = await params;
  // El layout ya lo hizo, pero la página no puede depender de eso: nunca se
  // consulta una obra por id sin pasar por `requireObra` (src/app/CLAUDE.md §3).
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [
    [docs],
    laminasPorEstado,
    primeras,
    itemsPorRubro,
    estadosFilas,
    consultasAbiertas,
    [deduccionesPropuestas],
    compulsas,
    checklist,
  ] = await Promise.all([
      db.select({ total: count() }).from(documentos).where(eq(documentos.obraId, obra.id)),
      db
        .select({ estado: laminas.estadoAnalisis, total: count() })
        .from(laminas)
        .where(eq(laminas.obraId, obra.id))
        .groupBy(laminas.estadoAnalisis),
      db
        .select({ id: laminas.id })
        .from(laminas)
        .where(eq(laminas.obraId, obra.id))
        .orderBy(asc(laminas.numeroPagina), asc(laminas.createdAt))
        .limit(1),
      db
        .select({
          rubro: computoItems.rubro,
          total: count(),
          // Provenance (P1): cuántos ítems citan al menos una lámina. Se cuenta en
          // SQL y no en JS para no traerse `fuentes_json` entero por una métrica.
          conFuentes: sql<number>`count(*) filter (where jsonb_array_length(${computoItems.fuentesJson}) > 0)`.mapWith(
            Number,
          ),
        })
        .from(computoItems)
        .where(and(eq(computoItems.obraId, obra.id), eq(computoItems.estado, 'activo')))
        .groupBy(computoItems.rubro),
      db
        .select({ rubro: computoRubros.rubro, estado: computoRubros.estado })
        .from(computoRubros)
        .where(eq(computoRubros.obraId, obra.id)),
      // Las consultas abiertas vienen enteras (son unidades por obra, no miles):
      // el contador de bloqueantes se calcula con el checklist del estudio
      // aplicado, que es lo que decide el gate. Contar el `bloqueante` crudo
      // haría que un estudio que desactivó un chequeo viera "1 bloquea la
      // aprobación" con el rubro perfectamente aprobable.
      db
        .select({
          rubro: hallazgos.rubro,
          bloqueante: hallazgos.bloqueante,
          estado: hallazgos.estado,
          checklistItem: hallazgos.checklistItem,
        })
        .from(hallazgos)
        .where(and(eq(hallazgos.obraId, obra.id), eq(hallazgos.estado, 'abierto'))),
      db
        .select({ total: count() })
        .from(deducciones)
        .where(and(eq(deducciones.obraId, obra.id), eq(deducciones.estado, 'propuesta'))),
      // El ahorro no está guardado en ninguna tabla: se recalcula al leer desde
      // adjudicaciones + cotizaciones + negociaciones (ver el encabezado de
      // `@/lib/compulsa/adjudicar`). Con el orden de magnitud de una obra son
      // unidades de consultas, no cientos.
      resumenCompulsasObra(db, obra.id),
      checklistEfectivoDeTodos(db, obra.estudioId),
    ]);

  const consultas = {
    abiertas: consultasAbiertas.length,
    bloqueantes: contarBloqueantes(consultasAbiertas, checklist),
  };

  const porEstado = new Map(laminasPorEstado.map((f) => [f.estado, f.total]));
  const totalLaminas = laminasPorEstado.reduce((acc, f) => acc + f.total, 0);
  const analizadas = porEstado.get('analizada') ?? 0;
  const bloqueadas = porEstado.get('bloqueada_escala') ?? 0;
  const conError = porEstado.get('error') ?? 0;
  const enCola = (porEstado.get('pendiente') ?? 0) + (porEstado.get('procesando') ?? 0);

  const computoPorRubro = new Map(itemsPorRubro.map((f) => [f.rubro, f]));
  const estados = new Map(estadosFilas.map((f) => [f.rubro, f.estado]));
  const filasRubro = RUBROS.map((rubro) => {
    const fila = computoPorRubro.get(rubro);
    const items = fila?.total ?? 0;
    return {
      rubro,
      nombre: PLANTILLAS[rubro].nombre,
      items,
      estado: estados.get(rubro) ?? ('borrador' as EstadoRubro),
      // Sin ítems no hay porcentaje: `null` y guion. Un 100% sobre cero ítems
      // sería una tilde verde sobre nada.
      provenancePct: items === 0 ? null : Math.round(((fila?.conFuentes ?? 0) / items) * 100),
    };
  });
  const totalItems = filasRubro.reduce((acc, f) => acc + f.items, 0);
  const rubrosAprobados = filasRubro.filter((f) => f.estado === 'aprobado').length;

  const sinDocumentacion = docs.total === 0;
  // Mientras no haya una lámina analizada, "0 consultas" no significa "todo en
  // orden" sino "todavía no miramos nada": se muestra un guion.
  const hayAnalisis = analizadas + bloqueadas + conError > 0;
  const base = `/obras/${obra.id}`;
  const primeraLamina = primeras[0]?.id ?? null;

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metrica
          titulo="Láminas"
          valor={totalLaminas === 0 ? null : `${analizadas}/${totalLaminas}`}
          detalle={
            totalLaminas === 0
              ? 'Salen de separar los PDF del expediente por página.'
              : 'Analizadas sobre el total de la obra.'
          }
        >
          <div className="mt-1 flex flex-wrap gap-1">
            {totalLaminas === 0 ? (
              <Badge tone="neutral">{docs.total === 0 ? 'Sin documentación' : 'Sin láminas'}</Badge>
            ) : null}
            {enCola > 0 ? <Badge tone="info">{enCola} en cola</Badge> : null}
            {bloqueadas > 0 ? (
              <Badge tone="warn">
                {plural(bloqueadas, 'bloqueada por escala', 'bloqueadas por escala')}
              </Badge>
            ) : null}
            {conError > 0 ? <Badge tone="error">{conError} con error</Badge> : null}
            {totalLaminas > 0 && enCola === 0 && bloqueadas === 0 && conError === 0 ? (
              <Badge tone="ok">Todas analizadas</Badge>
            ) : null}
          </div>
        </Metrica>

        <Metrica
          titulo="Consultas"
          valor={hayAnalisis ? consultas.abiertas : null}
          detalle={
            hayAnalisis
              ? 'Abiertas en la bandeja, esperando respuesta.'
              : 'Salen del análisis: todavía no hay láminas analizadas.'
          }
        >
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {consultas.bloqueantes > 0 ? (
              <Badge tone="error">
                {plural(consultas.bloqueantes, 'bloquea la aprobación', 'bloquean la aprobación')}
              </Badge>
            ) : hayAnalisis ? (
              <Badge tone="ok">Ninguna bloquea</Badge>
            ) : null}
            <Link
              href={`${base}/bandeja`}
              className="text-xs font-medium text-neutral-900 underline"
            >
              Ir a la bandeja
            </Link>
          </div>
        </Metrica>

        <Metrica
          titulo="Deducciones"
          valor={hayAnalisis ? (deduccionesPropuestas?.total ?? 0) : null}
          detalle={
            hayAnalisis
              ? 'Propuestas esperando que las valides o las rechaces.'
              : 'Salen de cruzar láminas: todavía no hay ninguna analizada.'
          }
        >
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {(deduccionesPropuestas?.total ?? 0) > 0 ? (
              <Badge tone="info">Ningún dato se escribe sin tu visto bueno</Badge>
            ) : hayAnalisis ? (
              <Badge tone="ok">Nada pendiente</Badge>
            ) : null}
            <Link
              href={`${base}/deducciones`}
              className="text-xs font-medium text-neutral-900 underline"
            >
              Ver deducciones
            </Link>
          </div>
        </Metrica>

        <Metrica
          titulo="Cómputo consolidado"
          valor={totalItems === 0 ? null : totalItems}
          detalle={
            totalItems === 0
              ? 'Sin cómputo todavía no hay nada que exportar.'
              : 'Ítems activos que entran al XLSX, con su lámina de origen.'
          }
        >
          <div className="mt-1 flex flex-col gap-1">
            {totalItems === 0 ? null : (
              // `<a>` y no `<Link>`: es una descarga de la API, no una navegación
              // del App Router (nada que prefetchear).
              <a
                href={`/api/obras/${obra.id}/export?rubro=todos`}
                className="text-xs font-medium text-neutral-900 underline"
              >
                Bajar XLSX de los 4 rubros
              </a>
            )}
            <p className="text-[11px] leading-snug text-neutral-500">{`${DISCLAIMER}.`}</p>
          </div>
        </Metrica>
      </section>

      {/* La compulsa es la mitad del producto y no entra en la grilla de
          métricas de arriba: las cuatro de arriba son sobre la documentación,
          esta es sobre la plata. Va en su propia tarjeta, con los dos accesos
          adentro — la comparativa no tiene solapa propia. */}
      <section>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-sm font-semibold text-neutral-900">Compulsas</h2>
              {compulsas.total === 0 ? (
                <Badge tone="neutral">Sin compulsas todavía</Badge>
              ) : (
                <>
                  {compulsas.enCurso > 0 ? (
                    <Badge tone="info">
                      {plural(compulsas.enCurso, 'en curso', 'en curso')}
                    </Badge>
                  ) : null}
                  {compulsas.adjudicadas > 0 ? (
                    <Badge tone="ok">
                      {plural(compulsas.adjudicadas, 'adjudicada', 'adjudicadas')}
                    </Badge>
                  ) : null}
                </>
              )}
              <span className="ml-auto flex flex-wrap gap-3">
                <Link
                  href={`${base}/compulsas`}
                  className="text-xs font-medium text-neutral-900 underline"
                >
                  Ver compulsas
                </Link>
                <Link
                  href={`${base}/comparativa`}
                  className="text-xs font-medium text-neutral-900 underline"
                >
                  Ir a la comparativa
                </Link>
              </span>
            </div>

            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                  En curso
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
                  {compulsas.total === 0 ? '—' : compulsas.enCurso}
                </dd>
                <dd className="text-xs text-neutral-500">
                  {compulsas.total === 0
                    ? 'Se lanzan desde un rubro aprobado del cómputo.'
                    : `Sobre ${plural(compulsas.total, 'compulsa', 'compulsas')} de la obra.`}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                  Cotizaciones recibidas
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
                  {compulsas.total === 0 ? '—' : compulsas.cotizaciones}
                </dd>
                <dd className="text-xs text-neutral-500">
                  Presupuestos cargados, listos para comparar.
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                  Ahorro acumulado
                </dt>
                {/* Sin ninguna adjudicada no hay ahorro que medir: un "$ 0" se
                    leería como "no ahorramos nada" en vez de "todavía no hay
                    contra qué medir". */}
                <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
                  {compulsas.adjudicadas === 0
                    ? '—'
                    : `${obra.moneda === 'ARS' ? '$' : obra.moneda} ${formatearImporte(compulsas.ahorro)}`}
                </dd>
                <dd className="text-xs text-neutral-500">
                  {compulsas.adjudicadas === 0
                    ? 'Sale al adjudicar: mediana de las ofertas menos lo adjudicado, más lo que se negoció.'
                    : 'Mediana de las ofertas menos lo adjudicado, más las mejoras de negociación.'}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </section>

      {sinDocumentacion ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-2 py-8">
            <p className="text-sm font-medium text-neutral-900">Esta obra todavía está vacía.</p>
            <p className="text-sm text-neutral-600">
              Subí la documentación —plantas, cortes, vistas, planillas— y el análisis arranca solo.
            </p>
            <Link
              href={`${base}/expediente`}
              className="text-sm font-medium text-neutral-900 underline"
            >
              Ir al expediente
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-sm font-semibold text-neutral-900">Cómputo por rubro</h2>
          <Badge tone={rubrosAprobados === RUBROS.length ? 'ok' : 'neutral'}>
            {rubrosAprobados} de {RUBROS.length} rubros aprobados
          </Badge>
          <p className="ml-auto text-xs text-neutral-500">
            El % con fuente es la porción de ítems activos que cita al menos una lámina.
          </p>
        </div>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Rubro</TableHeaderCell>
              <TableHeaderCell numeric>Ítems activos</TableHeaderCell>
              <TableHeaderCell>Estado</TableHeaderCell>
              <TableHeaderCell numeric>% con fuente</TableHeaderCell>
              <TableHeaderCell>Exportar</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filasRubro.map((fila) => (
              <TableRow key={fila.rubro}>
                <TableCell>
                  <Link href={`${base}/computo?rubro=${fila.rubro}`} className="underline">
                    {fila.nombre}
                  </Link>
                </TableCell>
                <TableCell numeric>{fila.items === 0 ? '—' : fila.items}</TableCell>
                <TableCell>
                  <Badge tone={TONO_ESTADO_RUBRO[fila.estado]}>
                    {ETIQUETA_ESTADO_RUBRO[fila.estado]}
                  </Badge>
                </TableCell>
                <TableCell numeric>
                  {fila.provenancePct === null ? '—' : `${fila.provenancePct}%`}
                </TableCell>
                <TableCell>
                  {fila.items === 0 ? (
                    <span className="text-neutral-400">—</span>
                  ) : (
                    <a
                      href={`/api/obras/${obra.id}/export?rubro=${fila.rubro}`}
                      className="underline"
                    >
                      XLSX
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-900">Accesos rápidos</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Acceso
            href={`${base}/expediente`}
            titulo="Expediente"
            detalle="Subí los PDF, mirá cómo quedaron clasificadas las láminas y su estado."
          />
          <Acceso
            href={primeraLamina ? `${base}/laminas/${primeraLamina}` : null}
            titulo="Visor de láminas"
            detalle={
              primeraLamina
                ? 'Plano con las entidades detectadas y sus consultas encima.'
                : 'Se abre cuando haya al menos una lámina en el expediente.'
            }
          />
          <Acceso
            href={`${base}/computo`}
            titulo="Planilla de cómputo"
            detalle="Cantidad neta, desperdicio y cantidad de compra, rubro por rubro."
          />
          <Acceso
            href={`${base}/bandeja`}
            titulo="Bandeja de consultas"
            detalle="Lo que el sistema no pudo resolver solo, para responder de a un clic."
          />
        </div>
      </section>

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
              <dt className="text-neutral-500">Documentos</dt>
              <dd className="text-neutral-900 tabular-nums">{docs.total}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">Cómo leer el cómputo</h2>
            <p className="text-sm text-neutral-600">
              La cantidad neta es lo que la obra necesita; la cantidad de compra ya incluye el
              desperdicio y está redondeada hacia arriba a la presentación comercial. Cada ítem cita la
              lámina de la que salió: lo que no está en la documentación no se inventa, se pregunta
              en la bandeja.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
