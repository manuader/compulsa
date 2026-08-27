/**
 * Vocabulario compartido de la búsqueda dirigida.
 *
 * Es la **cuarta** familia de providers del módulo, hermana de `tipos.ts`
 * (láminas), `presupuesto-tipos.ts` (presupuestos) y `qa-tipos.ts` (preguntas al
 * expediente), y la que resuelve el reclamo que originó el rediseño: las medidas
 * de FP01 están escritas en la planilla de carpinterías (DET00) y el arquitecto
 * las estaba tipeando a mano porque la bandeja se las preguntaba de cero.
 *
 * ## Qué la hace distinta del análisis normal
 *
 * `extraerEntidades` mira una lámina y devuelve **todo lo que ve**. Acá el
 * pipeline ya sabe exactamente qué le falta —`anchoM` y `altoM` de la puerta
 * FP01— y vuelve a leer las láminas candidatas con esa lista en la mano. Es la
 * sistematización del prompt manual que el arquitecto escribe hoy en un chat:
 * "buscame el ancho y el alto de FP01 en esta planilla".
 *
 * ## La regla que gobierna todo el módulo
 *
 * **Solo se devuelve lo que se pidió.** El saneo (`sanearBusqueda`) descarta
 * todo dato cuya `clave` u `objetivo.campo` no estén en la lista de objetivos de
 * ESA llamada. Sin ese filtro, una respuesta entusiasta —o un fixture con más
 * datos de la cuenta— podría escribir una propuesta sobre un hallazgo que nadie
 * mandó a buscar, y el arquitecto vería un número aparecido de la nada en una
 * consulta que no tiene con qué explicar. Las dos implementaciones pasan por el
 * mismo saneo, así que un fixture no puede colar lo que el modelo no podría.
 *
 * ## Qué NO hace esto (P4)
 *
 * Nada de acá escribe en `entidades.atributos_json`. Lo que se encuentra viaja a
 * `hallazgos.valor_propuesto_json` como **propuesta**, y el dato entra a la
 * entidad recién cuando el arquitecto confirma. Ver `src/lib/pipeline/busqueda.ts`.
 */
import { z } from 'zod';

import type { BBox, LaminaInput, ObraContexto } from '@/types/domain';

// Ciclo de imports a propósito, igual que en `qa-tipos.ts` y
// `presupuesto-tipos.ts`: los dos providers dependen de este módulo para el
// contrato y este solo los usa dentro de `getBusquedaProvider()`, nunca en la
// evaluación del módulo.
import { crearProviderBusquedaClaude } from './busqueda-claude';
import { crearProviderBusquedaMock } from './busqueda-mock';

// ---------------------------------------------------------------------------
// Qué se busca y qué se encuentra
// ---------------------------------------------------------------------------

/**
 * Un dato que falta, expresado como pedido concreto.
 *
 * `clave` es la del hallazgo que lo pide (`aberturas.medidas_vano.FP01`): viaja
 * de ida y de vuelta para poder atribuir cada dato encontrado a la consulta que
 * lo motivó, sin que el provider tenga que saber nada de la base.
 */
export interface ObjetivoBusqueda {
  /** `hallazgos.clave` — única por obra. */
  clave: string;
  /** Qué se busca, en castellano: es lo que el modelo lee. */
  descripcion: string;
  /** Los campos que hay que completar, con los nombres del dominio. */
  campos: string[];
}

/** Un dato leído en la lámina, con su provenance (P1). */
export interface DatoEncontrado {
  clave: string;
  campo: string;
  valor: number | string;
  /** Dónde está escrito en la lámina. Sin bbox no hay dato. */
  bbox: BBox;
  confianza: number;
}

/**
 * La frontera con el mundo no determinístico, del lado de la búsqueda dirigida.
 * Dos implementaciones: `crearProviderBusquedaMock()` y
 * `crearProviderBusquedaClaude()`.
 *
 * Una llamada = una lámina. El pipeline decide qué láminas valen la pena y en
 * qué orden (`src/lib/pipeline/busqueda.ts`): esto solo mira la que le dan.
 */
