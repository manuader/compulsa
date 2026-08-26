/**
 * Comparativa de una compulsa (PRD §8.8).
 *
 * Server component: el cuadro, el ranking y las leyendas son datos, no
 * interacción. Lo único que corre en el cliente son el botón de adjudicar —con
 * su confirmación— y el de copiar la orden de compra (`ui.tsx`).
 *
 * ## Cómo se lee el cuadro
 *
 * Filas = ítems del pedido; columnas = proveedores. **La primera columna queda
 * fija** al scrollear en horizontal: con seis proveedores y veinte ítems, un
 * número sin su fila al lado no dice nada. La celda es `precio unitario ×
 * cantidad del pedido`, y lo que no se puede comparar sale `—` con el motivo
 * como `title` (el tooltip del navegador, que no necesita JS).
 *
 * ## Lo que la pantalla no decide
 *
 * El rol. El botón de adjudicar no aparece para un colaborador, pero eso es
 * cortesía: quien lo exige es `adjudicarCompulsa` (`requireAccion`), porque
 * todo `*Action` es un endpoint que se puede invocar sin pasar por acá.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { requireObra, requireUser } from '@/lib/auth/guards';
import { leerComparativa, listarCompulsasDeObra } from '@/lib/compulsa/adjudicar';
import {
  ETIQUETA_MATCH,
  ETIQUETA_VALIDEZ,
  formatearImporte,
  type CeldaComparativa,
  type ColumnaComparativa,
  type EstadoValidez,
} from '@/lib/compulsa/comparativa';
import { ETIQUETA_UNIDAD, formatearNumero } from '@/lib/computo/unidades';
import { MIN_MUESTRAS_BENCHMARK, type ClaseBenchmark } from '@/lib/indice/percentiles';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { PLANTILLAS } from '@/lib/rubros';
import type { EstadoCompulsa } from '@/types/domain';

import { BotonAdjudicar, BotonCopiar } from './ui';

export const metadata: Metadata = { title: 'Comparativa' };

const ETIQUETA_ESTADO_COMPULSA: Record<EstadoCompulsa, string> = {
  borrador: 'Borrador',
  lanzada: 'En curso',
  cerrada: 'Cerrada',
  adjudicada: 'Adjudicada',
};

const TONO_ESTADO_COMPULSA: Record<EstadoCompulsa, BadgeTone> = {
  borrador: 'neutral',
  lanzada: 'info',
  cerrada: 'neutral',
  adjudicada: 'ok',
};

const TONO_VALIDEZ: Record<EstadoValidez, BadgeTone> = {
  vigente: 'ok',
  por_vencer: 'warn',
  vencida: 'error',
  sin_dato: 'neutral',
};

/** El semáforo del benchmark. `sin_datos` no pinta nada: no hubo comparación. */
const CLASE_BENCHMARK: Record<ClaseBenchmark, string> = {
  verde: 'text-emerald-700',
  amarillo: 'text-amber-700',
  rojo: 'text-red-700',
  sin_datos: 'text-neutral-900',
};

const LEYENDA_BENCHMARK: Record<ClaseBenchmark, string> = {
  verde: 'Al nivel del mercado o por debajo (≤ p50 del índice del estudio).',
  amarillo: 'Por encima de la mediana, dentro del rango habitual (≤ p75).',
  rojo: 'Por encima del p75 del índice del estudio.',
  sin_datos: '',
};

function montoDe(n: number | null, moneda: string): string {
  if (n === null) return '—';
  const simbolo = moneda === 'ARS' ? '$' : moneda === 'USD' ? 'US$' : moneda;
  return `${simbolo} ${formatearImporte(n)}`;
}

