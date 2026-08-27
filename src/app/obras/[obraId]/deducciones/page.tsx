/**
 * Bandeja de deducciones de la obra (PRD §11, Checkpoint A): lo que el motor de
 * reglas pudo armar cruzando dos láminas y espera que una persona confirme.
 *
 * Server Component (`src/app/CLAUDE.md` §2): lee con `getDb()`, filtra desde la
 * URL —la vista es compartible y no necesita JavaScript— y le baja a
 * `BandejaDeducciones` solo datos serializables. El contador del encabezado
 * cuenta **todas** las propuestas de la obra, no las filtradas: es el estado de
 * la obra, no el de la vista.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { deducciones, entidades, hallazgos, laminas } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import { describirValor, etiquetaCampo, PRIORIDAD_REGLAS } from '@/lib/deduccion/motor';
import { TITULO_REGLA } from '@/lib/deduccion/memoria';
import {
  estaContradicha,
  explicarDeduccion,
  valorDeDeduccion,
  valorQueDocumenta,
} from '@/lib/deduccion/persistencia';
import { esClaveDeDeduccion } from '@/lib/pipeline/claves';
import type { ReglaDeduccion } from '@/types/domain';

import {
  BandejaDeducciones,
  type DeduccionVista,
  type GrupoElemento,
  type LaminaCitada,
  type VistaEnLamina,
} from './ui';

export const metadata: Metadata = { title: 'Deducciones' };

/** "A-01 · PLANTA PB", o el número de página si el rótulo no se pudo leer. */
function etiquetaDeLamina(fila: {
  codigo: string | null;
  titulo: string | null;
  numeroPagina: number;
}): string {
  const cabeza = fila.codigo ?? `Página ${fila.numeroPagina}`;
  return fila.titulo ? `${cabeza} · ${fila.titulo}` : cabeza;
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function primerParametro(valor: string | string[] | undefined): string | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}

