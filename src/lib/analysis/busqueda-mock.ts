/**
 * Búsqueda dirigida determinística, respaldada por fixtures JSON.
 *
 * Es el provider por defecto sin `ANTHROPIC_API_KEY` y **siempre** en tests. A
 * diferencia del mock de Q&A y del de presupuestos, este **no** cae a una
 * heurística cuando no encuentra fixture: devuelve `[]`.
 *
 * Por qué no busca por su cuenta en `textoExtraido`: un match por palabras
 * puede decir "en esta lámina aparece FP01", pero no puede decir **cuál** de los
 * números de la fila es el ancho y cuál el alto, ni dónde está el bbox de ese
 * número. Adivinarlo sería escribir una propuesta con un número real y una
 * provenance inventada, que es exactamente lo que P4 prohíbe. Sin fixture, la
 * consulta queda como estaba: una pregunta honesta en la bandeja.
 *
 * Busca `tests/fixtures/analysis/busqueda/<clave>.json` con la **misma** clave
 * que el mock de láminas (`slug(documentoNombre)-p<numeroPagina>`), un nivel más
 * abajo: `obra-busqueda-p2.json` es "qué encuentra la búsqueda en la planilla
 * DET00", y `analysis/obra-busqueda-p2.json` sigue siendo "qué ve el análisis en
 * esa misma lámina". Dos preguntas distintas sobre la misma página.
 *
 * El fixture pasa por `sanearBusqueda()`, igual que la salida del modelo: un
 * fixture **no puede** colar una clave o un campo que la corrida no pidió.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { claveFixture } from './tipos';
import {
  sanearBusqueda,
  zBusquedaFixture,
  type BusquedaFixture,
  type BusquedaProvider,
  type DatoEncontrado,
  type ObjetivoBusqueda,
} from './busqueda-tipos';

/**
 * `tests/fixtures/analysis/busqueda/`, resuelto desde la raíz del repo por los
 * mismos dos motivos que `DIR_FIXTURES_ANALISIS` (ver `mock.ts`).
 */
export const DIR_FIXTURES_BUSQUEDA = pathToFileURL(
  resolve(process.cwd(), 'tests', 'fixtures', 'analysis', 'busqueda'),
);

const cache = new Map<string, BusquedaFixture | null>();

function comoDirectorio(dir: URL | string): URL {
  if (typeof dir !== 'string') return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
  return new URL(`${pathToFileURL(resolve(dir)).href}/`);
}

function esArchivoInexistente(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function parsearFixture(ruta: string, crudo: string): BusquedaFixture {
  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (error) {
    throw new Error(
      `Fixture de búsqueda inválido (${ruta}): no es JSON válido — ${(error as Error).message}`,
    );
  }

  const resultado = zBusquedaFixture.safeParse(json);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Fixture de búsqueda inválido (${ruta}): ${detalle}`);
  }
  return resultado.data;
}

function cargarFixture(dir: URL, clave: string): BusquedaFixture | null {
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

/**
 * `dirFixtures` existe para los tests (y para apuntar a otro set de fixtures);
 * por defecto usa `tests/fixtures/analysis/busqueda/`.
 */
export function crearProviderBusquedaMock(
  dirFixtures: URL | string = DIR_FIXTURES_BUSQUEDA,
): BusquedaProvider {
  const dir = comoDirectorio(dirFixtures);

  return {
    nombre: 'busqueda-mock',

    async buscarDatos(
      lamina,
      objetivos: readonly ObjetivoBusqueda[],
    ): Promise<DatoEncontrado[]> {
      if (objetivos.length === 0) return [];

      const fixture = cargarFixture(
        dir,
        claveFixture(lamina.documentoNombre, lamina.numeroPagina),
      );
      if (!fixture) return [];

      // Mismo saneo que la salida del modelo: lo que la corrida no pidió no
      // entra, aunque el fixture lo traiga.
      return sanearBusqueda(fixture, objetivos).datos;
    },
  };
}
