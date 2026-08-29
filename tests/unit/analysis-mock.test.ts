import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claveFixture, crearProviderMock, getAnalysisProvider, slug } from '@/lib/analysis';
import { inventariarLamina, type AnalysisProvider } from '@/lib/analysis/tipos';
import type { LaminaInput, ObraContexto } from '@/types/domain';

const OBRA: ObraContexto = { obraId: 'obra-1', tipoObra: 'nueva' };

/**
 * El mock busca el fixture por `slug(documentoNombre)-p<numeroPagina>`: los
 * bytes no participan de la clave, así que acá van vacíos a propósito.
 */
function lamina(documentoNombre: string, numeroPagina: number): LaminaInput {
  return {
    laminaId: `${slug(documentoNombre)}-${numeroPagina}`,
    pdfBytes: new Uint8Array(),
    documentoNombre,
    numeroPagina,
  };
}

/** Provider apuntado a un directorio temporal, para los casos de fixture roto. */
function providerConFixture(nombreArchivo: string, contenido: string) {
  const dir = mkdtempSync(join(tmpdir(), 'compulsa-fixtures-'));
  writeFileSync(join(dir, nombreArchivo), contenido, 'utf8');
  return crearProviderMock(dir);
}

describe('claveFixture', () => {
  it('es el nombre del documento sin extensión, en minúsculas, más la página', () => {
    expect(claveFixture('obra-demo.pdf', 1)).toBe('obra-demo-p1');
    expect(claveFixture('Planta Baja REV2.PDF', 3)).toBe('planta-baja-rev2-p3');
    expect(claveFixture('Planilla de Carpinterías.pdf', 1)).toBe('planilla-de-carpinter-as-p1');
  });
});

describe('provider mock con fixture', () => {
  const provider = crearProviderMock();

  it('lee el rótulo de la planta con escala confiable', async () => {
    const rotulo = await provider.leerRotulo(lamina('obra-demo.pdf', 1));

    expect(rotulo.escala).toBe('1:100');
    expect(rotulo.escalaConfiable).toBe(true);
    expect(rotulo.titulo).toBe('PLANTA PB');
    expect(rotulo.codigo).toBe('A-01');
    expect(rotulo.tipoLamina).toBe('planta');
    expect(rotulo.disciplina).toBe('arquitectura');
  });

  it('devuelve las 7 entidades de la planta con sus atributos exactos', async () => {
    const entidades = await provider.extraerEntidades(lamina('obra-demo.pdf', 1), OBRA);

    expect(entidades).toHaveLength(7);
    expect(entidades.map((e) => e.nombre)).toEqual(['Estar', 'Dormitorio', 'T1', 'M1', 'V1', 'P1', 'P2']);

    const porNombre = new Map(entidades.map((e) => [e.nombre, e]));
    expect(porNombre.get('Estar')?.atributos).toEqual({
      superficieM2: 20,
      perimetroM: 18,
      alturaM: 2.6,
      vanosM2: 4,
    });
    expect(porNombre.get('Dormitorio')?.atributos).toEqual({
      superficieM2: 12,
      perimetroM: 14,
      alturaM: 2.6,
      vanosM2: 2,
    });
    expect(porNombre.get('T1')?.atributos).toEqual({
      tipo: 'durlock',
      largoM: 5,
      alturaM: 2.6,
      caras: 2,
    });
    expect(porNombre.get('M1')?.atributos).toEqual({ tipo: 'mamposteria', largoM: 6, alturaM: 2.6 });
    expect(porNombre.get('V1')?.atributos).toEqual({
      tag: 'V1',
      tipologia: 'ventana',
      anchoM: 1.5,
      altoM: 1.1,
    });
    expect(porNombre.get('P1')?.atributos).toEqual({
      tag: 'P1',
      tipologia: 'puerta',
      anchoM: 0.8,
      altoM: 2.05,
    });
  });

  it('toda entidad trae provenance: bbox normalizado y confianza alta', async () => {
    const entidades = await provider.extraerEntidades(lamina('obra-demo.pdf', 1), OBRA);

    for (const entidad of entidades) {
      expect(entidad.bbox).toHaveLength(4);
      for (const valor of entidad.bbox) {
        expect(valor).toBeGreaterThanOrEqual(0);
        expect(valor).toBeLessThanOrEqual(1);
      }
      expect(entidad.confianza).toBeGreaterThanOrEqual(0.8);
      expect(entidad.estadoReforma).toBe('na');
    }
  });

  it('el corte trae las terminaciones de piso y cielorraso', async () => {
    const rotulo = await provider.leerRotulo(lamina('obra-demo.pdf', 2));
    const entidades = await provider.extraerEntidades(lamina('obra-demo.pdf', 2), OBRA);

    expect(rotulo.tipoLamina).toBe('corte');
    expect(entidades).toHaveLength(3);
    expect(entidades.every((e) => e.tipo === 'terminacion')).toBe(true);
    expect(entidades[0].atributos).toEqual({ superficieM2: 20, ubicacion: 'piso', ambiente: 'Estar' });
    expect(entidades[1].atributos).toEqual({
      superficieM2: 19,
      ubicacion: 'cielorraso',
      ambiente: 'Estar',
    });
  });

  it('la planilla se lee como planilla, sin escala y sin verificarla', async () => {
    const rotulo = await provider.leerRotulo(lamina('obra-demo.pdf', 3));

    expect(rotulo.tipoLamina).toBe('planilla');
    // Una planilla no imprime escala en el rótulo, así que no hay nada que
    // verificar contra cotas: `escalaConfiable` es `false`. El fixture decía
    // `true` —una salida que el provider real NO puede emitir según su propio
    // prompt, regla 4— y con eso la suite entera validaba un rótulo imposible
    // (la trampa de tests/CLAUDE.md §6). Que la planilla se lea igual sin
    // escala es cosa del pipeline, no del provider.
    expect(rotulo.escala).toBeNull();
    expect(rotulo.escalaConfiable).toBe(false);
    // Esta planilla en particular no trae filas cargadas en su fixture; que una
    // planilla con filas sí produzca aberturas lo prueba `obra-reforma-p2`.
    expect(await provider.extraerEntidades(lamina('obra-demo.pdf', 3), OBRA)).toEqual([]);
  });

  it('no comparte estado entre llamadas: mutar el resultado no ensucia el fixture', async () => {
    const primera = await provider.extraerEntidades(lamina('obra-demo.pdf', 1), OBRA);
    primera[0].atributos.superficieM2 = 999;

    const segunda = await provider.extraerEntidades(lamina('obra-demo.pdf', 1), OBRA);
    expect(segunda[0].atributos.superficieM2).toBe(20);
  });
});

