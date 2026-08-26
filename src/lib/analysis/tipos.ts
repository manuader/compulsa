/**
 * Vocabulario compartido de los providers de análisis.
 *
 * Acá vive lo que `mock.ts` y `claude.ts` tienen en común: la interfaz, el shape
 * de una lámina analizada (que es también el shape de los fixtures y el de la
 * salida estructurada del LLM) y el rótulo "no pude leer nada".
 */
import { z } from 'zod';
import {
  zEntidadDetectada,
  zRotuloDetectado,
  type EntidadDetectada,
  type LaminaInput,
  type ObraContexto,
  type RotuloDetectado,
} from '@/types/domain';

/**
 * La frontera con el mundo no determinístico (`src/lib/analysis/CLAUDE.md`).
 * Dos implementaciones: `crearProviderMock()` y `crearProviderClaude()`.
 */
export interface AnalysisProvider {
  /** Título, código, escala, disciplina, tipo y revisión del rótulo de la lámina. */
  leerRotulo(lamina: LaminaInput): Promise<RotuloDetectado>;
  /** Entidades de la lámina, todas con bbox normalizado y confianza. */
  extraerEntidades(lamina: LaminaInput, ctx: ObraContexto): Promise<EntidadDetectada[]>;
}

/**
 * Una lámina analizada por completo. Es el contrato de tres cosas a la vez:
 * los fixtures JSON del mock, la salida estructurada de Claude y lo que el
 * pipeline persiste.
 */
export const zAnalisisLamina = z.object({
  rotulo: zRotuloDetectado,
  entidades: z.array(zEntidadDetectada),
});

export type AnalisisLamina = z.infer<typeof zAnalisisLamina>;

/**
 * Rótulo devuelto cuando no hay nada que leer (sin fixture, o el LLM no encontró
 * rótulo). `escalaConfiable: false` es deliberado: el pipeline bloquea la lámina
 * y le pide la escala al usuario en vez de inventarla (P4).
 */
export function rotuloNulo(): RotuloDetectado {
  return {
    titulo: null,
    codigo: null,
    disciplina: null,
    tipoLamina: null,
    escala: null,
    escalaConfiable: false,
    revision: null,
    confianza: 0,
  };
}

/** Minúsculas, sin extensión, todo lo no alfanumérico colapsado a `-`. */
export function slug(nombre: string): string {
  return nombre
    .replace(/\.[^./\\]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Clave del fixture de una lámina: `slug(documentoNombre)-p<numeroPagina>`.
 *
 * No usamos el hash de los bytes: pdf-lib re-serializa cada página con fechas
 * propias y el hash no es estable entre corridas.
 */
export function claveFixture(documentoNombre: string, numeroPagina: number): string {
  return `${slug(documentoNombre)}-p${numeroPagina}`;
}
