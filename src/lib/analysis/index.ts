/**
 * Punto de entrada de los providers de análisis.
 *
 * El resto del sistema pide `getAnalysisProvider()` y no sabe cuál le tocó: esa
 * es toda la gracia del adaptador (CLAUDE.md — "adaptadores, no dependencias
 * directas").
 */
import { crearProviderClaude } from './claude';
import { crearProviderMock } from './mock';
import type { AnalysisProvider } from './tipos';

export type { AnalisisLamina, AnalysisProvider } from './tipos';
export { claveFixture, rotuloNulo, slug, zAnalisisLamina } from './tipos';
export { crearProviderMock, DIR_FIXTURES_ANALISIS } from './mock';
export { crearProviderClaude } from './claude';

/**
 * Claude solo con `ANTHROPIC_API_KEY` **y** fuera de tests; si no, el mock.
 *
 * La condición sobre `NODE_ENV` no es defensa en profundidad de más: es el
 * seguro que garantiza que ninguna suite salga a la red ni gaste tokens aunque
 * la key esté exportada en la máquina de quien corre los tests.
 */
export function getAnalysisProvider(): AnalysisProvider {
  if (process.env.NODE_ENV !== 'test' && process.env.ANTHROPIC_API_KEY) {
    return crearProviderClaude();
  }
  return crearProviderMock();
}
