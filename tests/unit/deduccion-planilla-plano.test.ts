/**
 * Regla `planilla_plano` (§11 PRD): la carpintería que la planta no acota toma
 * sus medidas de la planilla de carpinterías con el mismo tag —y a la inversa,
 * para reconstruir la planilla derivada (RF-504) desde los planos.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { deducir, type LaminaResumen } from '@/lib/deduccion/motor';
import { normalizarTag } from '@/lib/deduccion/reglas/planilla-plano';

const LAMINAS: LaminaResumen[] = [
  { id: 'L-planta', tipo: 'planta', codigo: 'A-01' },
  { id: 'L-planilla', tipo: 'planilla', codigo: 'A-05' },
  { id: 'L-planta-2', tipo: 'planta', codigo: 'A-02' },
];

function abertura(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L-planta',
    tipo: 'abertura',
    nombre: 'V2',
    bbox: [0.1, 0.1, 0.05, 0.05],
    confianza: 0.8,
    estadoReforma: 'na',
    atributos: { tag: 'V2', tipologia: 'ventana' },
    ...over,
  };
}

/** V2 dibujada en planta sin cotas: es la que hay que completar. */
const v2EnPlanta = abertura({ id: 'e-planta', confianza: 0.8 });

/** La misma V2 en la planilla de carpinterías, con las dos medidas. */
const v2EnPlanilla = abertura({
  id: 'e-planilla',
  laminaId: 'L-planilla',
  bbox: [0.4, 0.3, 0.2, 0.04],
  confianza: 0.9,
  atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.5, altoM: 1.1 },
});

describe('deducción · planilla ↔ plano', () => {
  it('completa ancho y alto de la V2 de planta con los de la planilla', () => {
    const { propuestas, inconsistencias } = deducir([v2EnPlanta, v2EnPlanilla], LAMINAS);

    expect(inconsistencias).toEqual([]);
    expect(propuestas).toHaveLength(2);

    const [ancho, alto] = propuestas;
    expect(ancho!.entidadId).toBe('e-planta');
    expect(ancho!.campo).toBe('anchoM');
    expect(ancho!.valor).toBe(1.5);
    expect(ancho!.regla).toBe('planilla_plano');
    // 0,95 (factor de la regla) × 0,8 (la peor de las dos entidades)
    expect(ancho!.confianza).toBe(0.76);
    expect(ancho!.fuentes).toEqual([
      { laminaId: 'L-planta', bbox: [0.1, 0.1, 0.05, 0.05], detalle: 'V2' },
      { laminaId: 'L-planilla', bbox: [0.4, 0.3, 0.2, 0.04], detalle: 'V2' },
    ]);
    expect(ancho!.explicacion).toBe(
      'El ancho 1,50 m de V2 sale de la planilla de carpinterías (lámina A-05); ' +
        'en el plano (lámina A-01) la abertura está sin acotar.',
    );

    expect(alto!.campo).toBe('altoM');
    expect(alto!.valor).toBe(1.1);
    expect(alto!.confianza).toBe(0.76);
  });

  it('a la inversa: reconstruye la planilla desde el plano acotado (RF-504)', () => {
    const enPlanilla = abertura({
      id: 'p-vacia',
      laminaId: 'L-planilla',
      bbox: [0.4, 0.3, 0.2, 0.04],
      nombre: 'V3',
      confianza: 0.9,
      atributos: { tag: 'V3', tipologia: 'ventana' },
    });
    const enPlanta = abertura({
      id: 'p-acotada',
      nombre: 'V3',
      confianza: 0.8,
      atributos: { tag: 'V3', tipologia: 'ventana', anchoM: 0.9, altoM: 2.05 },
    });

    const { propuestas } = deducir([enPlanilla, enPlanta], LAMINAS);

    expect(propuestas.map((p) => [p.entidadId, p.campo, p.valor])).toEqual([
      ['p-vacia', 'anchoM', 0.9],
      ['p-vacia', 'altoM', 2.05],
    ]);
    expect(propuestas[0]!.explicacion).toBe(
      'El ancho 0,90 m de V3 lo trae el plano (lámina A-01); ' +
        'la planilla de carpinterías (lámina A-05) lo tiene vacío.',
    );
  });

  it('completa solo el campo que falta: el ancho acotado en planta no se toca', () => {
    const conAncho = abertura({ id: 'mixta', atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.2 } });

    const { propuestas } = deducir([conAncho, v2EnPlanilla], LAMINAS);

    expect(propuestas).toHaveLength(1);
    expect(propuestas[0]!.campo).toBe('altoM');
    expect(propuestas[0]!.valor).toBe(1.1);
  });

  it('no cruza tags distintos', () => {
    const v7 = abertura({ id: 'v7', nombre: 'V7', atributos: { tag: 'V7', tipologia: 'ventana' } });

    expect(deducir([v7, v2EnPlanilla], LAMINAS).propuestas).toEqual([]);
  });

  it('dos plantas no se completan entre sí por esta regla: hace falta una planilla', () => {
    const sinCotas = abertura({ id: 'sin-cotas', confianza: 0.9 });
    const otraPlanta = abertura({
      id: 'otra-planta',
      laminaId: 'L-planta-2',
      bbox: [0.5, 0.5, 0.05, 0.05],
      confianza: 0.9,
      atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.5, altoM: 1.1 },
    });

    const { propuestas } = deducir([sinCotas, otraPlanta], LAMINAS);

    // Lo resuelve continuidad, que es la regla que corresponde entre dos plantas.
    expect(propuestas.filter((p) => p.regla === 'planilla_plano')).toEqual([]);
  });

  it('confianza por debajo del umbral: no propone nada, ni inconsistencia', () => {
    // 0,95 × 0,6 = 0,57 < 0,7 (regla de oro §11.b)
    const dudosa = abertura({ id: 'dudosa', confianza: 0.6 });

    expect(deducir([dudosa, v2EnPlanilla], LAMINAS)).toEqual({ propuestas: [], inconsistencias: [] });
  });
});

