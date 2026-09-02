/**
 * El cartel de progreso del expediente cuando el análisis **no** está corriendo.
 *
 * `textoDeFase` y `enCurso` —lo que dice cada fase y lo que enciende el
 * polling— se prueban en `expediente-fase.test.ts`. Acá van las dos cosas que
 * la revisión final encontró mal, que son sobre lo contrario: qué muestra la
 * pantalla cuando el análisis terminó mal o se murió sin avisar.
 *
 *  - el badge decía «Analizando» —en rojo— al lado de «El análisis terminó con
 *    problemas», con el polling ya apagado: afirmaba que algo estaba pasando
 *    cuando no pasaba nada;
 *  - una fase que dejó de moverse dejaba la barra girando para siempre, que es
 *    el spinner eterno que el §6 de `app/CLAUDE.md` prohíbe.
 *
 * ## Ojo al integrar con la rama del pipeline
 *
 * `faseColgada`/`selloDeFase` son **la mitad de pantalla** de algo que el
 * pipeline resolvió del otro lado en paralelo: `FaseAnalisis.desde` y
 * `faseVencida(fase, ahora)` en `types/domain.ts`, con
 * `TTL_FASE_ANALISIS_MS`. Cuando las dos ramas estén juntas, esto se borra y
 * `ProgresoAnalisis` llama a `faseVencida` directo — los nombres del campo y el
 * TTL ya coinciden a propósito para que sea un borrado y no una reescritura.
 */
import { describe, expect, it } from 'vitest';

import {
  etiquetaDeEstado,
  FASE_VIEJA_MS,
  faseColgada,
  selloDeFase,
} from '@/app/obras/[obraId]/expediente/progreso-ui';
import type { FaseAnalisis } from '@/types/domain';

/**
 * Una fase con el sello de tiempo que el pipeline escribe en cada marca. Se
 * arma con un ensanchamiento explícito porque `selloDeFase` lo lee igual: el
 * JSON de la columna puede ser más ancho que el tipo de esta rama.
 */
function conSello(fase: FaseAnalisis, desde: string): FaseAnalisis {
  return { ...fase, desde } as FaseAnalisis;
}

describe('etiquetaDeEstado: el badge no puede decir «Analizando» cuando falló', () => {
  it('un análisis que terminó con problemas lo dice, y en rojo', () => {
    expect(etiquetaDeEstado({ fase: 'error', detalle: 'se cayó el cruce' }, false)).toEqual({
      texto: 'Con problemas',
      tono: 'error',
    });
  });

  it('el que terminó bien y el que está corriendo se siguen leyendo igual', () => {
    expect(etiquetaDeEstado({ fase: 'listo' }, false)).toEqual({ texto: 'Analizado', tono: 'ok' });
    expect(etiquetaDeEstado({ fase: 'extraccion', total: 25, completadas: 3 }, false)).toEqual({
      texto: 'Analizando',
      tono: 'info',
    });
  });

  it('una fase colgada deja de afirmar que algo está pasando', () => {
    expect(etiquetaDeEstado({ fase: 'extraccion', total: 25, completadas: 3 }, true)).toEqual({
      texto: 'Sin novedades',
      tono: 'warn',
    });
  });
});

describe('faseColgada: un pipeline que se murió sin escribir su error', () => {
  const AHORA = Date.parse('2026-09-02T18:00:00.000Z');
  const CORRIENDO: FaseAnalisis = { fase: 'extraccion', total: 25, completadas: 3 };

  it('sin sello no se puede saber, y no se inventa', () => {
    expect(selloDeFase(CORRIENDO)).toBeNull();
    expect(faseColgada(CORRIENDO, AHORA)).toBe(false);
  });

  it('una fase que se movió recién no está colgada', () => {
    const fase = conSello(CORRIENDO, new Date(AHORA - FASE_VIEJA_MS + 60_000).toISOString());
    expect(faseColgada(fase, AHORA)).toBe(false);
  });

  it('una que hace más del TTL que no se mueve, sí', () => {
    const fase = conSello(CORRIENDO, new Date(AHORA - FASE_VIEJA_MS - 60_000).toISOString());
    expect(faseColgada(fase, AHORA)).toBe(true);
  });

  it('una terminada nunca está colgada, por vieja que sea', () => {
    const vieja = new Date(AHORA - 30 * FASE_VIEJA_MS).toISOString();
    expect(faseColgada(conSello({ fase: 'listo' }, vieja), AHORA)).toBe(false);
    expect(faseColgada(conSello({ fase: 'error' }, vieja), AHORA)).toBe(false);
    expect(faseColgada(null, AHORA)).toBe(false);
  });

  it('un sello ilegible no cuelga la fase: se comporta como si no estuviera', () => {
    expect(faseColgada(conSello(CORRIENDO, 'cuando sea'), AHORA)).toBe(false);
  });
});
