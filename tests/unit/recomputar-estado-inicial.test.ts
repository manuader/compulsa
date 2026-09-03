/**
 * `estadoInicialDeduccion()`: con qué estado nace una deducción (§5.4 y §5.5).
 *
 * La decisión de producto de esta ola: lo deducido **con fuentes** ya no espera
 * en una bandeja a que alguien apriete un botón — entra al cómputo marcado y
 * reversible. El umbral es el mismo `UMBRAL_DEDUCCION` de siempre (0,7), así que
 * lo que este test protege es la línea exacta: 0,7 entra, 0,69 no.
 *
 * `medicion_grafica` es la excepción y va por regla propia: mide sobre el dibujo
 * con confianza fija 0,5 y aun así entra —el ítem lo dice con `origen:
 * 'inferido'`, que es la advertencia más fuerte del sistema—.
 *
 * Dominio puro: sin base.
 */
import { describe, expect, it } from 'vitest';

import { UMBRAL_DEDUCCION } from '@/lib/deduccion/motor';
import { estadoInicialDeduccion } from '@/lib/pipeline/recomputar';

describe('estadoInicialDeduccion', () => {
  it('el umbral es el 0,7 de siempre, y 0,7 exacto entra', () => {
    expect(UMBRAL_DEDUCCION).toBe(0.7);
    expect(estadoInicialDeduccion(0.7, 'planta_corte')).toBe('validada');
  });

  it('0,69 se queda esperando en la bandeja', () => {
    expect(estadoInicialDeduccion(0.69, 'planta_corte')).toBe('propuesta');
    expect(estadoInicialDeduccion(0, 'continuidad')).toBe('propuesta');
  });

  it('las cinco reglas documentales y el cruce se rigen por el umbral', () => {
    for (const regla of [
      'planilla_plano',
      'planta_corte',
      'continuidad',
      'idem_tipologia',
      'cierre_cotas',
      'cruce',
    ] as const) {
      expect(estadoInicialDeduccion(0.76, regla)).toBe('validada');
      expect(estadoInicialDeduccion(0.5, regla)).toBe('propuesta');
    }
  });

  it('la medición gráfica entra por regla propia, con su 0,5 fija', () => {
    // Su confianza nunca llega al umbral: si dependiera de él, el Nivel C del
    // §5.5 no existiría. Lo que la hace honesta es el `origen: 'inferido'` del
    // ítem, no una fila esperando en una bandeja.
    expect(estadoInicialDeduccion(0.5, 'medicion_grafica')).toBe('validada');
  });

  it('una confianza que no es un número no valida nada', () => {
    expect(estadoInicialDeduccion(Number.NaN, 'planta_corte')).toBe('propuesta');
  });
});
