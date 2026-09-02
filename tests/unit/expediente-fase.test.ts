/**
 * En qué anda el análisis, escrito para que lo lea un arquitecto.
 *
 * `obras.analisis_json` es un `FaseAnalisis` —cinco fases, más el error— y la
 * pantalla del expediente lo traduce. Es lo único de `progreso-ui.tsx` que se
 * puede equivocar sin que se note: un texto mal armado no rompe nada, deja al
 * arquitecto mirando «fase 3» sin saber por qué la planilla todavía está vacía.
 *
 * `enCurso` es lo que enciende y apaga el polling: si devolviera `true` sobre
 * una obra terminada, la pantalla pediría un refresh cada cuatro segundos para
 * siempre.
 */
import { describe, expect, it } from 'vitest';

import {
  enCurso,
  etiquetaDeEstado,
  FASE_VIEJA_MS,
  faseColgada,
  selloDeFase,
  textoDeFase,
} from '@/app/obras/[obraId]/expediente/progreso-ui';
import type { FaseAnalisis } from '@/types/domain';

/**
 * Una fase con el sello de tiempo que el pipeline deja (o dejará: el campo lo
 * agrega el arreglo del pipeline). `selloDeFase` lo lee con un ensanchamiento
 * explícito, así que acá se arma igual: el JSON de la columna es más ancho que
 * el tipo.
 */
function conSello(fase: FaseAnalisis, at: string): FaseAnalisis {
  return { ...fase, at } as FaseAnalisis;
}

describe('textoDeFase', () => {
  it('el inventario dice cuántas láminas lleva', () => {
    expect(textoDeFase({ fase: 'inventario', total: 25, completadas: 3 })).toBe(
      'Inventariando la documentación · 3 de 25',
    );
  });

  it('la extracción también, que es la fase larga', () => {
    expect(textoDeFase({ fase: 'extraccion', total: 25, completadas: 12 })).toBe(
      'Analizando las láminas · 12 de 25',
    );
  });

  it('sin total no inventa una cuenta', () => {
    expect(textoDeFase({ fase: 'extraccion' })).toBe('Analizando las láminas');
    expect(textoDeFase({ fase: 'inventario' })).toBe('Inventariando la documentación');
  });

  it('recién arrancada la cuenta es 0, no "sin datos"', () => {
    expect(textoDeFase({ fase: 'extraccion', total: 25, completadas: 0 })).toBe(
      'Analizando las láminas · 0 de 25',
    );
  });

  it('el cruce se nombra por lo que hace, no por su número de fase', () => {
    expect(textoDeFase({ fase: 'cruce' })).toBe('Cruzando la información del expediente');
  });

  it('la relectura dice cuántas láminas vuelve a mirar, en singular y en plural', () => {
    expect(textoDeFase({ fase: 'relectura', total: 2 })).toBe('Releyendo 2 láminas');
    expect(textoDeFase({ fase: 'relectura', total: 1 })).toBe('Releyendo 1 lámina');
    expect(textoDeFase({ fase: 'relectura' })).toBe('Releyendo las láminas que hacen falta');
  });

  it('terminado dice listo', () => {
    expect(textoDeFase({ fase: 'listo' })).toBe('Listo');
  });

  it('el error muestra su detalle: es lo único que dice qué falló', () => {
    expect(textoDeFase({ fase: 'error', detalle: 'A-03: no pude leer el rótulo' })).toBe(
      'El análisis terminó con problemas: A-03: no pude leer el rótulo',
    );
  });

  it('un error sin detalle no deja la frase colgada de dos puntos', () => {
    expect(textoDeFase({ fase: 'error' })).toBe('El análisis terminó con problemas');
    expect(textoDeFase({ fase: 'error', detalle: '' })).toBe('El análisis terminó con problemas');
  });
});

describe('enCurso', () => {
  it('las cuatro fases de trabajo mantienen el polling encendido', () => {
    expect(enCurso({ fase: 'inventario' })).toBe(true);
    expect(enCurso({ fase: 'extraccion' })).toBe(true);
    expect(enCurso({ fase: 'cruce' })).toBe(true);
    expect(enCurso({ fase: 'relectura' })).toBe(true);
  });

  it('listo y error lo apagan: si no, la pantalla pide para siempre', () => {
    expect(enCurso({ fase: 'listo' })).toBe(false);
    expect(enCurso({ fase: 'error', detalle: 'algo' })).toBe(false);
  });

  it('una obra que nunca se analizó tampoco lo enciende', () => {
    expect(enCurso(null)).toBe(false);
  });
});


describe('etiquetaDeEstado: el badge no puede decir «Analizando» cuando falló', () => {
  it('un análisis que terminó con problemas lo dice, y en rojo', () => {
    // Decía «Analizando» en rojo al lado de «El análisis terminó con
    // problemas», con el polling ya apagado: el badge afirmaba que algo estaba
    // pasando cuando no pasaba nada.
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

  it('una que hace más de media hora que no se mueve, sí', () => {
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
