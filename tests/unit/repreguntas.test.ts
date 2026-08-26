import { describe, expect, it } from 'vitest';
import {
  faltantesDeLinea,
  generarRepregunta,
  repreguntaPorItemNoCotizado,
  repreguntaPorLineaAmbigua,
} from '@/lib/compulsa/repreguntas';
import type { ItemRfq, LineaPresupuesto } from '@/types/domain';

const PLACAS: ItemRfq = {
  claveItem: 'seco.placas',
  descripcion: 'Placa de yeso 12,5 mm',
  unidad: 'm2',
  cantidad: 31.68,
  presentacion: '11 placas de 2,88 m²',
  specsCriticas: { tipo: 'durlock' },
};

function linea(over: Partial<LineaPresupuesto> = {}): LineaPresupuesto {
  return {
    descripcion: 'Ventana V2 corrediza',
    unidad: 'u',
    cantidad: 3,
    precioUnitario: 180000,
    precioTotal: 540000,
    claveItemSugerida: null,
    notas: null,
    ...over,
  };
}

describe('repregunta por ítem no cotizado', () => {
  it('pide el precio del ítem con su cantidad, unidad y presentación', () => {
    const texto = generarRepregunta({ tipo: 'no_cotizada', item: PLACAS });

    expect(texto).toContain('¿Nos pasás precio de');
    expect(texto).toContain('31,68 m²');
    expect(texto).toContain('Placa de yeso 12,5 mm');
    expect(texto).toContain('11 placas de 2,88 m²');
  });

  it('repite la spec crítica: es lo que no se puede sustituir', () => {
    expect(generarRepregunta({ tipo: 'no_cotizada', item: PLACAS })).toContain('tipo durlock');
  });

  it('sin specs no escribe la aclaración vacía', () => {
    const sinSpecs = { ...PLACAS, specsCriticas: {} };

    expect(generarRepregunta({ tipo: 'no_cotizada', item: sinSpecs })).not.toMatch(/no sustituible/i);
  });

  it('la repregunta lleva clave estable por ítem, para no mandarla dos veces', () => {
    expect(repreguntaPorItemNoCotizado(PLACAS)).toEqual({
      clave: 'repregunta.no_cotizada.seco.placas',
      motivo: 'no_cotizada',
      texto: expect.stringContaining('¿Nos pasás precio de'),
    });
  });
});

describe('repregunta por línea ambigua', () => {
  it('una línea sin precio (ni unitario ni total) es ambigua', () => {
    expect(faltantesDeLinea(linea({ precioUnitario: null, precioTotal: null }))).toEqual(['precio']);
  });

  it('con precio total pero sin unitario NO es ambigua: el unitario se deduce', () => {
    expect(faltantesDeLinea(linea({ precioUnitario: null }))).toEqual([]);
  });

  it('una línea sin cantidad es ambigua', () => {
    expect(faltantesDeLinea(linea({ cantidad: null }))).toEqual(['cantidad']);
  });

  it('sin cantidad y sin precio faltan las dos cosas, en una sola repregunta', () => {
    const rota = linea({ cantidad: null, precioUnitario: null, precioTotal: null });

    expect(faltantesDeLinea(rota)).toEqual(['cantidad', 'precio']);

    const texto = generarRepregunta({ tipo: 'ambigua', linea: rota, falta: ['cantidad', 'precio'] });
    expect(texto).toContain('la cantidad y el precio');
    expect(texto).toContain('Ventana V2 corrediza');
  });

  it('el texto cita la línea del proveedor y pregunta en es-AR', () => {
    const texto = generarRepregunta({
      tipo: 'ambigua',
      linea: linea({ precioUnitario: null, precioTotal: null }),
      falta: ['precio'],
    });

    expect(texto).toContain('"Ventana V2 corrediza"');
    expect(texto).toContain('el precio');
    expect(texto).toMatch(/¿Nos lo pasás\?/);
  });

  it('la clave de la ambigua es la posición de la línea en el presupuesto', () => {
    const rota = linea({ cantidad: null });

    expect(repreguntaPorLineaAmbigua(rota, 4)).toEqual({
      clave: 'repregunta.ambigua.5',
      motivo: 'ambigua',
      texto: expect.stringContaining('la cantidad'),
    });
  });

  it('una línea completa no genera repregunta', () => {
    expect(repreguntaPorLineaAmbigua(linea(), 0)).toBeNull();
  });
});
