/**
 * Regla `idem_tipologia` (§11 PRD): "ídem V1". La abertura sin acotar que
 * comparte tipología y prefijo de tag con otra acotada toma sus medidas.
 *
 * Es la regla más floja de las cinco (factor 0,75) porque el prefijo de tag es
 * una convención de dibujo, no un dato: apenas pasa el umbral y por eso casi
 * siempre exige lecturas muy limpias.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { deducir, type LaminaResumen } from '@/lib/deduccion/motor';

const LAMINAS: LaminaResumen[] = [{ id: 'L-planta', tipo: 'planta', codigo: 'A-01' }];

function abertura(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L-planta',
    tipo: 'abertura',
    nombre: 'V2',
    bbox: [0.1, 0.1, 0.05, 0.05],
    confianza: 0.96,
    estadoReforma: 'na',
    atributos: { tag: 'V2', tipologia: 'ventana' },
    ...over,
  };
}

/** V2 acotada: la que presta las medidas. */
const v2 = abertura({
  id: 'v2',
  atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.5, altoM: 1.1 },
});

/** V2a: la variante sin acotar. */
const v2a = abertura({
  id: 'v2a',
  nombre: 'V2a',
  bbox: [0.6, 0.1, 0.05, 0.05],
  atributos: { tag: 'V2a', tipologia: 'ventana' },
});

describe('deducción · ídem tipología', () => {
  it('V2a toma las medidas de V2', () => {
    const { propuestas, inconsistencias } = deducir([v2a, v2], LAMINAS);

    expect(inconsistencias).toEqual([]);
    expect(propuestas).toHaveLength(2);

    const [ancho, alto] = propuestas;
    expect(ancho!.entidadId).toBe('v2a');
    expect(ancho!.campo).toBe('anchoM');
    expect(ancho!.valor).toBe(1.5);
    expect(ancho!.regla).toBe('idem_tipologia');
    // 0,75 (factor) × 0,96 = 0,72: la regla más floja apenas pasa el umbral
    expect(ancho!.confianza).toBe(0.72);
    expect(ancho!.fuentes).toEqual([
      { laminaId: 'L-planta', bbox: [0.6, 0.1, 0.05, 0.05], detalle: 'V2a' },
      { laminaId: 'L-planta', bbox: [0.1, 0.1, 0.05, 0.05], detalle: 'V2' },
    ]);
    expect(ancho!.explicacion).toBe(
      'V2a no está acotada y comparte tipología (ventana) con V2 (lámina A-01): toma su ancho 1,50 m.',
    );

    expect(alto!.campo).toBe('altoM');
    expect(alto!.valor).toBe(1.1);
  });

  it('P1 puerta NO toma las medidas de V2 ventana', () => {
    const p1 = abertura({
      id: 'p1',
      nombre: 'P1',
      bbox: [0.6, 0.1, 0.05, 0.05],
      atributos: { tag: 'P1', tipologia: 'puerta' },
    });

    expect(deducir([p1, v2], LAMINAS).propuestas).toEqual([]);
  });

  it('mismo prefijo pero otra tipología tampoco alcanza', () => {
    const v2Puerta = abertura({
      id: 'v2p',
      nombre: 'V2p',
      bbox: [0.6, 0.1, 0.05, 0.05],
      atributos: { tag: 'V2p', tipologia: 'puerta' },
    });

    expect(deducir([v2Puerta, v2], LAMINAS).propuestas).toEqual([]);
  });

  it('V21 no es una variante de V2: el sufijo numérico es otro tag', () => {
    const v21 = abertura({
      id: 'v21',
      nombre: 'V21',
      bbox: [0.6, 0.1, 0.05, 0.05],
      atributos: { tag: 'V21', tipologia: 'ventana' },
    });

    expect(deducir([v21, v2], LAMINAS).propuestas).toEqual([]);
  });

  it('el prefijo va en un solo sentido: V2 no toma las medidas de V2a', () => {
    const v2aAcotada = abertura({
      id: 'v2a',
      nombre: 'V2a',
      bbox: [0.6, 0.1, 0.05, 0.05],
      atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 1.5, altoM: 1.1 },
    });
    const v2Vacia = abertura({ id: 'v2', atributos: { tag: 'V2', tipologia: 'ventana' } });

    expect(deducir([v2Vacia, v2aAcotada], LAMINAS).propuestas).toEqual([]);
  });

  it('dos variantes candidatas que no coinciden: no se elige ninguna', () => {
    const v2b = abertura({
      id: 'v2b',
      nombre: 'V2b',
      bbox: [0.3, 0.1, 0.05, 0.05],
      atributos: { tag: 'V2b', tipologia: 'ventana' },
    });
    const v2Otra = abertura({
      id: 'v2-otra',
      bbox: [0.8, 0.1, 0.05, 0.05],
      atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.2, altoM: 1.1 },
    });

    const { propuestas } = deducir([v2b, v2, v2Otra], LAMINAS);

    expect(propuestas.map((p) => p.campo)).toEqual(['altoM']); // el alto coincide; el ancho no
  });

  it('gana el prefijo más largo: V2a1 hereda de V2a, no de V2', () => {
    const v2a1 = abertura({
      id: 'v2a1',
      nombre: 'V2a-1',
      bbox: [0.3, 0.1, 0.05, 0.05],
      atributos: { tag: 'V2a-1', tipologia: 'ventana' },
    });
    const v2aAcotada = abertura({
      id: 'v2a',
      nombre: 'V2a',
      bbox: [0.6, 0.1, 0.05, 0.05],
      atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 0.9, altoM: 1.1 },
    });

    const { propuestas } = deducir([v2a1, v2, v2aAcotada], LAMINAS);

    expect(propuestas.filter((p) => p.entidadId === 'v2a1').map((p) => p.valor)).toEqual([0.9, 1.1]);
  });

  it('la planilla de carpinterías le gana: prioridad de reglas', () => {
    const laminas: LaminaResumen[] = [...LAMINAS, { id: 'L-planilla', tipo: 'planilla', codigo: 'A-05' }];
    const v2aEnPlanilla = abertura({
      id: 'v2a-planilla',
      nombre: 'V2a',
      laminaId: 'L-planilla',
      bbox: [0.4, 0.3, 0.2, 0.04],
      atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 0.8, altoM: 1.1 },
    });

    const { propuestas } = deducir([v2a, v2, v2aEnPlanilla], laminas);

    const deV2a = propuestas.filter((p) => p.entidadId === 'v2a');
    expect(deV2a.map((p) => [p.regla, p.valor])).toEqual([
      ['planilla_plano', 0.8],
      ['planilla_plano', 1.1],
    ]);
  });

  it('confianza justo por debajo: 0,75 × 0,9 = 0,68, no sale', () => {
    const floja = abertura({ ...v2a, id: 'v2a', confianza: 0.9 });

    expect(deducir([floja, v2], LAMINAS).propuestas).toEqual([]);
  });
});