export interface BusquedaProvider {
  buscarDatos(
    lamina: LaminaInput,
    objetivos: readonly ObjetivoBusqueda[],
    ctx: ObraContexto,
  ): Promise<DatoEncontrado[]>;
}

// ---------------------------------------------------------------------------
// Qué campos son medidas
// ---------------------------------------------------------------------------

/**
 * Campos numéricos que no llevan sufijo de unidad en el nombre. Son los dos
 * conteos del dominio (`src/lib/analysis/CLAUDE.md`, claves de `atributos`).
 */
export const CAMPOS_NUMERICOS: ReadonlySet<string> = new Set(['caras', 'cantidad']);

/** `anchoM`, `superficieM2`, `volumenM3`… más los conteos. */
const SUFIJO_DE_MEDIDA = /(?:M|M2|M3)$/;

/**
 * `true` si el campo espera un número.
 *
 * La convención del dominio es el sufijo de unidad en el nombre (`anchoM`,
 * `alturaM`, `superficieM2`, `vanosM2`), y los campos de texto —`tag`,
 * `tipologia`, `tipo`, `material`, `vidrio`, `ubicacion`, `ambiente`— no lo
 * llevan. Es lo que permite descartar un "no figura" devuelto como valor de una
 * medida sin tener que enumerar los campos de los cuatro rubros acá.
 */
export function esCampoDeMedida(campo: string): boolean {
  return SUFIJO_DE_MEDIDA.test(campo) || CAMPOS_NUMERICOS.has(campo);
}

// ---------------------------------------------------------------------------
// Contrato estricto (fixtures) y cable laxo (LLM)
// ---------------------------------------------------------------------------

/**
 * Lo que tiene que cumplir un fixture del mock: se valida estricto (los
 * fixtures son nuestros). Que acepte el valor como número **o** como texto es
 * deliberado: en un fixture se escribe `0.9` y del modelo viene `"0,90"`, tal
 * como está en la planilla.
 */
export const zBusquedaFixture = z.array(
  z.object({
    clave: z.string().min(1),
    campo: z.string().min(1),
    valor: z.union([z.number(), z.string()]),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    confianza: z.number().min(0).max(1),
  }),
);

export type BusquedaFixture = z.infer<typeof zBusquedaFixture>;

/**
 * El cable del LLM, laxo a propósito (mismo patrón que `sanearAnalisis`,
 * `sanearPresupuesto` y `sanearRespuestaQa`): la gramática de structured
 * outputs garantiza las claves, no que el bbox traiga cuatro números, ni que la
 * confianza caiga en [0,1], ni que lo que vuelve sea algo que se haya pedido.
 * El contrato lo aplica `sanearBusqueda()`.
 *
 * **`valor` es `string` y no una unión con `number` a propósito.** Dos motivos:
 * la unión se traduce a un `anyOf` que no hace falta meter en la gramática, y
 * una planilla argentina dice `0,90` — que el modelo transcriba lo que está
 * escrito y que la conversión con coma decimal la haga nuestro código (el mismo
 * criterio de `leerNumero()`) es más honesto que pedirle que convierta él.
 */
export const zRespuestaBusquedaCruda = z.object({
  datos: z.array(
    z.object({
      clave: z.string(),
      campo: z.string(),
      valor: z.string(),
      bbox: z.array(z.number()),
      confianza: z.number(),
    }),
  ),
});

export type RespuestaBusquedaCruda = z.infer<typeof zRespuestaBusquedaCruda>;

/**
 * Lo que el saneo acepta: la unión de lo que puede llegar por el cable del LLM
 * y de lo que puede traer un fixture. Es un supertipo de los dos, así que las
 * dos implementaciones entran por la misma puerta.
 */
