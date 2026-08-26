/**
 * La orden de compra que sale de adjudicar una compulsa (RF-1102).
 *
 * Es el único documento de esta fase que sale del sistema y entra a la
 * contabilidad de otro: lo recibe un corralón, lo archiva un administrativo y
 * alguien lo factura. Por eso tiene que decir, sin ambigüedad, **quién compra,
 * a quién, para qué obra, qué exactamente, a qué precio y bajo qué
 * condiciones** — las del PRD §13, que son las mismas con las que se pidió la
 * cotización.
 *
 * Tres decisiones que valen la pena:
 *
 *  1. **La orden repite las cantidades del pedido, no las del presupuesto.**
 *     Los `itemsAdjudicados` los arma quien adjudica a partir del cuadro
 *     comparativo, donde cada celda ya es `precio unitario × cantidad del RFQ`.
 *     Si el proveedor cotizó 25 ml donde se pedían 20, la orden compra 20.
 *  2. **Nada se rellena en silencio.** Sin plazo declarado la orden dice "a
 *     confirmar con el proveedor"; sin forma de pago, "a convenir". Inventar un
 *     plazo en un documento comercial es peor que no tenerlo.
 *  3. **El disclaimer viaja adentro del documento**, igual que en el export de
 *     cómputo: lo asiste el sistema, lo firma el profesional.
 *
 * Módulo **puro**: `generarOrdenCompra` es texto a texto; `ordenCompraPdf` es
 * texto a bytes con pdf-lib. Ninguna de las dos toca la base ni el filesystem.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { formatearCantidad } from '@/lib/computo/unidades';
import { formatearImporte } from '@/lib/compulsa/comparativa';
import { PLANTILLAS } from '@/lib/rubros';
import type { CondicionesRfq, RubroId, Unidad } from '@/types/domain';

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export interface EstudioOrdenCompra {
  nombre: string;
  /** `estudios.config_json.mepReferencia`. `null` ⇒ la orden no menciona dólares. */
  mepReferencia: { valor: number; fecha: string } | null;
}

export interface ObraOrdenCompra {
  nombre: string;
  zona: string;
  moneda: string;
}

export interface ProveedorOrdenCompra {
  nombre: string;
  /** Persona / teléfono con quien se habló. `null` ⇒ no se nombra a nadie. */
  contacto?: string | null;
}

/** Lo que la orden hereda del presupuesto que se aceptó. */
export interface CotizacionOrdenCompra {
  moneda: string;
  incluyeIva: boolean;
  validezDias: number | null;
  plazoDias: number | null;
  formaPago: string | null;
}

export interface ItemOrdenCompra {
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  /** La del pedido (RF-701), no la que cotizó el proveedor. */
  cantidad: number;
  precioUnitario: number;
  /** `precioUnitario × cantidad`, ya calculado por el cuadro comparativo. */
  importe: number;
}

