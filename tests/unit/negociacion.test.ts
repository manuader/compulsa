import { describe, expect, it } from 'vitest';

import { FRASES_PALANCA, type EntradaContraoferta, proponerContraoferta } from '@/lib/negociacion/motor';
import { CONDICIONES_RFQ_DEFAULT, type CondicionesRfq, type Mandato } from '@/types/domain';

function condiciones(over: Partial<CondicionesRfq> = {}): CondicionesRfq {
  return { ...CONDICIONES_RFQ_DEFAULT, ...over };
}

function mandato(over: Partial<Mandato> = {}): Mandato {
  return { objetivoMejoraPct: 5, palancas: ['volumen', 'plazo_pago'], maxRondas: 2, ...over };
}

function entrada(over: Partial<EntradaContraoferta> = {}): EntradaContraoferta {
  return {
    totalCotizado: 100,
    mejorTotalComparable: 100,
    tieneSustituciones: false,
    ronda: 1,
    mandato: mandato(),
    proveedorNombre: 'Corralón San Martín',
    rubroNombre: 'Aberturas',
    estudioNombre: 'Estudio Norte',
    condiciones: condiciones({ separarManoObraMateriales: true }),
    ...over,
  };
}

describe('proponerContraoferta — cuándo procede', () => {
  it('procede si el total está por encima del objetivo, con el objetivo calculado', () => {
    const r = proponerContraoferta(entrada());
    expect(r.procede).toBe(true);
    if (!r.procede) throw new Error('debería proceder');
    expect(r.objetivoTotal).toBe(95); // (1 − 5/100) × 100
  });

  it('no procede si el total ya está en el objetivo (el corte es estricto)', () => {
    expect(proponerContraoferta(entrada({ totalCotizado: 95 }))).toEqual({
      procede: false,
      motivo: 'dentro_de_objetivo',
    });
  });

  it('no procede si el total está por debajo del objetivo', () => {
    expect(proponerContraoferta(entrada({ totalCotizado: 94 }))).toMatchObject({
      motivo: 'dentro_de_objetivo',
    });
  });

  it('ronda 3 ⇒ no procede: el PRD fija dos rondas', () => {
    expect(proponerContraoferta(entrada({ ronda: 3 }))).toEqual({ procede: false, motivo: 'max_rondas' });
  });

  it('ronda 2 todavía procede', () => {
    expect(proponerContraoferta(entrada({ ronda: 2 })).procede).toBe(true);
  });

  it('una línea sustituto escala al usuario: la negociación no toca la spec (RF-1002)', () => {
    expect(proponerContraoferta(entrada({ tieneSustituciones: true }))).toEqual({
      procede: false,
      motivo: 'escala_spec',
    });
  });

  it('el sustituto manda incluso sobre el tope de rondas', () => {
    expect(
      proponerContraoferta(entrada({ tieneSustituciones: true, ronda: 3 })),
    ).toMatchObject({ motivo: 'escala_spec' });
  });

  it('el sustituto manda incluso si el precio ya está dentro del objetivo', () => {
    expect(
      proponerContraoferta(entrada({ tieneSustituciones: true, totalCotizado: 80 })),
    ).toMatchObject({ motivo: 'escala_spec' });
  });

  it('redondea el objetivo a 2 decimales', () => {
    const r = proponerContraoferta(
      entrada({ totalCotizado: 1000.33, mejorTotalComparable: 1000.33, mandato: mandato({ objetivoMejoraPct: 7 }) }),
    );
    if (!r.procede) throw new Error('debería proceder');
    expect(r.objetivoTotal).toBe(930.31); // 0,93 × 1000,33 = 930,3069
  });

  it('rechaza rondas y totales que no tienen sentido', () => {
    expect(() => proponerContraoferta(entrada({ ronda: 0 }))).toThrow(/ronda/i);
    expect(() => proponerContraoferta(entrada({ ronda: 1.5 }))).toThrow(/ronda/i);
    expect(() => proponerContraoferta(entrada({ totalCotizado: 0 }))).toThrow(/positivo/i);
    expect(() => proponerContraoferta(entrada({ mejorTotalComparable: Number.NaN }))).toThrow(/positivo/i);
  });

  it('rechaza un objetivo de mejora fuera de rango', () => {
    expect(() => proponerContraoferta(entrada({ mandato: mandato({ objetivoMejoraPct: -1 }) }))).toThrow(
      /objetivo/i,
    );
    expect(() => proponerContraoferta(entrada({ mandato: mandato({ objetivoMejoraPct: 100 }) }))).toThrow(
      /objetivo/i,
    );
  });
});

