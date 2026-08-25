import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { sanityChecks } from '@/lib/computo/sanity';

function terminacion(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'terminacion',
    nombre: 'Piso Living',
    bbox: [0.2, 0.2, 0.3, 0.25],
    confianza: 0.9,
    estadoReforma: 'na',
    atributos: { superficieM2: 12, ubicacion: 'piso', ambiente: 'Living', material: 'porcelanato' },
    ...over,
  };
}

const pisoLiving = terminacion({ id: 'p1' });

function cieloLiving(superficieM2: number): EntidadPersistida {
  return terminacion({
    id: 'c1',
    nombre: 'Cielorraso Living',
    laminaId: 'L2',
    bbox: [0.2, 0.6, 0.3, 0.25],
    atributos: { superficieM2, ubicacion: 'cielorraso', ambiente: 'Living' },
  });
}

describe('sanity: m² de piso vs. m² de cielorraso por ambiente', () => {
  it('una diferencia dentro del 10% no dice nada', () => {
    expect(sanityChecks([pisoLiving, cieloLiving(12.5)])).toEqual([]); // 4,17%
  });

  it('el 10% justo todavía no es inconsistencia', () => {
    const piso = terminacion({ id: 'p9', atributos: { superficieM2: 10, ubicacion: 'piso', ambiente: 'Living' } });
    expect(sanityChecks([piso, cieloLiving(11)])).toEqual([]);
  });

  it('más del 10% de diferencia es una inconsistencia no bloqueante que cita las dos fuentes', () => {
    const hallazgos = sanityChecks([pisoLiving, cieloLiving(15)]); // 25%

    expect(hallazgos).toHaveLength(1);
    const [hallazgo] = hallazgos;
    expect(hallazgo!.clave).toBe('sanity.piso_cielo.Living');
    expect(hallazgo!.tipo).toBe('inconsistencia');
    expect(hallazgo!.rubro).toBeNull();
    expect(hallazgo!.bloqueante).toBe(false);
    expect(hallazgo!.descripcion).toContain('25%');
    expect(hallazgo!.fuentes).toEqual([
      { laminaId: 'L1', bbox: [0.2, 0.2, 0.3, 0.25], detalle: 'Piso Living' },
      { laminaId: 'L2', bbox: [0.2, 0.6, 0.3, 0.25], detalle: 'Cielorraso Living' },
    ]);
  });

  it('no compara ambientes que no tienen las dos terminaciones', () => {
    expect(sanityChecks([pisoLiving])).toEqual([]);
    expect(sanityChecks([cieloLiving(30)])).toEqual([]);
  });

  it('suma las terminaciones del mismo ambiente antes de comparar', () => {
    const mediaPieza = terminacion({
      id: 'p2',
      nombre: 'Piso Living (2)',
      bbox: [0.5, 0.2, 0.1, 0.25],
      atributos: { superficieM2: 3, ubicacion: 'piso', ambiente: 'Living' },
    });
    // 12 + 3 = 15 m² de piso contra 15 de cielorraso: cierran.
    expect(sanityChecks([pisoLiving, mediaPieza, cieloLiving(15)])).toEqual([]);
  });

  it('revisa cada ambiente por separado', () => {
    const pisoCocina = terminacion({
      id: 'p3',
      nombre: 'Piso Cocina',
      atributos: { superficieM2: 8, ubicacion: 'piso', ambiente: 'Cocina' },
    });
    const cieloCocina = terminacion({
      id: 'c3',
      nombre: 'Cielorraso Cocina',
      atributos: { superficieM2: 4, ubicacion: 'cielorraso', ambiente: 'Cocina' },
    });

    const hallazgos = sanityChecks([pisoLiving, cieloLiving(12.5), pisoCocina, cieloCocina]);
    expect(hallazgos.map((h) => h.clave)).toEqual(['sanity.piso_cielo.Cocina']);
  });

  it('ignora terminaciones sin ambiente o sin superficie', () => {
    const huerfana = terminacion({
      id: 'p4',
      atributos: { superficieM2: 40, ubicacion: 'piso' },
    });
    const sinSuperficie = terminacion({
      id: 'c4',
      atributos: { ubicacion: 'cielorraso', ambiente: 'Living' },
    });
    expect(sanityChecks([huerfana, sinSuperficie, pisoLiving])).toEqual([]);
  });
});
