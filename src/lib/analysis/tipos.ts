/**
 * Vocabulario compartido de los providers de análisis.
 *
 * Acá vive lo que `mock.ts` y `claude.ts` tienen en común: la interfaz, el shape
 * de una lámina analizada (que es también el shape de los fixtures y el de la
 * salida estructurada del LLM) y el rótulo "no pude leer nada".
 */
import { z } from 'zod';
import {
  zEntidadDetectada,
  zRotuloDetectado,
  type EntidadDetectada,
  type LaminaInput,
  type ObraContexto,
  type RotuloDetectado,
} from '@/types/domain';

/**
 * La frontera con el mundo no determinístico (`src/lib/analysis/CLAUDE.md`).
 * Dos implementaciones: `crearProviderMock()` y `crearProviderClaude()`.
 */
export interface AnalysisProvider {
  /**
   * Título, código, escala, disciplina, tipo y revisión del rótulo de la lámina.
   *
   * `ctx` es **opcional y aditivo**: el mock lo ignora y quien llama sin él
   * obtiene exactamente lo de antes. Existe porque `claude.ts` resuelve la
   * lámina entera en una sola llamada y cachea por `laminaId`: si el rótulo se
   * pide sin contexto, la llamada que queda cacheada es la que no lo tenía y el
   * `ObraContexto` no llega nunca al prompt (deuda del HANDOFF §8).
   */
  leerRotulo(lamina: LaminaInput, ctx?: ObraContexto): Promise<RotuloDetectado>;
  /** Entidades de la lámina, todas con bbox normalizado y confianza. */
  extraerEntidades(lamina: LaminaInput, ctx: ObraContexto): Promise<EntidadDetectada[]>;
  /**
   * Solo el rótulo, en una llamada corta y **aparte** de la de siempre.
   *
   * Es la fase de **inventario**: antes de extraer nada, el pipeline recorre el
   * expediente entero leyendo únicamente rótulos, para que la extracción de
   * cada lámina arranque con el índice completo en su `ObraContexto`. Por eso
   * en `claude.ts` **no comparte el caché por lámina** de `leerRotulo`: ese
   * caché guarda la extracción completa, y el inventario es justamente la
   * pasada que no la paga.
   *
   * El `ctx` es **opcional y aditivo**, igual que el de `leerRotulo`, pero acá
   * no viaja al prompt: el índice de la obra es justamente lo que esta fase
   * construye, así que todavía no hay nada que contarle al modelo. Viaja por
   * el **costo** (RNF-7): sin `ctx.obraId`, la fila `inventario_llm` de
   * `auditoria` queda sin obra y el consumo del inventario —una llamada por
   * lámina, la primera de todas— es invisible en `/estudio/auditoria`, que es
   * donde se responde cuánto costó analizar una obra.
   *
   * Un provider que no implemente el método sigue siendo un `AnalysisProvider`
   * válido. Quien lo consuma llama a `inventariarLamina()`, que cae a
   * `leerRotulo` si no está.
   */
  inventariar?(lamina: LaminaInput, ctx?: ObraContexto): Promise<RotuloDetectado>;
}

/**
 * El rótulo de una lámina para la fase de inventario, sin ramificar en el
 * llamador: el método barato si el provider lo trae, el rótulo de siempre si no.
 *
 * La caída no es una degradación silenciosa: `leerRotulo` devuelve exactamente
 * el mismo `RotuloDetectado`, solo que por el camino caro (en `claude.ts`,
 * resolviendo también las entidades y dejándolas cacheadas).
 *
 * El `ctx` se reenvía a las dos ramas: las dos escriben su fila de costo y
 * ninguna de las dos puede quedar sin obra (RNF-7).
 */
export function inventariarLamina(
  provider: AnalysisProvider,
  lamina: LaminaInput,
  ctx?: ObraContexto,
): Promise<RotuloDetectado> {
  return provider.inventariar
    ? provider.inventariar(lamina, ctx)
    : provider.leerRotulo(lamina, ctx);
}

/**
 * Una lámina analizada por completo. Es el contrato de tres cosas a la vez:
 * los fixtures JSON del mock, la salida estructurada de Claude y lo que el
 * pipeline persiste.
 */
export const zAnalisisLamina = z.object({
  rotulo: zRotuloDetectado,
  entidades: z.array(zEntidadDetectada),
});

export type AnalisisLamina = z.infer<typeof zAnalisisLamina>;

