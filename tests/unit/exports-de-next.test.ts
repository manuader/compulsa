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
 *
 * ## El cuarto, de la misma familia: `'use client'` mirado desde el server
 *
 * La frontera corre para los dos lados. Lo que un archivo `'use client'`
 * exporta **hacia el server** no es la función: es una referencia serializable
 * que solo sirve para renderizar como componente o pasar como prop. Un Server
 * Component que **llama** a una función exportada de ahí compila con `tsc`,
 * pasa la suite y tira 500 en runtime: «Attempted to call X() from the server
 * but X is on the client».
 *
 * Pasó con `fuentesDeAfectadas` en la bandeja, y la pantalla entera se caía al
 * abrir una obra con una consulta de dato de obra. La pieza pura se mudó a
 * `bandeja/plano.ts`, que no lleva la directiva. `import type` sigue estando
 * bien: los tipos se borran y nunca llegan a ser un valor.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.join(process.cwd(), 'src');

/** Un archivo del árbol de mentira que usa el test del chequeo 4. */
function escribir(destino: string, contenido: string): void {
  writeFileSync(destino, contenido, 'utf8');
}
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

// ---------------------------------------------------------------------------
// 4. Un Server Component no llama a una función de un `'use client'`
// ---------------------------------------------------------------------------

/** La directiva vale solo si es lo primero del archivo, igual que `use server`. */
function tieneDirectivaUseClient(fuente: string): boolean {
  const primera = fuente
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((linea) => linea.trim())
    .find(
      (linea) =>
        linea !== '' && !linea.startsWith('//') && !linea.startsWith('/*') && !linea.startsWith('*'),
    );
  return primera === `'use client';` || primera === '"use client";';
}

/**
 * El prefijo del alias de `src/`, leído del `tsconfig.json` en vez de escrito a
 * mano.
 *
 * `paths` dice `"@/*": ["./src/*"]`, y de ahí sale el `'@/'` que hay que
 * reconocer en un import. Se lee y no se hardcodea por dos razones: si mañana
 * el alias cambia, este chequeo lo sigue solo; y si alguien lo saca, el test
 * falla acá con un mensaje que lo dice, en vez de volverse silenciosamente
 * ciego a la mitad de los imports del repo.
 */
