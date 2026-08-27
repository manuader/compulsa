/**
 * Los dos lugares donde Next decide qué se puede exportar, y nosotros no.
 *
 * Un `.ts` de `src/app/` puede compilar perfecto con `tsc`, pasar la suite
 * entera y aun así romper el `next build` (y devolver un 500 en desarrollo)
 * porque Next impone sus propias reglas sobre los exports de dos clases de
 * archivo. Los tests importan estos módulos derecho, sin pasar por el loader ni
 * por los tipos generados en `.next/types`, así que ninguna suite los mira.
 *
 *  1. **`'use server'`** — solo funciones `async`. Exportar una clase, una
 *     constante o una función sincrónica tira
 *     «Only async functions are allowed to be exported in a "use server" file».
 *     Pasó con `EstadoContactoInvalidoError`, y dejaba la pantalla de la
 *     conversación en 500.
 *  2. **`src/app/api/**\/route.ts`** — solo los verbos HTTP y las opciones de
 *     segmento (`runtime`, `dynamic`, `revalidate`…). Cualquier otro export
 *     rompe el type-check contra `.next/types` con
 *     «Type ... does not satisfy the constraint '{ [x: string]: never; }'».
 *     Pasó con `nombreArchivoReporte`, y solo se veía con un `.next/` generado.
 *
 * En los dos casos `export type` y `export interface` están permitidos: se
 * borran al compilar, así que nunca llegan a ser un export de runtime.
 *
 * Este archivo es más barato que un build y señala la línea exacta.
 *
 * ## El tercer chequeo, que sale del mismo hecho
 *
 * De «en un `'use server'` todo export es un endpoint» se sigue algo más: un
 * export de ahí que recibe un `obraId` **por parámetro** lo recibe del cliente,
 * y si no lo valida contra el estudio de la sesión, cualquiera opera sobre la
 * obra de otro estudio (RNF-4). Le pasó a `aprobarRubroCore`, que usaba el
 * `estudioId` del actor solo para leer el checklist y filtraba las tres queries
 * por `obra_id` pelado: con el id de una obra ajena aprobaba su rubro, que es la
 * llave de `lanzarCompulsa`. `tsc` no lo ve y ninguna suite lo miraba.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.join(process.cwd(), 'src');
const API = path.join(SRC, 'app', 'api');

/** Todos los `.ts`/`.tsx` de un directorio, sin entrar a `node_modules`. */
function archivosDeFuente(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules') continue;
    const completo = path.join(dir, entrada);
    if (statSync(completo).isDirectory()) {
      salida.push(...archivosDeFuente(completo));
    } else if (/\.tsx?$/.test(entrada)) {
      salida.push(completo);
    }
  }
  return salida.sort();
}

/** La directiva vale solo si es lo primero del archivo (antes de todo import). */
function tieneDirectivaUseServer(fuente: string): boolean {
  const primera = fuente
    .split('\n')
    .map((linea) => linea.trim())
    .find((linea) => linea.length > 0);
  return primera === `'use server';` || primera === `"use server";`;
}

/**
 * Las líneas que arrancan un export que Next va a rechazar.
 *
 * Se mira solo el arranque de línea: dentro de un template literal o de un
 * comentario un `export class` va indentado o no está al margen izquierdo, y
 * ningún archivo del repo escribe una declaración exportada con sangría.
 */
function exportsProhibidos(fuente: string, permitido: RegExp): string[] {
  return fuente
    .split('\n')
    .map((linea, indice) => ({ linea, numero: indice + 1 }))
    .filter(({ linea }) => /^export\b/.test(linea))
    .filter(({ linea }) => !/^export\s+(type\s|interface\s)/.test(linea))
    .filter(({ linea }) => !permitido.test(linea))
    .map(({ linea, numero }) => `${numero}: ${linea.trim()}`);
}

/** Lo único exportable de un `'use server'`. */
const SOLO_ASYNC = /^export\s+async\s+function\s/;

