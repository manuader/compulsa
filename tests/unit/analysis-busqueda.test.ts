/**
 * El contrato de la búsqueda dirigida: qué entra y qué se descarta.
 *
 * `busqueda-claude.ts` no tiene tests (los tests no salen a la red), así que
 * todo lo que se puede pinnear de esa familia de providers vive acá: el saneo
 * del cable laxo y el mock, que pasa sus fixtures por el **mismo** saneo.
 */
import { describe, expect, it } from 'vitest';

import { crearProviderBusquedaMock } from '@/lib/analysis/busqueda-mock';
import {
  esCampoDeMedida,
  sanearBusqueda,
  type DatoCrudo,
  type ObjetivoBusqueda,
} from '@/lib/analysis/busqueda-tipos';
import type { LaminaInput } from '@/types/domain';

const OBJETIVOS: ObjetivoBusqueda[] = [
  {
    clave: 'aberturas.medidas_vano.FP01',
    descripcion: 'abertura FP01 — falta el ancho y el alto',
    campos: ['anchoM', 'altoM'],
  },
];

const BBOX = [0.1, 0.3, 0.3, 0.04];

function crudo(parcial: Partial<DatoCrudo>): DatoCrudo {
  return {
    clave: 'aberturas.medidas_vano.FP01',
    campo: 'anchoM',
    valor: 0.9,
    bbox: BBOX,
    confianza: 0.85,
    ...parcial,
  };
}

describe('esCampoDeMedida', () => {
  it('reconoce los campos con sufijo de unidad y los dos conteos', () => {
    for (const campo of ['anchoM', 'altoM', 'largoM', 'alturaM', 'perimetroM']) {
      expect(esCampoDeMedida(campo)).toBe(true);
    }
    expect(esCampoDeMedida('superficieM2')).toBe(true);
    expect(esCampoDeMedida('vanosM2')).toBe(true);
    expect(esCampoDeMedida('caras')).toBe(true);
    expect(esCampoDeMedida('cantidad')).toBe(true);
  });

  it('no confunde los campos de texto del dominio', () => {
    for (const campo of ['tag', 'tipologia', 'tipo', 'material', 'vidrio', 'ubicacion', 'ambiente']) {
      expect(esCampoDeMedida(campo)).toBe(false);
    }
  });
});

describe('sanearBusqueda', () => {
  it('deja pasar lo que se pidió, con el valor como número', () => {
    const { datos, descartados } = sanearBusqueda(
      [crudo({}), crudo({ campo: 'altoM', valor: 2.05 })],
      OBJETIVOS,
    );

    expect(descartados).toBe(0);
    expect(datos).toEqual([
      { clave: OBJETIVOS[0].clave, campo: 'anchoM', valor: 0.9, bbox: BBOX, confianza: 0.85 },
      { clave: OBJETIVOS[0].clave, campo: 'altoM', valor: 2.05, bbox: BBOX, confianza: 0.85 },
    ]);
  });

  it('convierte el número escrito con coma, como está en la planilla', () => {
    const { datos } = sanearBusqueda([crudo({ valor: '0,90' })], OBJETIVOS);
    expect(datos[0].valor).toBe(0.9);
  });

  it('descarta una clave que nadie pidió', () => {
    const { datos, descartados } = sanearBusqueda(
      [crudo({ clave: 'aberturas.medidas_vano.FP02' })],
      OBJETIVOS,
    );

    expect(datos).toEqual([]);
    expect(descartados).toBe(1);
  });

  it('descarta un campo que no está entre los pedidos de esa clave', () => {
    const { datos, descartados } = sanearBusqueda([crudo({ campo: 'material' })], OBJETIVOS);

    expect(datos).toEqual([]);
    expect(descartados).toBe(1);
  });

  it('descarta lo que no se puede ubicar en la lámina', () => {
    const { datos, descartados } = sanearBusqueda(
      [crudo({ bbox: [0.1, 0.3, 0.3] }), crudo({ bbox: [0.1, 0.3, 0.3, Number.NaN] })],
      OBJETIVOS,
    );

    expect(datos).toEqual([]);
    expect(descartados).toBe(2);
  });

  it('descarta un valor que no es una medida donde tiene que haber una', () => {
    const { datos, descartados } = sanearBusqueda(
      [
        crudo({ valor: 'no figura' }),
        crudo({ valor: '2,05 m' }),
        crudo({ valor: 0 }),
        crudo({ valor: -1.2 }),
      ],
      OBJETIVOS,
    );

    expect(datos).toEqual([]);
    expect(descartados).toBe(4);
  });

  it('conserva el texto en un campo de texto', () => {
    const { datos } = sanearBusqueda([crudo({ campo: 'tipologia', valor: ' puerta ' })], [
      { clave: OBJETIVOS[0].clave, descripcion: 'x', campos: ['tipologia'] },
    ]);

    expect(datos[0].valor).toBe('puerta');
  });

  it('clampa bbox y confianza a [0,1]', () => {
    const { datos } = sanearBusqueda(
      [crudo({ bbox: [-0.5, 0.3, 1.4, 0.04], confianza: 1.7 })],
      OBJETIVOS,
    );

    expect(datos[0].bbox).toEqual([0, 0.3, 1, 0.04]);
    expect(datos[0].confianza).toBe(1);
  });

  it('no deduplica: dos lecturas del mismo campo compiten en el pipeline', () => {
    const { datos } = sanearBusqueda([crudo({}), crudo({ valor: 0.95, confianza: 0.4 })], OBJETIVOS);
    expect(datos).toHaveLength(2);
  });

  it('sin objetivos no pasa nada', () => {
    const { datos, descartados } = sanearBusqueda([crudo({})], []);
    expect(datos).toEqual([]);
    expect(descartados).toBe(1);
  });
});

