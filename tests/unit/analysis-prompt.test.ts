import { describe, expect, it } from 'vitest';

import { armarContextoObra, textoInstrucciones } from '@/lib/analysis/prompt';
import { RUBROS } from '@/types/domain';
import type { InstruccionesExtraccion, LaminaIndice, ObraContexto, RubroId } from '@/types/domain';

/**
 * `prompt.ts` es donde vive todo lo testeable del prompt de extracción:
 * `claude.ts` no tiene tests porque los tests no salen a la red (CLAUDE.md del
 * módulo), así que lo que se puede equivocar —qué secciones se emiten y cómo se
 * escribe cada línea— se pinnea acá.
 */

const OBRA: ObraContexto = { obraId: 'obra-1', tipoObra: 'reforma' };

const LAMINAS: LaminaIndice[] = [
  { codigo: 'A-01', titulo: 'PLANTA PB', tipo: 'planta' },
  { codigo: 'DET00', titulo: 'PLANILLA DE CARPINTERÍAS', tipo: 'planilla' },
];

describe('armarContextoObra', () => {
  it('el índice de láminas sale una por línea, con código, título y tipo', () => {
    const texto = armarContextoObra({ ...OBRA, indiceLaminas: LAMINAS });

    const lineas = texto.split('\n');
    expect(lineas).toContain('- A-01 — PLANTA PB (planta)');
    expect(lineas).toContain('- DET00 — PLANILLA DE CARPINTERÍAS (planilla)');
    expect(texto).toContain('Obra de tipo: reforma.');
  });

  it('sin resumen, sin índice y sin instrucciones no emite esas secciones', () => {
    const texto = armarContextoObra(OBRA);

    expect(texto).toBe('Obra de tipo: reforma.');
    expect(texto).not.toContain('De qué se trata');
    expect(texto).not.toContain('láminas del expediente');
    expect(texto).not.toContain('Instrucciones');
  });

  it('el resumen y las instrucciones del estudio entran con su encabezado', () => {
    const texto = armarContextoObra({
      ...OBRA,
      resumen: 'Reforma de un PH en Villa Crespo: dos baños y cocina.',
      instruccionesEstudio: 'Las cotas de esta obra están en centímetros.',
    });

    expect(texto).toContain('Reforma de un PH en Villa Crespo');
    expect(texto).toContain('Instrucciones de este estudio para leer sus láminas:');
    expect(texto).toContain('Las cotas de esta obra están en centímetros.');
  });

  it('lo que viene en blanco no cuenta como dato', () => {
    const texto = armarContextoObra({ ...OBRA, resumen: '   ', instruccionesEstudio: '' });

    expect(texto).toBe('Obra de tipo: reforma.');
  });

  it('una lámina sin código ni título no entra al índice; sin tipo va sin paréntesis', () => {
    const texto = armarContextoObra({
      ...OBRA,
      indiceLaminas: [
        { codigo: null, titulo: null, tipo: 'otra' },
        { codigo: null, titulo: 'CORTE A-A', tipo: null },
      ],
    });

    const lineas = texto.split('\n').filter((linea) => linea.startsWith('- '));
    expect(lineas).toEqual(['- CORTE A-A']);
  });
});

describe('textoInstrucciones', () => {
  it('sin nada escrito devuelve null', () => {
    expect(textoInstrucciones({ general: '', porRubro: {} })).toBeNull();
    expect(textoInstrucciones({ general: '  ', porRubro: { aberturas: '   ' } })).toBeNull();
  });

  it('con general y por rubro, cada rubro sale etiquetado', () => {
    const instrucciones: InstruccionesExtraccion = {
      general: 'Las cotas están en centímetros.',
      porRubro: {
        aberturas: 'Las medidas de las carpinterías están en la planilla DET00.',
        seco: 'Los tabiques de durlock van rayados en planta.',
      },
    };

    const texto = textoInstrucciones(instrucciones);
    expect(texto).not.toBeNull();
    expect(texto).toContain('Las cotas están en centímetros.');
    expect(texto).toContain('Aberturas:');
    expect(texto).toContain('Aberturas: Las medidas de las carpinterías están en la planilla DET00.');
    expect(texto).toContain('Construcción en seco: Los tabiques de durlock van rayados en planta.');
    expect(texto).not.toContain('Pintura:');
  });

  it('solo un rubro configurado alcanza para que haya texto', () => {
    expect(textoInstrucciones({ general: '', porRubro: { pintura: 'Dos manos siempre.' } })).toBe(
      'Pintura: Dos manos siempre.',
    );
  });

  /**
   * `ETIQUETA_RUBRO` es un `satisfies Record<RubroId, string>`: un rubro nuevo
   * sin etiqueta no compila. Lo que el compilador NO mira es qué dice cada
   * etiqueta ni en qué orden salen, y eso es lo que ve el modelo. Pinneadas las
   * ocho, las cuatro de esta ola incluidas.
   */
  it('los ocho rubros salen etiquetados, en el orden de RUBROS', () => {
    const porRubro = Object.fromEntries(
      RUBROS.map((rubro) => [rubro, `instrucción de ${rubro}`]),
    ) as Record<RubroId, string>;

    expect(textoInstrucciones({ general: '', porRubro })?.split('\n')).toEqual([
      'Aberturas: instrucción de aberturas',
      'Construcción en seco: instrucción de seco',
      'Pintura: instrucción de pintura',
      'Obra gruesa: instrucción de gruesa',
      'Terminaciones: instrucción de terminaciones',
      'Instalación sanitaria: instrucción de sanitaria',
      'Instalación eléctrica: instrucción de electrica',
      'Demolición: instrucción de demolicion',
    ]);
  });

  it('un rubro nuevo solo también alcanza, con su etiqueta', () => {
    expect(
      textoInstrucciones({
        general: '',
        porRubro: { sanitaria: 'Los diámetros de esta obra están en pulgadas.' },
      }),
    ).toBe('Instalación sanitaria: Los diámetros de esta obra están en pulgadas.');
  });

  it('el general va primero y después los rubros, sin mezclarse', () => {
    const texto = textoInstrucciones({
      general: 'Las cotas están en centímetros.',
      porRubro: { demolicion: 'Lo rayado en diagonal se demuele.' },
    });

    expect(texto).toBe(
      'Las cotas están en centímetros.\nDemolición: Lo rayado en diagonal se demuele.',
    );
  });
});
