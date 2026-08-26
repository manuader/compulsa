/**
 * Q&A determinístico: fixture si lo hay, búsqueda por palabras si no.
 *
 * Es el provider por defecto sin `ANTHROPIC_API_KEY` y **siempre** en tests.
 * Igual que el mock de presupuestos, no se rinde cuando no encuentra fixture:
 * cae a una **búsqueda literal sobre `laminas.texto_extraido`** para que el panel
 * "Preguntale al expediente" sirva de algo sin gastar un token. Un fixture sirve
 * para pinnear una respuesta redactada; la búsqueda es lo que usa el arquitecto
 * que no tiene la key puesta.
 *
 * ## Las reglas de la búsqueda (determinísticas y documentadas)
 *
 * 1. **La pregunta se parte en palabras** (sin tildes, en minúsculas). Se
 *    descartan las de menos de 3 letras y las vacías de contenido (`que`, `la`,
 *    `de`, `hay`…): con "de" adentro matchearía todo el expediente.
 * 2. **Una lámina matchea si alguna de esas palabras está entre las suyas.** El
 *    match es por palabra completa contra el conjunto de palabras del texto
 *    extraído, no por substring: `"m"` adentro de `"1,20 m"` sí, pero `"cor"` no
 *    matchea `"corte"`. Substring daría falsos positivos imposibles de explicar.
 * 3. **Gana el puntaje más alto**, que es cuántas palabras distintas de la
 *    pregunta aparecen en la lámina. Empate ⇒ entran todas las empatadas, hasta
 *    3, ordenadas por código (y por id, para que el orden no dependa del orden
 *    de lectura de la base).
 * 4. **La respuesta transcribe, no redacta.** Devuelve la primera línea de cada
 *    lámina donde aparece alguna palabra de la pregunta, entre comillas y con el
 *    código adelante. El mock no sabe de arquitectura: si "contestara" con sus
 *    palabras estaría inventando, que es justo lo que P4 prohíbe.
 * 5. **Sin match no hay respuesta:** `SIN_RESPUESTA` y cero citas. Lo mismo si la
 *    pregunta se quedó sin palabras útiles.
 *
 * Los fixtures pasan por el mismo saneo que la salida del modelo
 * (`sanearRespuestaQa`), así que un fixture que cita una lámina que no está en el
 * expediente degrada a "No encontré eso en el expediente" en vez de afirmar algo
 * sin respaldo.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  etiquetaLamina,
  normalizarTexto,
  respuestaVacia,
  sanearRespuestaQa,
  slugPregunta,
  zRespuestaQaFixture,
  type ContextoQa,
  type LaminaQa,
  type QaProvider,
  type RespuestaQa,
  type RespuestaQaFixture,
} from './qa-tipos';

/**
 * `tests/fixtures/analysis/qa/`, resuelto desde la raíz del repo por los mismos
 * motivos que `DIR_FIXTURES_ANALISIS` (ver `mock.ts`).
 */
export const DIR_FIXTURES_QA = pathToFileURL(
  resolve(process.cwd(), 'tests', 'fixtures', 'analysis', 'qa'),
);

/** Cuántas láminas cita como mucho una respuesta de la búsqueda. */
export const MAXIMO_CITAS = 3;

/** Largo máximo de una línea transcripta, para que la respuesta se pueda leer. */
const MAXIMO_LINEA = 200;

/**
 * Palabras que no aportan a la búsqueda. Son las de función del castellano más
 * las que aparecen en toda pregunta de expediente ("dice", "lamina"): tenerlas
 * adentro haría matchear cualquier lámina con cualquier pregunta.
 */
const VACIAS = new Set([
  'que',
  'cual',
  'cuales',
  'cuanto',
  'cuanta',
  'cuantos',
  'cuantas',
  'como',
  'donde',
  'cuando',
  'por',
  'para',
  'con',
  'sin',
  'del',
  'las',
  'los',
  'una',
  'uno',
  'unos',
  'unas',
  'hay',
  'esta',
  'este',
  'estan',
  'son',
  'tiene',
  'tienen',
  'lleva',
  'llevan',
  'dice',
  'dicen',
  'sobre',
  'entre',
  'segun',
  'mas',
  'menos',
  'pero',
  'obra',
  'lamina',
  'laminas',
  'expediente',
]);

const cache = new Map<string, RespuestaQaFixture | null>();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function comoDirectorio(dir: URL | string): URL {
  if (typeof dir !== 'string') return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
  return new URL(`${pathToFileURL(resolve(dir)).href}/`);
}

