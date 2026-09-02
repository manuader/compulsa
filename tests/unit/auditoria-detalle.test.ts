/**
 * La columna «Detalle» de la auditoría, y por qué el orden no es cosmético.
 *
 * El detalle corta a tres campos —el diff entero está en la base y la columna
 * es para reconocer la fila—, pero cortaba por el orden en que `jsonb` devuelve
 * las claves, que **no** es el orden en que se escribieron. En una fila de
 * `analisis_llm` los tres primeros salían `modelo`, `documentoNombre` y
 * `numeroPagina`, y `tokensEntrada` —que es lo que domina la factura— no
 * aparecía nunca. RNF-7 pide que el costo se mida *y* se vea; estaba medido y
 * escondido.
 */
import { describe, expect, it } from 'vitest';

import { detalle, objeto, ordenarCampos } from '@/app/estudio/auditoria/detalle';

/** Una fila de `analisis_llm` como la escribe el provider, con jsonb reordenando. */
const COMO_VUELVE_DE_JSONB = {
  documentoNombre: 'planos.pdf',
  modelo: 'claude-sonnet-4-5',
  numeroPagina: 4,
  entidadesDescartadas: 0,
  tokensSalida: 1_204,
  tokensCacheEscritura: 0,
  tokensEntrada: 38_950,
  tokensCacheLectura: 12_000,
};

describe('ordenarCampos', () => {
  it('los tokens van primero, en su orden, sin importar cómo vengan', () => {
    expect(ordenarCampos(Object.keys(COMO_VUELVE_DE_JSONB)).slice(0, 4)).toEqual([
      'tokensEntrada',
      'tokensSalida',
      'tokensCacheLectura',
      'tokensCacheEscritura',
    ]);
  });

  it('lo demás queda como venía: no se reordena lo que no hace falta', () => {
    expect(ordenarCampos(['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
  });

  it('no inventa campos que no están', () => {
    expect(ordenarCampos(['modelo', 'tokensSalida'])).toEqual(['tokensSalida', 'modelo']);
  });
});

describe('detalle', () => {
  it('una fila de análisis muestra los tokens, que es lo que se va a mirar', () => {
    expect(detalle(COMO_VUELVE_DE_JSONB)).toBe(
      'tokensEntrada: 38950 · tokensSalida: 1204 · tokensCacheLectura: 12000 · …',
    );
  });

  it('un diff de edición sigue mostrándose como antes → después', () => {
    expect(detalle({ cantNeta: { antes: 24, despues: 26 } })).toBe('cantNeta: 24 → 26');
  });

  it('sin diff no hay detalle que mostrar', () => {
    expect(detalle(null)).toBe('—');
  });
});

describe('objeto', () => {
  it('saca el prefijo de la tabla, que no es el objeto', () => {
    expect(objeto('computo_items:seco.placas')).toBe('seco.placas');
    expect(objeto('datos_obra:altura_local.PB')).toBe('altura_local.PB');
  });

  it('sin target_ref no inventa uno', () => {
    expect(objeto(null)).toBe('—');
  });
});
