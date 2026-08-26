/**
 * Vocabulario compartido del Q&A del expediente (RF-106).
 *
 * Es el tercer espejo de `tipos.ts` (láminas) y `presupuesto-tipos.ts`
 * (presupuestos), para la tercera frontera no determinística del sistema:
 * preguntarle en castellano al legajo. Acá viven la interfaz del provider, el
 * shape de una respuesta —que es a la vez el de los fixtures del mock y el de la
 * salida estructurada de Claude— y el saneo del cable laxo.
 *
 * ## La regla que gobierna todo el módulo
 *
 * **Una respuesta sin citas no es una respuesta.** El contrato dice que toda
 * respuesta viaja con `citas: [{ laminaId, codigo }]` y que sin fuentes el
 * sistema contesta "No encontré eso en el expediente" (P4: deducir, no
 * inventar). Por eso el saneo no es cosmético: si las citas que vuelven no
 * existen en el expediente que se le pasó al provider, la respuesta **entera**
 * se degrada a `respuestaVacia()`. Preferimos un "no sé" a una afirmación que
 * nadie puede ir a verificar en una lámina.
 *
 * ## Por qué las citas viajan por código y no por id
 *
 * Ni un fixture ni un prompt pueden conocer los UUID de las láminas: el fixture
 * se escribe una vez y los ids cambian en cada corrida, y meterle 36 caracteres
 * de UUID por lámina al modelo es pedirle que los transcriba sin un error. Las
 * dos implementaciones citan por **código de lámina** (`A-01`, el que el
 * arquitecto lee en el rótulo) y `resolverCitas()` los traduce a ids contra el
 * contexto de la pregunta. Esa traducción es, además, el filtro que impide citar
 * una lámina que no existe.
 */
import { z } from 'zod';

import type { Disciplina, TipoLamina } from '@/types/domain';

// Ciclo de imports a propósito, igual que en `presupuesto-tipos.ts`: los dos
// providers dependen de este módulo para el contrato y este solo los usa dentro
// de `getQaProvider()`, nunca en la evaluación del módulo.
import { crearProviderQaClaude } from './qa-claude';
import { crearProviderQaMock } from './qa-mock';

// ---------------------------------------------------------------------------
// Contexto: el expediente tal como lo ve el Q&A
// ---------------------------------------------------------------------------

/**
 * Una lámina como insumo del Q&A: su rótulo y el texto que el pipeline extrajo
 * del PDF (`laminas.texto_extraido`). `textoExtraido` puede ser `null` —una
 * lámina recién subida, o un plano que es puro dibujo—: eso significa que la
 * lámina no tiene nada que citar, no que el Q&A pueda suponer qué dice.
 */
export interface LaminaQa {
  id: string;
  codigo: string | null;
  titulo: string | null;
  tipo: TipoLamina | null;
  disciplina: Disciplina | null;
  textoExtraido: string | null;
}

export interface ContextoQa {
  obraId: string;
  obraNombre: string;
  laminas: readonly LaminaQa[];
}

/** Una lámina citada: el id para linkear al visor, el código para mostrar. */
export interface CitaQa {
  laminaId: string;
  codigo: string | null;
}

export interface RespuestaQa {
  respuesta: string;
  citas: CitaQa[];
}

/**
 * La frontera con el mundo no determinístico, del lado de las preguntas. Dos
 * implementaciones: `crearProviderQaMock()` y `crearProviderQaClaude()`.
 */
export interface QaProvider {
  responder(pregunta: string, contexto: ContextoQa): Promise<RespuestaQa>;
}

/**
 * Lo que se contesta cuando el expediente no lo dice (P4). Es texto de producto,
 * no un código de error: se muestra tal cual en la pantalla.
 */
export const SIN_RESPUESTA = 'No encontré eso en el expediente.';

export function respuestaVacia(): RespuestaQa {
  return { respuesta: SIN_RESPUESTA, citas: [] };
}

/** `true` si la respuesta es la de "no está en el expediente". */
export function esSinRespuesta(respuesta: RespuestaQa): boolean {
  return respuesta.citas.length === 0;
}

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/** Minúsculas y sin tildes: la forma en la que se comparan textos acá. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Clave del fixture de una pregunta: `qa/<slug-pregunta>.json`.
 *
 * No reusa `slug()` de `tipos.ts` a propósito: aquel está pensado para nombres
 * de archivo y le saca la extensión (`.pdf`), así que una pregunta con un número
 * decimal —"¿mide 1.20 m?"— perdería la mitad. Este normaliza tildes (para que
 * "carpinterías" y "carpinterias" den el mismo archivo) y acota el largo, que es
 * lo que un nombre de archivo necesita.
 */