describe('proponerContraoferta — el texto', () => {
  function textoDe(over: Partial<EntradaContraoferta> = {}): string {
    const r = proponerContraoferta(entrada(over));
    if (!r.procede) throw new Error('debería proceder');
    return r.texto;
  }

  it('se identifica con el NOMBRE del estudio y nombra proveedor y rubro (PRD §13)', () => {
    const texto = textoDe();
    // «el asistente del estudio» no le dice nada al proveedor: la contraoferta
    // le llega por el mismo canal que el pedido, firmada igual que aquel.
    expect(texto).toContain('asistente de Estudio Norte');
    expect(texto).toContain('Corralón San Martín');
    expect(texto).toContain('Aberturas');
  });

  it('sin nombre de estudio no se arma el texto: es un dato que falta, no uno degradado', () => {
    expect(() => textoDe({ estudioNombre: '   ' })).toThrow(/nombre del estudio/);
  });

  it('usa SOLO las palancas del mandato', () => {
    const texto = textoDe();
    expect(texto).toContain(FRASES_PALANCA.volumen);
    expect(texto).toContain(FRASES_PALANCA.plazo_pago);
    expect(texto).not.toContain(FRASES_PALANCA.fecha);
    expect(texto).not.toContain(FRASES_PALANCA.adjudicacion_inmediata);
  });

  it('con otro mandato cambian las palancas y ninguna otra promesa aparece', () => {
    const texto = textoDe({ mandato: mandato({ palancas: ['fecha', 'adjudicacion_inmediata'] }) });
    expect(texto).toContain(FRASES_PALANCA.fecha);
    expect(texto).toContain(FRASES_PALANCA.adjudicacion_inmediata);
    expect(texto).not.toContain(FRASES_PALANCA.volumen);
    expect(texto).not.toContain(FRASES_PALANCA.plazo_pago);
  });

  it('sin palancas el pedido sale igual, pero sin ofrecer nada a cambio', () => {
    const texto = textoDe({ mandato: mandato({ palancas: [] }) });
    for (const frase of Object.values(FRASES_PALANCA)) expect(texto).not.toContain(frase);
    expect(texto).toContain('asistente de Estudio Norte');
  });

  it('dice el número cotizado y el objetivo, en formato es-AR', () => {
    const texto = textoDe({ totalCotizado: 1200000, mejorTotalComparable: 1200000 });
    expect(texto).toContain('1.200.000'); // cotizado
    expect(texto).toContain('1.140.000'); // objetivo: 0,95 × 1.200.000
  });

  it('nunca revela el total del mejor comparable: el proveedor ve su número y el objetivo', () => {
    const texto = textoDe({ totalCotizado: 1000, mejorTotalComparable: 800 });
    expect(texto).toContain('760'); // objetivo: 0,95 × 800
    expect(texto).not.toContain('800');
  });

  it('deja escrito que la especificación no se toca (RF-1002)', () => {
    const texto = textoDe();
    expect(texto).toContain('especificaciones');
    expect(texto).toContain('IVA discriminado');
  });

  it('solo repite lo de separar mano de obra si el pedido lo pidió así', () => {
    // El IVA discriminado es del §13 y va siempre; separar mano de obra,
    // materiales y flete depende de cómo se lanzó la compulsa, y prometerlo
    // sobre un pedido que no lo pidió es cambiarle las condiciones al
    // proveedor en el mensaje de la contraoferta.
    expect(textoDe()).toContain('mano de obra, materiales y flete por separado');

    const sinSeparar = textoDe({
      condiciones: condiciones({ separarManoObraMateriales: false }),
    });
    expect(sinSeparar).toContain('IVA discriminado');
    expect(sinSeparar).not.toContain('mano de obra');
  });
});