// ---------------------------------------------------------------------------
// Shape "de cable" para la salida del LLM y su saneo.
//
// La gramática de structured outputs garantiza claves y enums, pero NO largos
// de array ni rangos numéricos: un bbox de 3 elementos pasa la generación y
// recién explota al validar — y con el schema estricto tiraba la lámina entera
// (visto en producción: `entidades.1.bbox: too_small`). Por eso el cable es
// laxo en lo numérico y `sanearAnalisis` aplica el contrato entidad por
// entidad: lo recuperable se clampa, lo inutilizable se descarta y se cuenta.
// El mock NO usa esto: los fixtures son nuestros y se validan estrictos.
// ---------------------------------------------------------------------------

const zEntidadCruda = zEntidadDetectada.extend({
  bbox: z.array(z.number()),
  confianza: z.number(),
});

/**
 * El rótulo tal como viaja por el cable, y también **la salida entera de la
 * fase de inventario**: ahí no hay entidades que pedir, así que el schema del
 * structured output es este objeto y nada más.
 */
export const zRotuloCrudo = zRotuloDetectado.extend({ confianza: z.number() });

export type RotuloCrudo = z.infer<typeof zRotuloCrudo>;

export const zAnalisisLaminaCrudo = z.object({
  rotulo: zRotuloCrudo,
  entidades: z.array(zEntidadCruda),
});

export type AnalisisLaminaCrudo = z.infer<typeof zAnalisisLaminaCrudo>;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Aplica el contrato estricto sobre un rótulo crudo.
 *
 * `confianza` se clampa a [0,1]; si aun así no valida, degrada a `rotuloNulo()`
 * —la lámina queda bloqueada por escala, que es honesto y no roto—. Lo usan las
 * dos llamadas que devuelven rótulo: el análisis completo y el inventario.
 */
export function sanearRotulo(crudo: RotuloCrudo): RotuloDetectado {
  const rotulo = zRotuloDetectado.safeParse({ ...crudo, confianza: clamp01(crudo.confianza) });
  return rotulo.success ? rotulo.data : rotuloNulo();
}

/**
 * Aplica el contrato estricto sobre la salida cruda del LLM.
 *
 * - Rótulo: lo resuelve `sanearRotulo()` (clampeo y caída a `rotuloNulo()`).
 * - Entidades: `confianza` y cada coordenada del bbox se clampan a [0,1]; una
 *   entidad cuyo bbox no tenga exactamente 4 números no se puede ubicar en la
 *   lámina y se descarta ("sin bbox no hay entidad", CLAUDE.md del módulo).
 */
export function sanearAnalisis(crudo: AnalisisLaminaCrudo): {
  analisis: AnalisisLamina;
  entidadesDescartadas: number;
} {
  const rotulo = sanearRotulo(crudo.rotulo);

  const entidades: EntidadDetectada[] = [];
  let entidadesDescartadas = 0;
  for (const cruda of crudo.entidades) {
    if (cruda.bbox.length !== 4) {
      entidadesDescartadas += 1;
      continue;
    }
    const saneada = {
      ...cruda,
      bbox: cruda.bbox.map(clamp01),
      confianza: clamp01(cruda.confianza),
    };
    const valida = zEntidadDetectada.safeParse(saneada);
    if (valida.success) entidades.push(valida.data);
    else entidadesDescartadas += 1;
  }

  return { analisis: { rotulo, entidades }, entidadesDescartadas };
}

/**
 * Rótulo devuelto cuando no hay nada que leer (sin fixture, o el LLM no encontró
 * rótulo). `escalaConfiable: false` es deliberado: el pipeline bloquea la lámina
 * y le pide la escala al usuario en vez de inventarla (P4).
 */
export function rotuloNulo(): RotuloDetectado {
  return {
    titulo: null,
    codigo: null,
    disciplina: null,
    tipoLamina: null,
    escala: null,
    escalaConfiable: false,
    revision: null,
    confianza: 0,
  };
}

/** Minúsculas, sin extensión, todo lo no alfanumérico colapsado a `-`. */
export function slug(nombre: string): string {
  return nombre
    .replace(/\.[^./\\]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Clave del fixture de una lámina: `slug(documentoNombre)-p<numeroPagina>`.
 *
 * No usamos el hash de los bytes: pdf-lib re-serializa cada página con fechas
 * propias y el hash no es estable entre corridas.
 */
export function claveFixture(documentoNombre: string, numeroPagina: number): string {
  return `${slug(documentoNombre)}-p${numeroPagina}`;
}
