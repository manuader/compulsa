import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button, estilosBoton } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { getDb } from '@/db/client';
import { auditoria, obras, usuarios } from '@/db/schema';
import { esUuid, requireUser } from '@/lib/auth/guards';
import { esRolSuficiente } from '@/lib/plataforma/roles';

import { SinPermiso } from '../ui';

import { detalle, objeto } from './detalle';
import { frase } from './frases';

export const metadata: Metadata = { title: 'Auditoría' };

/** Filas por página. El cursor es `(at, id)`, no un offset: ver `condicionCursor`. */
const POR_PAGINA = 50;

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});


/**
 * Keyset por `(at, id)`, no `OFFSET`.
 *
 * Con `OFFSET` una fila nueva escrita mientras alguien pagina corre todo un
 * lugar y la página siguiente repite una fila y se saltea otra. Con el cursor
 * en el último `(at, id)` mostrado, la página siguiente es siempre "lo que
 * sigue", pase lo que pase adelante. El `id` desempata: dos filas escritas en el
 * mismo microsegundo con solo `at <` se perderían.
 */
function condicionCursor(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const [iso, id] = cursor.split('|');
  if (!iso || !id || !esUuid(id)) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;

  return or(lt(auditoria.at, at), and(eq(auditoria.at, at), lt(auditoria.id, id)));
}

