/**
 * Bandeja de consultas de la obra (PRD §8): todo lo que el sistema no pudo
 * resolver solo, agrupado por rubro y accionable de un click.
 *
 * Server Component (`src/app/CLAUDE.md` §2): lee con `getDb()` y filtra desde
 * la URL —así la vista es compartible y no necesita JavaScript—, y le baja a
 * `BandejaConsultas` solo datos serializables. El contador del header cuenta
 * **todas** las consultas de la obra, no las filtradas: es el estado de la
 * obra, no el de la vista.
 */
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { getDb } from '@/db/client';
import { entidades, hallazgos, laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import { PREFIJO_ESCALA } from '@/lib/pipeline/claves';
import { checklistEfectivoDeTodos, contarBloqueantes } from '@/lib/plataforma/checklists';
import { PLANTILLAS } from '@/lib/rubros/index';
import { RUBROS, type EstadoHallazgo } from '@/types/domain';

import { BandejaConsultas, type ConsultaVista, type GrupoConsultas, type LaminaCitada } from './ui';

/** Qué estados muestra cada filtro. `null` en el mapa ⇒ no filtra. */
const FILTROS = [
  { valor: 'abiertas', etiqueta: 'Abiertas', estado: 'abierto' as EstadoHallazgo | null },
  { valor: 'respondidas', etiqueta: 'Respondidas', estado: 'respondido' as EstadoHallazgo | null },
  { valor: 'descartadas', etiqueta: 'Descartadas', estado: 'descartado' as EstadoHallazgo | null },
  { valor: 'todas', etiqueta: 'Todas', estado: null },
] as const;

type ValorFiltro = (typeof FILTROS)[number]['valor'];

interface Vista {
  filtro: ValorFiltro;
  soloBloqueantes: boolean;
}

function enlace(obraId: string, vista: Vista): string {
  const query = new URLSearchParams({ estado: vista.filtro });
  if (vista.soloBloqueantes) query.set('bloqueantes', '1');
  return `/obras/${obraId}/bandeja?${query.toString()}`;
}

function primerParametro(valor: string | string[] | undefined): string | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}

function esFiltro(valor: string | null): valor is ValorFiltro {
  return valor !== null && FILTROS.some((filtro) => filtro.valor === valor);
}

/** Chip de filtro: el estado de la vista viaja en la URL, no en el cliente. */
function Chip({ href, activo, children }: { href: string; activo: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={activo ? 'true' : undefined}
      className={[
        'inline-flex items-center rounded-full border px-3 py-1 text-sm transition-colors',
        activo
          ? 'border-neutral-900 bg-neutral-900 text-white'
          : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100',
      ].join(' ')}
    >
      {children}
    </Link>
  );
}

