/**
 * `/obras/[obraId]/deducciones` redirige a la solapa «Para revisar», y el
 * deep-link sobrevive.
 *
 * La pantalla se mudó adentro de la bandeja (§5.8) y la ruta vieja quedó como
 * redirección: está linkeada desde el tablero y desde cualquier URL que alguien
 * haya guardado. Lo que se rompe en silencio es el **query**: un `?regla=cruce`
 * que se pierde deja al arquitecto mirando todas las deducciones cuando pidió
 * una regla, y nadie lo nota porque la pantalla igual abre.
 *
 * `redirect()` de Next no devuelve: lanza un error con la URL adentro del
 * `digest` (`NEXT_REDIRECT;replace;<url>;…`). Es lo que se lee acá — sin
 * request de Next, sin base, sin render.
 */
import { describe, expect, it } from 'vitest';

import DeduccionesPage from '@/app/obras/[obraId]/deducciones/page';

const OBRA = '11111111-1111-4111-8111-111111111111';

/** La URL a la que la página manda, o un error si no redirigió. */
async function destinoDe(query: Record<string, string | string[] | undefined>): Promise<string> {
  try {
    await DeduccionesPage({
      params: Promise.resolve({ obraId: OBRA }),
      searchParams: Promise.resolve(query),
    });
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT')) throw error;
    return digest.split(';')[2] ?? '';
  }
  throw new Error('La página no redirigió.');
}

describe('/obras/[obraId]/deducciones', () => {
  it('manda a la solapa «Para revisar» de la bandeja', async () => {
    expect(await destinoDe({})).toBe(`/obras/${OBRA}/bandeja?solapa=revisar`);
  });

  it('conserva el filtro por regla del link viejo', async () => {
    expect(await destinoDe({ regla: 'cruce' })).toBe(
      `/obras/${OBRA}/bandeja?solapa=revisar&regla=cruce`,
    );
    expect(await destinoDe({ regla: 'planilla_plano' })).toBe(
      `/obras/${OBRA}/bandeja?solapa=revisar&regla=planilla_plano`,
    );
  });

  it('una regla inventada no se propaga: iría a un filtro que no existe', async () => {
    expect(await destinoDe({ regla: 'lo-que-sea' })).toBe(`/obras/${OBRA}/bandeja?solapa=revisar`);
  });

  it('un array de reglas —dos `?regla=` en la URL— toma la primera', async () => {
    expect(await destinoDe({ regla: ['continuidad', 'cruce'] })).toBe(
      `/obras/${OBRA}/bandeja?solapa=revisar&regla=continuidad`,
    );
  });
});
