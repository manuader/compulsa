/**
 * Export XLSX del cómputo (RF-405).
 *
 * Lo que sale de acá es lo que el arquitecto le manda al corralón, así que hay
 * tres cosas que no se negocian:
 *
 * 1. **Los números viajan como números.** Una cantidad exportada como texto
 *    rompe cualquier suma del otro lado. Todas las cantidades se escriben como
 *    `number` con formato `0.00`; el formateo con coma decimal es cosa de Excel
 *    según el locale de quien abre el archivo, no nuestra.
 * 2. **Cada fila cita su lámina** (P1). La columna `Lámina(s) fuente` traduce
 *    `fuentes_json` a códigos/títulos legibles. Una fila sin lámina es un ítem
 *    cargado a mano — la celda queda vacía, nunca se inventa una fuente.
 * 3. **El disclaimer profesional viaja adentro del libro.** El cómputo es
 *    asistido, la responsabilidad es del profesional que firma.
 *
 * Módulo puro: no toca la base ni el filesystem. La route handler
 * (`src/app/api/obras/[obraId]/export/route.ts`) consulta y le pasa las filas.
 */
import ExcelJS from 'exceljs';

import { ETIQUETA_UNIDAD, redondear2 } from '@/lib/computo/unidades';
import { formatearMonto } from '@/lib/format/dinero';
import { PLANTILLAS } from '@/lib/rubros';
import type {
  EstadoRubro,
  Fuente,
  Origen,
  PrecioEstimado,
  RubroId,
  TipoObra,
  Unidad,
} from '@/types/domain';
import { RUBROS } from '@/types/domain';

// --- Contrato de datos -----------------------------------------------------

/** Lo que el export necesita de la obra (estructural: la fila de `obras` encaja). */
export interface ObraExport {
  nombre: string;
  zona: string;
  tipo: TipoObra;
  moneda: string;
}

/**
 * Lo que el export necesita de un ítem. Los nombres son los de la fila de
 * `computo_items` para que la route pueda pasar el `select` derecho, sin mapeo
 * intermedio que se desincronice.
 */
export interface ItemExport {
  rubro: RubroId;
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  cantNeta: number;
  desperdicioPct: number;
  cantCompra: number;
  presentacion: string;
  origen: Origen;
  confianza: number;
  estado: 'activo' | 'anulado';
  fuentesJson: Fuente[];
  /**
   * El precio unitario con de dónde salió (§5.6), o `null` si no hay con qué
   * valorizarlo. Opcional en el tipo para que un llamador viejo compile; la
   * route lo pasa siempre.
   */
  precioJson?: PrecioEstimado | null;
}

/** Lámina nombrable: con esto se resuelve la columna `Lámina(s) fuente`. */
export interface LaminaExport {
  id: string;
  codigo: string | null;
  titulo: string | null;
}

/** Estado de aprobación por rubro. Un rubro ausente todavía está en borrador. */
export type EstadosRubro = Partial<Record<RubroId, EstadoRubro>>;

export interface OpcionesXlsx {
  /**
   * Rubro único a exportar. Con un rubro el libro trae solo esa hoja + las
   * referencias (sin consolidada: consolidar una sola cosa no consolida nada).
   * `undefined` o `'todos'` ⇒ las cuatro hojas + consolidada + referencias.
   */
  rubro?: RubroId | 'todos';
  /** Fecha del export. Inyectable para que los tests no dependan del reloj. */
  fecha?: Date;
}

// --- Etiquetas es-AR -------------------------------------------------------

export const DISCLAIMER =
  'Cómputo asistido por Compulsa — sujeto a validación del profesional responsable';

const ETIQUETA_ORIGEN: Record<Origen, string> = {
  explicito: 'Explícito',
  deducido: 'Deducido',
  supuesto: 'Supuesto',
  inferido: 'Inferido',
};

/** De dónde salió el precio de la fila. La IA no está en la lista, y no es casual (§5.6). */
const ETIQUETA_FUENTE_PRECIO: Record<PrecioEstimado['fuente'], string> = {
  manual: 'Cargado a mano',
  lista: 'Lista del estudio',
  indice: 'Índice del estudio',
};

const ETIQUETA_ESTADO_RUBRO: Record<EstadoRubro, string> = {
  borrador: 'Borrador',
  revision: 'En revisión',
  aprobado: 'Aprobado',
};

const ETIQUETA_TIPO_OBRA: Record<TipoObra, string> = {
  nueva: 'Obra nueva',
  reforma: 'Reforma',
  ampliacion: 'Ampliación',
};