/** "A-01 · PLANTA PB", o el número de página si la lámina no tiene rótulo leído. */
function etiquetaDeLamina(fila: { codigo: string | null; titulo: string | null; numeroPagina: number }): string {
  const cabeza = fila.codigo ?? `Página ${fila.numeroPagina}`;
  return fila.titulo ? `${cabeza} · ${fila.titulo}` : cabeza;
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export const metadata: Metadata = { title: 'Bandeja de consultas' };

export default async function BandejaPage({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ obraId }, query] = await Promise.all([params, searchParams]);
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [filas, planos, elementos, checklist] = await Promise.all([
    db.select().from(hallazgos).where(eq(hallazgos.obraId, obra.id)).orderBy(hallazgos.clave),
    db
      .select({
        id: laminas.id,
        codigo: laminas.codigo,
        titulo: laminas.titulo,
        numeroPagina: laminas.numeroPagina,
      })
      .from(laminas)
      .where(eq(laminas.obraId, obra.id)),
    db
      .select({ id: entidades.id, tipo: entidades.tipo, nombre: entidades.nombre })
      .from(entidades)
      .where(eq(entidades.obraId, obra.id)),
    checklistEfectivoDeTodos(db, obra.estudioId),
  ]);

  const etiquetaLamina = new Map(planos.map((fila) => [fila.id, etiquetaDeLamina(fila)]));
  const nombreEntidad = new Map(
    elementos.map((fila) => [fila.id, `${capitalizar(fila.tipo)} ${fila.nombre}`]),
  );

  const abiertas = filas.filter((fila) => fila.estado === 'abierto');
  // El contador tiene que decir lo mismo que el gate: un ítem de checklist que
  // el estudio desactivó (o marcó no bloqueante) deja de frenar la aprobación,
  // aunque la fila siga guardada con `bloqueante = true` y siga en la bandeja.
  const bloqueantes = contarBloqueantes(abiertas, checklist);

  const pedido = primerParametro(query.estado);
  const filtro: ValorFiltro = esFiltro(pedido) ? pedido : 'abiertas';
  const soloBloqueantes = primerParametro(query.bloqueantes) === '1';
  const vista: Vista = { filtro, soloBloqueantes };
  const estado = FILTROS.find((candidato) => candidato.valor === filtro)!.estado;

  const visibles = filas
    .filter((fila) => (estado === null ? true : fila.estado === estado))
    .filter((fila) => (soloBloqueantes ? fila.bloqueante : true));

  const consultas: ConsultaVista[] = visibles.map((fila) => {
    const citadas: LaminaCitada[] = [];
    const vistas = new Set<string>();
    for (const fuente of fila.laminasJson) {
      if (vistas.has(fuente.laminaId)) continue;
      vistas.add(fuente.laminaId);
      const etiqueta = etiquetaLamina.get(fuente.laminaId);
      if (etiqueta) citadas.push({ laminaId: fuente.laminaId, etiqueta });
    }

    return {
      id: fila.id,
      clave: fila.clave,
      tipo: fila.tipo,
      rubro: fila.rubro,
      descripcion: fila.descripcion,
      bloqueante: fila.bloqueante,
      estado: fila.estado,
      campo: fila.targetRef?.campo ?? null,
      entidad: fila.targetRef ? (nombreEntidad.get(fila.targetRef.entidadId) ?? null) : null,
      esEscala: fila.clave.startsWith(PREFIJO_ESCALA),
      laminas: citadas,
      respuesta: fila.respuestaJson,
    };
  });

  // Un grupo por rubro (en el orden canónico) y "Generales" al final: las
  // consultas de obra —sanity checks, escala— no son de ningún rubro.
  const grupos: GrupoConsultas[] = [
    ...RUBROS.map((rubro) => ({
      rubro,
      titulo: PLANTILLAS[rubro].nombre,
      consultas: consultas.filter((consulta) => consulta.rubro === rubro),
    })),
    {
      rubro: null,
      titulo: 'Generales',
      consultas: consultas.filter((consulta) => consulta.rubro === null),
    },
  ].filter((grupo) => grupo.consultas.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-base font-semibold text-neutral-900">
          {abiertas.length === 1 ? '1 consulta abierta' : `${abiertas.length} consultas abiertas`}
          <span className="text-neutral-400"> · </span>
          <span className={bloqueantes > 0 ? 'text-red-700' : 'text-neutral-500'}>
            {bloqueantes === 1 ? '1 bloqueante' : `${bloqueantes} bloqueantes`}
          </span>
        </h1>
        <p className="text-sm text-neutral-600">
          Una consulta bloqueante frena la aprobación hasta que la respondas o la descartes: las de
          un rubro frenan ese rubro, y las generales —una lámina sin escala— los frenan a todos.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Estado</span>
        {FILTROS.map((candidato) => (
          <Chip
            key={candidato.valor}
            href={enlace(obra.id, { ...vista, filtro: candidato.valor })}
            activo={filtro === candidato.valor}
          >
            {candidato.etiqueta}
          </Chip>
        ))}
        <span className="ml-2">
          <Chip
            href={enlace(obra.id, { ...vista, soloBloqueantes: !soloBloqueantes })}
            activo={soloBloqueantes}
          >
            {soloBloqueantes ? 'Ver todas' : 'Solo bloqueantes'}
          </Chip>
        </span>
      </div>

      <BandejaConsultas obraId={obra.id} grupos={grupos} />
    </div>
  );
}
