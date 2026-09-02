/**
 * Bandeja de la obra (PRD §8 + §5.8 del diseño), en dos solapas.
 *
 * De compuerta a revisión: hasta acá la bandeja era una sola lista donde todo
 * pesaba lo mismo, y desde que lo deducido entra solo al cómputo (§5.4) eso ya
 * no alcanza. Ahora hay dos cosas distintas y se ven distintas:
 *
 *  - **Preguntas** — las consultas abiertas: lo único que espera algo del
 *    arquitecto. Un dato que falta, un conflicto entre láminas, una escala sin
 *    confirmar. Es lo que frena la aprobación de un rubro (RF-404).
 *  - **Para revisar** — lo que el sistema ya aplicó: deducciones que se validaron
 *    solas e ítems computados con medidas del dibujo, con su fuente y su método
 *    y un botón para rechazarlas. Informa; **no bloquea nada**.
 *
 * La solapa viaja en la URL (`?solapa=revisar`) como el resto de los filtros:
 * así la vista es compartible, no necesita JavaScript, y `/obras/[obraId]/deducciones`
 * puede redirigir acá conservando su deep-link (`?regla=`).
 *
 * Server Component (`src/app/CLAUDE.md` §2): lee con `getDb()`, filtra desde la
 * URL y le baja a `BandejaConsultas` solo datos serializables. El contador del
 * header cuenta **todas** las consultas de la obra, no las filtradas: es el
 * estado de la obra, no el de la vista.
 */
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { getDb } from '@/db/client';
import { entidades, hallazgos, laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import { formatearNumero } from '@/lib/computo/unidades';
import { camposDelTarget } from '@/lib/hallazgos/target';
import { CAMPO_DATO_OBRA, etiquetaDeDatoObra } from '@/lib/hallazgos/taxonomia';
import { PREFIJO_ESCALA } from '@/lib/pipeline/claves';
import {
  checklistEfectivoDeTodos,
  contarBloqueantes,
  esBloqueanteEfectivo,
} from '@/lib/plataforma/checklists';
import { PLANTILLAS } from '@/lib/rubros/index';
import { RUBROS, type EstadoHallazgo } from '@/types/domain';

import { esRegla, SolapaRevisar } from './revisar';
import {
  BandejaConsultas,
  fuentesDeAfectadas,
  type ConsultaVista,
  type FuenteVista,
  type GrupoConsultas,
  type LaminaCitada,
} from './ui';

/** Qué estados muestra cada filtro. `null` en el mapa ⇒ no filtra. */
const FILTROS = [
  { valor: 'abiertas', etiqueta: 'Abiertas', estado: 'abierto' as EstadoHallazgo | null },
  { valor: 'respondidas', etiqueta: 'Respondidas', estado: 'respondido' as EstadoHallazgo | null },
  { valor: 'descartadas', etiqueta: 'Descartadas', estado: 'descartado' as EstadoHallazgo | null },
  { valor: 'todas', etiqueta: 'Todas', estado: null },
] as const;

type ValorFiltro = (typeof FILTROS)[number]['valor'];

/**
 * Las dos solapas del §5.8. La de por defecto es la que pide algo.
 *
 * Sin `export`: un `page.tsx` solo puede exportar el componente por defecto y
 * las opciones de segmento (CLAUDE.md §9, misma familia que un `route.ts`).
 */
const SOLAPAS = [
  { valor: 'preguntas', etiqueta: 'Preguntas' },
  { valor: 'revisar', etiqueta: 'Para revisar' },
] as const;

type ValorSolapa = (typeof SOLAPAS)[number]['valor'];

interface Vista {
  filtro: ValorFiltro;
  soloBloqueantes: boolean;
}

function enlace(obraId: string, vista: Vista): string {
  const query = new URLSearchParams({ estado: vista.filtro });
  if (vista.soloBloqueantes) query.set('bloqueantes', '1');
  // Los chips de estado son de «Preguntas»: no llevan `solapa` porque es la de
  // por defecto, y sumarla a cada link solo alargaría la URL que se comparte.
  return `/obras/${obraId}/bandeja?${query.toString()}`;
}

function esSolapa(valor: string | null): valor is ValorSolapa {
  return valor !== null && SOLAPAS.some((solapa) => solapa.valor === valor);
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

/**
 * El valor propuesto, listo para entrar en un input.
 *
 * Se formatea acá, en el server, porque la pantalla es cliente y el
 * `toString()` de JS escribe "0.9": el arquitecto tiene que ver "0,90" y
 * poder corregirlo sin traducir de un formato a otro (`src/app/CLAUDE.md`).
 * Los enteros van sin decimales ("2 caras", no "2,00 caras"); el resto con dos,
 * que es como se escribe una medida en un plano.
 */
function valorParaInput(valor: number | string): string {
  if (typeof valor === 'string') return valor;
  return Number.isInteger(valor) ? formatearNumero(valor) : formatearNumero(valor, 2);
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
      .select({
        id: entidades.id,
        tipo: entidades.tipo,
        nombre: entidades.nombre,
        // Para el split view de una consulta de dato de obra: el hallazgo nace
        // sin fuentes (el hecho no se leyó en ninguna lámina) y lo que hay para
        // mirar es dónde está dibujado cada afectado.
        fuentes: entidades.fuentesJson,
      })
      .from(entidades)
      .where(eq(entidades.obraId, obra.id)),
    checklistEfectivoDeTodos(db, obra.estudioId),
  ]);

  const etiquetaLamina = new Map(planos.map((fila) => [fila.id, etiquetaDeLamina(fila)]));
  // Para la leyenda de la propuesta alcanza el código ("DET00"): el título
  // entero adentro de "propuesto por la búsqueda en …" tapa el dato propuesto.
  const codigoLamina = new Map(
    planos.map((fila) => [fila.id, fila.codigo ?? `Página ${fila.numeroPagina}`]),
  );
  const nombreEntidad = new Map(
    elementos.map((fila) => [fila.id, `${capitalizar(fila.tipo)} ${fila.nombre}`]),
  );
  const fuentesEntidad = new Map<string, FuenteVista[]>(
    elementos.map((fila) => [
      fila.id,
      fila.fuentes.map((fuente) => ({ laminaId: fuente.laminaId, bbox: fuente.bbox })),
    ]),
  );

  const abiertas = filas.filter((fila) => fila.estado === 'abierto');
  // El contador tiene que decir lo mismo que el gate: un ítem de checklist que
  // el estudio desactivó (o marcó no bloqueante) deja de frenar la aprobación,
  // aunque la fila siga guardada con `bloqueante = true` y siga en la bandeja.
  const bloqueantes = contarBloqueantes(abiertas, checklist);

  const solapaPedida = primerParametro(query.solapa);
  const solapa: ValorSolapa = esSolapa(solapaPedida) ? solapaPedida : 'preguntas';
  const reglaPedida = primerParametro(query.regla);
  const regla = esRegla(reglaPedida) ? reglaPedida : null;

  const pedido = primerParametro(query.estado);
  const filtro: ValorFiltro = esFiltro(pedido) ? pedido : 'abiertas';
  const soloBloqueantes = primerParametro(query.bloqueantes) === '1';
  const vista: Vista = { filtro, soloBloqueantes };
  const estado = FILTROS.find((candidato) => candidato.valor === filtro)!.estado;

  const visibles = filas
    .filter((fila) => (estado === null ? true : fila.estado === estado))
    // El mismo ajuste que el contador, y por el mismo motivo: con el
    // `bloqueante` crudo de la fila, un estudio que desactivó un chequeo veía
    // «0 bloqueantes» en el encabezado y la consulta seguía apareciendo al
    // filtrar por bloqueantes.
    .filter((fila) => (soloBloqueantes ? esBloqueanteEfectivo(fila, checklist) : true));

  const consultas: ConsultaVista[] = visibles.map((fila) => {
    const citadas: LaminaCitada[] = [];
    const vistas = new Set<string>();
    for (const fuente of fila.laminasJson) {
      if (vistas.has(fuente.laminaId)) continue;
      vistas.add(fuente.laminaId);
      const etiqueta = etiquetaLamina.get(fuente.laminaId);
      if (etiqueta) citadas.push({ laminaId: fuente.laminaId, etiqueta });
    }

    const campos = camposDelTarget(fila.targetRef);
    const propuesta = fila.valorPropuestoJson;
    const fuentePropuesta = propuesta?.fuente ?? null;

    // Una consulta de dato de obra (§5.2) no apunta a ninguna entidad: nombra un
    // hecho y a quiénes afecta. De los afectados salen las fuentes que el panel
    // resalta —el hallazgo no tiene ninguna propia, y con razón (P1)— y de la
    // clave sale el nombre del input.
    const dato = fila.targetDato;
    const fuentesAfectadas = dato === null ? [] : fuentesDeAfectadas(dato.entidades, fuentesEntidad);
    const fuentesPropias: FuenteVista[] = fila.laminasJson.map((f) => ({
      laminaId: f.laminaId,
      bbox: f.bbox,
    }));
    const fuentes = dato === null ? fuentesPropias : [...fuentesPropias, ...fuentesAfectadas];
    const laminasDeAfectadas: LaminaCitada[] = [];
    for (const fuente of fuentesAfectadas) {
      if (vistas.has(fuente.laminaId)) continue;
      vistas.add(fuente.laminaId);
      const etiqueta = etiquetaLamina.get(fuente.laminaId);
      if (etiqueta) laminasDeAfectadas.push({ laminaId: fuente.laminaId, etiqueta });
    }

    return {
      id: fila.id,
      clave: fila.clave,
      tipo: fila.tipo,
      rubro: fila.rubro,
      descripcion: fila.descripcion,
      bloqueante: fila.bloqueante,
      estado: fila.estado,
      campos,
      campo: campos[0] ?? null,
      entidad: fila.targetRef ? (nombreEntidad.get(fila.targetRef.entidadId) ?? null) : null,
      esEscala: fila.clave.startsWith(PREFIJO_ESCALA),
      datoObra:
        dato === null
          ? null
          : {
              clave: dato.clave,
              etiqueta: etiquetaDeDatoObra(dato.clave),
              unidad: dato.unidad ?? null,
              campo: CAMPO_DATO_OBRA,
              afectadas: dato.entidades.length,
            },
      laminas: [...citadas, ...laminasDeAfectadas],
      // Con bbox: es lo que el visor necesita para resaltar de qué está
      // hablando la consulta sin que el arquitecto tenga que buscarlo.
      fuentes,
      valorPropuesto: propuesta
        ? {
            valores: Object.fromEntries(
              Object.entries(propuesta.valores).map(([campo, valor]) => [
                campo,
                valorParaInput(valor),
              ]),
            ),
            origen: propuesta.origen,
            confianza: propuesta.confianza ?? null,
            fuente:
              fuentePropuesta === null
                ? null
                : {
                    laminaId: fuentePropuesta.laminaId,
                    etiqueta: codigoLamina.get(fuentePropuesta.laminaId) ?? 'la documentación',
                    bbox: fuentePropuesta.bbox,
                  },
          }
        : null,
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

  // Las solapas van arriba de todo y en las dos vistas: son la navegación de la
  // pantalla, no un filtro de una de ellas. El link de «Para revisar» conserva
  // la regla del deep-link con el que se puede haber llegado desde /deducciones.
  const solapas = (
    <nav className="flex flex-wrap items-center gap-2 border-b border-neutral-200 pb-2">
      {SOLAPAS.map((candidata) => {
        const query = new URLSearchParams({ solapa: candidata.valor });
        if (candidata.valor === 'revisar' && regla !== null) query.set('regla', regla);
        const activa = solapa === candidata.valor;
        return (
          <Link
            key={candidata.valor}
            href={`/obras/${obra.id}/bandeja?${query.toString()}`}
            aria-current={activa ? 'page' : undefined}
            className={[
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              activa
                ? 'bg-neutral-900 text-white'
                : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
            ].join(' ')}
          >
            {candidata.etiqueta}
          </Link>
        );
      })}
    </nav>
  );

  if (solapa === 'revisar') {
    return (
      <div className="flex flex-col gap-4">
        {solapas}
        <h1 className="text-base font-semibold text-neutral-900">Para revisar</h1>
        <SolapaRevisar
          obraId={obra.id}
          regla={regla}
          enlace={(candidata) =>
            candidata === null
              ? `/obras/${obra.id}/bandeja?solapa=revisar`
              : `/obras/${obra.id}/bandeja?solapa=revisar&regla=${candidata}`
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {solapas}
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
