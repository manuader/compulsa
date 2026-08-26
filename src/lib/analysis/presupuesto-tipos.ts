/**
 * Vocabulario compartido del parser de presupuestos.
 *
 * Es el espejo de `tipos.ts` (el de las láminas) para el otro documento no
 * estructurado del sistema: el presupuesto que manda el proveedor. Acá viven la
 * interfaz del provider, el shape de un presupuesto leído —que es a la vez el de
 * los fixtures del mock y el de la salida estructurada de Claude— y el saneo del
 * cable laxo.
 *
 * ## Por qué el cable es laxo (mismo patrón que `sanearAnalisis`)
 *
 * La gramática de structured outputs garantiza claves y enums, pero no rangos
 * numéricos: un `precioUnitario: -1` o un `validezDias: 0` pasan la generación y
 * recién explotan al validar, tirando el presupuesto entero. Por eso el schema
 * del cable acepta números sueltos y `sanearPresupuesto()` aplica el contrato
 * línea por línea: lo recuperable se limpia, lo inutilizable se descarta y se
 * cuenta.
 *
 * El saneo **no reusa** `sanearAnalisis`: comparten la forma general (laxo →
 * estricto, descartando y contando) pero no la regla. Allá se clampan bbox y
 * confianzas a [0,1]; acá un número fuera de rango no se clampa —clampar un
 * precio sería inventarlo— sino que se anula. Un genérico sobre dos políticas
 * opuestas escondería las dos.
 *
 * Módulo puro salvo `getPresupuestoProvider()`, que solo elige implementación.
 */
import { z } from 'zod';

import { zLineaPresupuesto, type LineaPresupuesto } from '@/types/domain';

// Ciclo de imports a propósito: los dos providers dependen de este módulo para
// el contrato y este solo los usa dentro de `getPresupuestoProvider()`, nunca
// en la evaluación del módulo.
import { crearProviderPresupuestoClaude } from './presupuesto-claude';
import { crearProviderPresupuestoMock } from './presupuesto-mock';

/**
 * Lo que se le da a parsear: el texto pegado por el usuario, los bytes del PDF
 * que mandó el proveedor, o los dos. `nombre` es obligatorio porque es la clave
 * del fixture del mock y lo que se cita en la auditoría.
 */
export interface EntradaPresupuesto {
  nombre: string;
  texto?: string;
  pdfBytes?: Uint8Array;
}

/**
 * Lo que un presupuesto dice de sí mismo. **Todo es nullable**: si el proveedor
 * no lo declaró, el campo va `null` — el sistema no completa un plazo ni asume
 * que el IVA está incluido (CLAUDE.md §3).
 */
export interface MetadatosPresupuesto {
  /** Total declarado por el proveedor. `null` ⇒ no lo declaró (no se suma solo). */
  total: number | null;
  incluyeIva: boolean | null;
  validezDias: number | null;
  plazoDias: number | null;
  formaPago: string | null;
}

export interface PresupuestoParseado {
  lineas: LineaPresupuesto[];
  metadatos: MetadatosPresupuesto;
}

/**
 * La frontera con el mundo no determinístico, del lado del presupuesto. Dos
 * implementaciones: `crearProviderPresupuestoMock()` y
 * `crearProviderPresupuestoClaude()`.
 */
export interface PresupuestoProvider {
  parsear(entrada: EntradaPresupuesto): Promise<PresupuestoParseado>;
}

/** Nada declarado. Es lo que devuelve el mock sin fixture y sin texto. */
export const METADATOS_VACIOS: MetadatosPresupuesto = {
  total: null,
  incluyeIva: null,
  validezDias: null,
  plazoDias: null,
  formaPago: null,
};

// ---------------------------------------------------------------------------
// Contrato estricto (fixtures) y cable laxo (LLM)
// ---------------------------------------------------------------------------

export const zMetadatosPresupuesto = z.object({
  total: z.number().positive().nullable(),
  incluyeIva: z.boolean().nullable(),
  validezDias: z.number().int().positive().nullable(),
  plazoDias: z.number().int().nonnegative().nullable(),
  formaPago: z.string().min(1).nullable(),
});

/** Lo que tiene que cumplir un fixture del mock: se valida estricto. */
export const zPresupuestoParseado = z.object({
  lineas: z.array(zLineaPresupuesto),
  metadatos: zMetadatosPresupuesto,
});