describe('provider mock sin fixture', () => {
  const provider = crearProviderMock();

  it('devuelve un rótulo nulo con escala no confiable', async () => {
    const rotulo = await provider.leerRotulo(lamina('sin-escala.pdf', 1));

    expect(rotulo.escalaConfiable).toBe(false);
    expect(rotulo.escala).toBeNull();
    expect(rotulo.titulo).toBeNull();
    expect(rotulo.confianza).toBe(0);
  });

  it('no devuelve entidades', async () => {
    expect(await provider.extraerEntidades(lamina('sin-escala.pdf', 1), OBRA)).toEqual([]);
  });

  it('una página fuera del rango del fixture tampoco inventa nada', async () => {
    expect((await provider.leerRotulo(lamina('obra-demo.pdf', 9))).escalaConfiable).toBe(false);
    expect(await provider.extraerEntidades(lamina('obra-demo.pdf', 9), OBRA)).toEqual([]);
  });
});

/**
 * La fase de inventario (§25.1 del diseño): antes de extraer nada, el pipeline
 * recorre el expediente leyendo SOLO rótulos, así la extracción de cada lámina
 * arranca con el índice completo. Del lado del mock no hay llamada que ahorrar,
 * así que el contrato es "el mismo rótulo del mismo fixture".
 */
