/**
 * Regla `continuidad` (§11 PRD): el mismo elemento dibujado en dos láminas es
 * uno solo, así que lo que una lámina dice completa lo que la otra calla —salvo
 * que se contradigan, y entonces no hay deducción sino inconsistencia.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { deducir, type LaminaResumen } from '@/lib/deduccion/motor';

const LAMINAS: LaminaResumen[] = [
  { id: 'L-pb', tipo: 'planta', codigo: 'A-01' },
  { id: 'L-pa', tipo: 'planta', codigo: 'A-02' },
  { id: 'L-detalle', tipo: 'detalle', codigo: null },
];

function tabique(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L-pb',
    tipo: 'tabique',
    nombre: 'T1',
    bbox: [0.2, 0.2, 0.3, 0.05],
    confianza: 0.9,
    estadoReforma: 'na',
    atributos: { largoM: 4.2, tipo: 'durlock' },
    ...over,
  };
}

const t1SinAltura = tabique({ id: 't1-pb' });

const t1ConAltura = tabique({
  id: 't1-pa',
  laminaId: 'L-pa',
  bbox: [0.2, 0.6, 0.3, 0.05],
  atributos: { largoM: 4.2, alturaM: 2.6, tipo: 'durlock' },
});

describe('deducción · continuidad entre láminas', () => {
  it('T1 hereda de su par la altura que su lámina no dibuja', () => {
    const { propuestas, inconsistencias } = deducir([t1SinAltura, t1ConAltura], LAMINAS);

    expect(inconsistencias).toEqual([]);
    expect(propuestas).toHaveLength(1);

    const [altura] = propuestas;
    expect(altura!.entidadId).toBe('t1-pb');
    expect(altura!.campo).toBe('alturaM');
    expect(altura!.valor).toBe(2.6);
    expect(altura!.regla).toBe('continuidad');
    // 0,85 (factor) × 0,9 (la peor de las dos entidades) = 0,765
    expect(altura!.confianza).toBe(0.77);
    expect(altura!.fuentes).toEqual([
      { laminaId: 'L-pb', bbox: [0.2, 0.2, 0.3, 0.05], detalle: 'T1' },
      { laminaId: 'L-pa', bbox: [0.2, 0.6, 0.3, 0.05], detalle: 'T1' },
    ]);
    expect(altura!.explicacion).toBe(
      'T1 no tiene altura en la lámina A-01, pero aparece en la lámina A-02 con 2,60 m: ' +
        'por continuidad es el mismo elemento.',
    );
  });

  it('dos láminas que se contradicen: inconsistencia no bloqueante y ninguna propuesta', () => {
    const t1Otra = tabique({
      id: 't1-pa',
      laminaId: 'L-pa',
      bbox: [0.2, 0.6, 0.3, 0.05],
      atributos: { largoM: 4.2, alturaM: 2.4, tipo: 'durlock' },
    });
    const t1Corte = tabique({
      id: 't1-det',
      laminaId: 'L-detalle',
      bbox: [0.1, 0.1, 0.2, 0.4],
      atributos: { largoM: 4.2, alturaM: 2.6, tipo: 'durlock' },
    });

    const { propuestas, inconsistencias } = deducir([t1Otra, t1Corte], LAMINAS);

    expect(propuestas).toEqual([]);
    expect(inconsistencias).toHaveLength(1);

    const [hallazgo] = inconsistencias;
    expect(hallazgo!.clave).toBe('deduccion.continuidad.T1.alturaM');
    expect(hallazgo!.tipo).toBe('inconsistencia');
    expect(hallazgo!.rubro).toBeNull();
    expect(hallazgo!.bloqueante).toBe(false);
    expect(hallazgo!.checklistItem).toBe('deduccion.continuidad');
    expect(hallazgo!.descripcion).toBe(
      'T1 aparece con distinta altura según la lámina: 2,40 m (lámina A-02) y 2,60 m (lámina sin código). ' +
        'No la deduzco: decidí cuál vale.',
    );
    expect(hallazgo!.fuentes).toEqual([
      { laminaId: 'L-pa', bbox: [0.2, 0.6, 0.3, 0.05], detalle: 'T1' },
      { laminaId: 'L-detalle', bbox: [0.1, 0.1, 0.2, 0.4], detalle: 'T1' },
    ]);
  });

  it('el que ya tiene el dato no recibe propuesta; el que no lo tiene, sí', () => {
    const t1Tercera = tabique({
      id: 't1-det',
      laminaId: 'L-detalle',
      bbox: [0.1, 0.1, 0.2, 0.4],
      atributos: { largoM: 4.2, tipo: 'durlock' },
    });

    const { propuestas } = deducir([t1SinAltura, t1ConAltura, t1Tercera], LAMINAS);

    expect(propuestas.map((p) => [p.entidadId, p.valor])).toEqual([
      ['t1-pb', 2.6],
      ['t1-det', 2.6],
    ]);
  });

  it('hereda cualquiera de los campos deducibles, no solo la altura', () => {
    const ambientePb = tabique({
      id: 'amb-pb',
      tipo: 'ambiente',
      nombre: 'Estar',
      atributos: { superficieM2: 18.4 },
    });
    const ambientePa = tabique({
      id: 'amb-pa',
      tipo: 'ambiente',
      nombre: 'Estar',
      laminaId: 'L-pa',
      bbox: [0.2, 0.6, 0.3, 0.05],
      atributos: { superficieM2: 18.4, perimetroM: 17.2, alturaM: 2.6 },
    });

    const { propuestas } = deducir([ambientePb, ambientePa], LAMINAS);

    expect(propuestas.map((p) => [p.campo, p.valor])).toEqual([
      ['alturaM', 2.6],
      ['perimetroM', 17.2],
    ]);
  });

  it('una sola lámina no es continuidad', () => {
    const gemelo = tabique({ id: 't1-bis', bbox: [0.5, 0.2, 0.3, 0.05], atributos: { alturaM: 2.6 } });

    expect(deducir([t1SinAltura, gemelo], LAMINAS).propuestas).toEqual([]);
  });

  it('no cruza tipos distintos con el mismo nombre', () => {
    const muroT1 = tabique({
      id: 'muro-t1',
      tipo: 'muro',
      laminaId: 'L-pa',
      bbox: [0.2, 0.6, 0.3, 0.05],
      atributos: { largoM: 4.2, alturaM: 2.6 },
    });

    expect(deducir([t1SinAltura, muroT1], LAMINAS).propuestas).toEqual([]);
  });

  it('confianza por debajo del umbral: 0,85 × 0,8 = 0,68, no sale', () => {
    const flojo = tabique({ id: 't1-pb', confianza: 0.8 });

    expect(deducir([flojo, t1ConAltura], LAMINAS)).toEqual({ propuestas: [], inconsistencias: [] });
  });

  it('RF-506: un campo que no es medida de arquitectura jamás se propone', () => {
    const conCarga = tabique({
      id: 't1-pa',
      laminaId: 'L-pa',
      bbox: [0.2, 0.6, 0.3, 0.05],
      atributos: { largoM: 4.2, cargaKg: 850, tipo: 'durlock' },
    });

    expect(deducir([t1SinAltura, conCarga], LAMINAS).propuestas).toEqual([]);
  });
});