/** Qué significa cada origen, para el que abre el archivo y no usó Compulsa. */
const LEYENDA_ORIGENES: ReadonlyArray<readonly [string, string]> = [
  [
    ETIQUETA_ORIGEN.explicito,
    'El dato está escrito en la documentación (cota, planilla de aberturas, rótulo).',
  ],
  [
    ETIQUETA_ORIGEN.deducido,
    'Se calculó a partir de datos explícitos. Las láminas de la fila muestran de dónde salió.',
  ],
  [
    ETIQUETA_ORIGEN.supuesto,
    'El dato no estaba: se usó un supuesto declarado y quedó una consulta abierta en la bandeja.',
  ],
  [
    ETIQUETA_ORIGEN.inferido,
    'La medida se sacó midiendo sobre el dibujo a escala. Es la evidencia más débil: verificala antes de comprar.',
  ],
];

// --- Columnas --------------------------------------------------------------

interface DefColumna {
  header: string;
  width: number;
  /** Presente ⇒ la celda es numérica y lleva este formato. */
  numFmt?: string;
}

const NUM2 = '0.00';

/**
 * Las columnas del contrato, en este orden exacto. Cambiarlas rompe las
 * planillas que ya circularon por mail: si hay que tocarlas, es una decisión
 * de producto, no un refactor. Las cuatro del precio se **agregaron al final**
 * por lo mismo: las once de siempre están donde estaban.
 *
 * `Origen` es el nivel de evidencia del §5.5 y `Lámina(s) fuente` su respaldo:
 * son las dos columnas que hacen que el archivo se pueda auditar sin abrir la
 * app.
 */
const COLUMNAS: readonly DefColumna[] = [
  { header: 'Clave', width: 24 },
  { header: 'Descripción', width: 48 },
  { header: 'Unidad', width: 9 },
  { header: 'Cant. neta', width: 12, numFmt: NUM2 },
  { header: 'Desp. %', width: 10, numFmt: NUM2 },
  { header: 'Cant. compra', width: 13, numFmt: NUM2 },
  { header: 'Presentación', width: 36 },
  { header: 'Origen', width: 12 },
  { header: 'Confianza', width: 11, numFmt: NUM2 },
  { header: 'Estado rubro', width: 14 },
  { header: 'Lámina(s) fuente', width: 30 },
  { header: 'Precio unit.', width: 14, numFmt: NUM2 },
  { header: 'Subtotal', width: 16, numFmt: NUM2 },
  { header: 'Fuente del precio', width: 18 },
  { header: 'Fecha del precio', width: 16 },
];

/** Índice (base 1) de la columna `Subtotal` en una hoja de rubro: donde va el total. */
const COLUMNA_SUBTOTAL = COLUMNAS.findIndex((c) => c.header === 'Subtotal') + 1;

/** Los encabezados tal cual salen en la fila 1 de cada hoja de rubro. */
export const COLUMNAS_ITEM: readonly string[] = COLUMNAS.map((c) => c.header);

const COLUMNA_RUBRO: DefColumna = { header: 'Rubro', width: 20 };

/** La consolidada es lo mismo con el rubro adelante, para poder ordenar y filtrar. */
const COLUMNAS_CONSOLIDADO: readonly DefColumna[] = [COLUMNA_RUBRO, ...COLUMNAS];

export const NOMBRE_HOJA_CONSOLIDADO = 'Consolidado';
export const NOMBRE_HOJA_REFERENCIAS = 'Referencias';

// --- Fecha y nombre de archivo ---------------------------------------------

/**
 * El cómputo es de una obra argentina y lo fecha quien lo baja: el día del
 * archivo es el día de Buenos Aires, no el UTC del servidor (a las 21:30 de
 * Buenos Aires, UTC ya está en el día siguiente).
 */
const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';

function partesFecha(fecha: Date): Record<string, string> {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);

  return Object.fromEntries(partes.map((p) => [p.type, p.value]));
}

/** `2026-08-25` — para el nombre del archivo (ordenable alfabéticamente). */
export function fechaIso(fecha: Date): string {
  const { year, month, day } = partesFecha(fecha);
  return `${year}-${month}-${day}`;
}

