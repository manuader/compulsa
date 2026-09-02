/**
 * Planilla de carpinterías **derivada** (RF-504).
 *
 * El caso real: el expediente trae las ventanas dibujadas en la planta y la
 * planilla de carpinterías no existe, o existe a medias. Con lo que el sistema
 * leyó de los planos y lo que el arquitecto validó, se puede reconstruir —y eso
 * es lo que sale de acá—.
 *
 * Tres cosas que este archivo no negocia:
 *
 * 1. **Dice lo que es.** El libro se abre con "DOCUMENTACIÓN DERIVADA — no
 *    reemplaza a la documentación original" y lleva el descargo profesional de
 *    §12. Una planilla derivada que se hace pasar por la del proyecto es
 *    exactamente el problema que el PRD quiere evitar.
 * 2. **Cada fila declara de dónde salió su medida** (columna `Origen del dato`).
 *    Explícito, deducido y validado, o todavía pendiente: las tres cosas son
 *    distintas y la que las mezcla es la que hace pifiar una compra.
 * 3. **Lo propuesto no entra** (P4). Solo se escriben medidas explícitas o
 *    deducciones que una persona validó; una propuesta que nadie miró deja la
 *    celda vacía y la fila marcada como pendiente.
 *
 * Módulo puro: no toca la base ni el filesystem. La route handler consulta y le
 * pasa las filas ya armadas.
 */
import ExcelJS from 'exceljs';

import { DISCLAIMER, fechaIso, fechaLegible, slugObra, type ObraExport } from '@/lib/export/xlsx';
import type { Origen } from '@/types/domain';

// --- Contrato de datos -----------------------------------------------------

/**
 * De dónde salió la medida de una carpintería.
 *
 * `inferido` es el nivel C del §5.5: la medida se sacó midiendo sobre el dibujo
 * a escala, no leyendo un número escrito. Va separado de `deducido` porque no
 * es lo mismo cruzar dos láminas que medir con la regla sobre el plano, y quien
 * fabrica una carpintería con esta planilla tiene derecho a saber cuál de las
 * dos cosas pasó.
 */
export type OrigenDato = 'explicito' | 'deducido' | 'inferido' | 'pendiente';

export interface FilaCarpinteria {
  /** "V2", "P1" — el tag con el que se pide la cotización. */
  tag: string;
  tipologia: string | null;
  anchoM: number | null;
  altoM: number | null;
  material: string | null;
  vidrio: string | null;
  origen: OrigenDato;
  /** Códigos de las láminas que sostienen la fila, ya legibles. */
  laminas: string;
}

/**
 * Con qué origen sale una fila, a partir de lo que se sabe de sus medidas.
 *
 * Vive acá y no en la route para poder pinnearlo: es una decisión de producto
 * —qué se le dice a quien va a mandar a fabricar— y no un detalle de un handler.
 *
 * El **peor** origen manda, igual que en el ítem de cómputo (§5.5): si el ancho
 * está acotado y el alto se midió sobre el dibujo, la fila es `inferido`. Decir
 * «deducido validado» de una medida sacada con la regla sería vender una
 * medición gráfica como un cruce documental.
 *
 * @param faltaAlgunaMedida `true` si el ancho o el alto no están: sin medida no
 *   hay fila que fabricar, y eso gana sobre todo lo demás.
 * @param origenes El origen de cada medida que **no** salió de la documentación
 *   escrita (las explícitas no aportan nada acá).
 */
export function origenDeCarpinteria(
  faltaAlgunaMedida: boolean,
  origenes: readonly Origen[],
): OrigenDato {
  if (faltaAlgunaMedida) return 'pendiente';
  if (origenes.includes('inferido')) return 'inferido';
  return origenes.some((origen) => origen !== 'explicito') ? 'deducido' : 'explicito';
}

export interface OpcionesPlanilla {
  /** Fecha del export. Inyectable para que los tests no dependan del reloj. */
  fecha?: Date;
}

export const AVISO_DERIVADA =
  'DOCUMENTACIÓN DERIVADA — no reemplaza a la documentación original';

export const ETIQUETA_ORIGEN_DATO: Record<OrigenDato, string> = {
  explicito: 'Explícito',
  deducido: 'Deducido validado',
  inferido: 'Inferido (medido sobre el dibujo)',
  pendiente: 'Pendiente',
};

const LEYENDA_ORIGENES: ReadonlyArray<readonly [string, string]> = [
  [
    ETIQUETA_ORIGEN_DATO.explicito,
    'La medida está escrita en la documentación original (cota o planilla del proyecto).',
  ],
  [
    ETIQUETA_ORIGEN_DATO.deducido,
    'La medida la dedujo el sistema cruzando dos láminas y una persona del estudio la validó.',
  ],
  [
    ETIQUETA_ORIGEN_DATO.inferido,
    'La medida se sacó midiendo sobre el dibujo a escala, no de una cota. Es la evidencia más débil: verificala antes de mandar a fabricar.',
  ],
  [
    ETIQUETA_ORIGEN_DATO.pendiente,
    'Falta la medida. Si hay una deducción propuesta, está esperando validación en la bandeja de deducciones: hasta entonces no se escribe.',
  ],
];

