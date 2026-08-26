/**
 * `carpetaPglite()` crea el directorio de la base si no está.
 *
 * PGlite hace un `mkdirSync` no recursivo sobre lo que se le pasa: con `data/`
 * ausente —un clon recién bajado, o el «borrá `data/` y volvé a sembrar» que
 * dice el README— tira `ENOENT` antes de la primera migración, envuelto en un
 * `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` que no menciona ningún
 * directorio. Pasó de verdad: `npm run seed` sobre un worktree limpio no
 * arrancaba.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { carpetaPglite } from '@/db/client';

describe('carpetaPglite', () => {
  let raiz: string;

  beforeEach(() => {
    raiz = mkdtempSync(path.join(tmpdir(), 'compulsa-db-'));
  });

  afterEach(() => {
    rmSync(raiz, { recursive: true, force: true });
  });

  it('crea data/pglite cuando no existe ni el padre', () => {
    expect(existsSync(path.join(raiz, 'data'))).toBe(false);

    const dir = carpetaPglite(raiz);

    expect(dir).toBe(path.join(raiz, 'data', 'pglite'));
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('es idempotente: llamarla dos veces no rompe', () => {
    const primera = carpetaPglite(raiz);
    const segunda = carpetaPglite(raiz);

    expect(segunda).toBe(primera);
    expect(statSync(segunda).isDirectory()).toBe(true);
  });
});