/** Verbos HTTP y opciones de segmento: lo único exportable de un `route.ts`. */
const SOLO_HANDLERS_Y_OPCIONES =
  /^export\s+(async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|const\s+(runtime|dynamic|dynamicParams|revalidate|fetchCache|preferredRegion|maxDuration)\b)/;

function ofensores(archivos: string[], permitido: RegExp) {
  return archivos
    .map((archivo) => ({
      archivo: path.relative(process.cwd(), archivo),
      lineas: exportsProhibidos(readFileSync(archivo, 'utf8'), permitido),
    }))
    .filter(({ lineas }) => lineas.length > 0);
}

describe(`archivos 'use server'`, () => {
  const conDirectiva = archivosDeFuente(SRC).filter((archivo) =>
    tieneDirectivaUseServer(readFileSync(archivo, 'utf8')),
  );

  it('hay al menos uno (si no, el test se volvió decorativo)', () => {
    expect(conDirectiva.length).toBeGreaterThan(0);
  });

  it('exportan solo funciones async (más tipos, que se borran al compilar)', () => {
    expect(ofensores(conDirectiva, SOLO_ASYNC)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aislamiento: un `obraId` que llega por parámetro llega del cliente
// ---------------------------------------------------------------------------

/** Los guards que resuelven un id contra el estudio de la sesión (RNF-4). */
const GUARDS_DE_TENANT =
  /require(Obra|ObraCore|ContactoCore|CotizacionCore|CompulsaCore|NegociacionCore)\s*\(/;

/**
 * Los exports que reciben un `obraId` y no lo validan.
 *
 * El cuerpo de la función es todo lo que va desde su `export async function`
 * hasta la primera línea que es exactamente `}`: en `src/app/` todas las
 * funciones son de nivel superior, así que ese es su cierre. La lista de
 * parámetros termina antes, en la primera línea que arranca con `)` — no se
 * puede cortar en el primer `{` porque hay firmas con un tipo inline.
 */
function sinGuardDeTenant(archivos: string[]): string[] {
  const ofensores: string[] = [];

  for (const archivo of archivos) {
    const lineas = readFileSync(archivo, 'utf8').split('\n');
    for (let i = 0; i < lineas.length; i += 1) {
      if (!/^export\s+async\s+function\s/.test(lineas[i])) continue;

      let fin = i;
      while (fin < lineas.length && lineas[fin] !== '}') fin += 1;
      const cuerpo = lineas.slice(i, fin + 1);

      const cierre = cuerpo.findIndex((linea) => /^\)/.test(linea));
      const firma = cuerpo.slice(0, (cierre < 0 ? 0 : cierre) + 1).join('\n');
      if (!/\bobraId\s*:/.test(firma)) continue;

      if (GUARDS_DE_TENANT.test(cuerpo.join('\n'))) continue;
      ofensores.push(
        `${path.relative(process.cwd(), archivo)}:${i + 1}: ${lineas[i].trim()}`,
      );
    }
  }

  return ofensores;
}

/**
 * La única excepción, y por qué.
 *
 * `notificarSinRespuestaCore` no lee ni escribe nada de la obra: el `obraId`
 * solo se concatena en el `link` de la notificación, que se escribe para los
 * titulares de `actor.estudioId`. La pantalla que la llama ya resolvió la obra
 * con `detectarSinRespuestaCore` dos líneas antes, y agregarle un
 * `requireObraCore` sería una segunda consulta idéntica en cada render.
 */
const EXENTOS: readonly string[] = ['notificarSinRespuestaCore'];

describe('aislamiento de los exports de un `use server`', () => {
  const conDirectiva = archivosDeFuente(SRC).filter((archivo) =>
    tieneDirectivaUseServer(readFileSync(archivo, 'utf8')),
  );

  it('el que recibe un obraId por parámetro lo valida contra el estudio', () => {
    const ofensores = sinGuardDeTenant(conDirectiva).filter(
      (linea) => !EXENTOS.some((exento) => linea.includes(exento)),
    );

    expect(ofensores).toEqual([]);
  });

  it('el chequeo encuentra algo que mirar (si no, se volvió decorativo)', () => {
    // Si un refactor mueve los cores a `src/lib/` —que es la tarea futura—, esto
    // se cae y hay que llevar el chequeo con ellos, no borrarlo.
    const conObraId = conDirectiva.filter((archivo) =>
      /^export\s+async\s+function[\s\S]*?\bobraId\s*:/m.test(readFileSync(archivo, 'utf8')),
    );
    expect(conObraId.length).toBeGreaterThan(0);
  });
});

describe('route handlers de src/app/api', () => {
  const rutas = archivosDeFuente(API).filter((archivo) => path.basename(archivo) === 'route.ts');

  it('hay al menos uno (si no, el test se volvió decorativo)', () => {
    expect(rutas.length).toBeGreaterThan(0);
  });

  it('exportan solo verbos HTTP y opciones de segmento', () => {
    expect(ofensores(rutas, SOLO_HANDLERS_Y_OPCIONES)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// El cuarto chequeo: un `import()` que el bundler tiene prohibido seguir
// ---------------------------------------------------------------------------

/**
 * Un `import()` marcado `webpackIgnore` / `turbopackIgnore` dentro de `src/`.
 *
 * Esos comentarios le dicen al bundler «no toques este import»: dejá el
 * specifier crudo y que lo resuelva Node en runtime. Node no conoce el alias
 * `@/` —lo inventan `tsconfig.json` y el bundler—, así que un import ignorado
 * que apunte a un módulo nuestro termina en `ERR_MODULE_NOT_FOUND` **cada vez
 * que se ejecuta**, con el build en verde y la suite entera en verde.
 *
 * Pasó de verdad: `buscarEnDocumentacionAction` conservó de un merge un
 * `await import(...)` ignorado hacia `@/lib/pipeline/busqueda`, con un `catch`
 * que traducía el fallo a «la búsqueda todavía no está disponible en esta
 * versión». El botón de la bandeja estuvo muerto una ola entera.
 *
 * Y **ningún test de runtime lo agarra**, que es exactamente por qué este mira
 * el texto del fuente: bajo `vitest` estos comentarios no significan nada,
 * vite-node resuelve el alias igual y el import anda. El bug solo existe con el
 * bundler de por medio, o sea únicamente en la app de verdad. Se verificó
 * corriendo el test de runtime contra el código roto: pasaba.
 *
 * La regla es entera y sin excepciones porque hoy no hay ninguna que valga: en
 * `src/` **todo import lo sigue el bundler**. Si algún día hace falta uno que
 * no —un módulo opcional, uno generado—, el specifier tiene que ser algo que
 * Node resuelva solo (una ruta relativa, una URL `file://`, un paquete de
 * `node_modules`), y esa excepción se escribe acá con su motivo al lado.
 *
 * Se mira el `import(` y su lista de argumentos, no el archivo entero: un
 * comentario que **cuenta** esta historia —como el de `actions.ts`— no es un
 * import ignorado, y marcarlo sería enseñar a apagar el chequeo.
 */
const IMPORT_IGNORADO = /\bimport\s*\([^)]*(?:webpackIgnore|turbopackIgnore)/;

describe('imports que el bundler no sigue', () => {
  it('no hay ninguno en src/: Node no resuelve nuestros alias en runtime', () => {
    const ofensores = archivosDeFuente(SRC)
      .map((archivo) => ({ archivo, fuente: readFileSync(archivo, 'utf8') }))
      .filter(({ fuente }) => IMPORT_IGNORADO.test(fuente))
      .map(({ archivo }) => path.relative(process.cwd(), archivo));

    expect(ofensores).toEqual([]);
  });
});