export const NOMBRE_HOJA_PLANILLA = 'Carpinterías';

interface DefColumna {
  header: string;
  width: number;
  numFmt?: string;
}

const NUM2 = '0.00';

const COLUMNAS: readonly DefColumna[] = [
  { header: 'Tag', width: 12 },
  { header: 'Tipología', width: 16 },
  { header: 'Ancho (m)', width: 12, numFmt: NUM2 },
  { header: 'Alto (m)', width: 12, numFmt: NUM2 },
  { header: 'Material', width: 18 },
  { header: 'Vidrio', width: 16 },
  { header: 'Origen del dato', width: 20 },
  { header: 'Lámina(s) fuente', width: 30 },
];

export const COLUMNAS_CARPINTERIA: readonly string[] = COLUMNAS.map((c) => c.header);

/** Fila 1 del encabezado, para que el aviso viaje aunque se imprima la hoja. */
const FILAS_ENCABEZADO = 4;

/**
 * `planilla-carpinterias-casa-perez-2026-08-26.xlsx`. Sin acentos ni nada fuera
 * de `[a-z0-9-]`, por el `Content-Disposition` (mismo criterio que el cómputo).
 */
export function nombreArchivoPlanilla(nombreObra: string, fecha: Date): string {
  const slug = slugObra(nombreObra) || 'obra';
  return `planilla-carpinterias-${slug}-${fechaIso(fecha)}.xlsx`;
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Genera el libro de la planilla derivada.
 *
 * @param obra     Datos de cabecera de la obra.
 * @param filas    Una por entidad `abertura` de la obra, ya resuelta.
 * @param opciones `fecha` fija el sello del archivo.
 */
export async function generarPlanillaCarpinterias(
  obra: ObraExport,
  filas: readonly FilaCarpinteria[],
  opciones: OpcionesPlanilla = {},
): Promise<Buffer> {
  const fecha = opciones.fecha ?? new Date();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Compulsa';
  wb.created = fecha;

  const hoja = wb.addWorksheet(NOMBRE_HOJA_PLANILLA);
  hoja.columns = COLUMNAS.map((c) => ({ width: c.width }));

  const aviso = hoja.addRow([AVISO_DERIVADA]);
  aviso.font = { bold: true };
  hoja.addRow([`${DISCLAIMER}.`]);
  hoja.addRow([`${obra.nombre} · ${obra.zona} · generada el ${fechaLegible(fecha)}`]);
  hoja.addRow([]);

  const encabezado = hoja.addRow(COLUMNAS.map((c) => c.header));
  encabezado.font = { bold: true };
  // El aviso y el encabezado quedan siempre a la vista al scrollear.
  hoja.views = [{ state: 'frozen', ySplit: FILAS_ENCABEZADO + 1 }];

  for (const carpinteria of filas) {
    const fila = hoja.addRow([
      carpinteria.tag,
      carpinteria.tipologia ? capitalizar(carpinteria.tipologia) : null,
      carpinteria.anchoM,
      carpinteria.altoM,
      carpinteria.material,
      carpinteria.vidrio,
      ETIQUETA_ORIGEN_DATO[carpinteria.origen],
      carpinteria.laminas || null,
    ]);
    COLUMNAS.forEach((columna, i) => {
      if (columna.numFmt) fila.getCell(i + 1).numFmt = columna.numFmt;
    });
  }

  const referencias = wb.addWorksheet('Referencias');
  referencias.columns = [{ width: 22 }, { width: 96 }];
  referencias.addRow([AVISO_DERIVADA]).font = { bold: true };
  referencias.addRow([DISCLAIMER]);
  referencias.addRow([]);

  const datos: ReadonlyArray<readonly [string, string]> = [
    ['Obra', obra.nombre],
    ['Zona', obra.zona],
    ['Generada', fechaLegible(fecha)],
    ['Carpinterías', String(filas.length)],
    ['Pendientes', String(filas.filter((fila) => fila.origen === 'pendiente').length)],
  ];
  for (const [etiqueta, valor] of datos) {
    referencias.addRow([etiqueta, valor]).getCell(1).font = { bold: true };
  }

  referencias.addRow([]);
  referencias.addRow(['Origen del dato']).getCell(1).font = { bold: true };
  for (const [etiqueta, explicacion] of LEYENDA_ORIGENES) {
    referencias.addRow([etiqueta, explicacion]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
