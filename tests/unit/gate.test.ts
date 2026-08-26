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

  it('un bloqueante de obra (rubro null) frena a TODOS los rubros', () => {
    // El caso vivo: la lámina bloqueada por escala (RF-201). No pertenece a
    // ningún rubro porque no se midió nada de ella: aprobar cualquier rubro
    // sería aprobar un cómputo al que le falta un pedazo.
    const escala = hallazgo({ rubro: null });
    expect(puedeAprobarRubro('seco', [escala])).toEqual({ ok: false, bloqueantes: 1 });
    expect(puedeAprobarRubro('pintura', [escala])).toEqual({ ok: false, bloqueantes: 1 });
    expect(puedeAprobarRubro('gruesa', [escala])).toEqual({ ok: false, bloqueantes: 1 });
    expect(puedeAprobarRubro('aberturas', [escala])).toEqual({ ok: false, bloqueantes: 1 });
  });

  it('un hallazgo de obra NO bloqueante (sanity) no frena a ningún rubro', () => {
    // Los `inconsistencia` de sanity.ts nacen con `bloqueante: false`: quién
    // frena y quién no lo decide el motor al crearlos, no el gate al contarlos.
    expect(puedeAprobarRubro('seco', [hallazgo({ rubro: null, bloqueante: false })])).toEqual({
      ok: true,
      bloqueantes: 0,
    });
  });

  it('un bloqueante de obra ya resuelto deja de frenar', () => {
    expect(puedeAprobarRubro('seco', [hallazgo({ rubro: null, estado: 'respondido' })])).toEqual({ ok: true, bloqueantes: 0 });
    expect(puedeAprobarRubro('seco', [hallazgo({ rubro: null, estado: 'descartado' })])).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('cuenta los del rubro y los de obra juntos, y ninguno de otro rubro', () => {
    const hallazgos = [
      hallazgo(), // seco, abierto, bloqueante        → cuenta
      hallazgo(), // seco, abierto, bloqueante        → cuenta
      hallazgo({ rubro: null }), // escala, abierto   → cuenta
      hallazgo({ estado: 'respondido' }), // resuelto → no
      hallazgo({ rubro: 'gruesa' }), // otro rubro    → no
      hallazgo({ bloqueante: false }), // no bloquea  → no
      hallazgo({ rubro: null, bloqueante: false }), // sanity → no
    ];
    expect(puedeAprobarRubro('seco', hallazgos)).toEqual({ ok: false, bloqueantes: 3 });
    // El mismo lote visto desde otro rubro: sus dos de seco no cuentan.
    expect(puedeAprobarRubro('pintura', hallazgos)).toEqual({ ok: false, bloqueantes: 1 });
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