export interface DatoCrudo {
  clave: string;
  campo: string;
  valor: number | string;
  bbox: readonly number[];
  confianza: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Mismo criterio que `leerNumero()` de la taxonomía: tolera la coma decimal. */
function comoNumero(valor: number | string): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (valor.trim() === '') return null;
  const parseado = Number(valor.replace(',', '.'));
  return Number.isFinite(parseado) ? parseado : null;
}

/**
 * Aplica el contrato sobre lo que devolvió una búsqueda.
 *
 * Descarta —y cuenta— todo lo que no se puede usar:
 *
 *  - **lo que no se pidió**: `clave` que no está entre los objetivos, o `campo`
 *    que no está entre los campos de ESE objetivo. Es la regla del módulo;
 *  - **lo que no se puede ubicar**: un `bbox` que no sean exactamente cuatro
 *    números finitos. Sin bbox no hay provenance y la propuesta no se podría
 *    señalar en el visor (P1);
 *  - **una confianza que no es un número**: no podría competir contra otra
 *    lectura del mismo campo;
 *  - **un valor no numérico en un campo de medida**: "no figura", "s/d" o "2,05
 *    m" no son medidas. Un cero o un negativo tampoco: `leerMedida()` exige
 *    positiva y proponer un cero sería proponer algo que la bandeja va a
 *    rechazar.
 *
 * Lo recuperable se clampa: `bbox` y `confianza` a [0,1].
 *
 * **No deduplica.** Si vuelven dos lecturas del mismo campo, las dos quedan y
 * el pipeline se queda con la de mayor confianza — esa decisión es suya porque
 * también compite contra lo que devuelvan las otras láminas.
 */
export function sanearBusqueda(
  crudos: readonly DatoCrudo[],
  objetivos: readonly ObjetivoBusqueda[],
): { datos: DatoEncontrado[]; descartados: number } {
  const pedidos = new Map<string, Set<string>>();
  for (const objetivo of objetivos) {
    const campos = pedidos.get(objetivo.clave) ?? new Set<string>();
    for (const campo of objetivo.campos) campos.add(campo);
    pedidos.set(objetivo.clave, campos);
  }

  const datos: DatoEncontrado[] = [];
  let descartados = 0;

  for (const crudo of crudos) {
    const clave = crudo.clave.trim();
    const campo = crudo.campo.trim();

    if (!pedidos.get(clave)?.has(campo)) {
      descartados += 1;
      continue;
    }

    if (
      crudo.bbox.length !== 4 ||
      !crudo.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      descartados += 1;
      continue;
    }

    if (!Number.isFinite(crudo.confianza)) {
      descartados += 1;
      continue;
    }

    let valor: number | string;
    if (esCampoDeMedida(campo)) {
      const numero = comoNumero(crudo.valor);
      if (numero === null || numero <= 0) {
        descartados += 1;
        continue;
      }
      valor = numero;
    } else {
      const texto = String(crudo.valor).trim();
      if (texto === '') {
        descartados += 1;
        continue;
      }
      valor = texto;
    }

    const [x, y, ancho, alto] = crudo.bbox;
    datos.push({
      clave,
      campo,
      valor,
      bbox: [clamp01(x), clamp01(y), clamp01(ancho), clamp01(alto)],
      confianza: clamp01(crudo.confianza),
    });
  }

  return { datos, descartados };
}

// ---------------------------------------------------------------------------
// Elección de implementación
// ---------------------------------------------------------------------------

/**
 * Claude solo con `ANTHROPIC_API_KEY` **y** fuera de tests; si no, el mock.
 *
 * Misma condición y mismo motivo que `getAnalysisProvider()`,
 * `getPresupuestoProvider()` y `getQaProvider()`: ninguna suite sale a la red ni
 * gasta tokens aunque la key esté exportada en la máquina. Acá pesa doble — la
 * búsqueda dirigida corre sola al final de cada documento y son créditos del
 * usuario.
 */
export function getBusquedaProvider(): BusquedaProvider {
  if (process.env.NODE_ENV !== 'test' && process.env.ANTHROPIC_API_KEY) {
    return crearProviderBusquedaClaude();
  }
  return crearProviderBusquedaMock();
}
