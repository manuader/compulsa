/**
 * En qué lista de «Para revisar» cae cada deducción (§5.8).
 *
 * Es un reparto de tres líneas y ninguna se lee sola en la fila:
 *
 *  - `validado_por` es lo **único** que distingue una deducción que aplicó el
 *    sistema de una que validó una persona (§5.4). Si las mezcláramos, la
 *    solapa ofrecería deshacer decisiones que un arquitecto ya tomó a mano.
 *  - una **contradicha** está `validada` y sin embargo **no se está aplicando**:
 *    la documentación le pasó por encima y el cómputo usa el dato escrito.
 *    Ofrecer «Rechazar» ahí sería ofrecer deshacer algo que no está hecho.
 *  - una **propuesta** todavía no entró al cómputo: se valida, no se rechaza
 *    "para sacarla".
 */
import { describe, expect, it } from 'vitest';

import { clasificarDeducciones } from '@/app/obras/[obraId]/bandeja/revisar';
import type { Deduccion } from '@/db/schema';
import { MARCA_CONTRADICHA, MARCA_VALOR_DOCUMENTADO } from '@/lib/pipeline/recomputar';

/** Una fila de `deducciones` con lo mínimo, y lo que el caso necesite encima. */
function deduccion(extra: Partial<Deduccion> = {}): Deduccion {
  return {
    id: 'd1',
    obraId: 'o1',
    entidadId: 'e1',
    campo: 'alturaM',
    regla: 'planta_corte',
    valorJson: { alturaM: 2.6 },
    fuentesJson: [{ laminaId: 'l1', bbox: [0.1, 0.1, 0.2, 0.05] }],
    confianza: 0.81,
    estado: 'validada',
    validadoPor: null,
    createdAt: new Date(0),
    ...extra,
  };
}

describe('clasificarDeducciones', () => {
  it('la que validó el sistema va a «lo que completó el sistema»', () => {
    const fila = deduccion({ estado: 'validada', validadoPor: null });

    expect(clasificarDeducciones([fila])).toEqual({
      aplicadas: [fila],
      propuestas: [],
      superadas: [],
    });
  });

  it('la que validó una persona no vuelve a la solapa: ya decidió', () => {
    const fila = deduccion({ estado: 'validada', validadoPor: 'u1' });

    expect(clasificarDeducciones([fila])).toEqual({
      aplicadas: [],
      propuestas: [],
      superadas: [],
    });
  });

  it('la que no llegó al umbral espera un visto bueno', () => {
    const fila = deduccion({ estado: 'propuesta', validadoPor: null });

    expect(clasificarDeducciones([fila])).toEqual({
      aplicadas: [],
      propuestas: [fila],
      superadas: [],
    });
  });

  it('una contradicha se avisa, no se ofrece para rechazar', () => {
    const fila = deduccion({
      valorJson: { alturaM: 2.6, [MARCA_CONTRADICHA]: true, [MARCA_VALOR_DOCUMENTADO]: 2.4 },
    });

    expect(clasificarDeducciones([fila])).toEqual({
      aplicadas: [],
      propuestas: [],
      superadas: [fila],
    });
  });

  it('una contradicha validada a mano también va al aviso, no se pierde', () => {
    const fila = deduccion({
      validadoPor: 'u1',
      valorJson: { alturaM: 2.6, [MARCA_CONTRADICHA]: true, [MARCA_VALOR_DOCUMENTADO]: 2.4 },
    });

    expect(clasificarDeducciones([fila]).superadas).toEqual([fila]);
  });

  it('una rechazada es historia y no entra a ninguna lista', () => {
    const fila = deduccion({ estado: 'rechazada', validadoPor: 'u1' });

    expect(clasificarDeducciones([fila])).toEqual({
      aplicadas: [],
      propuestas: [],
      superadas: [],
    });
  });

  it('reparte una obra entera conservando el orden de cada lista', () => {
    const sistema = deduccion({ id: 'a' });
    const persona = deduccion({ id: 'b', validadoPor: 'u1' });
    const espera = deduccion({ id: 'c', estado: 'propuesta' });
    const otraEspera = deduccion({ id: 'd', estado: 'propuesta' });

    const clasificadas = clasificarDeducciones([sistema, persona, espera, otraEspera]);

    expect(clasificadas.aplicadas.map((f) => f.id)).toEqual(['a']);
    expect(clasificadas.propuestas.map((f) => f.id)).toEqual(['c', 'd']);
  });
});
