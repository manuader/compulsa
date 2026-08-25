/**
 * Provider de análisis determinístico, respaldado por fixtures JSON.
 *
 * Es el provider por defecto sin `ANTHROPIC_API_KEY` y **siempre** en tests
 * (global-constraints: los tests jamás usan red). Con él, el pipeline completo y
 * la UI corren sin gastar un token.
 *
 * Busca `tests/fixtures/analysis/<clave>.json` con
 * `clave = slug(documentoNombre)-p<numeroPagina>`. Sin fixture no inventa nada:
 * devuelve rótulo nulo (`escalaConfiable: false`, que bloquea la lámina) y cero
 * entidades — el comportamiento honesto según P4.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EntidadDetectada, RotuloDetectado } from '@/types/domain';
import {
  claveFixture,
  rotuloNulo,
  zAnalisisLamina,
  type AnalisisLamina,
  type AnalysisProvider,
} from './tipos';

/**
 * `tests/fixtures/analysis/`, resuelto desde la raíz del repo.
 *
 * Igual que la carpeta de migraciones en `src/db/client.ts`: se arma con
 * `process.cwd()` y no con `import.meta.url`. Los dos motivos son el mismo que
 * allá, y valen tanto en el build como en el bundler:
 *
 *  - tras `next build` este módulo vive en `.next/server/`, así que un
 *    `../../../tests/…` relativo al archivo apunta a cualquier lado;
 *  - webpack trata `new URL(ruta, import.meta.url)` como un asset y trata de
 *    resolverlo en tiempo de build; con un directorio no puede, y rompe la
 *    compilación de cualquier ruta que llegue hasta acá (el pipeline llega).
 *
 * `next`, `vitest` y `tsx` corren todos desde la raíz del repo.
 */
export const DIR_FIXTURES_ANALISIS = pathToFileURL(
  resolve(process.cwd(), 'tests', 'fixtures', 'analysis'),
);

/** Un fixture leído y validado, o `null` si el archivo no existe. */
const cache = new Map<string, AnalisisLamina | null>();

function comoDirectorio(dir: URL | string): URL {
  if (typeof dir !== 'string') return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
  return new URL(`${pathToFileURL(resolve(dir)).href}/`);
}

function esArchivoInexistente(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function parsear(ruta: string, crudo: string): AnalisisLamina {
  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (error) {
    throw new Error(
      `Fixture de análisis inválido (${ruta}): no es JSON válido — ${(error as Error).message}`,
    );
  }

  const resultado = zAnalisisLamina.safeParse(json);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Fixture de análisis inválido (${ruta}): ${detalle}`);
  }
  return resultado.data;
}

function cargarFixture(dir: URL, clave: string): AnalisisLamina | null {
  const url = new URL(`${clave}.json`, dir);
  const enCache = cache.get(url.href);
  if (enCache !== undefined) return enCache;

  let crudo: string;
  try {
    crudo = readFileSync(url, 'utf8');
  } catch (error) {
    // Solo "no existe" significa "no hay fixture". Un permiso denegado o un
    // directorio ilegible es un problema real y tiene que explotar.
    if (!esArchivoInexistente(error)) throw error;
    cache.set(url.href, null);
    return null;
  }

  const analisis = parsear(fileURLToPath(url), crudo);
  cache.set(url.href, analisis);
  return analisis;
}

/**
 * `dirFixtures` existe para los tests (y para apuntar a otro set de fixtures);
 * por defecto usa `tests/fixtures/analysis/`.
 */
export function crearProviderMock(dirFixtures: URL | string = DIR_FIXTURES_ANALISIS): AnalysisProvider {
  const dir = comoDirectorio(dirFixtures);

  return {
    async leerRotulo(lamina): Promise<RotuloDetectado> {
      const analisis = cargarFixture(dir, claveFixture(lamina.documentoNombre, lamina.numeroPagina));
      // Copia: el fixture queda cacheado y el pipeline no debería poder ensuciarlo.
      return analisis ? structuredClone(analisis.rotulo) : rotuloNulo();
    },

    async extraerEntidades(lamina): Promise<EntidadDetectada[]> {
      const analisis = cargarFixture(dir, claveFixture(lamina.documentoNombre, lamina.numeroPagina));
      return analisis ? structuredClone(analisis.entidades) : [];
    },
  };
}