describe('normalizarTag', () => {
  it('saca espacios (también los internos) y pasa a mayúsculas', () => {
    expect(normalizarTag(' fp 01 ')).toBe('FP01');
    expect(normalizarTag('v5')).toBe('V5');
    expect(normalizarTag('V 5')).toBe('V5');
    expect(normalizarTag('V5')).toBe('V5');
  });

  it('es idempotente y no toca un tag ya limpio', () => {
    expect(normalizarTag(normalizarTag(' p 3 '))).toBe('P3');
    expect(normalizarTag('DET00')).toBe('DET00');
  });

  it('no confunde tags distintos', () => {
    expect(normalizarTag('V5')).not.toBe(normalizarTag('V6'));
  });
});

describe('deducción · planilla ↔ plano: el tag se compara normalizado', () => {
  it("la planilla que dice 'v5' completa la planta que dice 'V5'", () => {
    const enPlanta = abertura({
      id: 'planta-v5',
      nombre: 'V5',
      confianza: 0.9,
      atributos: { tag: 'V5', tipologia: 'ventana' },
    });
    const enPlanilla = abertura({
      id: 'planilla-v5',
      laminaId: 'L-planilla',
      nombre: 'v5',
      bbox: [0.4, 0.3, 0.2, 0.04],
      confianza: 0.9,
      atributos: { tag: 'v5', tipologia: 'ventana', anchoM: 1.2, altoM: 1 },
    });

    const { propuestas } = deducir([enPlanta, enPlanilla], LAMINAS);
    const paraLaPlanta = propuestas.filter((p) => p.entidadId === 'planta-v5');

    expect(paraLaPlanta.map((p) => [p.campo, p.valor])).toEqual([
      ['anchoM', 1.2],
      ['altoM', 1],
    ]);
    expect(paraLaPlanta[0]!.regla).toBe('planilla_plano');
  });
});
