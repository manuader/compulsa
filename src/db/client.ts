/**
 * Único punto de acceso a la base (ver `src/db/CLAUDE.md` §1).
 *
 * - `DATABASE_URL` seteada  → Postgres real (producción / Supabase).
 * - `NODE_ENV === 'test'`   → PGlite en memoria.
 * - resto                   → PGlite persistido en `data/pglite/`.
 *
 * El cliente vive en `globalThis.__compulsaDb` como *promesa*: así el hot-reload
 * de Next no abre clientes duplicados y las migraciones corren exactamente una
 * vez por proceso, aunque `getDb()` se llame en paralelo desde varias requests.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from './schema';

export type Esquema = typeof schema;

/** Handle de la base, agnóstico del driver (PGlite en dev/test, postgres-js en prod). */
export type Db = PgDatabase<PgQueryResultHKT, Esquema>;

declare global {
  // eslint-disable-next-line no-var
  var __compulsaDb: Promise<Db> | undefined;
}

/**
 * `data/pglite/`, creada si no está.
 *
 * PGlite hace un `mkdirSync` **no recursivo** sobre el directorio que se le
 * pasa: con `data/` ausente —un clon recién bajado, o el «borrá `data/` y volvé
 * a sembrar» del README— revienta con `ENOENT` antes de la primera migración, y
 * lo que se ve en pantalla es `Failed query: CREATE SCHEMA IF NOT EXISTS
 * "drizzle"`, que no menciona ningún directorio. Un `mkdir -p` de una línea de
 * nuestro lado sale más barato que el rato que se pierde leyendo ese error.
 *
 * `raiz` es un parámetro para poder testearlo contra un temporal; en producción
 * siempre es `process.cwd()`, como el resto del módulo.
 */
export function carpetaPglite(raiz: string = process.cwd()): string {
  const dir = path.join(raiz, 'data', 'pglite');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Carpeta de migraciones generada por `npm run db:generate`. */
function carpetaMigraciones(): string {
  // Tanto `next` como `vitest` y los scripts de `tsx` corren desde la raíz del
  // repo; `import.meta.url` no sirve acá porque apunta a `.next/` tras el build.
  return path.join(process.cwd(), 'drizzle');
}

/**
 * `max: 1` es **load-bearing**, no una configuración conservadora.
 *
 * Con una sola conexión los statements de todo el proceso quedan serializados,
 * y hay tres lugares del dominio que hoy dependen de eso porque hacen
 * read-modify-write sin `SELECT … FOR UPDATE`:
 *
 *  - **El índice de precios** (`acumularMuestra` en `flujo.ts`): lee
 *    `price_index.muestras_json`, le suma la muestra y reescribe la fila. Dos
 *    cotizaciones registradas a la vez sobre la misma `(clave, zona, mes)` se
 *    pisarían la serie y perderían una muestra.
 *  - **El último titular** (`usuarios.ts`): el `UPDATE` condicional es exacto
 *    con los statements serializados; el TODO de ahí explica por qué no se usó
 *    `db.transaction` + `FOR UPDATE` (PGlite tiene una sola conexión y el lock
 *    no protegería nada) y qué hay que hacer al pasar a un pool.
 *  - **La adjudicación** (`adjudicar.ts`): esa sí está cubierta por el UNIQUE
 *    `adjudicaciones_compulsa_uq`, que serializa en la base y no depende del
 *    pool. Queda acá para que se vea cuál es el patrón que sí sobrevive.
 *
 * Subir `max` sin cerrar los dos primeros con transacciones y `FOR UPDATE`
 * cambia el comportamiento del producto, no su throughput.
 */
async function crearDbPostgres(url: string): Promise<Db> {
  const [{ drizzle }, { migrate }, postgres] = await Promise.all([
    import('drizzle-orm/postgres-js'),
    import('drizzle-orm/postgres-js/migrator'),
    import('postgres').then((m) => m.default),
  ]);
  const db = drizzle(postgres(url, { max: 1 }), { schema });
  await migrate(db, { migrationsFolder: carpetaMigraciones() });
  return db as unknown as Db;
}

async function crearDbPglite(): Promise<Db> {
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  const cliente = process.env.NODE_ENV === 'test' ? new PGlite() : new PGlite(carpetaPglite());
  const db = drizzle(cliente, { schema });
  await migrate(db, { migrationsFolder: carpetaMigraciones() });
  return db as unknown as Db;
}

async function crearDb(): Promise<Db> {
  const url = process.env.DATABASE_URL?.trim();
  return url ? crearDbPostgres(url) : crearDbPglite();
}

/** Singleton. La primera llamada corre las migraciones; las siguientes esperan la misma promesa. */
export function getDb(): Promise<Db> {
  globalThis.__compulsaDb ??= crearDb().catch((error: unknown) => {
    // Un arranque fallido no puede quedar cacheado: la próxima llamada reintenta.
    globalThis.__compulsaDb = undefined;
    throw error;
  });
  return globalThis.__compulsaDb;
}

/** Inyecta la base que va a devolver `getDb()`. Solo para tests (`createTestDb()`). */
export function setDbForTests(db: Db): void {
  globalThis.__compulsaDb = Promise.resolve(db);
}

/** Suelta el singleton: la próxima `getDb()` vuelve a construirlo. */
export function resetDb(): void {
  globalThis.__compulsaDb = undefined;
}
