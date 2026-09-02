/**
 * El contrato del cruce: qué entra, qué se descarta y cómo se cuenta.
 *
 * `cruce-claude.ts` no tiene tests (los tests no salen a la red), así que todo
 * lo que se puede pinnear de esta familia vive acá: el cable laxo, la
 * resolución de códigos de lámina a ids, el match de entidades por tag
 * normalizado, el filtro de `CAMPOS_DEDUCIBLES` (RF-506) y el mock, que
 * devuelve el fixture **crudo** —el saneo es uno solo y corre río abajo, igual
 * para el mock que para el modelo—.
 */
import { describe, expect, it } from 'vitest';

import { crearProviderCruceMock } from '@/lib/analysis/cruce-mock';
import {
  getCruceProvider,
  sanearCruce,
  zRespuestaCruceCruda,
  type ContextoCruce,
  type CruceCrudo,
} from '@/lib/analysis/cruce-tipos';
import type { ObraContexto } from '@/types/domain';

// ---------------------------------------------------------------------------
// El expediente de prueba
// ---------------------------------------------------------------------------

const CTX: ContextoCruce = {
  laminasPorCodigo: new Map([
    ['PL01', 'lam-planta'],
    ['DET00', 'lam-planilla'],
    ['CO01', 'lam-corte'],
  ]),
  entidades: [
    { id: 'e-fp01', laminaId: 'lam-planta', nombre: 'FP01', tipo: 'abertura' },
    // La misma carpintería, escrita distinto y en otra lámina.
    { id: 'e-fp01-planilla', laminaId: 'lam-planilla', nombre: 'fp 01', tipo: 'abertura' },
    { id: 'e-tabique', laminaId: 'lam-planta', nombre: 'Tabique 1', tipo: 'tabique' },
    // Dos tabiques distintos de la MISMA lámina: son dos cosas dibujadas dos
    // veces, no una cosa vista dos veces (§15).
    { id: 'e-tabique-2', laminaId: 'lam-planta', nombre: 'Tabique 2', tipo: 'tabique' },
    // Mismo tag que la carpintería de la planta, otra lámina, otro tipo.
    { id: 'e-tabique-corte', laminaId: 'lam-corte', nombre: 'FP01', tipo: 'tabique' },
    { id: 'e-cocina', laminaId: 'lam-planta', nombre: 'Cocina', tipo: 'ambiente' },
    // Dos entidades con el MISMO nombre normalizado en la MISMA lámina: el
    // match es ambiguo y no hay forma honesta de elegir una.
    { id: 'e-v5-a', laminaId: 'lam-corte', nombre: 'V5', tipo: 'abertura' },
    { id: 'e-v5-b', laminaId: 'lam-corte', nombre: 'v 5', tipo: 'abertura' },
  ],
};

const VACIO: CruceCrudo = {
  datosObra: [],
  completados: [],
  identidades: [],
  conflictos: [],
  relecturas: [],
};

function crudo(parcial: Partial<CruceCrudo>): CruceCrudo {
  return { ...VACIO, ...parcial };
}

function unCompletado(parcial: Partial<CruceCrudo['completados'][number]> = {}) {
  return {
    laminaCodigo: 'PL01',
    entidadNombre: 'FP01',
    campo: 'anchoM',
    valor: '0,90',
    fuenteLaminaCodigo: 'DET00',
    bbox: [0.1, 0.3, 0.3, 0.04],
    confianza: 0.9,
    ...parcial,
  };
}

function unDatoObra(parcial: Partial<CruceCrudo['datosObra'][number]> = {}) {
  return {
    clave: 'altura_local.PB',
    valor: '2,60',
    unidad: 'm',
    laminaCodigo: 'CO01',
    bbox: [0.2, 0.4, 0.1, 0.05],
    confianza: 0.85,
    ...parcial,
  };
}

// ---------------------------------------------------------------------------
// Completados: el filtro que manda es RF-506
// ---------------------------------------------------------------------------

