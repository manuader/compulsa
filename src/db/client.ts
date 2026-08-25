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

/** Carpeta de migraciones generada por `npm run db:generate`. */
function carpetaMigraciones(): string {
  // Tanto `next` como `vitest` y los scripts de `tsx` corren desde la raíz del
  // repo; `import.meta.url` no sirve acá porque apunta a `.next/` tras el build.
  return path.join(process.cwd(), 'drizzle');
}

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
  const cliente =
    process.env.NODE_ENV === 'test'
      ? new PGlite()
      : new PGlite(path.join(process.cwd(), 'data', 'pglite'));
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
