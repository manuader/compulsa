/**
 * Guardia de los archivos `'use server'`.
 *
 * Next compila cada archivo con la directiva `'use server'` como un módulo de
 * Server Actions, y ahí **lo único que se puede exportar en runtime son
 * funciones `async`**. Exportar una clase, una constante o una función sincrónica
 * no rompe ni el type-check ni los tests —que importan el módulo derecho, sin
 * pasar por el loader de Next— pero rompe el `next build` y, en desarrollo,
 * devuelve un 500 en la primera pantalla que toque ese módulo:
 *
 *     Only async functions are allowed to be exported in a "use server" file.
 *
 * Pasó de verdad: `EstadoContactoInvalidoError` vivía en el `'use server'` de
 * conversaciones y dejaba la pantalla de la conversación en 500. Este test es
 * más barato que un build y falla en el lugar exacto.
 *
 * Los `export type` y `export interface` sí están permitidos: se borran al
 * compilar, así que nunca llegan a ser un export de runtime.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const RAIZ = path.join(process.cwd(), 'src');

/** Todos los `.ts`/`.tsx` de `src/`, sin seguir symlinks ni entrar a `node_modules`. */
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
 * Las líneas que arrancan un export de runtime que Next va a rechazar.
 *
 * Se mira solo el arranque de línea: dentro de un template literal o de un
 * comentario un `export class` va indentado o no está al margen izquierdo, y
 * ningún archivo del repo escribe una declaración exportada con sangría.
 */
function exportsProhibidos(fuente: string): string[] {
  return fuente
    .split('\n')
    .map((linea, indice) => ({ linea, numero: indice + 1 }))
    .filter(({ linea }) => /^export\b/.test(linea))
    .filter(({ linea }) => !/^export\s+(async\s+function|type\s|interface\s)/.test(linea))
    .map(({ linea, numero }) => `${numero}: ${linea.trim()}`);
}

describe(`archivos 'use server'`, () => {
  const conDirectiva = archivosDeFuente(RAIZ).filter((archivo) =>
    tieneDirectivaUseServer(readFileSync(archivo, 'utf8')),
  );

  it('hay al menos uno (si no, el test se volvió decorativo)', () => {
    expect(conDirectiva.length).toBeGreaterThan(0);
  });

  it('exportan solo funciones async (más tipos, que se borran al compilar)', () => {
    const ofensores = conDirectiva
      .map((archivo) => ({
        archivo: path.relative(process.cwd(), archivo),
        lineas: exportsProhibidos(readFileSync(archivo, 'utf8')),
      }))
      .filter(({ lineas }) => lineas.length > 0);

    expect(ofensores).toEqual([]);
  });
});