/** El tooltip de una celda: qué pasó con el match y cómo está contra el índice. */
function tituloCelda(celda: CeldaComparativa): string {
  const partes = [`${ETIQUETA_MATCH[celda.match]}: ${celda.detalle}`];
  if (celda.precioUnitario !== null) {
    partes.push(`Precio unitario: ${formatearImporte(celda.precioUnitario)}.`);
  }
  if (celda.indice) {
    partes.push(
      `Índice del estudio (${celda.indice.mes}, ${celda.indice.n} muestras): p50 ${formatearImporte(celda.indice.p50)}, p75 ${formatearImporte(celda.indice.p75)}. ${LEYENDA_BENCHMARK[celda.benchmark]}`,
    );
  }
  return partes.join(' ');
}

function Columna({ columna }: { columna: ColumnaComparativa }) {
  return (
    <div className="flex min-w-40 flex-col gap-1">
      <span className="font-medium text-neutral-900">{columna.proveedorNombre}</span>
      <span className="flex flex-wrap gap-1">
        <Badge tone={TONO_VALIDEZ[columna.validez]}>
          {columna.validez === 'por_vencer' && columna.diasParaVencer !== null
            ? `Vence en ${columna.diasParaVencer} ${columna.diasParaVencer === 1 ? 'día' : 'días'}`
            : ETIQUETA_VALIDEZ[columna.validez]}
        </Badge>
        {columna.sinTotalDeclarado ? <Badge tone="warn">Sin total</Badge> : null}
        {columna.difiereDelDeclarado ? <Badge tone="warn">Total ≠ cuadro</Badge> : null}
      </span>
    </div>
  );
}

