/**
 * El texto del pedido de cotización, en castellano de gremio.
 *
 * Lo escribe un asistente, no una persona, y el PRD §13 obliga a que eso se
 * diga: el mensaje arranca identificándose como el asistente del estudio. Lo
 * demás que exige el compliance también es parte del texto, no del criterio de
 * quien lo manda — IVA discriminado, mano de obra / materiales / flete
 * separados cuando el estudio lo pide, validez mínima, plazo y cotización por
 * escrito.
 *
 * Lo que el texto **no** dice es tan importante como lo que dice: del proyecto
 * viaja la zona y nada más. Ni la dirección, ni el comitente, ni el nombre de la
 * obra. Por eso la entrada de esta función es un objeto chico y propio
 * (`CompulsaParaTexto`) en vez de la fila de `compulsas` con la obra colgada:
 * si el dato no entra, no se puede filtrar por accidente.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import { ETIQUETA_UNIDAD, formatearNumero } from '@/lib/computo/unidades';
import { PLANTILLAS } from '@/lib/rubros';
import type { CondicionesRfq, ItemRfq, RubroId } from '@/types/domain';

/** Lo único que el texto puede saber de la compulsa (y del proyecto: la zona). */
export interface CompulsaParaTexto {
  rubro: RubroId;
  /** Zona/localidad para que el proveedor sepa si llega. `null` ⇒ no se menciona. */
  zona: string | null;
  itemsRfq: readonly ItemRfq[];
  condiciones: CondicionesRfq;
}

/** "3 u — Ventana V2 corrediza (a medida). Especificación no sustituible: vidrio DVH." */
function lineaDeItem(item: ItemRfq, numero: number): string {
  const cantidad = `${formatearNumero(item.cantidad)} ${ETIQUETA_UNIDAD[item.unidad]}`;
  const presentacion = item.presentacion.trim() === '' ? '' : ` (${item.presentacion})`;

  const specs = Object.entries(item.specsCriticas).map(([clave, valor]) => `${clave} ${valor}`);
  const detalle =
    specs.length === 0 ? '' : ` Especificación no sustituible: ${specs.join(', ')}.`;

  return `${numero}. ${cantidad} — ${item.descripcion}${presentacion}.${detalle}`;
}

function lineasDeCondiciones(condiciones: CondicionesRfq): string[] {
  const lineas = ['- Precios con IVA discriminado.'];

  lineas.push(
    condiciones.separarManoObraMateriales
      ? '- Separá mano de obra, materiales y flete: los necesitamos por separado para comparar.'
      : '- Aclará si el precio incluye el flete a obra.',
  );

  lineas.push(`- Validez de la oferta: ${condiciones.validezMinimaDias} días corridos como mínimo.`);

  lineas.push(
    condiciones.plazoEntregaDias === null
      ? '- Plazo de entrega: decinos en cuántos días corridos podés entregar desde la orden de compra.'
      : `- Plazo de entrega: hasta ${condiciones.plazoEntregaDias} días corridos desde la orden de compra.`,
  );

  const notas = condiciones.notas?.trim();
  if (notas) lineas.push(`- ${notas}`);

  return lineas;
}

/**
 * El mensaje completo para mandarle al proveedor, listo para copiar y pegar.
 *
 * `estudioNombre` es obligatorio: sin el nombre del estudio el mensaje no
 * cumple la identificación del PRD §13, así que es un error de programa, no un
 * texto degradado.
 */
export function generarTextoRfq(compulsa: CompulsaParaTexto, estudioNombre: string): string {
  const estudio = estudioNombre.trim();
  if (estudio === '') {
    throw new RangeError('El pedido de cotización tiene que ir firmado por el estudio: falta el nombre del estudio.');
  }
  if (compulsa.itemsRfq.length === 0) {
    throw new RangeError('Un pedido de cotización sin ítems no se manda.');
  }

  const rubro = PLANTILLAS[compulsa.rubro].nombre.toLowerCase();
  const zona = compulsa.zona?.trim();
  const dondeEsLaObra = zona ? `para una obra en ${zona}` : 'para una obra';

  const bloques = [
    'Hola, ¿cómo va?',
    `Soy el asistente de ${estudio} y armo los pedidos de cotización del estudio. ` +
      `Estamos pidiendo precio de ${rubro} ${dondeEsLaObra}.`,
    'Esto es lo que necesitamos cotizar:',
    compulsa.itemsRfq.map((item, indice) => lineaDeItem(item, indice + 1)).join('\n'),
    'Condiciones del pedido:',
    lineasDeCondiciones(compulsa.condiciones).join('\n'),
    '¿Nos pasás la cotización por escrito (PDF o planilla), ítem por ítem y con la cantidad de cada uno? ' +
      'Si algo no lo hacés, o lo cotizás con otra especificación, aclaralo en la respuesta: ' +
      'así lo comparamos como corresponde y no te dejamos afuera por una diferencia de criterio.',
    'Gracias.',
  ];

  return bloques.join('\n\n');
}
