/**
 * Motor de negociación con mandato (RF-1001 / RF-1002).
 *
 * Decide si corresponde contraofertar y, si corresponde, arma el texto. Tres
 * reglas duras, en este orden:
 *
 * 1. **Una línea `sustituto` escala siempre** (RF-1002, P0): si el proveedor
 *    cambió una especificación, el motor no negocia — eso lo decide el
 *    arquitecto, y ninguna urgencia de precio lo destraba.
 * 2. **Máximo 2 rondas** (`Mandato.maxRondas`, fijo por PRD).
 * 3. **Solo si hay diferencia real**: `total > (1 − objetivoMejoraPct/100) ×
 *    mejorTotalComparable`.
 *
 * El texto usa **solo** las palancas del mandato, con frases fijas
 * (`FRASES_PALANCA`): el motor no improvisa concesiones ni promete números que
 * el estudio no autorizó, y nunca le revela al proveedor el total de la
 * competencia — le muestra su número y el objetivo, nada más.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import { redondear2 } from '@/lib/computo/unidades';
import type { Mandato } from '@/types/domain';

type Palanca = Mandato['palancas'][number];

/**
 * Lo único que el motor puede ofrecer, palabra por palabra.
 *
 * Son las cuatro palancas de RF-1001 y nada más. Están acá afuera para que los
 * tests (y P5, al armar el mensaje) verifiquen por substring que el texto no
 * ofrece nada que el mandato no habilite.
 */
export const FRASES_PALANCA: Record<Palanca, string> = {
  volumen: 'Podemos concentrar en vos todo el volumen del rubro en esta obra.',
  plazo_pago: 'Podemos revisar el plazo de pago y acomodarlo a lo que te sirva.',
  fecha: 'Podemos mover la fecha de entrega dentro de lo que le convenga a tu logística.',
  adjudicacion_inmediata: 'Si llegamos a ese número, adjudicamos en el acto y sale la orden de compra.',
};

export interface EntradaContraoferta {
  /** Total normalizado de la cotización que estamos negociando. */
  totalCotizado: number;
  /** Total más bajo de la comparativa. NO se le muestra al proveedor. */
  mejorTotalComparable: number;
  /** ¿La conciliación marcó alguna línea `sustituto`? */
  tieneSustituciones: boolean;
  /** Ronda que estaría por abrirse, 1-based. */
  ronda: number;
  mandato: Mandato;
  proveedorNombre: string;
  rubroNombre: string;
}

/** Por qué el motor no contraoferta. */
export type MotivoNoProcede = 'dentro_de_objetivo' | 'max_rondas' | 'escala_spec';

export type ResultadoContraoferta =
  | { procede: false; motivo: MotivoNoProcede }
  | { procede: true; texto: string; objetivoTotal: number };

/** Monto en formato es-AR: miles con punto, decimales con coma, sin ceros de relleno. */
function formatearMonto(n: number): string {
  const valor = redondear2(n);
  const texto = Number.isInteger(valor) ? String(valor) : valor.toFixed(2).replace('.', ',');
  const [entera, decimal] = texto.split(',');
  const conMiles = entera.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return decimal === undefined ? conMiles : `${conMiles},${decimal}`;
}

function exigirMontoPositivo(n: number, que: string): void {
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${que} tiene que ser un número positivo: ${String(n)}.`);
  }
}

function armarTexto(entrada: EntradaContraoferta, objetivoTotal: number): string {
  const { proveedorNombre, rubroNombre, totalCotizado, mandato } = entrada;
  // Sin `Set` ni orden propio: se respeta el orden del mandato y se filtran
  // palancas desconocidas, para que el texto no pueda ofrecer nada de más.
  const frases = mandato.palancas.filter((p) => p in FRASES_PALANCA).map((p) => `- ${FRASES_PALANCA[p]}`);

  const bloques = [
    `Hola, ${proveedorNombre}. Soy el asistente del estudio y estoy siguiendo la compulsa de ${rubroNombre}.`,
    `Tu cotización quedó en ${formatearMonto(totalCotizado)}. Para poder adjudicarte necesitamos llegar a ${formatearMonto(objetivoTotal)}.`,
  ];
  if (frases.length > 0) {
    bloques.push(['De nuestro lado podemos acompañarte con esto:', ...frases].join('\n'));
  }
  bloques.push(
    'Las especificaciones y los ítems del pedido no cambian: es el mismo listado que te pasamos, con IVA discriminado y con mano de obra, materiales y flete separados. Si querés proponer un cambio de especificación, decímelo y lo consulto con el estudio antes de avanzar.',
    '¿Lo podés revisar y confirmarme? Si no llegás a ese número, contame hasta dónde podés y lo llevo al estudio.',
  );
  return bloques.join('\n\n');
}

/**
 * Decide y arma la contraoferta de una ronda.
 *
 * El corte de precio es estricto: si el total ya está en el objetivo (o por
 * debajo), no se negocia — apretar a un proveedor que ya cumplió el mandato es
 * quemar la relación sin mandato para hacerlo.
 */
export function proponerContraoferta(entrada: EntradaContraoferta): ResultadoContraoferta {
  const { totalCotizado, mejorTotalComparable, ronda, mandato } = entrada;
  exigirMontoPositivo(totalCotizado, 'El total cotizado');
  exigirMontoPositivo(mejorTotalComparable, 'El mejor total comparable');
  if (!Number.isInteger(ronda) || ronda < 1) {
    throw new Error(`La ronda de negociación tiene que ser un entero desde 1: ${String(ronda)}.`);
  }
  if (!Number.isFinite(mandato.objetivoMejoraPct) || mandato.objetivoMejoraPct < 0 || mandato.objetivoMejoraPct >= 100) {
    throw new Error(
      `El objetivo de mejora del mandato tiene que estar entre 0 y 100: ${String(mandato.objetivoMejoraPct)}.`,
    );
  }

  // RF-1002 primero: un cambio de spec escala aunque sobre precio y ronda.
  if (entrada.tieneSustituciones) return { procede: false, motivo: 'escala_spec' };
  if (ronda > mandato.maxRondas) return { procede: false, motivo: 'max_rondas' };

  const objetivoTotal = redondear2((1 - mandato.objetivoMejoraPct / 100) * mejorTotalComparable);
  if (totalCotizado <= objetivoTotal) return { procede: false, motivo: 'dentro_de_objetivo' };

  return { procede: true, texto: armarTexto(entrada, objetivoTotal), objetivoTotal };
}
