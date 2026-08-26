/**
 * Base de datos para tests: PGlite **en memoria** + las migraciones de
 * `drizzle/`. Cada suite arma la suya; nada persiste entre corridas.
 *
 * Para que el código de la app (`getDb()`) use esta base, inyectala con
 * `setDbForTests(db)` de `@/db/client`.
 */
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import type { Db } from '@/db/client';
import * as schema from '@/db/schema';

export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  return db as unknown as Db;
}