function prefijoDelAlias(): string {
  const tsconfig = JSON.parse(readFileSync(path.join(process.cwd(), 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const entrada = Object.entries(paths).find(([, destinos]) =>
    destinos.some((destino) => destino.replace(/^\.\//, '').startsWith('src/')),
  );
  if (entrada === undefined) {
    throw new Error(
      'No encontré en tsconfig.json un alias de `paths` que apunte a src/. ' +
        'Si el alias cambió, actualizá este chequeo: sin él solo ve los imports relativos.',
    );
  }
  // `"@/*"` → `"@/"`.
  return entrada[0].replace(/\*$/, '');
}

const ALIAS_SRC = prefijoDelAlias();

/**
 * Los nombres de **valor** que un archivo importa de cada specifier del repo.
 *
 * Cuentan los relativos (`./ui`) **y los del alias** (`@/app/…/ui`), que es el
 * estilo dominante para cruzar directorios: mirar solo los relativos dejaba el
 * chequeo ciego justo donde una llamada nueva es más probable, y el bug volvería
 * en silencio. Los paquetes de `node_modules` no interesan: no llevan directiva.
 *
 * `import type { X } from './y'` y una lista de solo `{ type A, type B }` no
 * cuentan: se borran al compilar y nunca llegan a ser un valor en runtime.
 * De `{ X as Y }` se queda con `Y`, que es como se lo usa acá.
 */
function importsDeValorDelRepo(fuente: string): Map<string, string[]> {
  const porSpecifier = new Map<string, string[]>();
  // La cláusula no puede tener comillas ni `;`: sin eso el `*?` salta por
  // encima de un `from '…'` anterior y le atribuye a este módulo los nombres
  // que en realidad venían de drizzle.
  const re = /import\s+(type\s+)?([^;']*?)\s+from\s+'([^']+)'/g;
  let encontrado: RegExpExecArray | null;
  while ((encontrado = re.exec(fuente)) !== null) {
    const [, esType, clausula, specifier] = encontrado;
    if (esType !== undefined || specifier === undefined) continue;
    if (!specifier.startsWith('.') && !specifier.startsWith(ALIAS_SRC)) continue;
    const nombres = (clausula ?? '')
      .replace(/[{}]/g, '')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '' && !n.startsWith('type '))
      .map((n) => (n.includes(' as ') ? (n.split(' as ')[1] as string).trim() : n));
    if (nombres.length === 0) continue;
    porSpecifier.set(specifier, [...(porSpecifier.get(specifier) ?? []), ...nombres]);
  }
  return porSpecifier;
}

/**
 * El archivo real detrás de un specifier, con su extensión.
 *
 * `'./plano'` se resuelve contra el directorio del que importa; `'@/app/x/ui'`,
 * contra `raizSrc` — que en la corrida de verdad es `src/` y en el test del
 * propio chequeo es un directorio temporal, así que el mismo código resuelve
 * las dos formas en los dos escenarios.
 */
function resolverImport(desde: string, specifier: string, raizSrc: string): string | null {
  const base = specifier.startsWith(ALIAS_SRC)
    ? path.resolve(raizSrc, specifier.slice(ALIAS_SRC.length))
    : path.resolve(path.dirname(desde), specifier);
  const candidatos = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidato of candidatos) {
    try {
      if (statSync(candidato).isFile()) return candidato;
    } catch {
      // no existe: probamos el siguiente
    }
  }
  return null;
}

/**
 * ¿El archivo **llama** a ese nombre, o solo lo renderiza?
 *
 * Es la distinción que hace útil al chequeo. Importar un componente de un
 * `'use client'` y ponerlo en el JSX (`<BandejaConsultas … />`) es exactamente
 * para lo que existe la directiva. Lo que rompe es **invocarlo**
 * (`fuentesDeAfectadas(...)`): ahí del otro lado no hay función, hay una
 * referencia serializable, y Next tira «Attempted to call X() from the server».
 */
function loLlama(fuente: string, nombre: string): boolean {
  return new RegExp(`(?<![\\w.$])${nombre}\\s*\\(`).test(fuente);
}

/**
 * Todo módulo **sin** `'use client'` que **llame** a un nombre exportado por uno
 * que sí la tiene, bajo `raizSrc`.
 *
 * `raizSrc` es a la vez el árbol que se recorre y la raíz contra la que se
 * resuelve el alias, así que el test del propio chequeo puede apuntarlo a un
 * directorio temporal y ejercitar exactamente este código.
 */
function ofensoresDeFrontera(raizSrc: string): string[] {
  const fuentes = new Map(
    archivosDeFuente(raizSrc).map((archivo) => [archivo, readFileSync(archivo, 'utf8')]),
  );

  const ofensores: string[] = [];
  for (const [archivo, fuente] of fuentes) {
    if (tieneDirectivaUseClient(fuente)) continue; // cliente → cliente está bien
    for (const [specifier, nombres] of importsDeValorDelRepo(fuente)) {
      const destino = resolverImport(archivo, specifier, raizSrc);
      if (destino === null) continue;
      const fuenteDestino = fuentes.get(destino) ?? readFileSync(destino, 'utf8');
      if (!tieneDirectivaUseClient(fuenteDestino)) continue;
      for (const nombre of nombres) {
        if (!loLlama(fuente, nombre)) continue; // lo renderiza, no lo llama
        ofensores.push(
          `${path.relative(raizSrc, archivo)} llama a ${nombre}(), que exporta ` +
            `${path.relative(raizSrc, destino)} y es 'use client'`,
        );
      }
    }
  }
  return ofensores.sort();
}

describe('la frontera client/server, mirada desde el server', () => {
  it("ningún módulo de server llama a una función de un 'use client'", () => {
    expect(ofensoresDeFrontera(SRC)).toEqual([]);
  });

  /**
   * El chequeo mirándose a sí mismo, sobre un árbol de mentira.
   *
   * Un guard que nunca vio el bug que dice atrapar no es un guard: es una
   * función que devuelve `[]`. Este caso le pone delante las cuatro formas que
   * importan —la llamada por ruta relativa (la que rompió de verdad), **la
   * llamada por alias** (la que el chequeo no veía hasta esta ronda), el
   * componente que solo se renderiza y el import de tipo— y verifica que marque
   * exactamente las dos primeras.
   */
  it('marca la llamada, por ruta relativa Y por alias, y no el componente renderizado', () => {
    const raiz = mkdtempSync(path.join(tmpdir(), 'frontera-'));
    try {
      mkdirSync(path.join(raiz, 'app', 'panel'), { recursive: true });
      mkdirSync(path.join(raiz, 'app', 'otra'), { recursive: true });

      escribir(
        path.join(raiz, 'app', 'panel', 'ui.tsx'),
        `'use client';\n` +
          `export function ayuda(): number { return 1; }\n` +
          `export function Panel(): null { return null; }\n` +
          `export interface Vista { id: string }\n`,
      );

      // El caso que rompió de verdad: ruta relativa, y llama.
      escribir(
        path.join(raiz, 'app', 'panel', 'page.tsx'),
        `import { ayuda, Panel, type Vista } from './ui';\n` +
          `export default function P(v: Vista) { return ayuda() + (Panel ? 0 : 1) + v.id.length; }\n`,
      );

      // El que el chequeo no veía: el MISMO error cruzando directorios por alias.
      escribir(
        path.join(raiz, 'app', 'otra', 'page.tsx'),
        `import { ayuda } from '${ALIAS_SRC}app/panel/ui';\n` +
          `export default function O() { return ayuda(); }\n`,
      );

      // Renderizar un componente de un `'use client'` es para lo que existe la
      // directiva: no se marca.
      escribir(
        path.join(raiz, 'app', 'otra', 'solo-render.tsx'),
        `import { Panel } from '${ALIAS_SRC}app/panel/ui';\n` +
          `export default function R() { return <Panel />; }\n`,
      );

      // Un import de tipo se borra al compilar: tampoco se marca.
      escribir(
        path.join(raiz, 'app', 'otra', 'solo-tipo.ts'),
        `import type { Vista } from '${ALIAS_SRC}app/panel/ui';\n` +
          `export function largo(v: Vista): number { return v.id.length; }\n`,
      );

      expect(ofensoresDeFrontera(raiz)).toEqual([
        `app/otra/page.tsx llama a ayuda(), que exporta app/panel/ui.tsx y es 'use client'`,
        `app/panel/page.tsx llama a ayuda(), que exporta app/panel/ui.tsx y es 'use client'`,
      ]);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});
