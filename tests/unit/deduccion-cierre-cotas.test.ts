/**
 * Regla `cierre_cotas` (§11 PRD): cota total − Σ parciales = la parcial que
 * falta. Y si están todas y no suman, no hay deducción: hay inconsistencia.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { deducir, type LaminaResumen } from '@/lib/deduccion/motor';

const LAMINAS: LaminaResumen[] = [{ id: 'L-planta', tipo: 'planta', codigo: 'A-01' }];

let siguiente = 0;

function cota(
  tramo: string,
  valorM: number | null,
  over: Partial<EntidadPersistida> = {},
): EntidadPersistida {
  siguiente += 1;
  return {
    id: `cota-${tramo}`,
    laminaId: 'L-planta',
    tipo: 'cota',
    nombre: `Cota ${tramo}`,
    bbox: [0.1 * siguiente, 0.9, 0.08, 0.02],
    confianza: 0.9,
    estadoReforma: 'na',
    atributos: { sobre: 'muro M1', tramo, ...(valorM === null ? {} : { valorM }) },
    ...over,
  };
}

describe('deducción · cierre de cotas', () => {
  it('despeja el tramo faltante: 5,00 − (2,00 + 1,50) = 1,50', () => {
    const total = cota('total', 5);
    const t1 = cota('T1', 2);
    const t2 = cota('T2', 1.5);
    const t3 = cota('T3', null);

    const { propuestas, inconsistencias } = deducir([total, t1, t2, t3], LAMINAS);

    expect(inconsistencias).toEqual([]);
    expect(propuestas).toHaveLength(1);

    const [tramo] = propuestas;
    expect(tramo!.entidadId).toBe('cota-T3');
    expect(tramo!.campo).toBe('valorM');
    expect(tramo!.valor).toBe(1.5);
    expect(tramo!.regla).toBe('cierre_cotas');
    // 0,9 (factor) × 0,9 (la peor de las cotas que intervienen)
    expect(tramo!.confianza).toBe(0.81);
    expect(tramo!.fuentes.map((f) => f.detalle)).toEqual([
      'Cota T3',
      'Cota total',
      'Cota T1',
      'Cota T2',
    ]);
    expect(tramo!.explicacion).toBe(
      'El tramo T3 sobre muro M1 mide 1,50 m por cierre de cotas: la cota total 5,00 m ' +
        'menos los parciales 2,00 m y 1,50 m (lámina A-01).',
    );
  });

  it('parciales que no cierran contra la total: inconsistencia, no deducción', () => {
    const total = cota('total', 5);
    const t1 = cota('T1', 2);
    const t2 = cota('T2', 1.6);
    const t3 = cota('T3', 1.5);

    const { propuestas, inconsistencias } = deducir([total, t1, t2, t3], LAMINAS);

    expect(propuestas).toEqual([]);
    expect(inconsistencias).toHaveLength(1);

    const [hallazgo] = inconsistencias;
    expect(hallazgo!.clave).toBe('deduccion.cotas.muro M1');
    expect(hallazgo!.tipo).toBe('inconsistencia');
    expect(hallazgo!.rubro).toBeNull();
    expect(hallazgo!.bloqueante).toBe(false);
    expect(hallazgo!.checklistItem).toBe('deduccion.cierre_cotas');
    expect(hallazgo!.descripcion).toBe(
      'Las cotas parciales sobre muro M1 suman 5,10 m contra una total de 5,00 m: 2% de diferencia, ' +
        'más del 1% que tolera el cierre de cotas. Revisá cuál cota vale.',
    );
    expect(hallazgo!.fuentes).toHaveLength(4);
  });

  it('un desvío dentro del 1% cierra y no dice nada', () => {
    const { propuestas, inconsistencias } = deducir(
      [cota('total', 5), cota('T1', 2), cota('T2', 3.04)], // 5,04 = 0,8%
      LAMINAS,
    );

    expect(propuestas).toEqual([]);
    expect(inconsistencias).toEqual([]);
  });

  it('el 1% justo todavía cierra', () => {
    const { inconsistencias } = deducir([cota('total', 5), cota('T1', 2), cota('T2', 3.05)], LAMINAS);

    expect(inconsistencias).toEqual([]);
  });

  it('dos tramos sin valor: no se puede despejar, no se propone nada', () => {
    const { propuestas, inconsistencias } = deducir(
      [cota('total', 5), cota('T1', 2), cota('T2', null), cota('T3', null)],
      LAMINAS,
    );

    expect(propuestas).toEqual([]);
    expect(inconsistencias).toEqual([]);
  });

  it('sin cota total no hay cierre posible', () => {
    const { propuestas } = deducir([cota('T1', 2), cota('T2', 1.5), cota('T3', null)], LAMINAS);

    expect(propuestas).toEqual([]);
  });

  it('los parciales ya se pasan de la total: inconsistencia, no un tramo negativo', () => {
    const { propuestas, inconsistencias } = deducir(
      [cota('total', 5), cota('T1', 3), cota('T2', 2), cota('T3', null)],
      LAMINAS,
    );

    expect(propuestas).toEqual([]);
    expect(inconsistencias.map((h) => h.clave)).toEqual(['deduccion.cotas.muro M1']);
    expect(inconsistencias[0]!.descripcion).toBe(
      'Los parciales sobre muro M1 ya suman 5,00 m contra una total de 5,00 m, y todavía falta el tramo T3. ' +
        'Revisá las cotas antes de computar.',
    );
  });

  it('cotas sobre elementos distintos no se mezclan', () => {
    // M1 cierra sola (2,00 + 3,00 = 5,00); el tramo que falta es de M2, que no
    // tiene total, así que nadie lo despeja con las cotas de M1.
    const otroMuro = cota('T9', null, {
      id: 'cota-otro',
      atributos: { sobre: 'muro M2', tramo: 'T9' },
    });

    const { propuestas, inconsistencias } = deducir(
      [cota('total', 5), cota('T1', 2), cota('T2', 3), otroMuro],
      LAMINAS,
    );

    expect(propuestas).toEqual([]);
    expect(inconsistencias).toEqual([]);
  });

  it('RF-506: sobre una cota solo se deduce su valor, nunca otro campo', () => {
    const conCarga = cota('T3', null, { atributos: { sobre: 'muro M1', tramo: 'T3', cargaKg: 850 } });

    const { propuestas } = deducir([cota('total', 5), cota('T1', 2), cota('T2', 1.5), conCarga], LAMINAS);

    expect(propuestas.map((p) => p.campo)).toEqual(['valorM']);
  });
});