const zLineaCruda = zLineaPresupuesto.extend({
  cantidad: z.number().nullable(),
  precioUnitario: z.number().nullable(),
  precioTotal: z.number().nullable(),
});

export const zPresupuestoCrudo = z.object({
  lineas: z.array(zLineaCruda),
  metadatos: z.object({
    total: z.number().nullable(),
    incluyeIva: z.boolean().nullable(),
    validezDias: z.number().nullable(),
    plazoDias: z.number().nullable(),
    formaPago: z.string().nullable(),
  }),
});

export type PresupuestoCrudo = z.infer<typeof zPresupuestoCrudo>;

/** Un número que sirve como precio o cantidad: finito y mayor a cero. */
function positivoONull(valor: number | null): number | null {
  if (valor === null || !Number.isFinite(valor) || valor <= 0) return null;
  return valor;
}

function diasONull(valor: number | null, minimo: number): number | null {
  if (valor === null || !Number.isFinite(valor) || !Number.isInteger(valor) || valor < minimo) {
    return null;
  }
  return valor;
}

function textoONull(valor: string | null): string | null {
  const limpio = valor?.trim() ?? '';
  return limpio === '' ? null : limpio;
}

/**
 * Aplica el contrato estricto sobre un presupuesto crudo.
 *
 * - **Líneas sin descripción se descartan y se cuentan**: una línea que no dice
 *   qué se está cotizando no se puede conciliar contra ningún ítem del pedido.
 * - **Cantidades y precios imposibles vuelven `null`**, no cero: un 0 o un
 *   negativo envenena el índice de precios (P2b: `acumularMuestra` lanza con
 *   ≤ 0) y un `null` es exactamente lo que dispara la repregunta al proveedor.
 * - **`validezDias` y `plazoDias`** tienen que ser enteros (días corridos); el
 *   plazo admite 0 —entrega inmediata— y la validez no.
 */
export function sanearPresupuesto(crudo: PresupuestoCrudo): {
  presupuesto: PresupuestoParseado;
  lineasDescartadas: number;
} {
  const lineas: LineaPresupuesto[] = [];
  let lineasDescartadas = 0;

  for (const cruda of crudo.lineas) {
    const descripcion = cruda.descripcion.trim();
    if (descripcion === '') {
      lineasDescartadas += 1;
      continue;
    }

    const saneada: LineaPresupuesto = {
      descripcion,
      unidad: textoONull(cruda.unidad),
      cantidad: positivoONull(cruda.cantidad),
      precioUnitario: positivoONull(cruda.precioUnitario),
      precioTotal: positivoONull(cruda.precioTotal),
      claveItemSugerida: textoONull(cruda.claveItemSugerida),
      notas: textoONull(cruda.notas),
    };

    const valida = zLineaPresupuesto.safeParse(saneada);
    if (valida.success) lineas.push(valida.data);
    else lineasDescartadas += 1;
  }

  return {
    presupuesto: {
      lineas,
      metadatos: {
        total: positivoONull(crudo.metadatos.total),
        incluyeIva: crudo.metadatos.incluyeIva,
        validezDias: diasONull(crudo.metadatos.validezDias, 1),
        plazoDias: diasONull(crudo.metadatos.plazoDias, 0),
        formaPago: textoONull(crudo.metadatos.formaPago),
      },
    },
    lineasDescartadas,
  };
}

// ---------------------------------------------------------------------------
// Elección de implementación
// ---------------------------------------------------------------------------

/**
 * Claude solo con `ANTHROPIC_API_KEY` **y** fuera de tests; si no, el mock.
 *
 * Misma condición y mismo motivo que `getAnalysisProvider()`: ninguna suite sale
 * a la red ni gasta tokens aunque la key esté exportada en la máquina. Vive acá
 * y no en `index.ts` porque ese archivo es de otra tarea; si algún día se
 * unifican los dos puntos de entrada, esta función se muda tal cual.
 */
export function getPresupuestoProvider(): PresupuestoProvider {
  if (process.env.NODE_ENV !== 'test' && process.env.ANTHROPIC_API_KEY) {
    return crearProviderPresupuestoClaude();
  }
  return crearProviderPresupuestoMock();
}