describe('inventariar', () => {
  const provider = crearProviderMock();

  it('devuelve el rótulo del fixture, el mismo que leerRotulo', async () => {
    const entrada = lamina('obra-demo.pdf', 1);

    const inventario = await provider.inventariar!(entrada);

    expect(inventario).toEqual(await provider.leerRotulo(entrada));
    expect(inventario.codigo).toBe('A-01');
    expect(inventario.titulo).toBe('PLANTA PB');
    expect(inventario.tipoLamina).toBe('planta');
    expect(inventario.escala).toBe('1:100');
  });

  it('sin fixture devuelve el rótulo nulo, no confiable, sin inventar nada', async () => {
    const inventario = await provider.inventariar!(lamina('sin-escala.pdf', 1));

    expect(inventario.titulo).toBeNull();
    expect(inventario.escala).toBeNull();
    expect(inventario.escalaConfiable).toBe(false);
    expect(inventario.confianza).toBe(0);
  });

  it('no comparte estado: mutar el rótulo devuelto no ensucia el fixture', async () => {
    const primera = await provider.inventariar!(lamina('obra-demo.pdf', 1));
    primera.titulo = 'OTRA COSA';

    expect((await provider.inventariar!(lamina('obra-demo.pdf', 1))).titulo).toBe('PLANTA PB');
  });

  it('inventariarLamina cae a leerRotulo cuando el provider no lo implementa', async () => {
    const sinInventario: AnalysisProvider = {
      leerRotulo: (entrada) => provider.leerRotulo(entrada),
      extraerEntidades: async () => [],
    };

    const rotulo = await inventariarLamina(sinInventario, lamina('obra-demo.pdf', 1));

    expect(rotulo.titulo).toBe('PLANTA PB');
  });

  it('inventariarLamina usa el método barato cuando está', async () => {
    let llamadas = 0;
    const conInventario: AnalysisProvider = {
      leerRotulo: async () => {
        throw new Error('no se debería haber llamado a leerRotulo');
      },
      extraerEntidades: async () => [],
      inventariar: async (entrada) => {
        llamadas += 1;
        return provider.leerRotulo(entrada);
      },
    };

    const rotulo = await inventariarLamina(conInventario, lamina('obra-demo.pdf', 1));

    expect(llamadas).toBe(1);
    expect(rotulo.codigo).toBe('A-01');
  });
});

describe('fixture inválido', () => {
  it('falla nombrando el archivo y el campo que no valida', async () => {
    const provider = providerConFixture(
      'roto-p1.json',
      JSON.stringify({
        rotulo: {
          titulo: null,
          codigo: null,
          disciplina: null,
          tipoLamina: null,
          escala: null,
          escalaConfiable: false,
          revision: null,
          confianza: 0,
        },
        entidades: [
          {
            tipo: 'ambiente',
            nombre: 'Estar',
            bbox: [0.1, 0.1, 0.2, 0.2],
            confianza: 1.4,
            estadoReforma: 'na',
            atributos: {},
          },
        ],
      }),
    );

    await expect(provider.leerRotulo(lamina('roto.pdf', 1))).rejects.toThrow(
      /Fixture de análisis inválido[\s\S]*roto-p1\.json[\s\S]*entidades\.0\.confianza/,
    );
  });

  it('falla claro cuando el rótulo tiene un tipo de lámina desconocido', async () => {
    const provider = providerConFixture(
      'raro-p1.json',
      JSON.stringify({
        rotulo: {
          titulo: 'X',
          codigo: null,
          disciplina: null,
          tipoLamina: 'croquis',
          escala: null,
          escalaConfiable: true,
          revision: null,
          confianza: 0.5,
        },
        entidades: [],
      }),
    );

    await expect(provider.extraerEntidades(lamina('raro.pdf', 1), OBRA)).rejects.toThrow(
      /Fixture de análisis inválido[\s\S]*rotulo\.tipoLamina/,
    );
  });

  it('falla claro cuando el archivo no es JSON', async () => {
    const provider = providerConFixture('basura-p1.json', '{ esto no es json');

    await expect(provider.leerRotulo(lamina('basura.pdf', 1))).rejects.toThrow(
      /Fixture de análisis inválido[\s\S]*no es JSON válido/,
    );
  });
});

describe('getAnalysisProvider', () => {
  const keyOriginal = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (keyOriginal === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = keyOriginal;
  });

  it('en tests devuelve el mock aunque haya ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-no-se-usa';
    expect(process.env.NODE_ENV).toBe('test');

    const rotulo = await getAnalysisProvider().leerRotulo(lamina('obra-demo.pdf', 1));

    expect(rotulo.titulo).toBe('PLANTA PB');
  });

  it('sin key devuelve el mock', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(await getAnalysisProvider().extraerEntidades(lamina('obra-demo.pdf', 1), OBRA)).toHaveLength(7);
  });
});
