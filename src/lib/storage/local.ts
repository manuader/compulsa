/**
 * Adaptador de storage sobre el filesystem local (`data/uploads/`).
 *
 * La referencia que devuelve `guardar()` es la propia ruta relativa con
 * separadores POSIX: así `/api/archivos/[...ref]` la sirve sin traducción.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { StorageAdapter } from './index';

export const RAIZ_UPLOADS = path.join(process.cwd(), 'data', 'uploads');

/**
 * Resuelve `ruta` dentro de `raiz` y falla si se escapa (`..`, ruta absoluta).
 * Las refs viajan por la URL: sin este chequeo son un directory traversal.
 */
export function resolverRuta(raiz: string, ruta: string): string {
  const raizAbs = path.resolve(raiz);
  const destino = path.resolve(raizAbs, ruta);
  if (destino !== raizAbs && !destino.startsWith(raizAbs + path.sep)) {
    throw new Error(`Ruta de storage inválida (se escapa de la raíz): ${ruta}`);
  }
  return destino;
}

export function crearStorageLocal(raiz: string = RAIZ_UPLOADS): StorageAdapter {
  return {
    // `mime` no se usa acá (el filesystem no lo guarda); lo persiste
    // `documentos.mime`. El parámetro existe para el adaptador de Supabase.
    async guardar(ruta, bytes, _mime) {
      const destino = resolverRuta(raiz, ruta);
      await mkdir(path.dirname(destino), { recursive: true });
      await writeFile(destino, bytes);
      return path.relative(path.resolve(raiz), destino).split(path.sep).join('/');
    },

    async leer(ref) {
      const origen = resolverRuta(raiz, ref);
      const buffer = await readFile(origen);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },

    // Misma guarda anti-traversal que `leer`: la ref sale de la base, pero la
    // base la escribió a partir de datos que en algún momento vinieron de una
    // request. `ENOENT` se traga a propósito (ver `StorageAdapter.eliminar`);
    // cualquier otro error del filesystem sí sube.
    async eliminar(ref) {
      const destino = resolverRuta(raiz, ref);
      try {
        await unlink(destino);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