describe('sanearCruce — completados', () => {
  it('resuelve la entidad por (lámina, tag normalizado) y la fuente por código', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado()] }),
      CTX,
    );

    expect(completados).toHaveLength(1);
    expect(completados[0].entidadId).toBe('e-fp01');
    expect(completados[0].campo).toBe('anchoM');
    expect(completados[0].fuentes).toEqual([{ laminaId: 'lam-planilla', bbox: [0.1, 0.3, 0.3, 0.04] }]);
    expect(descartados.completados).toBe(0);
  });

  it('matchea el nombre con espacios y minúsculas contra el tag de la lámina', () => {
    const { completados } = sanearCruce(
      crudo({ completados: [unCompletado({ laminaCodigo: 'DET00', entidadNombre: 'FP01' })] }),
      CTX,
    );

    expect(completados).toHaveLength(1);
    // La entidad de DET00 se llama 'fp 01': `normalizarTag` las iguala.
    expect(completados[0].entidadId).toBe('e-fp01-planilla');
  });

  it('"2,60" en un campo de medida entra como 2.6', () => {
    const { completados } = sanearCruce(
      crudo({ completados: [unCompletado({ campo: 'altoM', valor: '2,60' })] }),
      CTX,
    );

    expect(completados[0].valor).toBe(2.6);
  });

  it('descarta —y cuenta— un campo fuera de CAMPOS_DEDUCIBLES (RF-506)', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado({ campo: 'material', valor: 'aluminio' })] }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(1);
  });

  it('descarta un `valorM` sobre una entidad que no es cota', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado({ campo: 'valorM', valor: '1,20' })] }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(1);
  });

  it('descarta un `laminaCodigo` desconocido', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado({ laminaCodigo: 'PL99' })] }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(1);
  });

  it('descarta una `fuenteLaminaCodigo` desconocida: sin fuente no hay dato (P1)', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado({ fuenteLaminaCodigo: 'XX00' })] }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(1);
  });

  it('descarta una entidad que no existe en esa lámina', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado({ entidadNombre: 'FP99' })] }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(1);
  });

  it('descarta un match ambiguo: dos entidades con el mismo tag en la misma lámina', () => {
    const { completados, descartados } = sanearCruce(
      crudo({
        completados: [unCompletado({ laminaCodigo: 'CO01', entidadNombre: 'V5' })],
      }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(1);
  });

  it('descarta un valor no numérico o no positivo en un campo de medida', () => {
    const { completados, descartados } = sanearCruce(
      crudo({
        completados: [
          unCompletado({ valor: 'no figura' }),
          unCompletado({ campo: 'altoM', valor: '0' }),
          unCompletado({ campo: 'largoM', valor: '2,05 m' }),
        ],
      }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(3);
  });

  it('sin bbox, la fuente es la lámina completa', () => {
    const { completados } = sanearCruce(
      crudo({ completados: [unCompletado({ bbox: null })] }),
      CTX,
    );

    expect(completados[0].fuentes).toEqual([
      { laminaId: 'lam-planilla', bbox: [0, 0, 1, 1], detalle: 'Lámina completa' },
    ]);
  });

  it('un bbox que no son cuatro números es una lámina completa, no un descarte', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado({ bbox: [0.1, 0.2, 0.3] })] }),
      CTX,
    );

    expect(completados[0].fuentes[0].bbox).toEqual([0, 0, 1, 1]);
    expect(descartados.completados).toBe(0);
  });

  it('clampa el bbox y la confianza a [0,1]', () => {
    const { completados } = sanearCruce(
      crudo({ completados: [unCompletado({ bbox: [-0.5, 0.2, 3, 0.04], confianza: 1.4 })] }),
      CTX,
    );

    expect(completados[0].fuentes[0].bbox).toEqual([0, 0.2, 1, 0.04]);
    expect(completados[0].confianza).toBe(1);
  });

  it('descarta una confianza que no es un número', () => {
    const { completados, descartados } = sanearCruce(
      crudo({ completados: [unCompletado({ confianza: Number.NaN })] }),
      CTX,
    );

    expect(completados).toEqual([]);
    expect(descartados.completados).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Datos de obra
// ---------------------------------------------------------------------------

describe('sanearCruce — datosObra', () => {
  it('lee la medida con coma y la deja con su unidad y su fuente', () => {
    const { datosObra, descartados } = sanearCruce(
      crudo({ datosObra: [unDatoObra()] }),
      CTX,
    );

    expect(datosObra).toHaveLength(1);
    expect(datosObra[0]).toEqual({
      clave: 'altura_local.PB',
      valor: 2.6,
      unidad: 'm',
      fuentes: [{ laminaId: 'lam-corte', bbox: [0.2, 0.4, 0.1, 0.05] }],
      confianza: 0.85,
    });
    expect(descartados.datosObra).toBe(0);
  });

  it('un valor que no es número queda como texto', () => {
    const { datosObra } = sanearCruce(
      crudo({
        datosObra: [
          unDatoObra({
            clave: 'altura_revestimiento.Baño',
            valor: ' hasta el cielorraso ',
            unidad: null,
          }),
        ],
      }),
      CTX,
    );

    expect(datosObra[0].valor).toBe('hasta el cielorraso');
    expect(datosObra[0].unidad).toBeUndefined();
  });

  /**
   * RF-506 del lado de `datosObra`, que hasta acá no tenía ninguno: el saneo
   * validaba que la clave no fuera vacía y nada más.
   *
   * No es teórico aunque hoy ninguna plantilla lea otra familia:
   * `memoria/render.ts` imprime TODAS las filas de `datos_obra` en el `.md` que
   * baja el arquitecto —como hechos establecidos, con su confianza y su lámina
   * citada— y `memoria/compacta.ts` se las devuelve al cruce de la corrida
   * siguiente. Una clave inventada se publica y después se refuerza sola.
   */
  it('descarta una clave que no es de una familia conocida', () => {
    const { datosObra, descartados } = sanearCruce(
      crudo({
        datosObra: [
          unDatoObra({ clave: 'resistencia_hormigon.PB', valor: '21' }),
          unDatoObra({ clave: 'solado.general', valor: 'porcelanato' }),
          // Sin sufijo no la encuentra ninguna plantilla: la cadena de respaldo
          // busca `altura_local.PB` y `altura_local.general`, nunca la pelada.
          unDatoObra({ clave: 'altura_local' }),
        ],
      }),
      CTX,
    );

    expect(datosObra).toEqual([]);
    expect(descartados.datosObra).toBe(3);
  });

  it('las tres familias que las plantillas leen sí entran', () => {
    const { datosObra, descartados } = sanearCruce(
      crudo({
        datosObra: [
          unDatoObra({ clave: 'altura_local.general' }),
          unDatoObra({ clave: 'altura_revestimiento.Cocina', valor: '2,10' }),
          unDatoObra({ clave: 'nivel.PB', valor: '0,00' }),
        ],
      }),
      CTX,
    );

    expect(datosObra.map((dato) => dato.clave)).toEqual([
      'altura_local.general',
      'altura_revestimiento.Cocina',
      'nivel.PB',
    ]);
    expect(descartados.datosObra).toBe(0);
  });

  it('un cero es un dato de obra válido (un nivel puede ser 0,00)', () => {
    const { datosObra } = sanearCruce(
      crudo({ datosObra: [unDatoObra({ clave: 'nivel.PB', valor: '0,00' })] }),
      CTX,
    );

    expect(datosObra[0].valor).toBe(0);
  });

  it('descarta un `laminaCodigo` desconocido y un valor vacío', () => {
    const { datosObra, descartados } = sanearCruce(
      crudo({
        datosObra: [unDatoObra({ laminaCodigo: 'ZZ99' }), unDatoObra({ valor: '   ' })],
      }),
      CTX,
    );

    expect(datosObra).toEqual([]);
    expect(descartados.datosObra).toBe(2);
  });

  it('una unidad que no es del dominio se cae; el número no', () => {
    const { datosObra, descartados } = sanearCruce(
      crudo({ datosObra: [unDatoObra({ unidad: 'mts' })] }),
      CTX,
    );

    expect(datosObra).toHaveLength(1);
    expect(datosObra[0].valor).toBe(2.6);
    expect(datosObra[0].unidad).toBeUndefined();
    expect(descartados.datosObra).toBe(0);
  });

  it('resuelve el código de lámina sin importar mayúsculas ni espacios', () => {
    const { datosObra } = sanearCruce(
      crudo({ datosObra: [unDatoObra({ laminaCodigo: ' co 01 ' })] }),
      CTX,
    );

    expect(datosObra[0].fuentes[0].laminaId).toBe('lam-corte');
  });
});

// ---------------------------------------------------------------------------
// Identidades, conflictos y relecturas
// ---------------------------------------------------------------------------

describe('sanearCruce — identidades', () => {
  it('resuelve un grupo a ids de entidad', () => {
    const { identidades, descartados } = sanearCruce(
      crudo({
        identidades: [
          [
            { laminaCodigo: 'PL01', entidadNombre: 'FP01' },
            { laminaCodigo: 'DET00', entidadNombre: 'fp01' },
          ],
        ],
      }),
      CTX,
    );

    expect(identidades).toEqual([['e-fp01', 'e-fp01-planilla']]);
    expect(descartados.identidades).toBe(0);
  });

  it('un grupo con una sola entidad resuelta se descarta entero', () => {
    const { identidades, descartados } = sanearCruce(
      crudo({
        identidades: [
          [
            { laminaCodigo: 'PL01', entidadNombre: 'FP01' },
            { laminaCodigo: 'PL99', entidadNombre: 'FP01' },
          ],
        ],
      }),
      CTX,
    );

    expect(identidades).toEqual([]);
    expect(descartados.identidades).toBe(1);
  });

  it('la misma entidad dos veces no es una identidad', () => {
    const { identidades, descartados } = sanearCruce(
      crudo({
        identidades: [
          [
            { laminaCodigo: 'PL01', entidadNombre: 'FP01' },
            { laminaCodigo: 'PL01', entidadNombre: 'fp 01' },
          ],
        ],
      }),
      CTX,
    );

    expect(identidades).toEqual([]);
    expect(descartados.identidades).toBe(1);
  });

  /**
   * El descarte que evita que el cruce le coma la mitad a un rubro en silencio.
   *
   * `unificarPorElemento()` funde el grupo en un elemento solo, así que dos
   * entidades DISTINTAS de la misma lámina metidas en un grupo dejan una sola
   * fila computando: en la corrida que lo encontró, `seco.placas` pasó de
   * 31,2 m² a 15,6 m² con `conflictos: []` y `hallazgos: []`. El §15 pregunta
   * si la FP01 de la planta es la misma que la de la planilla — un par de la
   * misma lámina es un error del modelo por construcción.
   */
  it('dos entidades distintas de la misma lámina no son una identidad', () => {
    const { identidades, descartados } = sanearCruce(
      crudo({
        identidades: [
          [
            { laminaCodigo: 'PL01', entidadNombre: 'Tabique 1' },
            { laminaCodigo: 'PL01', entidadNombre: 'Tabique 2' },
          ],
        ],
      }),
      CTX,
    );

    expect(identidades).toEqual([]);
    expect(descartados.identidades).toBe(1);
  });

  it('un tabique y una abertura no son el mismo elemento físico, aunque compartan el tag', () => {
    const { identidades, descartados } = sanearCruce(
      crudo({
        identidades: [
          [
            { laminaCodigo: 'PL01', entidadNombre: 'FP01' },
            { laminaCodigo: 'CO01', entidadNombre: 'FP01' },
          ],
        ],
      }),
      CTX,
    );

    expect(identidades).toEqual([]);
    expect(descartados.identidades).toBe(1);
  });

  /**
   * Un grupo malo no se lleva puesto al de al lado: se descarta el grupo, se
   * cuenta uno, y el resto del cruce entra igual.
   */
  it('el grupo bueno entra y el malo se cuenta aparte', () => {
    const { identidades, descartados } = sanearCruce(
      crudo({
        identidades: [
          [
            { laminaCodigo: 'PL01', entidadNombre: 'Tabique 1' },
            { laminaCodigo: 'PL01', entidadNombre: 'Tabique 2' },
          ],
          [
            { laminaCodigo: 'PL01', entidadNombre: 'FP01' },
            { laminaCodigo: 'DET00', entidadNombre: 'fp01' },
          ],
        ],
      }),
      CTX,
    );

    expect(identidades).toEqual([['e-fp01', 'e-fp01-planilla']]);
    expect(descartados.identidades).toBe(1);
  });
});

describe('sanearCruce — conflictos y relecturas', () => {
  it('resuelve las dos láminas del conflicto y limpia la causa vacía', () => {
    const { conflictos, descartados } = sanearCruce(
      crudo({
        conflictos: [
          {
            descripcion: 'La planta dice 0,90 y la planilla 1,00 para FP01',
            datoA: 'anchoM 0,90',
            laminaCodigoA: 'PL01',
            datoB: 'anchoM 1,00',
            laminaCodigoB: 'DET00',
            causaPosible: '  ',
          },
        ],
      }),
      CTX,
    );

    expect(conflictos).toEqual([
      {
        descripcion: 'La planta dice 0,90 y la planilla 1,00 para FP01',
        datoA: 'anchoM 0,90',
        laminaIdA: 'lam-planta',
        datoB: 'anchoM 1,00',
        laminaIdB: 'lam-planilla',
      },
    ]);
    expect(descartados.conflictos).toBe(0);
  });

  it('descarta un conflicto con una lámina irresoluble o sin descripción', () => {
    const { conflictos, descartados } = sanearCruce(
      crudo({
        conflictos: [
          {
            descripcion: 'algo',
            datoA: 'a',
            laminaCodigoA: 'PL01',
            datoB: 'b',
            laminaCodigoB: 'NO-EXISTE',
            causaPosible: null,
          },
          {
            descripcion: '   ',
            datoA: 'a',
            laminaCodigoA: 'PL01',
            datoB: 'b',
            laminaCodigoB: 'DET00',
            causaPosible: null,
          },
        ],
      }),
      CTX,
    );

    expect(conflictos).toEqual([]);
    expect(descartados.conflictos).toBe(2);
  });

  it('resuelve la relectura y descarta la que no apunta a ninguna lámina', () => {
    const { relecturas, descartados } = sanearCruce(
      crudo({
        relecturas: [
          { laminaCodigo: 'DET00', queBuscar: 'el alto de FP01 en la fila de la planilla' },
          { laminaCodigo: 'PL77', queBuscar: 'cualquier cosa' },
          { laminaCodigo: 'PL01', queBuscar: '  ' },
        ],
      }),
      CTX,
    );

    expect(relecturas).toEqual([
      { laminaId: 'lam-planilla', queBuscar: 'el alto de FP01 en la fila de la planilla' },
    ]);
    expect(descartados.relecturas).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// El cable
// ---------------------------------------------------------------------------

describe('zRespuestaCruceCruda', () => {
  it('acepta la respuesta con los opcionales en null y sin nada adentro', () => {
    const parseado = zRespuestaCruceCruda.safeParse({
      datosObra: [
        {
          clave: 'altura_local.PB',
          valor: '2,60',
          unidad: null,
          laminaCodigo: 'CO01',
          bbox: null,
          confianza: 0.8,
        },
      ],
      completados: [],
      identidades: [],
      conflictos: [],
      relecturas: [],
    });

    expect(parseado.success).toBe(true);
  });

  it('no acepta que falte una de las cinco listas: la gramática garantiza las claves', () => {
    const parseado = zRespuestaCruceCruda.safeParse({ datosObra: [] });
    expect(parseado.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// El mock
// ---------------------------------------------------------------------------

const OBRA: ObraContexto = {
  obraId: 'obra-1',
  tipoObra: 'reforma',
  nombreObra: 'Obra Cruce',
};

describe('crearProviderCruceMock', () => {
  it('sin fixture devuelve las cinco listas vacías, nunca una heurística', async () => {
    const provider = crearProviderCruceMock();
    const respuesta = await provider.cruzar('# Memoria\n\nlo que sea', {
      ...OBRA,
      nombreObra: 'Obra Sin Fixture',
    });

    expect(respuesta).toEqual({
      datosObra: [],
      completados: [],
      identidades: [],
      conflictos: [],
      relecturas: [],
    });
  });

  it('sin nombre de obra no hay clave de fixture, y eso también es vacío', async () => {
    const provider = crearProviderCruceMock();
    const respuesta = await provider.cruzar('# Memoria', { obraId: 'x', tipoObra: 'nueva' });

    expect(respuesta.datosObra).toEqual([]);
  });

  it('con fixture devuelve el crudo tal cual, para que lo sanee quien tiene el expediente', async () => {
    const provider = crearProviderCruceMock();
    const respuesta = await provider.cruzar('# Memoria', OBRA);

    expect(respuesta.datosObra).toHaveLength(1);
    expect(respuesta.datosObra[0].clave).toBe('altura_local.PB');
    // El fixture escribe lo que el modelo escribiría: la coma de la lámina.
    expect(respuesta.datosObra[0].valor).toBe('2,60');
    expect(respuesta.completados).toHaveLength(2);
    expect(respuesta.relecturas).toHaveLength(1);
  });

  it('el fixture rellena con null y [] lo que no escribió', async () => {
    const provider = crearProviderCruceMock();
    const respuesta = await provider.cruzar('# Memoria', OBRA);

    expect(respuesta.identidades).toEqual([]);
    expect(respuesta.completados[1].bbox).toBeNull();
  });

  it('el mock es el provider de los tests', () => {
    expect(getCruceProvider().nombre).toBe('cruce-mock');
  });
});
