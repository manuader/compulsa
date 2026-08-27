/**
 * Contratos de "proponer en vez de bloquear" del lado puro: a qué campos apunta
 * un hallazgo (`camposDelTarget`) y qué se le puede proponer al arquitecto en
 * vez de preguntárselo (`propuestaDeLectura`).
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { camposDelTarget } from '@/lib/hallazgos/target';
import {
  hallazgoBajaConfianza,
  hallazgoDatoFaltante,
  propuestaDeLectura,
} from '@/lib/hallazgos/taxonomia';

function tabique(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'tabique',
    nombre: 'T5',
    bbox: [0.3, 0.22, 0.02, 0.44],
    confianza: 0.62,
    estadoReforma: 'na',
    atributos: { tipo: 'durlock', largoM: 4, alturaM: 2.6, caras: 2 },
    ...over,
  };
}

describe('camposDelTarget: el único lector válido de target_ref', () => {
  it('lee el plural, que es lo que se escribe desde T0', () => {
    expect(camposDelTarget({ entidadId: 'e1', campos: ['anchoM', 'altoM'] })).toEqual([
      'anchoM',
      'altoM',
    ]);
  });

  it('lee el singular de las filas viejas como una lista de uno', () => {
    expect(camposDelTarget({ entidadId: 'e1', campo: 'altoM' })).toEqual(['altoM']);
  });

  it('el plural manda sobre el singular si una fila trae los dos', () => {
    expect(camposDelTarget({ entidadId: 'e1', campo: 'anchoM', campos: ['altoM'] })).toEqual([
      'altoM',
    ]);
  });

  it('sin target, o sin ninguno de los dos, no hay campos', () => {
    expect(camposDelTarget(null)).toEqual([]);
    expect(camposDelTarget(undefined)).toEqual([]);
    expect(camposDelTarget({ entidadId: 'e1' })).toEqual([]);
    expect(camposDelTarget({ entidadId: 'e1', campos: [] })).toEqual([]);
  });

  it('no comparte el array con el target: mutar la copia no toca la fila', () => {
    const target = { entidadId: 'e1', campos: ['anchoM'] };
    camposDelTarget(target).push('altoM');
    expect(target.campos).toEqual(['anchoM']);
  });
});

describe('hallazgoDatoFaltante: apunta a todos los campos que faltan', () => {
  it('escribe el target en plural', () => {
    const hallazgo = hallazgoDatoFaltante({
      rubro: 'aberturas',
      clave: 'aberturas.medidas_vano.FP01',
      descripcion: 'No encontré el ancho ni el alto de FP01.',
      entidad: tabique({ id: 'e1' }),
      campos: ['anchoM', 'altoM'],
    });

    expect(hallazgo.targetRef).toEqual({ entidadId: 'e1', campos: ['anchoM', 'altoM'] });
    expect(hallazgo.valorPropuesto).toBeUndefined();
  });
});

describe('propuestaDeLectura: lo ya leído se ofrece, no se tira', () => {
  it('propone todas las medidas positivas de la entidad, con su fuente', () => {
    const propuesta = propuestaDeLectura(tabique({ id: 't5' }));

    expect(propuesta).toEqual({
      entidadId: 't5',
      // `tipo: 'durlock'` no es una medida: no entra.
      campos: ['largoM', 'alturaM', 'caras'],
      valorPropuesto: {
        valores: { largoM: 4, alturaM: 2.6, caras: 2 },
        fuente: { laminaId: 'L1', bbox: [0.3, 0.22, 0.02, 0.44] },
        confianza: 0.62,
        origen: 'lectura_baja_confianza',
      },
    });
  });

  it('lee números escritos como texto, y descarta los que no son medidas', () => {
    const propuesta = propuestaDeLectura(
      tabique({ id: 't6', atributos: { largoM: '4,5', alturaM: 0, tipo: 'durlock' } }),
    );

    // El 0 no es una medida (`leerMedida` exige positivo) y `tipo` es texto.
    expect(propuesta?.campos).toEqual(['largoM']);
    expect(propuesta?.valorPropuesto.valores).toEqual({ largoM: 4.5 });
  });

  it('sin ninguna medida leída no hay nada que proponer', () => {
    expect(propuestaDeLectura(tabique({ id: 't7', atributos: { tipo: 'durlock' } }))).toBeNull();
    expect(propuestaDeLectura(tabique({ id: 't8', atributos: {} }))).toBeNull();
  });
});

describe('hallazgoBajaConfianza: la consulta lleva la propuesta', () => {
  it('vuelca la propuesta en targetRef y en valorPropuesto', () => {
    const entidad = tabique({ id: 't5' });
    const propuesta = propuestaDeLectura(entidad)!;

    const hallazgo = hallazgoBajaConfianza({
      rubro: 'seco',
      claveItem: 'seco.placas',
      descripcion: 'Placas de durlock',
      confianza: 0.62,
      fuentes: [{ laminaId: 'L1', bbox: [0.3, 0.22, 0.02, 0.44] }],
      propuesta,
    });

    expect(hallazgo.clave).toBe('seco.baja_confianza.placas');
    expect(hallazgo.bloqueante).toBe(true);
    expect(hallazgo.targetRef).toEqual({
      entidadId: 't5',
      campos: ['largoM', 'alturaM', 'caras'],
    });
    expect(hallazgo.valorPropuesto).toEqual(propuesta.valorPropuesto);
  });

  it('sin propuesta la consulta es una pregunta, sin target', () => {
    const hallazgo = hallazgoBajaConfianza({
      rubro: 'seco',
      claveItem: 'seco.placas',
      descripcion: 'Placas de durlock',
      confianza: 0.62,
      fuentes: [],
    });

    expect(hallazgo.targetRef).toBeUndefined();
    expect(hallazgo.valorPropuesto).toBeUndefined();
  });
});