export function slugPregunta(pregunta: string): string {
  return normalizarTexto(pregunta)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** Cómo se nombra una lámina dentro de una respuesta. */
export function etiquetaLamina(lamina: LaminaQa): string {
  return lamina.codigo ?? lamina.titulo ?? 'la lámina';
}

/** Un código comparable: sin espacios de más y en mayúsculas. */
function codigoNormalizado(codigo: string): string {
  return codigo.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Traduce códigos de lámina a citas contra el expediente de la pregunta.
 *
 * - El match es por `codigo` (sin distinguir mayúsculas ni espacios de más) y,
 *   para las láminas sin código, por `titulo`: una lámina sin rótulo leído
 *   igual se tiene que poder citar.
 * - Lo que no matchea **se descarta**: citar una lámina que no está en el
 *   expediente es exactamente la clase de invención que P4 prohíbe.
 * - Se deduplica conservando el orden: una respuesta que cita dos veces la misma
 *   lámina muestra un solo chip.
 */
export function resolverCitas(
  codigos: readonly string[],
  contexto: ContextoQa,
): { citas: CitaQa[]; descartados: number } {
  const porCodigo = new Map<string, LaminaQa>();
  for (const lamina of contexto.laminas) {
    const claves = [lamina.codigo, lamina.codigo === null ? lamina.titulo : null];
    for (const clave of claves) {
      if (clave === null || clave.trim() === '') continue;
      // La primera gana: dos láminas con el mismo código es una inconsistencia
      // del expediente, y elegir siempre la primera mantiene el determinismo.
      const normalizado = codigoNormalizado(clave);
      if (!porCodigo.has(normalizado)) porCodigo.set(normalizado, lamina);
    }
  }

  const citas: CitaQa[] = [];
  const vistas = new Set<string>();
  let descartados = 0;

  for (const codigo of codigos) {
    const lamina = porCodigo.get(codigoNormalizado(codigo));
    if (!lamina) {
      descartados += 1;
      continue;
    }
    if (vistas.has(lamina.id)) continue;
    vistas.add(lamina.id);
    citas.push({ laminaId: lamina.id, codigo: lamina.codigo });
  }

  return { citas, descartados };
}

// ---------------------------------------------------------------------------
// Contrato estricto (fixtures) y cable laxo (LLM)
// ---------------------------------------------------------------------------

/** Lo que tiene que cumplir un fixture del mock: se valida estricto. */
export const zRespuestaQaFixture = z.object({
  respuesta: z.string().min(1),
  citas: z.array(z.object({ codigo: z.string().min(1) })).min(1),
});

export type RespuestaQaFixture = z.infer<typeof zRespuestaQaFixture>;

/**
 * El cable del LLM, laxo a propósito (mismo patrón que `sanearAnalisis` y
 * `sanearPresupuesto`): la gramática de structured outputs garantiza las claves,
 * no que el código citado exista ni que la respuesta no venga vacía. El contrato
 * lo aplica `sanearRespuestaQa()`.
 */
export const zRespuestaQaCruda = z.object({
  respuesta: z.string(),
  citas: z.array(z.object({ codigo: z.string() })),
});

export type RespuestaQaCruda = z.infer<typeof zRespuestaQaCruda>;

/**
 * Aplica el contrato sobre una respuesta cruda: resuelve las citas contra el
 * expediente y degrada a `respuestaVacia()` si no queda ninguna.
 *
 * Es la implementación literal del pin de RF-106 ("sin fuentes ⇒ No encontré eso
 * en el expediente") y la usan **las dos** implementaciones: el fixture del mock
 * pasa por el mismo filtro que la salida del modelo, así que un fixture que cita
 * una lámina inexistente no puede colar una respuesta sin respaldo.
 */
export function sanearRespuestaQa(
  crudo: RespuestaQaCruda,
  contexto: ContextoQa,
): { respuesta: RespuestaQa; citasDescartadas: number } {
  const texto = crudo.respuesta.trim();
  const { citas, descartados } = resolverCitas(
    crudo.citas.map((cita) => cita.codigo),
    contexto,
  );

  if (texto === '' || citas.length === 0) {
    return { respuesta: respuestaVacia(), citasDescartadas: descartados };
  }
  return { respuesta: { respuesta: texto, citas }, citasDescartadas: descartados };
}

// ---------------------------------------------------------------------------
// Elección de implementación
// ---------------------------------------------------------------------------

/**
 * Claude solo con `ANTHROPIC_API_KEY` **y** fuera de tests; si no, el mock.
 *
 * Misma condición y mismo motivo que `getAnalysisProvider()` y
 * `getPresupuestoProvider()`: ninguna suite sale a la red ni gasta tokens aunque
 * la key esté exportada en la máquina.
 */
export function getQaProvider(): QaProvider {
  if (process.env.NODE_ENV !== 'test' && process.env.ANTHROPIC_API_KEY) {
    return crearProviderQaClaude();
  }
  return crearProviderQaMock();
}
