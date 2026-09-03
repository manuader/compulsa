/**
 * Qué dice la planilla de carpinterías derivada sobre de dónde salió cada medida.
 *
 * Es la columna que hace que el archivo sea honesto: quien lo recibe manda a
 * fabricar con esos números, y no es lo mismo una cota escrita que una medida
 * sacada con la regla sobre el dibujo. La regla del §5.5 es que **manda el peor
 * origen**, y acá está pinneada.
 *
 * Dominio puro: sin base, sin exceljs.
 */
import { describe, expect, it } from 'vitest';

import {
  ETIQUETA_ORIGEN_DATO,
  origenDeCarpinteria,
} from '@/lib/export/planilla-carpinterias';

describe('origenDeCarpinteria', () => {
  it('sin alguna de las dos medidas la fila está pendiente, diga lo que diga el resto', () => {
    expect(origenDeCarpinteria(true, [])).toBe('pendiente');
    expect(origenDeCarpinteria(true, ['deducido'])).toBe('pendiente');
    expect(origenDeCarpinteria(true, ['inferido'])).toBe('pendiente');
  });

  it('con las dos medidas escritas en la documentación, explícita', () => {
    expect(origenDeCarpinteria(false, [])).toBe('explicito');
    expect(origenDeCarpinteria(false, ['explicito'])).toBe('explicito');
  });

  it('una medida que puso una deducción validada deja la fila deducida', () => {
    expect(origenDeCarpinteria(false, ['deducido'])).toBe('deducido');
    expect(origenDeCarpinteria(false, ['explicito', 'deducido'])).toBe('deducido');
  });

  it('una medida sacada del dibujo deja la fila inferida, aunque la otra esté acotada', () => {
    // El ancho acotado no lava el alto medido con la regla: manda el peor.
    expect(origenDeCarpinteria(false, ['explicito', 'inferido'])).toBe('inferido');
    expect(origenDeCarpinteria(false, ['deducido', 'inferido'])).toBe('inferido');
    expect(origenDeCarpinteria(false, ['inferido'])).toBe('inferido');
  });

  it('el archivo lo dice con todas las letras', () => {
    expect(ETIQUETA_ORIGEN_DATO.inferido).toBe('Inferido (medido sobre el dibujo)');
    expect(ETIQUETA_ORIGEN_DATO.deducido).toBe('Deducido validado');
  });
});