/** Miles con punto: `1.284.503`. Es un conteo, no plata (`formatearImporte` es para plata). */
function contar(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Lo que gastó en tokens una obra, sumando **todas** las llamadas al modelo.
 *
 * RNF-7 pide que el costo se mida y se vea. Medido estaba: los seis proveedores
 * escriben `obra_id` y los cuatro campos de tokens en su fila de auditoría.
 * Verse, no se veía en ningún lado — y la columna «Detalle» tampoco ayudaba,
 * porque cortaba a tres campos por el orden que devolvía `jsonb` y
 * `tokensEntrada` casi nunca entraba.
 *
 * Se cuentan **tokens y llamadas, no pesos**: el precio por token depende del
 * modelo y de la fecha, y nada de eso está guardado. Poner un peso acá sería
 * inventarlo, que es exactamente lo que el producto no hace (P4).
 */
interface GastoDeObra {
  obraId: string | null;
  llamadas: number;
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
}

interface Props {
  searchParams: Promise<{ obra?: string; cursor?: string }>;
}

/**
 * Auditoría del estudio: todo lo que se hizo, con quién y cuándo.
 *
 * Es de titular. La pantalla no ofrece "borrar" nada: la auditoría es de solo
 * lectura por definición (`src/db/CLAUDE.md` §7).
 *
 * ## Cómo se acota al estudio
 *
 * `auditoria` no tiene `estudio_id`: las filas de obra se acotan por su obra, y
 * las filas **sin obra** (alta de invitación, configuración, la fila que
 * sobrevive a `obra_eliminada`) se acotan por el mail del actor, que es único
 * por usuario. Es exacto para todo lo que escribe una persona, que es todo lo
 * que hoy se audita sin obra. Una columna `estudio_id` en `auditoria` lo haría
 * directo y dejaría de depender de que el actor sea una persona; queda como
 * tarea futura, con su migración.
 */
export default async function AuditoriaPage({ searchParams }: Props) {
  const { usuario, estudio } = await requireUser();
  if (!esRolSuficiente(usuario, 'titular')) {
    return <SinPermiso que="ver la auditoría del estudio" minimo="titular" />;
  }

  const { obra: obraFiltro, cursor } = await searchParams;
  const db = await getDb();

  const [obrasDelEstudio, equipo] = await Promise.all([
    db
      .select({ id: obras.id, nombre: obras.nombre })
      .from(obras)
      .where(eq(obras.estudioId, estudio.id))
      .orderBy(obras.nombre),
    db.select({ email: usuarios.email }).from(usuarios).where(eq(usuarios.estudioId, estudio.id)),
  ]);

  const obraElegida =
    obraFiltro && obrasDelEstudio.some((obra) => obra.id === obraFiltro) ? obraFiltro : undefined;
  const idsDeObras = obrasDelEstudio.map((obra) => obra.id);
  const mails = equipo.map((miembro) => miembro.email);

  // `or()` sin condiciones devuelve `undefined`, que en el `where` significa
  // "sin filtro" — o sea, la auditoría de TODOS los estudios. No puede pasar
  // (el usuario de la sesión ya es un mail del estudio), pero un alcance que
  // falla abierto no es algo que se deje librado a que no pueda pasar.
  const alcance: SQL | undefined = obraElegida
    ? eq(auditoria.obraId, obraElegida)
    : or(
        idsDeObras.length > 0 ? inArray(auditoria.obraId, idsDeObras) : undefined,
        mails.length > 0
          ? and(isNull(auditoria.obraId), inArray(auditoria.actorNombre, mails))
          : undefined,
      ) ?? sql`false`;

  // El gasto en modelo por obra: una sola pasada agregada sobre las filas
  // `*_llm`, con el MISMO alcance que la tabla de abajo. Los `->>` devuelven
  // texto —la columna es `jsonb`— y el `::bigint` los suma; una fila sin el
  // campo suma cero, que es lo correcto para las llamadas viejas.
  const numero = (campo: string) =>
    sql<number>`coalesce(sum((${auditoria.diffJson} ->> ${campo})::bigint), 0)`.mapWith(Number);

  const gastos: GastoDeObra[] = await db
    .select({
      obraId: auditoria.obraId,
      llamadas: sql<number>`count(*)`.mapWith(Number),
      entrada: numero('tokensEntrada'),
      salida: numero('tokensSalida'),
      cacheLectura: numero('tokensCacheLectura'),
      cacheEscritura: numero('tokensCacheEscritura'),
    })
    .from(auditoria)
    // Por sufijo y no por una lista de acciones: el día que aparezca una
    // familia nueva de llamadas al modelo, su costo se cuenta solo. `like` con
    // un guion bajo pediría escaparlo, que es una trampa que no hace falta.
    .where(and(alcance, sql`right(${auditoria.accion}, 4) = '_llm'`))
    .groupBy(auditoria.obraId)
    .orderBy(auditoria.obraId);

  const totalTokens = gastos.reduce(
    (suma, gasto) => suma + gasto.entrada + gasto.salida + gasto.cacheLectura + gasto.cacheEscritura,
    0,
  );

  // Se piden 51 para saber si hay página siguiente sin contar la tabla entera.
  const filas = await db
    .select({
      id: auditoria.id,
      at: auditoria.at,
      actorTipo: auditoria.actorTipo,
      actorNombre: auditoria.actorNombre,
      accion: auditoria.accion,
      targetRef: auditoria.targetRef,
      diffJson: auditoria.diffJson,
      obraId: auditoria.obraId,
    })
    .from(auditoria)
    .where(and(alcance, condicionCursor(cursor)))
    .orderBy(desc(auditoria.at), desc(auditoria.id))
    .limit(POR_PAGINA + 1);

  const pagina = filas.slice(0, POR_PAGINA);
  const hayMas = filas.length > POR_PAGINA;
  const ultima = pagina[pagina.length - 1];
  const nombreDeObra = new Map(obrasDelEstudio.map((obra) => [obra.id, obra.nombre]));

  const siguiente = new URLSearchParams();
  if (obraElegida) siguiente.set('obra', obraElegida);
  if (ultima) siguiente.set('cursor', `${ultima.at.toISOString()}|${ultima.id}`);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link href="/estudio" className="text-sm text-neutral-600 underline">
          ← Estudio
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          Auditoría de {estudio.nombre}
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Toda escritura del sistema y de las personas deja rastro acá. No se edita ni se borra.
        </p>
      </header>

      {/* RNF-7: el costo del análisis, medido y **a la vista**. Va arriba de la
          tabla porque es la pregunta que se le hace a esta pantalla antes que
          «qué pasó»: cuánto salió analizar esta obra. */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">Consumo de modelo</h2>
            <p className="text-sm text-neutral-600 tabular-nums">
              {totalTokens === 0
                ? 'Todavía no se llamó al modelo en el alcance elegido.'
                : `${contar(totalTokens)} tokens en total`}
            </p>
          </div>

          {totalTokens === 0 ? null : (
            <>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Obra</TableHeaderCell>
                    <TableHeaderCell numeric>Llamadas</TableHeaderCell>
                    <TableHeaderCell numeric>Entrada</TableHeaderCell>
                    <TableHeaderCell numeric>Salida</TableHeaderCell>
                    <TableHeaderCell numeric>Caché leído</TableHeaderCell>
                    <TableHeaderCell numeric>Caché escrito</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {gastos.map((gasto) => (
                    <TableRow key={gasto.obraId ?? 'sin-obra'}>
                      <TableCell>
                        {gasto.obraId === null
                          ? 'Sin obra'
                          : (nombreDeObra.get(gasto.obraId) ?? 'obra eliminada')}
                      </TableCell>
                      <TableCell numeric>{contar(gasto.llamadas)}</TableCell>
                      <TableCell numeric className="font-medium">
                        {contar(gasto.entrada)}
                      </TableCell>
                      <TableCell numeric>{contar(gasto.salida)}</TableCell>
                      <TableCell numeric>{contar(gasto.cacheLectura)}</TableCell>
                      <TableCell numeric>{contar(gasto.cacheEscritura)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* Tokens y no pesos, y se dice por qué: el precio depende del
                  modelo y de la fecha, y eso no está guardado en ningún lado.
                  Un número en pesos acá sería inventado. */}
              <p className="text-xs text-neutral-500">
                Cuenta todas las llamadas al modelo: inventario, análisis de láminas, cruce del
                expediente, búsqueda dirigida, Q&amp;A y lectura de presupuestos. Son tokens, no
                pesos: el precio por token depende del modelo y de la
                fecha, y eso no se guarda. La entrada es la que manda en la factura.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Un GET normal: el filtro tiene que sobrevivir a un F5 y a un link compartido. */}
          <form method="get" className="flex items-end gap-3">
            <div className="w-72">
              <Select label="Obra" name="obra" defaultValue={obraElegida ?? ''}>
                <option value="">Todas (más lo que no es de una obra)</option>
                {obrasDelEstudio.map((obra) => (
                  <option key={obra.id} value={obra.id}>
                    {obra.nombre}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              Filtrar
            </Button>
          </form>

          {pagina.length === 0 ? (
            <p className="text-sm text-neutral-600">
              {cursor ? 'No hay más registros.' : 'Todavía no hay nada registrado.'}
            </p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Fecha</TableHeaderCell>
                  <TableHeaderCell>Actor</TableHeaderCell>
                  <TableHeaderCell>Acción</TableHeaderCell>
                  <TableHeaderCell>Objeto</TableHeaderCell>
                  <TableHeaderCell>Detalle</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pagina.map((fila) => (
                  <TableRow key={fila.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {FECHA.format(fila.at)}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Badge tone={fila.actorTipo === 'usuario' ? 'info' : 'neutral'}>
                          {fila.actorTipo === 'usuario' ? 'persona' : 'agente'}
                        </Badge>
                        {fila.actorNombre}
                      </span>
                    </TableCell>
                    <TableCell>{frase(fila.accion)}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{objeto(fila.targetRef)}</span>
                      {fila.obraId && !obraElegida ? (
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          {nombreDeObra.get(fila.obraId) ?? 'obra eliminada'}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-neutral-600">{detalle(fila.diffJson)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-600">
              {pagina.length} registro{pagina.length === 1 ? '' : 's'} en esta página
            </span>
            <div className="flex gap-2">
              {cursor ? (
                <Link
                  href={obraElegida ? `/estudio/auditoria?obra=${obraElegida}` : '/estudio/auditoria'}
                  className={estilosBoton('secondary', 'sm')}
                >
                  Volver al principio
                </Link>
              ) : null}
              {hayMas ? (
                <Link
                  href={`/estudio/auditoria?${siguiente.toString()}`}
                  className={estilosBoton('primary', 'sm')}
                >
                  Más viejas →
                </Link>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
