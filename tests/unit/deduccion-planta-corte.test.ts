/**
 * Regla `planta_corte` (§11 PRD): la altura que la planta no acota se lee del
 * corte que pasa por ese ambiente / tabique / muro.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { deducir, type LaminaResumen } from '@/lib/deduccion/motor';

const LAMINAS: LaminaResumen[] = [
  { id: 'L-planta', tipo: 'planta', codigo: 'A-01' },
  { id: 'L-corte', tipo: 'corte', codigo: 'A-03' },
  { id: 'L-corte-2', tipo: 'corte', codigo: 'A-04' },
];

function entidad(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L-planta',
    tipo: 'ambiente',
    nombre: 'Estar',
    bbox: [0.2, 0.2, 0.3, 0.25],
    confianza: 0.9,
    estadoReforma: 'na',
    atributos: { superficieM2: 18.4, perimetroM: 17.2 },
    ...over,
  };
}

const estarEnPlanta = entidad({ id: 'estar-planta' });

const estarEnCorte = entidad({
  id: 'estar-corte',
  laminaId: 'L-corte',
  bbox: [0.3, 0.4, 0.25, 0.2],
  confianza: 0.95,
  atributos: { alturaM: 2.6 },
});

describe('deducción · planta ↔ corte', () => {
  it('la altura del Estar sale del corte', () => {
    const { propuestas, inconsistencias } = deducir([estarEnPlanta, estarEnCorte], LAMINAS);

    expect(inconsistencias).toEqual([]);
    expect(propuestas).toHaveLength(1);

    const [altura] = propuestas;
    expect(altura!.entidadId).toBe('estar-planta');
    expect(altura!.campo).toBe('alturaM');
    expect(altura!.valor).toBe(2.6);
    expect(altura!.regla).toBe('planta_corte');
    // 0,9 (factor) × 0,9 (la peor de las dos entidades)
    expect(altura!.confianza).toBe(0.81);
    expect(altura!.fuentes).toEqual([
      { laminaId: 'L-planta', bbox: [0.2, 0.2, 0.3, 0.25], detalle: 'Estar' },
      { laminaId: 'L-corte', bbox: [0.3, 0.4, 0.25, 0.2], detalle: 'Estar' },
    ]);
    expect(altura!.explicacion).toBe(
      'La altura 2,60 m de Estar sale del corte (lámina A-03); en la planta (lámina A-01) no está acotada.',
    );
  });

  it('vale igual para tabiques y muros', () => {
    const tabiquePlanta = entidad({
      id: 't1-planta',
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { largoM: 4.2, tipo: 'durlock' },
    });
    const tabiqueCorte = entidad({
      id: 't1-corte',
      tipo: 'tabique',
      nombre: 'T1',
      laminaId: 'L-corte',
      bbox: [0.5, 0.4, 0.1, 0.2],
      confianza: 0.95,
      atributos: { alturaM: 2.4 },
    });

    const { propuestas } = deducir([tabiquePlanta, tabiqueCorte], LAMINAS);

    expect(propuestas).toHaveLength(1);
    expect(propuestas[0]!.entidadId).toBe('t1-planta');
    expect(propuestas[0]!.valor).toBe(2.4);
    expect(propuestas[0]!.regla).toBe('planta_corte');
  });

  it('no cruza tipos de entidad distintos aunque el nombre coincida', () => {
    const muroCorte = entidad({
      id: 'muro-corte',
      tipo: 'muro',
      laminaId: 'L-corte',
      bbox: [0.5, 0.4, 0.1, 0.2],
      confianza: 0.95,
      atributos: { alturaM: 2.6 },
    });

    // El ambiente "Estar" no hereda la altura de un muro que se llama igual.
    expect(deducir([estarEnPlanta, muroCorte], LAMINAS).propuestas).toEqual([]);
  });

  it('solo lee del corte: otra planta no sirve para esta regla', () => {
    const otroCorteQueNoLoEs = entidad({
      id: 'estar-vista',
      laminaId: 'L-planta',
      bbox: [0.6, 0.2, 0.2, 0.2],
      atributos: { alturaM: 2.6 },
    });

    const { propuestas } = deducir([estarEnPlanta, otroCorteQueNoLoEs], LAMINAS);

    expect(propuestas.filter((p) => p.regla === 'planta_corte')).toEqual([]);
  });

  it('dos cortes que no coinciden: es inconsistencia de continuidad, no una altura inventada', () => {
    const otroCorte = entidad({
      id: 'estar-corte-2',
      laminaId: 'L-corte-2',
      bbox: [0.3, 0.4, 0.25, 0.2],
      confianza: 0.95,
      atributos: { alturaM: 2.4 },
    });

    const { propuestas } = deducir([estarEnPlanta, estarEnCorte, otroCorte], LAMINAS);

    expect(propuestas).toEqual([]);
  });

  it('el corte que ya trae la altura no recibe propuesta', () => {
    expect(deducir([estarEnCorte], LAMINAS).propuestas).toEqual([]);
  });
});