export interface CondicionesOrdenCompra {
  rubro: RubroId;
  /** Versión de la compulsa (RF-701): identifica qué pedido se está comprando. */
  version: number;
  /** Total de la orden, en la moneda de la cotización. */
  total: number;
  /** Las condiciones con las que se pidió la cotización. */
  condiciones: CondicionesRfq;
  fecha: Date;
  /** Número de orden del estudio. `null` ⇒ el documento sale sin numerar. */
  numero?: string | null;
  notas?: string | null;
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

/**
 * Símbolo de cada moneda que el sistema sabe nombrar. Es la misma tabla que usa
 * el hilo de mensajes (`flujo.ts`), que es archivo de otra tarea; una moneda
 * desconocida sale con su código, nunca con un `$` que la haría pasar por pesos.
 */
const SIMBOLO_MONEDA: Record<string, string> = { ARS: '$', USD: 'US$' };

function simbolo(moneda: string): string {
  const codigo = moneda.trim().toUpperCase();
  return SIMBOLO_MONEDA[codigo] ?? codigo;
}

function monto(n: number, moneda: string): string {
  return `${simbolo(moneda)} ${formatearImporte(n)}`;
}

const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';

const FORMATO_FECHA = new Intl.DateTimeFormat('es-AR', {
  timeZone: ZONA_HORARIA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** `26/08/2026` — el día de Buenos Aires, no el UTC del servidor. */
function fechaLegible(fecha: Date): string {
  return FORMATO_FECHA.format(fecha);
}

/** `2026-08-25` → `25/08/2026`. Es la forma en que se guarda la fecha del MEP. */
function fechaIsoLegible(iso: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : iso;
}

export const DISCLAIMER_ORDEN_COMPRA =
  'Documento asistido por Compulsa — sujeto a validación del profesional responsable.';

// ---------------------------------------------------------------------------
// El texto
// ---------------------------------------------------------------------------

function lineasDeCondiciones(
  cotizacion: CotizacionOrdenCompra,
  condiciones: CondicionesOrdenCompra,
): string[] {
  const lineas: string[] = [];

  lineas.push(
    cotizacion.incluyeIva
      ? '- Los precios de esta orden incluyen IVA. Pedimos factura con el IVA discriminado.'
      : '- Los precios de esta orden no incluyen IVA: se factura con IVA discriminado.',
  );

  lineas.push(
    cotizacion.plazoDias !== null
      ? `- Plazo de entrega: ${cotizacion.plazoDias} días corridos desde la recepción de esta orden.`
      : '- Plazo de entrega: a confirmar con el proveedor.',
  );

  lineas.push(
    cotizacion.formaPago?.trim()
      ? `- Forma de pago: ${cotizacion.formaPago.trim()}.`
      : '- Forma de pago: a convenir.',
  );

  if (condiciones.condiciones.separarManoObraMateriales) {
    lineas.push('- La factura tiene que discriminar mano de obra, materiales y flete.');
  }

  if (cotizacion.validezDias !== null) {
    lineas.push(
      `- Esta orden toma los precios de la cotización recibida, con validez de ${cotizacion.validezDias} días corridos.`,
    );
  }

  const notasRfq = condiciones.condiciones.notas?.trim();
  if (notasRfq) lineas.push(`- ${notasRfq}`);

  const notas = condiciones.notas?.trim();
  if (notas) lineas.push(`- ${notas}`);

  return lineas;
}

/**
 * La orden de compra completa, lista para mandar o para imprimir.
 *
 * @throws RangeError si no hay estudio que la firme (PRD §13) o no hay ítems:
 * las dos cosas hacen del documento un papel sin valor, y degradarlo en
 * silencio sería peor que fallar.
 */
export function generarOrdenCompra(
  estudio: EstudioOrdenCompra,
  obra: ObraOrdenCompra,
  proveedor: ProveedorOrdenCompra,
  cotizacion: CotizacionOrdenCompra,
  itemsAdjudicados: readonly ItemOrdenCompra[],
  condiciones: CondicionesOrdenCompra,
): string {
  const nombreEstudio = estudio.nombre.trim();
  if (nombreEstudio === '') {
    throw new RangeError('Una orden de compra la emite un estudio: falta el nombre del estudio.');
  }
  if (itemsAdjudicados.length === 0) {
    throw new RangeError('Una orden de compra sin ningún ítem adjudicado no se emite.');
  }

  const bloques: string[] = [];

  const encabezado = ['ORDEN DE COMPRA'];
  if (condiciones.numero?.trim()) encabezado.push(`Número: ${condiciones.numero.trim()}`);
  encabezado.push(`Fecha: ${fechaLegible(condiciones.fecha)}`);
  bloques.push(encabezado.join('\n'));

  const partes = [
    `Emite: ${nombreEstudio}`,
    `Proveedor: ${proveedor.nombre.trim()}`,
  ];
  if (proveedor.contacto?.trim()) partes.push(`Contacto: ${proveedor.contacto.trim()}`);
  partes.push(`Obra: ${obra.nombre} (${obra.zona})`);
  partes.push(
    `Rubro: ${PLANTILLAS[condiciones.rubro].nombre} — compulsa versión ${condiciones.version}`,
  );
  bloques.push(partes.join('\n'));

  const detalle = ['DETALLE'];
  itemsAdjudicados.forEach((item, i) => {
    detalle.push(
      `${i + 1}. ${formatearCantidad(item.cantidad, item.unidad)} — ${item.descripcion}`,
    );
    detalle.push(
      `   Precio unitario: ${monto(item.precioUnitario, cotizacion.moneda)} — Importe: ${monto(item.importe, cotizacion.moneda)}`,
    );
  });
  bloques.push(detalle.join('\n'));

  bloques.push(`TOTAL: ${monto(condiciones.total, cotizacion.moneda)}`);

  bloques.push(['CONDICIONES', ...lineasDeCondiciones(cotizacion, condiciones)].join('\n'));

  // El MEP es una referencia del estudio, no una cláusula: dice contra qué
  // dólar se estaba mirando el precio el día que se compró. Sin MEP cargado la
  // orden no lo menciona (P4: no se inventa una cotización de dólar).
  if (estudio.mepReferencia) {
    bloques.push(
      `Referencia: dólar MEP de referencia del estudio: $ ${formatearImporte(estudio.mepReferencia.valor)} al ${fechaIsoLegible(estudio.mepReferencia.fecha)}.`,
    );
  }

  bloques.push(
    [
      `${nombreEstudio} confirma la compra de los ítems detallados. Cualquier cambio de especificación,`,
      'cantidad o precio tiene que consultarse antes de despachar.',
      '',
      DISCLAIMER_ORDEN_COMPRA,
    ].join('\n'),
  );

  return bloques.join('\n\n');
}

// ---------------------------------------------------------------------------
// El PDF
// ---------------------------------------------------------------------------

/** A4 vertical en puntos PostScript. */
const ANCHO = 595.28;
const ALTO = 841.89;
const MARGEN = 56;
const TAMANO = 10;
const INTERLINEADO = 14;

/**
 * Caracteres que WinAnsi —la codificación de las fuentes estándar de PDF— no
 * puede escribir, traducidos a algo que sí. Sin esto, un `≥` pegado por un
 * usuario hace que `drawText` lance y la descarga se caiga entera.
 */
const REEMPLAZOS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[≥]/g, '>='],
  [/[≤]/g, '<='],
  [/[≠]/g, '!='],
  [/[→]/g, '->'],
  [/[×]/g, 'x'],
  [/\t/g, '    '],
];

/** Lo que WinAnsi sí puede escribir: Latin-1 más los signos tipográficos usuales. */
const ENCODABLE = /[\x20-\x7E\xA0-\xFF–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜]/;

function sanearParaPdf(texto: string): string {
  let salida = texto;
  for (const [patron, reemplazo] of REEMPLAZOS) salida = salida.replace(patron, reemplazo);
  return [...salida].map((c) => (ENCODABLE.test(c) ? c : ' ')).join('');
}

/** Parte una línea en varias que entren en `ancho`, sin cortar palabras si se puede. */
function envolver(
  linea: string,
  ancho: number,
  medir: (texto: string) => number,
): string[] {
  if (linea === '') return [''];
  if (medir(linea) <= ancho) return [linea];

  const salida: string[] = [];
  let actual = '';

  for (const palabra of linea.split(' ')) {
    const candidata = actual === '' ? palabra : `${actual} ${palabra}`;
    if (medir(candidata) <= ancho) {
      actual = candidata;
      continue;
    }
    if (actual !== '') {
      salida.push(actual);
      actual = '';
    }
    // Una palabra sola más ancha que la hoja (una ref, una URL) se corta por
    // carácter: preferimos partirla a que se salga del margen.
    let resto = palabra;
    while (medir(resto) > ancho) {
      let corte = resto.length - 1;
      while (corte > 1 && medir(resto.slice(0, corte)) > ancho) corte -= 1;
      salida.push(resto.slice(0, corte));
      resto = resto.slice(corte);
    }
    actual = resto;
  }

  if (actual !== '') salida.push(actual);
  return salida;
}

/**
 * El texto de la orden como PDF A4, monoespaciado en Helvetica y paginado.
 *
 * Deliberadamente simple: sin logo, sin tablas dibujadas, sin fuentes
 * embebidas. Lo que tiene que sobrevivir es el contenido — el mismo texto que
 * `generarOrdenCompra` devuelve y que queda guardado en `adjudicaciones.oc_texto`.
 */
export async function ordenCompraPdf(texto: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Orden de compra');
  doc.setProducer('Compulsa');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const anchoUtil = ANCHO - MARGEN * 2;
  const medir = (t: string) => font.widthOfTextAtSize(t, TAMANO);

  const lineas = sanearParaPdf(texto)
    .split('\n')
    .flatMap((linea) => envolver(linea, anchoUtil, medir));

  let pagina = doc.addPage([ANCHO, ALTO]);
  let y = ALTO - MARGEN;

  for (const linea of lineas) {
    if (y < MARGEN) {
      pagina = doc.addPage([ANCHO, ALTO]);
      y = ALTO - MARGEN;
    }
    if (linea !== '') {
      pagina.drawText(linea, { x: MARGEN, y, size: TAMANO, font });
    }
    y -= INTERLINEADO;
  }

  return doc.save();
}
