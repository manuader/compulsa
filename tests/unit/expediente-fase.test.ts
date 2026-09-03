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

import { enCurso, textoDeFase } from '@/app/obras/[obraId]/expediente/progreso-ui';
import { faseVencida, TTL_FASE_ANALISIS_MS } from '@/types/domain';

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

/**
 * El otro lado del polling: `enCurso` dice si la fase **se declara** en curso;
 * `faseVencida` dice si esa declaración todavía se puede creer.
 *
 * `procesarDocumento` corre adentro del POST del upload (`maxDuration = 300`),
 * así que un expediente grande sobre el provider real se pasa del límite y el
 * proceso muere en el medio de una fase. Nadie escribe el `error`: la columna
 * queda diciendo «Analizando las láminas · 12 de 25» y la pantalla pide un
 * refresh cada cuatro segundos, para siempre.
 */
describe('faseVencida', () => {
  const AHORA = Date.parse('2026-09-02T12:00:00.000Z');
  const haceMinutos = (minutos: number) => new Date(AHORA - minutos * 60_000).toISOString();

  it('una fase que arrancó recién no venció', () => {
    expect(faseVencida({ fase: 'extraccion', desde: haceMinutos(2) }, AHORA)).toBe(false);
  });

  it('una fase más vieja que el TTL sí: el proceso que la escribió ya no existe', () => {
    expect(faseVencida({ fase: 'extraccion', desde: haceMinutos(11) }, AHORA)).toBe(true);
    expect(TTL_FASE_ANALISIS_MS).toBe(10 * 60 * 1000);
  });

  it('justo en el límite todavía no venció', () => {
    const enElBorde = new Date(AHORA - TTL_FASE_ANALISIS_MS).toISOString();
    expect(faseVencida({ fase: 'cruce', desde: enElBorde }, AHORA)).toBe(false);
  });

  it('una fase terminada no vence nunca: ya llegó a donde iba', () => {
    expect(faseVencida({ fase: 'listo', desde: haceMinutos(600) }, AHORA)).toBe(false);
    expect(faseVencida({ fase: 'error', detalle: 'x', desde: haceMinutos(600) }, AHORA)).toBe(false);
  });

  it('sin `desde` se lee como en curso: es una fila vieja, no una colgada', () => {
    expect(faseVencida({ fase: 'extraccion', total: 25, completadas: 12 }, AHORA)).toBe(false);
    expect(faseVencida({ fase: 'cruce', desde: 'no es una fecha' }, AHORA)).toBe(false);
  });

  it('una obra que nunca se analizó no tiene fase que vencer', () => {
    expect(faseVencida(null, AHORA)).toBe(false);
  });
});
