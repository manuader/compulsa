/**
 * Cruce determinístico, respaldado por fixtures JSON.
 *
 * Es el provider por defecto sin `ANTHROPIC_API_KEY` y **siempre** en tests.
 * Igual que el mock de la búsqueda dirigida —y a diferencia de los de Q&A y
 * presupuestos— **no** cae a una heurística cuando no encuentra fixture:
 * devuelve las cinco listas vacías.
 *
 * Por qué no cruza por su cuenta la memoria: un match por palabras sobre el
 * texto compactado puede decir "FP01 aparece en DET00 y en PL01", pero no puede
 * decir cuál de los números de esa fila es el ancho, ni si las dos FP01 son la
 * misma carpintería. Adivinarlo sería escribir una deducción con provenance
 * inventada, que es lo que P4 prohíbe. Sin fixture, la obra queda como estaba:
 * huecos honestos en la bandeja.
 *
 * Busca `tests/fixtures/analysis/cruce/<slug(nombreObra)>.json`, con el **mismo**
 * `slug()` que el mock de láminas. La clave es la obra y no la lámina porque el
 * cruce es una llamada por obra: `obra-cruce.json` es "qué cruza el modelo en el
 * expediente de la obra Obra Cruce".
 *
 * El fixture se valida estricto (los fixtures son nuestros) y se devuelve
 * **crudo**: el saneo es uno solo y corre río abajo, en el pipeline, igual para
 * el mock que para el modelo. Ver `cruce-tipos.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { ObraContexto } from '@/types/domain';

import { cruceVacio, type CruceProvider, type RespuestaCruceCruda } from './cruce-tipos';
import { slug } from './tipos';

/**
 * `tests/fixtures/analysis/cruce/`, resuelto desde la raíz del repo por los
 * mismos dos motivos que `DIR_FIXTURES_ANALISIS` (ver `mock.ts`).
 */
export const DIR_FIXTURES_CRUCE = pathToFileURL(
  resolve(process.cwd(), 'tests', 'fixtures', 'analysis', 'cruce'),
);

/**
 * El contrato del fixture. Es el mismo shape que el cable, con dos comodidades
 * de escritura: las cinco listas se pueden omitir (default `[]`) y los tres
 * campos que el modelo manda en `null` se pueden simplemente no escribir.
 *
 * Lo que **no** se afloja son los valores: van como texto, tal como el modelo
 * los transcribe de la lámina (`"2,60"`, no `2.6`). Un fixture tiene que poder
 * salir del provider real (tests/CLAUDE.md, regla 6).
 */
const opcional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

export const zCruceFixture = z.object({
  datosObra: z
    .array(
      z.object({
        clave: z.string().min(1),
        valor: z.string(),
        unidad: opcional(z.string()),
        laminaCodigo: z.string().min(1),
        bbox: opcional(z.array(z.number())),
        confianza: z.number(),
      }),
    )
    .default([]),
  completados: z
    .array(
      z.object({
        laminaCodigo: z.string().min(1),
        entidadNombre: z.string().min(1),
        campo: z.string().min(1),
        valor: z.string(),
        fuenteLaminaCodigo: z.string().min(1),
        bbox: opcional(z.array(z.number())),
        confianza: z.number(),
      }),
    )
    .default([]),
  identidades: z
    .array(
      z.array(z.object({ laminaCodigo: z.string().min(1), entidadNombre: z.string().min(1) })),
    )
    .default([]),
  conflictos: z
    .array(
      z.object({
        descripcion: z.string().min(1),
        datoA: z.string(),
        laminaCodigoA: z.string().min(1),
        datoB: z.string(),
        laminaCodigoB: z.string().min(1),
        causaPosible: opcional(z.string()),
      }),
    )
    .default([]),
  relecturas: z
    .array(z.object({ laminaCodigo: z.string().min(1), queBuscar: z.string().min(1) }))
    .default([]),
});

const cache = new Map<string, RespuestaCruceCruda | null>();

function comoDirectorio(dir: URL | string): URL {
  if (typeof dir !== 'string') return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
  return new URL(`${pathToFileURL(resolve(dir)).href}/`);
}

function esArchivoInexistente(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function parsearFixture(ruta: string, crudo: string): RespuestaCruceCruda {
  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (error) {
    throw new Error(
      `Fixture de cruce inválido (${ruta}): no es JSON válido — ${(error as Error).message}`,
    );
  }

  const resultado = zCruceFixture.safeParse(json);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Fixture de cruce inválido (${ruta}): ${detalle}`);
  }
  return resultado.data;
}

function cargarFixture(dir: URL, clave: string): RespuestaCruceCruda | null {
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
 * por defecto usa `tests/fixtures/analysis/cruce/`.
 */
export function crearProviderCruceMock(
  dirFixtures: URL | string = DIR_FIXTURES_CRUCE,
): CruceProvider {
  const dir = comoDirectorio(dirFixtures);

  return {
    nombre: 'cruce-mock',

    async cruzar(_memoria: string, ctx: ObraContexto): Promise<RespuestaCruceCruda> {
      // Sin nombre de obra no hay clave de fixture. Pasa mientras el pipeline no
      // lo pase (`ObraContexto.nombreObra` es opcional y aditivo): la respuesta
      // honesta es "no crucé nada", no un cruce inventado.
      const clave = slug(ctx.nombreObra ?? '');
      if (clave === '') return cruceVacio();

      return cargarFixture(dir, clave) ?? cruceVacio();
    },
  };
}
