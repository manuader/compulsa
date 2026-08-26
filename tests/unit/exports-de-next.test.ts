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

describe('route handlers de src/app/api', () => {
  const rutas = archivosDeFuente(API).filter((archivo) => path.basename(archivo) === 'route.ts');

  it('hay al menos uno (si no, el test se volvió decorativo)', () => {
    expect(rutas.length).toBeGreaterThan(0);
  });

  it('exportan solo verbos HTTP y opciones de segmento', () => {
    expect(ofensores(rutas, SOLO_HANDLERS_Y_OPCIONES)).toEqual([]);
  });
});
