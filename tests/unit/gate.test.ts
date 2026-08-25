import { describe, expect, it } from 'vitest';

import { puedeAprobarRubro, type HallazgoParaGate } from '@/lib/hallazgos/gate';
import { clasificarHueco } from '@/lib/hallazgos/taxonomia';

function hallazgo(over: Partial<HallazgoParaGate> = {}): HallazgoParaGate {
  return { rubro: 'seco', bloqueante: true, estado: 'abierto', ...over };
}

describe('puedeAprobarRubro (RF-404)', () => {
  it('un hallazgo bloqueante abierto del rubro frena la aprobación', () => {
    expect(puedeAprobarRubro('seco', [hallazgo()])).toEqual({ ok: false, bloqueantes: 1 });
  });

  it('respondido o descartado ya no frena', () => {
    expect(puedeAprobarRubro('seco', [hallazgo({ estado: 'respondido' })])).toEqual({ ok: true, bloqueantes: 0 });
    expect(puedeAprobarRubro('seco', [hallazgo({ estado: 'descartado' })])).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('un hallazgo abierto pero no bloqueante no frena', () => {
    expect(puedeAprobarRubro('seco', [hallazgo({ bloqueante: false })])).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('los bloqueantes de otro rubro no frenan este', () => {
    expect(puedeAprobarRubro('seco', [hallazgo({ rubro: 'pintura' })])).toEqual({ ok: true, bloqueantes: 0 });
    expect(puedeAprobarRubro('pintura', [hallazgo({ rubro: 'pintura' })])).toEqual({ ok: false, bloqueantes: 1 });
  });

  it('los hallazgos sin rubro (sanity) no frenan a ningún rubro', () => {
    expect(puedeAprobarRubro('seco', [hallazgo({ rubro: null })])).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('cuenta todos los bloqueantes abiertos del rubro', () => {
    const hallazgos = [
      hallazgo(),
      hallazgo(),
      hallazgo({ estado: 'respondido' }),
      hallazgo({ rubro: 'gruesa' }),
      hallazgo({ bloqueante: false }),
    ];
    expect(puedeAprobarRubro('seco', hallazgos)).toEqual({ ok: false, bloqueantes: 2 });
  });

  it('sin hallazgos se puede aprobar', () => {
    expect(puedeAprobarRubro('aberturas', [])).toEqual({ ok: true, bloqueantes: 0 });
  });
});

describe('clasificarHueco (§11)', () => {
  it('lo que está en la documentación es explícito y no genera hallazgo', () => {
    const clasificacion = clasificarHueco({ valorExplicito: 2.6 });
    expect(clasificacion.clase).toBe('explicito');
    expect(clasificacion.tipo).toBeNull();
    expect(clasificacion.bloqueante).toBe(false);
  });

  it('lo que ya está construido no falta: es existente', () => {
    const clasificacion = clasificarHueco({ estadoReforma: 'existente' });
    expect(clasificacion.clase).toBe('existente');
    expect(clasificacion.tipo).toBe('existente_confirmar');
    expect(clasificacion.bloqueante).toBe(false);
  });

  it('una deducción documental confiable es deducible', () => {
    const clasificacion = clasificarHueco({
      deduccion: { valor: 2.6, regla: 'planta ↔ corte', fuentes: [], confianza: 0.85 },
    });
    expect(clasificacion.clase).toBe('deducible');
    expect(clasificacion.motivo).toContain('planta ↔ corte');
  });

  it('confianza por debajo del umbral degrada la deducción a consulta bloqueante (§11.b)', () => {
    const clasificacion = clasificarHueco({
      deduccion: { valor: 2.6, regla: 'planta ↔ corte', fuentes: [], confianza: 0.6 },
    });
    expect(clasificacion.clase).toBe('faltante');
    expect(clasificacion.bloqueante).toBe(true);
  });

  it('un estándar aplicable se propone como supuesto, no se computa solo', () => {
    const clasificacion = clasificarHueco({ supuestoEstandar: { valor: 1.1, norma: 'altura estándar de antepecho' } });
    expect(clasificacion.clase).toBe('supuesto');
    expect(clasificacion.tipo).toBe('supuesto');
    expect(clasificacion.bloqueante).toBe(false);
  });

  it('nada estructural se auto-deduce (RF-506)', () => {
    const clasificacion = clasificarHueco({
      estructural: true,
      deduccion: { valor: 20, regla: 'continuidad', fuentes: [], confianza: 0.99 },
    });
    expect(clasificacion.clase).toBe('faltante');
    expect(clasificacion.bloqueante).toBe(true);
    expect(clasificacion.motivo).toContain('profesional competente');
  });

  it('sin fuente ni regla, es faltante real y bloquea', () => {
    const clasificacion = clasificarHueco({});
    expect(clasificacion.clase).toBe('faltante');
    expect(clasificacion.tipo).toBe('faltante');
    expect(clasificacion.bloqueante).toBe(true);
  });
});
