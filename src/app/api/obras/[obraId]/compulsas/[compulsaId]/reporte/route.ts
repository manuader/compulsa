/**
 * `GET /api/obras/[obraId]/compulsas/[compulsaId]/reporte` — el cuadro
 * comparativo en XLSX (RF-1105).
 *
 * Es el archivo que el arquitecto le manda al comitente para justificar por qué
 * se eligió a uno y no al más barato. Por eso el libro tiene tres clases de
 * hoja y no una:
 *
 *  1. **Comparativa** — el cuadro normalizado tal como se ve en pantalla, con
 *     los importes como **números** (una celda de texto rompe cualquier suma
 *     del otro lado) y los totales, el ranking y su puntaje al pie.
 *  2. **Una hoja por cotización** — las líneas tal como las mandó el proveedor,
 *     con contra qué ítem del pedido matchearon y por qué. Es lo que permite
 *     auditar el cuadro sin volver al sistema.
 *  3. **Condiciones** — de qué compulsa se trata, con qué condiciones se pidió,
 *     cómo se leen el benchmark y el ranking, y el disclaimer profesional.
 *
 * Con `?documento=orden-compra` la misma ruta devuelve la **orden de compra en
 * PDF** (`adjudicaciones.oc_texto` pasado por pdf-lib). Es el mismo recurso —el
 * papelerío de una compulsa— con el mismo control de acceso; una ruta aparte
 * sería una segunda copia de estas veinte líneas de validación.
 *
 * El middleware NO cubre `/api/*` (`matcher` de `src/middleware.ts`): este
 * handler valida sesión y tenant por su cuenta, igual que el export de cómputo.
 * Además chequea que la compulsa sea **de esa obra**: sin eso, la URL de una
 * obra propia serviría para bajar el reporte de otra compulsa del estudio.
 */
import { inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';

import { getDb, type Db } from '@/db/client';
import { conciliacionItems, cotizaciones } from '@/db/schema';
import { ObraNoEncontradaError, requireObraCore } from '@/lib/auth/guards';
import { getSession } from '@/lib/auth/session';
import { leerComparativa, type DatosComparativa } from '@/lib/compulsa/adjudicar';
import {
  ETIQUETA_MATCH,
  ETIQUETA_VALIDEZ,
  formatearImporte,
  type Comparativa,
  type MatchCelda,
} from '@/lib/compulsa/comparativa';
import { ordenCompraPdf } from '@/lib/compulsa/orden-compra';
import { ETIQUETA_UNIDAD } from '@/lib/computo/unidades';
import { fechaIso, fechaLegible, slugObra } from '@/lib/export/xlsx';
import { MIN_MUESTRAS_BENCHMARK } from '@/lib/indice/percentiles';
import { CompulsaNoEncontradaError } from '@/lib/outreach/threads';
import { PLANTILLAS } from '@/lib/rubros';

/** exceljs es Node puro (zlib, streams): este handler no corre en el edge. */
export const runtime = 'nodejs';
/** Depende de la cookie de sesión y de la base: nunca se prerenderiza. */
export const dynamic = 'force-dynamic';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_PDF = 'application/pdf';
const NUM2 = '0.00';

const DISCLAIMER =
  'Comparativa asistida por Compulsa — sujeto a validación del profesional responsable';

function problema(status: number, mensaje: string): Response {
  return Response.json({ error: mensaje }, { status });
}

/**
 * `compulsa-casa-demo-seco-v1-2026-08-26.xlsx`.
 *
 * Sin `export`, igual que la de la orden de compra: en un `route.ts` los únicos
 * exports que Next admite son los verbos HTTP y las opciones de segmento
 * (`runtime`, `dynamic`, …). Cualquier otro rompe el type-check contra los tipos
 * que Next genera en `.next/types` —y con él el build—, aunque el módulo
 * importado derecho desde un test compile perfecto.
 */
function nombreArchivoReporte(
  nombreObra: string,
  rubro: string,
  version: number,
  fecha: Date,
): string {
  const slug = slugObra(nombreObra) || 'obra';
  return `compulsa-${slug}-${rubro}-v${version}-${fechaIso(fecha)}.xlsx`;
}

/** `orden-compra-casa-demo-seco-v1-2026-08-26.pdf`. */
function nombreArchivoOrdenCompra(
  nombreObra: string,
  rubro: string,
  version: number,
  fecha: Date,
): string {
  const slug = slugObra(nombreObra) || 'obra';
  return `orden-compra-${slug}-${rubro}-v${version}-${fechaIso(fecha)}.pdf`;
}

/**
 * Nombre de hoja aceptable para Excel: sin `* ? : \ / [ ]`, hasta 31 caracteres
 * y único dentro del libro. Dos proveedores que se llaman parecido no pueden
 * pisarse la hoja.
 */
function nombreHoja(base: string, usados: Set<string>): string {
  const limpio = (base.replace(/[*?:\\/[\]]/g, ' ').trim() || 'Cotización').slice(0, 31);
  let nombre = limpio;
  let i = 2;
  while (usados.has(nombre)) {
    const sufijo = ` (${i})`;
    nombre = `${limpio.slice(0, 31 - sufijo.length)}${sufijo}`;
    i += 1;
  }
  usados.add(nombre);
  return nombre;
}

function encabezar(hoja: ExcelJS.Worksheet, headers: readonly string[]): void {
  const fila = hoja.addRow([...headers]);
  fila.font = { bold: true };
  hoja.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
}

// ---------------------------------------------------------------------------
// Hoja 1: el cuadro
// ---------------------------------------------------------------------------

function hojaComparativa(wb: ExcelJS.Workbook, datos: DatosComparativa): void {
  const { comparativa, ranking } = datos;
  const hoja = wb.addWorksheet('Comparativa');
  hoja.columns = [
    { width: 24 },
    { width: 46 },
    { width: 9 },
    { width: 11 },
    ...comparativa.columnas.map(() => ({ width: 18 })),
  ];

  encabezar(hoja, [
    'Clave',
    'Descripción',
    'Unidad',
    'Cantidad',
    ...comparativa.columnas.map((c) => c.proveedorNombre),
  ]);

  for (const fila of comparativa.filas) {
    const valores: (string | number | null)[] = [
      fila.claveItem,
      fila.item.descripcion,
      ETIQUETA_UNIDAD[fila.item.unidad],
      fila.item.cantidad,
      // Lo que no se puede comparar viaja como el mismo "—" de la pantalla: en
      // una planilla, un 0 se sumaría y una celda vacía parecería un olvido.
      ...fila.celdas.map((celda) => celda.importe ?? '—'),
    ];
    const excel = hoja.addRow(valores);
    excel.getCell(4).numFmt = NUM2;
    fila.celdas.forEach((celda, i) => {
      const cell = excel.getCell(5 + i);
      if (celda.importe !== null) cell.numFmt = NUM2;
      // El motivo del match queda como nota de la celda: es el mismo tooltip
      // que muestra la pantalla, y sin él "—" no explica nada.
      cell.note = `${ETIQUETA_MATCH[celda.match]}: ${celda.detalle}`;
    });
  }

  hoja.addRow([]);

  const puestos = new Map(ranking.map((p) => [p.id, p]));
  const pie: ReadonlyArray<readonly [string, (i: number) => string | number | null, string?]> = [
    ['Total comparable', (i) => comparativa.columnas[i].totalComparable, NUM2],
    ['Total declarado', (i) => comparativa.columnas[i].totalDeclarado, NUM2],
    [
      'Diferencia',
      (i) => comparativa.columnas[i].diferencia,
      NUM2,
    ],
    ['Ítems comparables', (i) => comparativa.columnas[i].itemsComparables],
    ['Ítems sin comparar', (i) => comparativa.columnas[i].itemsExcluidos],
    ['Score de fidelidad', (i) => comparativa.columnas[i].scoreFidelidad, NUM2],
    ['Plazo (días)', (i) => comparativa.columnas[i].plazoDias],
    ['Validez', (i) => ETIQUETA_VALIDEZ[comparativa.columnas[i].validez]],
    [
      'Vence',
      (i) => {
        const vence = comparativa.columnas[i].venceAt;
        return vence ? fechaLegible(vence) : '—';
      },
    ],
    ['Puntaje', (i) => puestos.get(comparativa.columnas[i].cotizacionId)?.puntaje ?? '—'],
    ['Posición', (i) => puestos.get(comparativa.columnas[i].cotizacionId)?.posicion ?? '—'],
  ];

  for (const [etiqueta, valor, numFmt] of pie) {
    const excel = hoja.addRow([
      etiqueta,
      null,
      null,
      null,
      ...comparativa.columnas.map((_, i) => valor(i)),
    ]);
    excel.getCell(1).font = { bold: true };
    if (numFmt) {
      comparativa.columnas.forEach((_, i) => {
        const cell = excel.getCell(5 + i);
        if (typeof cell.value === 'number') cell.numFmt = numFmt;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Hojas 2..n: una por cotización
// ---------------------------------------------------------------------------

function hojasPorCotizacion(
  wb: ExcelJS.Workbook,
  datos: DatosComparativa,
  crudas: ReadonlyMap<string, { lineas: readonly LineaVista[]; porLinea: Map<number, MatchVista> }>,
): void {
  const usados = new Set(['Comparativa', 'Condiciones']);

  for (const columna of datos.comparativa.columnas) {
    const hoja = wb.addWorksheet(nombreHoja(columna.proveedorNombre, usados));
    hoja.columns = [
      { width: 7 },
      { width: 46 },
      { width: 9 },
      { width: 11 },
      { width: 15 },
      { width: 15 },
      { width: 24 },
      { width: 14 },
      { width: 60 },
    ];
    encabezar(hoja, [
      'Línea',
      'Descripción',
      'Unidad',
      'Cantidad',
      'Precio unitario',
      'Importe',
      'Ítem del pedido',
      'Match',
      'Nota',
    ]);

    const cruda = crudas.get(columna.cotizacionId);
    cruda?.lineas.forEach((linea, i) => {
      const match = cruda.porLinea.get(i);
      const fila = hoja.addRow([
        i + 1,
        linea.descripcion,
        linea.unidad,
        linea.cantidad,
        linea.precioUnitario,
        linea.precioTotal,
        match?.claveItem ?? '—',
        match ? ETIQUETA_MATCH[match.match] : 'Sin conciliar',
        match?.nota ?? '',
      ]);
      for (const columnaNum of [4, 5, 6]) {
        if (typeof fila.getCell(columnaNum).value === 'number') {
          fila.getCell(columnaNum).numFmt = NUM2;
        }
      }
    });

    // Los ítems que este proveedor no cotizó no tienen línea: van al pie, que
    // es donde se ven de un vistazo (es la mitad de la información que el
    // comitente quiere: qué le falta a cada presupuesto).
    const faltantes = datos.comparativa.filas
      .map((fila) => ({ fila, celda: fila.celdas.find((c) => c.cotizacionId === columna.cotizacionId) }))
      .filter(({ celda }) => celda && !celda.comparable);

    if (faltantes.length > 0) {
      hoja.addRow([]);
      hoja.addRow(['Ítems del pedido sin importe comparable']).getCell(1).font = { bold: true };
      for (const { fila, celda } of faltantes) {
        hoja.addRow([
          null,
          fila.item.descripcion,
          ETIQUETA_UNIDAD[fila.item.unidad],
          fila.item.cantidad,
          null,
          null,
          fila.claveItem,
          ETIQUETA_MATCH[(celda!.match ?? 'sin_conciliar') as MatchCelda],
          celda!.detalle,
        ]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hoja final: condiciones y referencias
// ---------------------------------------------------------------------------

function hojaCondiciones(wb: ExcelJS.Workbook, datos: DatosComparativa, fecha: Date): void {
  const hoja = wb.addWorksheet('Condiciones');
  hoja.columns = [{ width: 26 }, { width: 100 }];

  hoja.addRow([DISCLAIMER]).font = { bold: true };
  hoja.addRow([]);

  const compulsa = datos.compulsa;
  const condiciones = compulsa.condicionesJson;
  const datosCabecera: ReadonlyArray<readonly [string, string]> = [
    ['Obra', datos.obra.nombre],
    ['Zona', datos.obra.zona],
    ['Rubro', PLANTILLAS[compulsa.rubro].nombre],
    ['Compulsa', `versión ${compulsa.version} — ${compulsa.estado}`],
    ['Hash del pedido', compulsa.snapshotHash],
    ['Ítems del pedido', String(compulsa.itemsJson.length)],
    ['Cotizaciones', String(datos.comparativa.columnas.length)],
    ['Generado', fechaLegible(fecha)],
  ];
  for (const [etiqueta, valor] of datosCabecera) {
    hoja.addRow([etiqueta, valor]).getCell(1).font = { bold: true };
  }

  hoja.addRow([]);
  hoja.addRow(['Condiciones del pedido']).getCell(1).font = { bold: true };
  hoja.addRow(['IVA', 'Precios con IVA discriminado.']);
  hoja.addRow([
    'Mano de obra',
    condiciones.separarManoObraMateriales
      ? 'Mano de obra, materiales y flete se pidieron por separado.'
      : 'No se pidió separar mano de obra de materiales.',
  ]);
  hoja.addRow(['Validez mínima', `${condiciones.validezMinimaDias} días corridos.`]);
  hoja.addRow([
    'Plazo de entrega',
    condiciones.plazoEntregaDias === null
      ? 'Lo declara cada proveedor.'
      : `Hasta ${condiciones.plazoEntregaDias} días corridos.`,
  ]);
  if (condiciones.notas?.trim()) hoja.addRow(['Notas', condiciones.notas.trim()]);

  hoja.addRow([]);
  hoja.addRow(['Cómo leerlo']).getCell(1).font = { bold: true };
  hoja.addRow([
    'Celda',
    'Precio unitario de la línea cotizada por la cantidad del pedido, no el importe que escribió el proveedor.',
  ]);
  hoja.addRow([
    '"—"',
    'El ítem no se puede comparar: no se cotizó, o el proveedor sustituyó una especificación. La nota de la celda dice cuál de las dos.',
  ]);
  hoja.addRow([
    'Total comparable',
    'Suma de las celdas comparables. Puede no coincidir con el total declarado: la fila «Diferencia» lo muestra.',
  ]);
  hoja.addRow([
    'Score de fidelidad',
    'De 0 a 1: cuánto del pedido cotizó el proveedor (exactos + medio parcial, sobre los ítems pedidos).',
  ]);
  hoja.addRow([
    'Puntaje',
    `Ranking multicriterio: ${datos.pesos.total} × (total mínimo / total) + ${datos.pesos.fidelidad} × fidelidad + ${datos.pesos.plazo} × (plazo mínimo / plazo).`,
  ]);
  hoja.addRow([
    'Benchmark',
    `Cada precio unitario se compara contra el índice del estudio para su ítem y zona (mes ${datos.comparativa.mesActual}, con fallback al último mes con datos). Solo se muestra con ${MIN_MUESTRAS_BENCHMARK} muestras o más.`,
  ]);

  if (datos.mepReferencia) {
    hoja.addRow([]);
    hoja.addRow([
      'Dólar MEP de referencia',
      `$ ${formatearImporte(datos.mepReferencia.valor)} al ${datos.mepReferencia.fecha} (referencia del estudio, no una cotización del día).`,
    ]).getCell(1).font = { bold: true };
  }

  if (datos.adjudicacion) {
    const ganadora = datos.comparativa.columnas.find(
      (c) => c.cotizacionId === datos.adjudicacion!.cotizacionId,
    );
    hoja.addRow([]);
    hoja.addRow(['Adjudicada a', ganadora?.proveedorNombre ?? '—']).getCell(1).font = {
      bold: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface LineaVista {
  descripcion: string;
  unidad: string | null;
  cantidad: number | null;
  precioUnitario: number | null;
  precioTotal: number | null;
}

interface MatchVista {
  claveItem: string | null;
  match: MatchCelda;
  nota: string | null;
}

/** Las líneas crudas y su match por índice, para las hojas por cotización. */
function crudasDe(
  comparativa: Comparativa,
  lineasPorCotizacion: ReadonlyMap<string, readonly LineaVista[]>,
  matchesPorCotizacion: ReadonlyMap<string, ReadonlyArray<{ lineaIdx: number | null } & MatchVista>>,
): Map<string, { lineas: readonly LineaVista[]; porLinea: Map<number, MatchVista> }> {
  const salida = new Map<string, { lineas: readonly LineaVista[]; porLinea: Map<number, MatchVista> }>();
  for (const columna of comparativa.columnas) {
    const porLinea = new Map<number, MatchVista>();
    for (const match of matchesPorCotizacion.get(columna.cotizacionId) ?? []) {
      if (match.lineaIdx !== null) {
        porLinea.set(match.lineaIdx, { claveItem: match.claveItem, match: match.match, nota: match.nota });
      }
    }
    salida.set(columna.cotizacionId, {
      lineas: lineasPorCotizacion.get(columna.cotizacionId) ?? [],
      porLinea,
    });
  }
  return salida;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ obraId: string; compulsaId: string }> },
): Promise<Response> {
  const sesion = await getSession();
  if (!sesion) return problema(401, 'Iniciá sesión para bajar el reporte.');

  const documento = new URL(request.url).searchParams.get('documento')?.trim() || 'comparativa';
  if (documento !== 'comparativa' && documento !== 'orden-compra') {
    // No se degrada al XLSX en silencio: pediste un documento que no existe y
    // el archivo que bajarías no sería el que creés.
    return problema(400, `No conozco el documento "${documento}".`);
  }

  const { obraId, compulsaId } = await params;
  const db = await getDb();

  let obra;
  try {
    obra = await requireObraCore(db, sesion.estudio.id, obraId);
  } catch (error) {
    if (error instanceof ObraNoEncontradaError) {
      return problema(404, 'Esa obra no existe o no es de tu estudio.');
    }
    throw error;
  }

  const fecha = new Date();
  let datos: DatosComparativa;
  try {
    datos = await leerComparativa(db, sesion.estudio.id, compulsaId, { ahora: fecha });
  } catch (error) {
    if (error instanceof CompulsaNoEncontradaError) {
      return problema(404, 'Esa compulsa no existe o no es de tu estudio.');
    }
    throw error;
  }

  // La compulsa es del estudio, pero puede ser de OTRA obra del mismo estudio:
  // el reporte se baja desde la obra, así que la URL tiene que ser coherente.
  if (datos.compulsa.obraId !== obra.id) {
    return problema(404, 'Esa compulsa no es de esta obra.');
  }

  if (documento === 'orden-compra') {
    if (!datos.adjudicacion) {
      return problema(404, 'Esta compulsa todavía no está adjudicada: no hay orden de compra.');
    }
    // El PDF se arma del texto guardado, no de uno nuevo: lo que se manda tiene
    // que ser el documento que quedó escrito al adjudicar, aunque después
    // cambien los precios o la configuración del estudio.
    const pdf = await ordenCompraPdf(datos.adjudicacion.ocTexto);
    const archivoPdf = nombreArchivoOrdenCompra(
      obra.nombre,
      datos.compulsa.rubro,
      datos.compulsa.version,
      fecha,
    );
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': MIME_PDF,
        'content-disposition': `attachment; filename="${archivoPdf}"`,
        'content-length': String(pdf.byteLength),
        'cache-control': 'no-store',
      },
    });
  }

  const lineas = new Map<string, readonly LineaVista[]>();
  const matches = new Map<string, ReadonlyArray<{ lineaIdx: number | null } & MatchVista>>();
  for (const columna of datos.comparativa.columnas) {
    lineas.set(columna.cotizacionId, []);
    matches.set(columna.cotizacionId, []);
  }
  await cargarCrudas(db, datos, lineas, matches);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Compulsa';
  wb.created = fecha;

  hojaComparativa(wb, datos);
  hojasPorCotizacion(wb, datos, crudasDe(datos.comparativa, lineas, matches));
  hojaCondiciones(wb, datos, fecha);

  const libro = Buffer.from(await wb.xlsx.writeBuffer());
  const archivo = nombreArchivoReporte(
    obra.nombre,
    datos.compulsa.rubro,
    datos.compulsa.version,
    fecha,
  );

  return new Response(new Uint8Array(libro), {
    headers: {
      'content-type': MIME_XLSX,
      'content-disposition': `attachment; filename="${archivo}"`,
      'content-length': String(libro.byteLength),
      // Una cotización nueva o una adjudicación cambian el archivo sin cambiar
      // la URL: nunca se sirve una copia vieja.
      'cache-control': 'no-store',
    },
  });
}

/**
 * Las líneas y los matches crudos, que el cuadro no expone porque no los
 * necesita: las hojas por cotización sí, para poder auditar el cuadro.
 */
async function cargarCrudas(
  db: Db,
  datos: DatosComparativa,
  lineas: Map<string, readonly LineaVista[]>,
  matches: Map<string, ReadonlyArray<{ lineaIdx: number | null } & MatchVista>>,
): Promise<void> {
  const ids = datos.comparativa.columnas.map((c) => c.cotizacionId);
  if (ids.length === 0) return;

  const [filasCot, filasConc] = await Promise.all([
    db
      .select({ id: cotizaciones.id, lineasJson: cotizaciones.lineasJson })
      .from(cotizaciones)
      .where(inArray(cotizaciones.id, ids)),
    db
      .select({
        cotizacionId: conciliacionItems.cotizacionId,
        claveItem: conciliacionItems.claveItem,
        lineaIdx: conciliacionItems.lineaIdx,
        match: conciliacionItems.match,
        nota: conciliacionItems.nota,
      })
      .from(conciliacionItems)
      .where(inArray(conciliacionItems.cotizacionId, ids)),
  ]);

  for (const fila of filasCot) lineas.set(fila.id, fila.lineasJson);
  for (const fila of filasConc) {
    const lista = [...(matches.get(fila.cotizacionId) ?? [])];
    lista.push({
      lineaIdx: fila.lineaIdx,
      claveItem: fila.claveItem,
      match: fila.match,
      nota: fila.nota,
    });
    matches.set(fila.cotizacionId, lista);
  }
}