export default async function ComparativaPage({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string }>;
  searchParams: Promise<{ compulsa?: string }>;
}) {
  const { obraId } = await params;
  const { compulsa: pedida } = await searchParams;
  const obra = await requireObra(obraId);
  const { usuario, estudio } = await requireUser();
  const db = await getDb();

  const compulsasObra = await listarCompulsasDeObra(db, estudio.id, obra.id);
  const base = `/obras/${obra.id}`;

  if (compulsasObra.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-2 py-8">
          <p className="text-sm font-medium text-neutral-900">Todavía no hay ninguna compulsa.</p>
          <p className="text-sm text-neutral-600">
            La comparativa se arma con los presupuestos que contestan los proveedores. Empezá
            aprobando un rubro del cómputo y lanzando la compulsa.
          </p>
          <Link href={`${base}/compulsas`} className="text-sm font-medium text-neutral-900 underline">
            Ir a compulsas
          </Link>
        </CardContent>
      </Card>
    );
  }

  // La compulsa del query si existe; si no, la que está en curso; si no, la
  // última. Un `?compulsa=` que no es de esta obra se ignora en vez de romper.
  const elegida =
    compulsasObra.find((c) => c.id === pedida) ??
    compulsasObra.find((c) => c.estado === 'lanzada') ??
    compulsasObra[compulsasObra.length - 1];

  const datos = await leerComparativa(db, estudio.id, elegida.id);
  const { comparativa, ranking, pesos, mepReferencia, adjudicacion } = datos;
  const puestos = new Map(ranking.map((p) => [p.id, p]));
  const puedeAdjudicar = esRolSuficiente(usuario, 'titular');
  const ganadora = adjudicacion
    ? comparativa.columnas.find((c) => c.cotizacionId === adjudicacion.cotizacionId)
    : null;

  const moneda = comparativa.columnas[0]?.moneda ?? obra.moneda;

  return (
    <div className="flex flex-col gap-6">
      {compulsasObra.length > 1 ? (
        <nav aria-label="Compulsas de la obra" className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Compulsa
          </span>
          {compulsasObra.map((compulsa) => {
            const activa = compulsa.id === elegida.id;
            return (
              <Link
                key={compulsa.id}
                href={`${base}/comparativa?compulsa=${compulsa.id}`}
                aria-current={activa ? 'page' : undefined}
                className={[
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors',
                  activa
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400',
                ].join(' ')}
              >
                {PLANTILLAS[compulsa.rubro].nombre} · v{compulsa.version}
                <span className={activa ? 'text-neutral-300' : 'text-neutral-500'}>
                  {ETIQUETA_ESTADO_COMPULSA[compulsa.estado]}
                </span>
              </Link>
            );
          })}
        </nav>
      ) : null}

      <section className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          {PLANTILLAS[elegida.rubro].nombre} · versión {elegida.version}
        </h2>
        <Badge tone={TONO_ESTADO_COMPULSA[elegida.estado]}>
          {ETIQUETA_ESTADO_COMPULSA[elegida.estado]}
        </Badge>
        <Badge tone="neutral">
          {comparativa.columnas.length === 1
            ? '1 cotización'
            : `${comparativa.columnas.length} cotizaciones`}
        </Badge>
        <a
          href={`/api/obras/${obra.id}/compulsas/${elegida.id}/reporte`}
          className="ml-auto text-xs font-medium text-neutral-900 underline"
        >
          Bajar comparativa en XLSX
        </a>
      </section>

      {comparativa.columnas.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-2 py-8">
            <p className="text-sm font-medium text-neutral-900">
              Todavía no llegó ningún presupuesto.
            </p>
            <p className="text-sm text-neutral-600">
              Cuando cargues la primera cotización y se concilie contra el pedido, el cuadro se
              arma solo.
            </p>
            <Link
              href={`${base}/conversaciones`}
              className="text-sm font-medium text-neutral-900 underline"
            >
              Ver las conversaciones
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* El scroll horizontal es del contenedor y la primera columna queda
              pegada: sin eso, con seis proveedores el ítem se pierde de vista. */}
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-neutral-100">
                <tr className="border-b border-neutral-200">
                  <th
                    scope="col"
                    className="sticky left-0 z-10 bg-neutral-100 px-3 py-2 text-left font-medium text-neutral-600"
                  >
                    Ítem del pedido
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap text-neutral-600">
                    Cantidad
                  </th>
                  {comparativa.columnas.map((columna) => (
                    <th key={columna.cotizacionId} scope="col" className="px-3 py-2 text-left font-medium text-neutral-600">
                      <Columna columna={columna} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparativa.filas.map((fila) => (
                  <tr key={fila.claveItem} className="border-b border-neutral-200 last:border-b-0">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-white px-3 py-2 text-left align-top font-normal"
                    >
                      <span className="block text-neutral-900">{fila.item.descripcion}</span>
                      <span className="block text-xs text-neutral-500">{fila.claveItem}</span>
                    </th>
                    <td className="px-3 py-2 text-right align-top tabular-nums whitespace-nowrap text-neutral-600">
                      {formatearNumero(fila.item.cantidad)} {ETIQUETA_UNIDAD[fila.item.unidad]}
                    </td>
                    {fila.celdas.map((celda) => (
                      <td
                        key={celda.cotizacionId}
                        title={tituloCelda(celda)}
                        className={`px-3 py-2 text-right align-top tabular-nums ${CLASE_BENCHMARK[celda.benchmark]}`}
                      >
                        {celda.texto}
                        {celda.benchmark !== 'sin_datos' ? (
                          <span aria-hidden="true" className="ml-1">
                            ●
                          </span>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-neutral-300 bg-neutral-50">
                <tr>
                  <th scope="row" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left">
                    Total comparable
                  </th>
                  <td />
                  {comparativa.columnas.map((columna) => (
                    <td
                      key={columna.cotizacionId}
                      className="px-3 py-2 text-right font-semibold tabular-nums text-neutral-900"
                    >
                      {montoDe(columna.totalComparable, columna.moneda)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-normal text-neutral-600">
                    Total declarado
                  </th>
                  <td />
                  {comparativa.columnas.map((columna) => (
                    <td key={columna.cotizacionId} className="px-3 py-2 text-right tabular-nums text-neutral-600">
                      {montoDe(columna.totalDeclarado, columna.moneda)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-normal text-neutral-600">
                    Fidelidad al pedido
                  </th>
                  <td />
                  {comparativa.columnas.map((columna) => (
                    <td key={columna.cotizacionId} className="px-3 py-2 text-right tabular-nums text-neutral-600">
                      {formatearNumero(columna.scoreFidelidad, 2)}
                      <span className="ml-1 text-xs text-neutral-500">
                        ({columna.itemsComparables}/{comparativa.filas.length})
                      </span>
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-normal text-neutral-600">
                    Plazo de entrega
                  </th>
                  <td />
                  {comparativa.columnas.map((columna) => (
                    <td key={columna.cotizacionId} className="px-3 py-2 text-right tabular-nums text-neutral-600">
                      {columna.plazoDias === null ? '—' : `${columna.plazoDias} días`}
                    </td>
                  ))}
                </tr>
                {puedeAdjudicar && !adjudicacion ? (
                  <tr>
                    <th scope="row" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-normal text-neutral-600">
                      Adjudicar
                    </th>
                    <td />
                    {comparativa.columnas.map((columna) => {
                      const puesto = puestos.get(columna.cotizacionId);
                      return (
                        <td key={columna.cotizacionId} className="px-3 py-2 text-right">
                          <BotonAdjudicar
                            obraId={obra.id}
                            cotizacionId={columna.cotizacionId}
                            requiereTotal={columna.sinTotalDeclarado}
                            resumen={{
                              proveedorNombre: columna.proveedorNombre,
                              total: columna.totalDeclarado === null
                                ? null
                                : montoDe(columna.totalDeclarado, columna.moneda),
                              itemsComparables: columna.itemsComparables,
                              itemsExcluidos: columna.itemsExcluidos,
                              totalComparable: montoDe(columna.totalComparable, columna.moneda),
                              difiereDelDeclarado: columna.difiereDelDeclarado,
                              puntaje: puesto?.puntaje ?? null,
                              posicion: puesto?.posicion ?? null,
                              validez: ETIQUETA_VALIDEZ[columna.validez],
                              otrosContactos: comparativa.columnas.length - 1,
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ) : null}
              </tfoot>
            </table>
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold text-neutral-900">Ranking multicriterio</h2>
              <p className="text-xs text-neutral-500">
                {`puntaje = ${formatearNumero(pesos.total, 2)} × (total mínimo / total) + ${formatearNumero(pesos.fidelidad, 2)} × fidelidad + ${formatearNumero(pesos.plazo, 2)} × (plazo mínimo / plazo)`}
              </p>
            </div>

            {ranking.length === 0 ? (
              <p className="text-sm text-neutral-600">
                Ninguna cotización tiene todavía un total con el que compararla. Cargá el total del
                presupuesto para que entre al ranking.
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {ranking.map((puesto) => {
                  const columna = comparativa.columnas.find(
                    (c) => c.cotizacionId === puesto.id,
                  )!;
                  const gana = puesto.posicion === 1;
                  return (
                    <li key={puesto.id}>
                      <Card className={gana ? 'border-neutral-400' : undefined}>
                        <CardContent className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span className="text-sm font-medium text-neutral-900">
                              {puesto.posicion}º {columna.proveedorNombre}
                            </span>
                            <span className="text-lg font-semibold tabular-nums text-neutral-900">
                              {formatearNumero(puesto.puntaje, 4)}
                            </span>
                            {adjudicacion?.cotizacionId === puesto.id ? (
                              <Badge tone="ok">Adjudicada</Badge>
                            ) : null}
                          </div>
                          {/* El desglose es el punto: sin él, el puntaje es un
                              número mágico y nadie puede discutirlo. */}
                          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-600">
                            <div>
                              <dt className="inline">Precio </dt>
                              <dd className="inline tabular-nums">
                                {formatearNumero(puesto.componentes.total.peso, 2)} ×{' '}
                                {formatearNumero(puesto.componentes.total.ratio, 4)} ={' '}
                                <strong className="font-semibold text-neutral-900">
                                  {formatearNumero(puesto.componentes.total.aporte, 4)}
                                </strong>
                              </dd>
                            </div>
                            <div>
                              <dt className="inline">Fidelidad </dt>
                              <dd className="inline tabular-nums">
                                {formatearNumero(puesto.componentes.fidelidad.peso, 2)} ×{' '}
                                {formatearNumero(puesto.componentes.fidelidad.ratio, 4)} ={' '}
                                <strong className="font-semibold text-neutral-900">
                                  {formatearNumero(puesto.componentes.fidelidad.aporte, 4)}
                                </strong>
                              </dd>
                            </div>
                            <div>
                              <dt className="inline">Plazo </dt>
                              <dd className="inline tabular-nums">
                                {formatearNumero(puesto.componentes.plazo.peso, 2)} ×{' '}
                                {formatearNumero(puesto.componentes.plazo.ratio, 4)} ={' '}
                                <strong className="font-semibold text-neutral-900">
                                  {formatearNumero(puesto.componentes.plazo.aporte, 4)}
                                </strong>
                                {columna.plazoDias === null ? ' (sin plazo declarado)' : ''}
                              </dd>
                            </div>
                          </dl>
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ol>
            )}

            {datos.sinRanking.length > 0 ? (
              <p className="text-xs text-neutral-500">
                {datos.sinRanking.length === 1
                  ? 'Una cotización quedó fuera del ranking porque no tiene total: cargalo para poder compararla.'
                  : `${datos.sinRanking.length} cotizaciones quedaron fuera del ranking porque no tienen total: cargalos para poder compararlas.`}
              </p>
            ) : null}
          </section>

          {adjudicacion && ganadora ? (
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-semibold text-neutral-900">Orden de compra</h2>
                <Badge tone="ok">Adjudicada a {ganadora.proveedorNombre}</Badge>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <BotonCopiar texto={adjudicacion.ocTexto} etiqueta="Copiar la orden" />
                  <a
                    href={`/api/obras/${obra.id}/compulsas/${elegida.id}/reporte?documento=orden-compra`}
                    className="text-xs font-medium text-neutral-900 underline"
                  >
                    Bajar en PDF
                  </a>
                </span>
              </div>
              <Card>
                <CardContent>
                  <pre className="max-h-96 overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-neutral-800">
                    {adjudicacion.ocTexto}
                  </pre>
                </CardContent>
              </Card>
            </section>
          ) : null}

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-neutral-900">Cómo leer el cuadro</h2>
                <p className="text-sm text-neutral-600">
                  Cada celda es el precio unitario que cotizó el proveedor por la cantidad del
                  pedido: así dos presupuestos que cotizaron cantidades distintas se pueden
                  comparar. Un «—» es un ítem que no se puede comparar —no lo cotizó, o cambió una
                  especificación— y no suma al total; pasá el mouse por encima para ver por qué.
                </p>
                <p className="text-sm text-neutral-600">
                  El punto de color compara el precio unitario contra el índice del estudio para ese
                  ítem y esa zona (mes {comparativa.mesActual}). Solo aparece con{' '}
                  {MIN_MUESTRAS_BENCHMARK} muestras o más: con menos, no hay mercado que comparar.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-neutral-900">Referencias</h2>
                <p className="text-sm text-neutral-600">
                  Los importes están en {moneda}, con IVA discriminado (las cotizaciones se pidieron
                  así, PRD §13).
                </p>
                {mepReferencia ? (
                  <p className="text-sm text-neutral-600">
                    Dólar MEP de referencia del estudio: ${' '}
                    {formatearImporte(mepReferencia.valor)} al {mepReferencia.fecha}. Es la
                    referencia que cargó el estudio, no una cotización del día.
                  </p>
                ) : (
                  <p className="text-sm text-neutral-600">
                    El estudio no tiene un dólar MEP de referencia cargado.{' '}
                    <Link href="/estudio/configuracion" className="underline">
                      Se carga en la configuración del estudio
                    </Link>
                    .
                  </p>
                )}
                <p className="text-xs text-neutral-500">
                  Comparativa asistida por Compulsa — sujeto a validación del profesional
                  responsable.
                </p>
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
