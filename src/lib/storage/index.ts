/**
 * Storage como adaptador (CLAUDE.md: "adaptadores, no dependencias directas").
 * Hoy solo existe el local; el de Supabase Storage entra implementando la misma
 * interfaz, sin que el core se entere.
 */
import { crearStorageLocal } from './local';

export interface StorageAdapter {
  /** Guarda `bytes` en `ruta` (relativa a la raíz del storage) y devuelve la ref. */
  guardar(ruta: string, bytes: Uint8Array, mime: string): Promise<string>;
  /** Lee los bytes de una ref devuelta por `guardar()`. */
  leer(ref: string): Promise<Uint8Array>;
}

let adaptador: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  adaptador ??= crearStorageLocal();
  return adaptador;
}

export { crearStorageLocal, RAIZ_UPLOADS, resolverRuta } from './local';