function esArchivoInexistente(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function parsearFixture(ruta: string, crudo: string): RespuestaQaFixture {
  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (error) {
    throw new Error(
      `Fixture de Q&A inválido (${ruta}): no es JSON válido — ${(error as Error).message}`,
    );
  }

  const resultado = zRespuestaQaFixture.safeParse(json);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Fixture de Q&A inválido (${ruta}): ${detalle}`);
  }
  return resultado.data;
}

function cargarFixture(dir: URL, clave: string): RespuestaQaFixture | null {
  const url = new URL(`${clave}.json`, dir);
  const enCache = cache.get(url.href);
  if (enCache !== undefined) return enCache;

  let crudo: string;
  try {
    crudo = readFileSync(url, 'utf8');
  } catch (error) {
    // Solo "no existe" significa "no hay fixture" (ver `mock.ts`).
    if (!esArchivoInexistente(error)) throw error;
    cache.set(url.href, null);
    return null;
  }

  const fixture = parsearFixture(fileURLToPath(url), crudo);
  cache.set(url.href, fixture);
  return fixture;
}

// ---------------------------------------------------------------------------
// Búsqueda por palabras
// ---------------------------------------------------------------------------

/** Las palabras de un texto, normalizadas: `["planta", "pb", "1", "100"]`. */
function palabrasDe(texto: string): string[] {
  return normalizarTexto(texto)
    .split(/[^a-z0-9]+/)
    .filter((palabra) => palabra !== '');
}

/** Las palabras de la pregunta que vale la pena buscar (reglas 1 y 2). */
export function terminosDeBusqueda(pregunta: string): string[] {
  const vistos = new Set<string>();
  const terminos: string[] = [];
  for (const palabra of palabrasDe(pregunta)) {
    if (palabra.length < 3 || VACIAS.has(palabra) || vistos.has(palabra)) continue;
    vistos.add(palabra);
    terminos.push(palabra);
  }
  return terminos;
}

interface Coincidencia {
  lamina: LaminaQa;
  puntaje: number;
  linea: string;
}

/** La primera línea del texto donde aparece alguno de los términos. */
function primeraLineaCon(texto: string, terminos: readonly string[]): string | null {
  for (const cruda of texto.split(/\r?\n/)) {
    const linea = cruda.replace(/\s+/g, ' ').trim();
    if (linea === '') continue;
    const palabras = new Set(palabrasDe(linea));
    if (terminos.some((termino) => palabras.has(termino))) {
      return linea.length > MAXIMO_LINEA ? `${linea.slice(0, MAXIMO_LINEA).trimEnd()}…` : linea;
    }
  }
  return null;
}

/** Orden estable de las citas: por código y, a igual código, por id. */
function compararLaminas(a: LaminaQa, b: LaminaQa): number {
  // Las láminas sin código van al final: no tienen con qué ordenarse entre las
  // que sí lo tienen, y el arquitecto busca por código.
  if (a.codigo !== b.codigo) {
    if (a.codigo === null) return 1;
    if (b.codigo === null) return -1;
    const porCodigo = a.codigo.localeCompare(b.codigo, 'es-AR');
    if (porCodigo !== 0) return porCodigo;
  }
  return a.id.localeCompare(b.id);
}

function buscar(pregunta: string, contexto: ContextoQa): RespuestaQa {
  const terminos = terminosDeBusqueda(pregunta);
  if (terminos.length === 0) return respuestaVacia();

  const coincidencias: Coincidencia[] = [];
  for (const lamina of contexto.laminas) {
    if (lamina.textoExtraido === null || lamina.textoExtraido.trim() === '') continue;
    const palabras = new Set(palabrasDe(lamina.textoExtraido));
    const puntaje = terminos.filter((termino) => palabras.has(termino)).length;
    if (puntaje === 0) continue;
    const linea = primeraLineaCon(lamina.textoExtraido, terminos);
    if (linea === null) continue;
    coincidencias.push({ lamina, puntaje, linea });
  }

  if (coincidencias.length === 0) return respuestaVacia();

  const mejor = Math.max(...coincidencias.map((c) => c.puntaje));
  const elegidas = coincidencias
    .filter((c) => c.puntaje === mejor)
    .sort((a, b) => compararLaminas(a.lamina, b.lamina))
    .slice(0, MAXIMO_CITAS);

  return {
    respuesta: elegidas
      .map((c) => `Según ${etiquetaLamina(c.lamina)}: «${c.linea}».`)
      .join(' '),
    citas: elegidas.map((c) => ({ laminaId: c.lamina.id, codigo: c.lamina.codigo })),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * `dirFixtures` existe para los tests (y para apuntar a otro set de fixtures);
 * por defecto usa `tests/fixtures/analysis/qa/`.
 */
export function crearProviderQaMock(dirFixtures: URL | string = DIR_FIXTURES_QA): QaProvider {
  const dir = comoDirectorio(dirFixtures);

  return {
    async responder(pregunta: string, contexto: ContextoQa): Promise<RespuestaQa> {
      const limpia = pregunta.trim();
      if (limpia === '') return respuestaVacia();

      const fixture = cargarFixture(dir, slugPregunta(limpia));
      if (fixture) {
        // Mismo saneo que la salida del modelo: las citas se resuelven contra
        // ESTE expediente y, si ninguna existe, la respuesta se cae a P4.
        return sanearRespuestaQa(fixture, contexto).respuesta;
      }

      return buscar(limpia, contexto);
    },
  };
}