function esRegla(valor: string | null): valor is ReglaDeduccion {
  return valor !== null && (PRIORIDAD_REGLAS as readonly string[]).includes(valor);
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

export default async function DeduccionesPage({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ obraId }, query] = await Promise.all([params, searchParams]);
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [decididas, planos, elementos, inconsistencias] = await Promise.all([
    db
      .select()
      .from(deducciones)
      .where(and(eq(deducciones.obraId, obra.id), inArray(deducciones.estado, ['propuesta', 'validada'])))
      .orderBy(deducciones.campo),
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
        laminaId: entidades.laminaId,
      })
      .from(entidades)
      .where(eq(entidades.obraId, obra.id)),
    db
      .select({ clave: hallazgos.clave })
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obra.id), eq(hallazgos.estado, 'abierto'))),
  ]);

  // Las propuestas son la cola de trabajo; las validadas solo entran a la
  // pantalla cuando la documentación las pasó por encima y hay que revisarlas.
  const filas = decididas.filter((fila) => fila.estado === 'propuesta');
  const superadas = decididas.filter(
    (fila) => fila.estado === 'validada' && estaContradicha(fila),
  );

  const etiquetaLamina = new Map(planos.map((fila) => [fila.id, etiquetaDeLamina(fila)]));
  // Para el "por qué" y las citas alcanza con el código; el título es de la UI.
  const codigos = new Map(planos.map((fila) => [fila.id, fila.codigo ?? `Página ${fila.numeroPagina}`]));
  const porEntidad = new Map(elementos.map((fila) => [fila.id, fila]));

  const pedida = primerParametro(query.regla);
  const regla = esRegla(pedida) ? pedida : null;
  const visibles = regla === null ? filas : filas.filter((fila) => fila.regla === regla);

  // Un grupo por elemento (tipo + nombre), y adentro un bloque por lámina: la
  // simetría de `continuidad` deja de parecer un duplicado. Ver `ui.tsx`.
  const grupos = new Map<string, GrupoElemento>();
  for (const fila of visibles) {
    const entidad = porEntidad.get(fila.entidadId);
    if (!entidad) continue; // la entidad se fue con un reproceso: nada que ofrecer

    const valor = valorDeDeduccion(fila);
    const vista: DeduccionVista = {
      id: fila.id,
      campo: fila.campo,
      etiqueta: etiquetaCampo(fila.campo),
      valor: valor === null ? '—' : describirValor(fila.campo, valor),
      regla: fila.regla,
      tituloRegla: TITULO_REGLA[fila.regla],
      explicacion: explicarDeduccion(fila, codigos),
      confianza: fila.confianza,
      laminas: citar(fila.fuentesJson, etiquetaLamina),
      // Los bbox que sostienen la deducción, para resaltarlos en el panel sin
      // navegar. Es lo mismo que resuelve `?highlight=<deduccionId>` en la
      // página del visor; el panel los filtra por la lámina que está mostrando.
      fuentes: fila.fuentesJson.map((fuente) => ({
        laminaId: fuente.laminaId,
        bbox: fuente.bbox,
      })),
    };

    const claveGrupo = `${entidad.tipo}::${entidad.nombre}`;
    let grupo = grupos.get(claveGrupo);
    if (!grupo) {
      grupo = {
        clave: claveGrupo,
        titulo: `${capitalizar(entidad.tipo)} ${entidad.nombre}`,
        vistas: [],
      };
      grupos.set(claveGrupo, grupo);
    }

    let enLamina = grupo.vistas.find((candidata) => candidata.entidadId === entidad.id);
    if (!enLamina) {
      enLamina = {
        entidadId: entidad.id,
        laminaId: entidad.laminaId,
        lamina: etiquetaLamina.get(entidad.laminaId) ?? 'Lámina sin rótulo',
        deducciones: [],
      };
      grupo.vistas.push(enLamina);
    }
    enLamina.deducciones.push(vista);
  }

  const porRegla = new Map<ReglaDeduccion, number>();
  for (const fila of filas) porRegla.set(fila.regla, (porRegla.get(fila.regla) ?? 0) + 1);
  const contradicciones = inconsistencias.filter((fila) => esClaveDeDeduccion(fila.clave)).length;

  const base = `/obras/${obra.id}`;
  const enlace = (valor: ReglaDeduccion | null): string =>
    valor === null ? `${base}/deducciones` : `${base}/deducciones?regla=${valor}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-base font-semibold text-neutral-900">
          {filas.length === 1 ? '1 deducción propuesta' : `${filas.length} deducciones propuestas`}
        </h1>
        <p className="max-w-2xl text-sm text-neutral-600">
          El sistema no completa un dato solo: cuando dos láminas dicen entre las dos algo que
          ninguna dice sola, lo propone acá con sus fuentes. Validar escribe el dato en el elemento y
          el ítem del cómputo queda marcado <strong className="font-medium">deducido</strong>;
          rechazar lo devuelve a la bandeja de consultas como dato faltante.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Regla</span>
        <Chip href={enlace(null)} activo={regla === null}>
          Todas ({filas.length})
        </Chip>
        {PRIORIDAD_REGLAS.filter((candidata) => (porRegla.get(candidata) ?? 0) > 0).map((candidata) => (
          <Chip key={candidata} href={enlace(candidata)} activo={regla === candidata}>
            {TITULO_REGLA[candidata]} ({porRegla.get(candidata)})
          </Chip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {/* `<a>` y no `<Link>`: son descargas de la API, no navegación. */}
        <a
          href={`/api/obras/${obra.id}/deducciones/memoria`}
          className="font-medium text-neutral-900 underline"
        >
          Bajar la memoria de deducciones (.md)
        </a>
        <a
          href={`/api/obras/${obra.id}/planilla-carpinterias`}
          className="font-medium text-neutral-900 underline"
        >
          Bajar la planilla de carpinterías derivada (.xlsx)
        </a>
        {contradicciones > 0 ? (
          <Link href={`${base}/bandeja`} className="inline-flex items-center gap-1">
            <Badge tone="warn">
              {contradicciones === 1
                ? '1 contradicción entre láminas'
                : `${contradicciones} contradicciones entre láminas`}
            </Badge>
          </Link>
        ) : null}
      </div>

      {/* Deducciones que alguien validó y que la documentación pasó por encima:
          el cómputo ya usa el dato escrito, pero la decisión vieja quedó
          registrada afirmando otra cosa y merece una mirada. La consulta
          `deduccion.contradicha.*` de la bandeja es la que se acciona. */}
      {superadas.length > 0 ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-amber-900">
              {superadas.length === 1
                ? '1 deducción superada por la documentación'
                : `${superadas.length} deducciones superadas por la documentación`}
            </h2>
            <p className="text-xs text-amber-900">
              Se validaron en su momento, pero la lámina pasó a decir otra cosa. Manda lo escrito:
              el cómputo ya usa el dato de la documentación. Están en la bandeja de consultas como
              inconsistencia para que decidas cuál vale.
            </p>
            <ul className="flex flex-col gap-1">
              {superadas.map((fila) => {
                const entidad = porEntidad.get(fila.entidadId);
                const validado = valorDeDeduccion(fila);
                const documentado = valorQueDocumenta(fila);
                return (
                  <li key={fila.id} className="text-sm text-amber-900">
                    <strong className="font-medium">
                      {entidad ? `${capitalizar(entidad.tipo)} ${entidad.nombre}` : 'Elemento'}
                    </strong>{' '}
                    · {etiquetaCampo(fila.campo)}: se validó{' '}
                    {validado === null ? '—' : describirValor(fila.campo, validado)} y la
                    documentación dice{' '}
                    {documentado === null || typeof documentado === 'boolean'
                      ? String(documentado)
                      : describirValor(fila.campo, documentado)}
                    .{' '}
                    {entidad ? (
                      <Link
                        href={`${base}/laminas/${entidad.laminaId}?highlight=${fila.id}`}
                        className="underline"
                      >
                        Ver en la lámina
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <BandejaDeducciones obraId={obra.id} grupos={[...grupos.values()]} filtrada={regla !== null} />
    </div>
  );
}

/** Láminas de las fuentes, sin repetir y en el orden en que sostienen el dato. */
function citar(
  fuentes: readonly { laminaId: string }[],
  etiquetas: ReadonlyMap<string, string>,
): LaminaCitada[] {
  const citadas: LaminaCitada[] = [];
  const vistas = new Set<string>();
  for (const fuente of fuentes) {
    if (vistas.has(fuente.laminaId)) continue;
    vistas.add(fuente.laminaId);
    const etiqueta = etiquetas.get(fuente.laminaId);
    if (etiqueta) citadas.push({ laminaId: fuente.laminaId, etiqueta });
  }
  return citadas;
}