describe('provider mock', () => {
  const lamina = (documentoNombre: string, numeroPagina: number): LaminaInput => ({
    laminaId: 'lam-1',
    pdfBytes: new Uint8Array(),
    documentoNombre,
    numeroPagina,
  });

  it('lee el fixture de la lámina y devuelve lo pedido', async () => {
    const provider = crearProviderBusquedaMock();
    const datos = await provider.buscarDatos(lamina('obra-busqueda.pdf', 2), OBJETIVOS, {
      obraId: 'obra-1',
      tipoObra: 'nueva',
    });

    expect(datos.map((d) => [d.campo, d.valor])).toEqual([
      ['anchoM', 0.9],
      ['altoM', 2.05],
    ]);
    expect(datos.every((d) => d.confianza === 0.85)).toBe(true);
    expect(datos.every((d) => d.bbox.length === 4)).toBe(true);
  });

  it('un fixture NO puede colar una clave que la corrida no pidió', async () => {
    const provider = crearProviderBusquedaMock();
    const datos = await provider.buscarDatos(
      lamina('obra-busqueda.pdf', 2),
      [{ clave: 'seco.altura_tabiques.T1', descripcion: 'otra cosa', campos: ['alturaM'] }],
      { obraId: 'obra-1', tipoObra: 'nueva' },
    );

    expect(datos).toEqual([]);
  });

  it('tampoco un campo que ese objetivo no pidió', async () => {
    const provider = crearProviderBusquedaMock();
    const datos = await provider.buscarDatos(
      lamina('obra-busqueda.pdf', 2),
      [{ clave: OBJETIVOS[0].clave, descripcion: 'solo el alto', campos: ['altoM'] }],
      { obraId: 'obra-1', tipoObra: 'nueva' },
    );

    expect(datos.map((d) => d.campo)).toEqual(['altoM']);
  });

  it('sin fixture no inventa: lista vacía', async () => {
    const provider = crearProviderBusquedaMock();
    const datos = await provider.buscarDatos(lamina('obra-busqueda.pdf', 1), OBJETIVOS, {
      obraId: 'obra-1',
      tipoObra: 'nueva',
    });

    expect(datos).toEqual([]);
  });

  it('sin objetivos no toca el disco', async () => {
    const provider = crearProviderBusquedaMock('/no/existe/este/directorio');
    await expect(
      provider.buscarDatos(lamina('obra-busqueda.pdf', 2), [], {
        obraId: 'obra-1',
        tipoObra: 'nueva',
      }),
    ).resolves.toEqual([]);
  });
});
