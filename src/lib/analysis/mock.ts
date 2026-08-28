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
import type { EntidadDetectada, LaminaInput, RotuloDetectado } from '@/types/domain';
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
 * Sufijo de los fixtures de la **segunda pasada** (RF-306, doble pasada).
 *
 * `obra-demo-p1-b.json` es "qué ve el provider la segunda vez que mira la misma
 * lámina". Con el provider real la segunda lectura difiere sola (el modelo no es
 * determinístico); con el mock hay que poder escribir esa diferencia, y esta es
 * la forma: si el fixture `-b` existe se usa, y si no se cae al mismo de la
 * primera pasada — que es exactamente el contrato pinneado ("mock usa fixture
 * `-b` si existe, si no, la misma") y hace que verificar una obra sin fixtures
 * `-b` no reporte ninguna diferencia.
 */
export const SUFIJO_SEGUNDA_PASADA = '-b';

/** El fixture con sufijo si está; si no, el de siempre. */
function cargarConSufijo(dir: URL, clave: string, sufijo: string): AnalisisLamina | null {
  if (sufijo !== '') {
    const conSufijo = cargarFixture(dir, `${clave}${sufijo}`);
    if (conSufijo) return conSufijo;
  }
  return cargarFixture(dir, clave);
}

export interface OpcionesProviderMock {
  /** `'-b'` para la segunda pasada de la verificación; vacío para la primera. */
  sufijoClave?: string;
}

/**
 * `dirFixtures` existe para los tests (y para apuntar a otro set de fixtures);
 * por defecto usa `tests/fixtures/analysis/`.
 */
export function crearProviderMock(
  dirFixtures: URL | string = DIR_FIXTURES_ANALISIS,
  opciones: OpcionesProviderMock = {},
): AnalysisProvider {
  const dir = comoDirectorio(dirFixtures);
  const sufijo = opciones.sufijoClave ?? '';

  /** Copia: el fixture queda cacheado y el pipeline no debería poder ensuciarlo. */
  function rotuloDe(lamina: LaminaInput): RotuloDetectado {
    const analisis = cargarConSufijo(
      dir,
      claveFixture(lamina.documentoNombre, lamina.numeroPagina),
      sufijo,
    );
    return analisis ? structuredClone(analisis.rotulo) : rotuloNulo();
  }

  return {
    async leerRotulo(lamina): Promise<RotuloDetectado> {
      return rotuloDe(lamina);
    },

    /**
     * El inventario del mock es el **mismo rótulo del mismo fixture** que
     * `leerRotulo`: acá no hay una llamada que ahorrar, y tener dos fuentes de
     * verdad para el rótulo de una lámina sería inventar una diferencia que el
     * provider real no tiene (el fixture es lo que la lámina dice, y punto).
     */
    async inventariar(lamina): Promise<RotuloDetectado> {
      return rotuloDe(lamina);
    },

    async extraerEntidades(lamina): Promise<EntidadDetectada[]> {
      const analisis = cargarConSufijo(
        dir,
        claveFixture(lamina.documentoNombre, lamina.numeroPagina),
        sufijo,
      );
      return analisis ? structuredClone(analisis.entidades) : [];
    },
  };
}
