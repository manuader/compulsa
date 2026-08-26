/**
 * Memoria de deducciones (RF-505): qué se dedujo, de dónde salió, quién lo
 * validó o lo rechazó y cuándo. Markdown es-AR, exportable.
 */
import { describe, expect, it } from 'vitest';

import { generarMemoria, type DeduccionRegistrada } from '@/lib/deduccion/memoria';
import type { LaminaResumen } from '@/lib/deduccion/motor';

const LAMINAS: LaminaResumen[] = [
  { id: 'L-planta', tipo: 'planta', codigo: 'A-01' },
  { id: 'L-corte', tipo: 'corte', codigo: 'A-03' },
  { id: 'L-planilla', tipo: 'planilla', codigo: 'A-05' },
  { id: 'L-detalle', tipo: 'detalle', codigo: null },
];

const anchoDeV2: DeduccionRegistrada = {
  entidadId: 'e-v2',
  campo: 'anchoM',
  regla: 'planilla_plano',
  valor: 1.5,
  confianza: 0.76,
  fuentes: [
    { laminaId: 'L-planta', bbox: [0.1, 0.1, 0.05, 0.05], detalle: 'V2' },
    { laminaId: 'L-planilla', bbox: [0.4, 0.3, 0.2, 0.04], detalle: 'V2' },
  ],
  explicacion:
    'El ancho 1,50 m de V2 sale de la planilla de carpinterías (lámina A-05); ' +
    'en el plano (lámina A-01) la abertura está sin acotar.',
  estado: 'validada',
  validadoPor: 'Manu Ader',
  fecha: '2026-08-26',
};

const alturaDelEstar: DeduccionRegistrada = {
  entidadId: 'e-estar',
  campo: 'alturaM',
  regla: 'planta_corte',
  valor: 2.6,
  confianza: 0.81,
  fuentes: [
    { laminaId: 'L-planta', bbox: [0.2, 0.2, 0.3, 0.25], detalle: 'Estar' },
    { laminaId: 'L-corte', bbox: [0.3, 0.4, 0.25, 0.2], detalle: 'Estar' },
  ],
  explicacion:
    'La altura 2,60 m de Estar sale del corte (lámina A-03); en la planta (lámina A-01) no está acotada.',
  estado: 'rechazada',
  validadoPor: 'Manu Ader',
  fecha: '2026-08-26',
};

const carasDeT1: DeduccionRegistrada = {
  entidadId: 'e-t1',
  campo: 'caras',
  regla: 'continuidad',
  valor: 2,
  confianza: 0.77,
  fuentes: [
    { laminaId: 'L-planta', bbox: [0.2, 0.5, 0.3, 0.05], detalle: 'T1' },
    { laminaId: 'L-detalle', bbox: [0.1, 0.1, 0.2, 0.4], detalle: 'T1' },
  ],
  explicacion:
    'T1 no tiene cantidad de caras en la lámina A-01, pero aparece en la lámina sin código con 2: ' +
    'por continuidad es el mismo elemento.',
  estado: 'propuesta',
};

describe('memoria de deducciones (RF-505)', () => {
  it('una obra sin deducciones lo dice y no inventa tablas', () => {
    expect(generarMemoria([], LAMINAS)).toBe(
      '# Memoria de deducciones\n' +
        '\n' +
        'No hay deducciones registradas en esta obra.\n' +
        '\n' +
        '---\n' +
        '\n' +
        '_La plataforma asiste: el cómputo y las deducciones los firma el profesional interviniente. ' +
        'Nada de índole estructural o de seguridad se deduce automáticamente (RF-506)._\n',
    );
  });

  it('arma una tabla por regla, en el orden de prioridad del motor', () => {
    const markdown = generarMemoria([carasDeT1, alturaDelEstar, anchoDeV2], LAMINAS);

    expect(markdown.match(/^## .*$/gm)).toEqual([
      '## Planilla ↔ plano',
      '## Planta ↔ corte',
      '## Continuidad entre láminas',
    ]);
  });

  it('cada fila dice qué, de dónde, con cuánta confianza y quién decidió', () => {
    const markdown = generarMemoria([anchoDeV2], LAMINAS);

    expect(markdown).toBe(
      '# Memoria de deducciones\n' +
        '\n' +
        '1 deducción: 1 validada, 0 rechazadas, 0 pendientes de validación.\n' +
        '\n' +
        '## Planilla ↔ plano\n' +
        '\n' +
        '| Entidad | Campo | Valor | Confianza | Fuentes | Estado | Validó / rechazó | Fecha | Por qué |\n' +
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' +
        '| V2 | ancho | 1,50 m | 76% | A-01, A-05 | Validada | Manu Ader | 2026-08-26 | ' +
        'El ancho 1,50 m de V2 sale de la planilla de carpinterías (lámina A-05); ' +
        'en el plano (lámina A-01) la abertura está sin acotar. |\n' +
        '\n' +
        '---\n' +
        '\n' +
        '_La plataforma asiste: el cómputo y las deducciones los firma el profesional interviniente. ' +
        'Nada de índole estructural o de seguridad se deduce automáticamente (RF-506)._\n',
    );
  });

  it('cuenta validadas, rechazadas y pendientes en el encabezado', () => {
    const markdown = generarMemoria([anchoDeV2, alturaDelEstar, carasDeT1], LAMINAS);

    expect(markdown).toContain('3 deducciones: 1 validada, 1 rechazada, 1 pendiente de validación.');
  });

  it('lo que sigue en propuesta no tiene quién ni cuándo', () => {
    const markdown = generarMemoria([carasDeT1], LAMINAS);

    expect(markdown).toContain('| T1 | cantidad de caras | 2 | 77% | A-01, sin código | Propuesta | — | — |');
  });

  it('sin la lista de láminas cae al id, que sigue siendo trazable', () => {
    const markdown = generarMemoria([anchoDeV2]);

    expect(markdown).toContain('| L-planta, L-planilla |');
  });

  it('escapa los pipes para no romper la tabla', () => {
    const conPipe: DeduccionRegistrada = {
      ...carasDeT1,
      explicacion: 'T1 | tabique doble | sale del detalle.',
    };

    expect(generarMemoria([conPipe], LAMINAS)).toContain('T1 \\| tabique doble \\| sale del detalle.');
  });
});