/** `25/08/2026 12:30` — para que lo lea una persona. */
export function fechaLegible(fecha: Date): string {
  const { year, month, day, hour, minute } = partesFecha(fecha);
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

/**
 * Nombre de obra apto para un nombre de archivo: sin acentos (un `Content-
 * Disposition` con `Pérez` adentro depende de codificaciones que no todos los
 * navegadores resuelven igual) y sin nada que no sea `[a-z0-9-]`.
 */
export function slugObra(nombre: string): string {
  const sinAcentos = nombre.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return sinAcentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `computo-casa-perez-consolidado-2026-08-25.xlsx`, o
 * `computo-casa-perez-pintura-2026-08-25.xlsx` cuando se baja un rubro solo.
 *
 * El alcance va en el nombre porque el archivo se baja a una carpeta donde ya
 * hay otros: sin el rubro, cinco descargas de la misma obra y el mismo día se
 * llamarían igual y el navegador las numeraría `(1)`, `(2)`… — nadie sabría
 * cuál es la de pintura sin abrirlas.
 */
export function nombreArchivoXlsx(
  nombreObra: string,
  fecha: Date,
  rubro: RubroId | 'todos' = 'todos',
): string {
  // Un nombre que se queda sin caracteres usables igual necesita archivo.
  const slug = slugObra(nombreObra) || 'obra';
  const alcance = rubro === 'todos' ? 'consolidado' : rubro;
  return `computo-${slug}-${alcance}-${fechaIso(fecha)}.xlsx`;
}

// --- Armado del libro ------------------------------------------------------

function crearHoja(
  wb: ExcelJS.Workbook,
  nombre: string,
  columnas: readonly DefColumna[],
): ExcelJS.Worksheet {
  const hoja = wb.addWorksheet(nombre);
  hoja.columns = columnas.map((c) => ({ width: c.width }));

  const encabezado = hoja.addRow(columnas.map((c) => c.header));
  encabezado.font = { bold: true };
  // Con 200 filas de cómputo, el encabezado tiene que quedar a la vista.
  hoja.views = [{ state: 'frozen', ySplit: 1 }];

  return hoja;
}

/**
 * El `numFmt` se escribe celda por celda a propósito: el estilo de columna de
 * exceljs no sobrevive el round-trip de guardar y volver a leer el archivo.
 */
function agregarFila(
  hoja: ExcelJS.Worksheet,
  columnas: readonly DefColumna[],
  valores: readonly (string | number | null)[],
): void {
  const fila = hoja.addRow([...valores]);
  columnas.forEach((columna, i) => {
    if (columna.numFmt) fila.getCell(i + 1).numFmt = columna.numFmt;
  });
}

/**
 * Códigos (o títulos) de las láminas que sostienen el ítem, sin repetir y en
 * el orden en que fueron citadas. Una lámina que ya no está en la obra cae a su
 * id: preferimos un identificador feo a perder la trazabilidad.
 */
function nombrarLaminas(fuentes: readonly Fuente[], porId: ReadonlyMap<string, LaminaExport>): string {
  const nombres: string[] = [];
  for (const fuente of fuentes) {
    const lamina = porId.get(fuente.laminaId);
    const nombre = lamina?.codigo || lamina?.titulo || fuente.laminaId;
    if (!nombres.includes(nombre)) nombres.push(nombre);
  }
  return nombres.join(', ');
}

/**
 * Lo que sale de multiplicar el precio por la cantidad de compra, o `null`.
 *
 * `null` y no `0`: un ítem sin precio no cuesta cero, no se sabe cuánto cuesta.
 * La diferencia importa porque estas celdas se suman del otro lado.
 */
export function subtotalDeItem(item: ItemExport): number | null {
  const precio = item.precioJson;
  if (!precio || !Number.isFinite(precio.unitario)) return null;
  return redondear2(precio.unitario * item.cantCompra);
}

function celdasItem(
  item: ItemExport,
  estados: EstadosRubro,
  porId: ReadonlyMap<string, LaminaExport>,
): (string | number | null)[] {
  const laminas = nombrarLaminas(item.fuentesJson, porId);
  const precio = item.precioJson ?? null;
  return [
    item.claveItem,
    item.descripcion,
    ETIQUETA_UNIDAD[item.unidad],
    item.cantNeta,
    item.desperdicioPct,
    item.cantCompra,
    item.presentacion,
    ETIQUETA_ORIGEN[item.origen],
    item.confianza,
    ETIQUETA_ESTADO_RUBRO[estados[item.rubro] ?? 'borrador'],
    // Vacío, no `—`: un ítem manual no tiene fuente y eso es un dato, no un hueco a rellenar.
    laminas || null,
    precio === null ? null : precio.unitario,
    subtotalDeItem(item),
    precio === null ? null : ETIQUETA_FUENTE_PRECIO[precio.fuente],
    // La fecha viaja como la guarda la fuente: `2026-08-20` de la lista, `2026-08`
    // del índice, que es mensual. Rellenarle el día sería inventar precisión.
    precio === null ? null : precio.fechaPrecio,
  ];
}

/** Lo que suman los ítems con precio, y cuántos quedaron sin. */
function totalizar(items: readonly ItemExport[]): { total: number; sinPrecio: number } {
  let total = 0;
  let sinPrecio = 0;
  for (const item of items) {
    const subtotal = subtotalDeItem(item);
    if (subtotal === null) sinPrecio += 1;
    else total = redondear2(total + subtotal);
  }
  return { total, sinPrecio };
}

/**
 * La fila de total de un bloque de ítems, con el monto en la columna `Subtotal`.
 *
 * Dice **siempre** cuántos ítems no pudo contar: un total que se calla sus
 * huecos es el que hace comprar de menos. Sin ningún ítem con precio no se
 * dibuja: un total en cero sería una afirmación que nadie hizo.
 */
function agregarTotal(
  hoja: ExcelJS.Worksheet,
  columnas: readonly DefColumna[],
  etiqueta: string,
  items: readonly ItemExport[],
  desplazamiento: number,
): void {
  const { total, sinPrecio } = totalizar(items);
  if (items.length === 0 || sinPrecio === items.length) return;

  const celdas: (string | number | null)[] = new Array(columnas.length).fill(null);
  celdas[0] = etiqueta;
  celdas[COLUMNA_SUBTOTAL - 1 + desplazamiento] = total;
  if (sinPrecio > 0) {
    // Misma frase que la fila de subtotal de la pantalla
    // (`components/planilla/planilla-rubro.tsx`): una oración, con mayúscula y
    // punto. El XLSX es el mismo cómputo en otro soporte, no otro producto.
    celdas[COLUMNA_SUBTOTAL + 1 + desplazamiento] =
      sinPrecio === 1
        ? 'No incluye 1 ítem sin precio.'
        : `No incluye ${sinPrecio} ítems sin precio.`;
  }

  const fila = hoja.addRow(celdas);
  fila.font = { bold: true };
  fila.getCell(COLUMNA_SUBTOTAL + desplazamiento).numFmt = NUM2;
}

function hojaReferencias(
  wb: ExcelJS.Workbook,
  obra: ObraExport,
  items: readonly ItemExport[],
  fecha: Date,
  rubro: RubroId | 'todos',
): void {
  const hoja = wb.addWorksheet(NOMBRE_HOJA_REFERENCIAS);
  hoja.columns = [{ width: 22 }, { width: 96 }];

  const titulo = hoja.addRow([DISCLAIMER]);
  titulo.font = { bold: true };
  hoja.addRow([]);

  const datos: ReadonlyArray<readonly [string, string]> = [
    ['Obra', obra.nombre],
    ['Zona', obra.zona],
    ['Tipo de obra', ETIQUETA_TIPO_OBRA[obra.tipo]],
    ['Moneda', obra.moneda],
    ['Generado', fechaLegible(fecha)],
    ['Alcance', rubro === 'todos' ? 'Todos los rubros' : PLANTILLAS[rubro].nombre],
    ['Ítems activos', String(items.length)],
  ];
  for (const [etiqueta, valor] of datos) {
    hoja.addRow([etiqueta, valor]).getCell(1).font = { bold: true };
  }

  hoja.addRow([]);
  hoja.addRow(['Orígenes']).getCell(1).font = { bold: true };
  for (const [etiqueta, explicacion] of LEYENDA_ORIGENES) {
    hoja.addRow([etiqueta, explicacion]);
  }

  hoja.addRow([]);
  hoja.addRow(['Cómo leerlo']).getCell(1).font = { bold: true };
  hoja.addRow([
    'Cant. neta',
    'Lo que la obra necesita, sin desperdicio.',
  ]);
  hoja.addRow([
    'Cant. compra',
    'Cant. neta más el desperdicio, redondeada hacia arriba a la presentación comercial.',
  ]);
  hoja.addRow([
    'Confianza',
    'De 0 a 1. Por debajo de 0,70 el dato quedó como consulta abierta en la bandeja.',
  ]);
  hoja.addRow([
    'Lámina(s) fuente',
    'De qué lámina salió la fila. Una fila sin lámina es un ítem cargado a mano.',
  ]);
  hoja.addRow([
    'Precio unit. / Subtotal',
    'Precio de referencia del estudio (lista, índice propio o cargado a mano) por la cantidad de compra. Una celda vacía es un ítem sin precio, no un ítem gratis: los totales lo dicen.',
  ]);
  hoja.addRow([
    'Fecha del precio',
    'Del día para la lista y el precio cargado a mano; del mes para el índice, que es mensual.',
  ]);

  hoja.addRow([]);
  hoja.addRow(['Total estimado']).getCell(1).font = { bold: true };
  const { total, sinPrecio } = totalizar(items);
  hoja.addRow([
    // `formatearMonto` y no `toFixed(2)`: eso escribía `ARS 1234500.00` —punto
    // decimal, sin separador de miles, la moneda en código— en el único lugar
    // del libro donde se lee el total de la obra. La app entera escribe
    // `$ 1.234.500,00`.
    formatearMonto(obra.moneda, total),
    sinPrecio === 0
      ? 'Suma de los subtotales de todos los ítems exportados.'
      : sinPrecio === 1
        ? 'Suma de los subtotales. Queda 1 ítem sin precio y no está contado acá.'
        : `Suma de los subtotales. Quedan ${sinPrecio} ítems sin precio y no están contados acá.`,
  ]);
}

/**
 * Genera el libro de cómputo.
 *
 * @param obra          Datos de cabecera (van a la hoja Referencias).
 * @param items         Filas de `computo_items`. Los `anulado` se descartan acá:
 *                      la base no los borra (`src/db/CLAUDE.md` §7) pero el
 *                      export es la foto de lo que se compra.
 * @param estadosRubro  Estado de aprobación por rubro; ausente ⇒ `borrador`.
 * @param laminas       Láminas de la obra, para poder nombrar `fuentes_json`.
 *                      Es un parámetro extra al contrato original: sin él la
 *                      columna `Lámina(s) fuente` solo podría escupir uuids.
 * @param opciones      `rubro` acota el libro a un rubro; `fecha` fija el sello.
 */
export async function generarXlsx(
  obra: ObraExport,
  items: readonly ItemExport[],
  estadosRubro: EstadosRubro,
  laminas: readonly LaminaExport[] = [],
  opciones: OpcionesXlsx = {},
): Promise<Buffer> {
  const rubroPedido = opciones.rubro ?? 'todos';
  const fecha = opciones.fecha ?? new Date();

  const activos = items.filter(
    (item) => item.estado === 'activo' && (rubroPedido === 'todos' || item.rubro === rubroPedido),
  );
  const porId = new Map(laminas.map((l) => [l.id, l]));
  const rubrosEnJuego: readonly RubroId[] = rubroPedido === 'todos' ? RUBROS : [rubroPedido];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Compulsa';
  wb.created = fecha;

  // Una hoja por rubro, siempre: un rubro sin ítems se ve vacío, que es
  // información ("acá todavía no hay cómputo"), no un rubro que desapareció.
  for (const rubro of rubrosEnJuego) {
    const hoja = crearHoja(wb, PLANTILLAS[rubro].nombre, COLUMNAS);
    const delRubro = activos.filter((i) => i.rubro === rubro);
    for (const item of delRubro) {
      agregarFila(hoja, COLUMNAS, celdasItem(item, estadosRubro, porId));
    }
    agregarTotal(hoja, COLUMNAS, `Total ${PLANTILLAS[rubro].nombre.toLowerCase()}`, delRubro, 0);
  }

  if (rubroPedido === 'todos') {
    const hoja = crearHoja(wb, NOMBRE_HOJA_CONSOLIDADO, COLUMNAS_CONSOLIDADO);
    for (const rubro of RUBROS) {
      const delRubro = activos.filter((i) => i.rubro === rubro);
      for (const item of delRubro) {
        agregarFila(hoja, COLUMNAS_CONSOLIDADO, [
          PLANTILLAS[rubro].nombre,
          ...celdasItem(item, estadosRubro, porId),
        ]);
      }
      // Un subtotal por rubro adentro de la consolidada, en el orden canónico:
      // es la lectura que hace el arquitecto antes de pedir cotizaciones.
      agregarTotal(hoja, COLUMNAS_CONSOLIDADO, `Total ${PLANTILLAS[rubro].nombre.toLowerCase()}`, delRubro, 1);
    }
    // Sentence case como sus hermanas de arriba («Total seco», «Total pintura»):
    // la mayúscula sostenida era la única de todo el libro.
    agregarTotal(hoja, COLUMNAS_CONSOLIDADO, 'Total general', activos, 1);
  }

  hojaReferencias(wb, obra, activos, fecha, rubroPedido);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
