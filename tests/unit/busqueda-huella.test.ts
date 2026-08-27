/**
 * La huella de la documentación: el reloj de "ya busqué esto y no estaba".
 *
 * De esta función depende plata. Si la huella se moviera sola, cada
 * `procesarDocumento` volvería a pagarle al modelo hasta ocho llamadas por una
 * consulta que la documentación no puede responder; si no se moviera nunca, el
 * dato que llega en la lámina nueva no se buscaría jamás.
 *
 * Se pinnea acá, aparte del flujo (`tests/integration/busqueda.test.ts`), porque
 * es puro: son cuatro campos, un orden y un framing. El framing importa tanto
 * como los campos — ver el último caso.
 */
import { describe, expect, it } from 'vitest';

import { huellaDocumentacion } from '@/lib/pipeline/busqueda';

const A01 = '11111111-1111-4111-8111-111111111111';
const A02 = '22222222-2222-4222-8222-222222222222';

function lamina(id: string, texto: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    tipo: 'planta' as const,
    estadoAnalisis: 'analizada',
    textoExtraido: texto,
    ...extra,
  };
}

describe('huellaDocumentacion', () => {
  it('la misma documentación da la misma huella, venga en el orden que venga', () => {
    const una = huellaDocumentacion([lamina(A01, 'PLANTA PB'), lamina(A02, 'CORTE A-A')]);
    const otra = huellaDocumentacion([lamina(A02, 'CORTE A-A'), lamina(A01, 'PLANTA PB')]);

    expect(una).toBe(otra);
    expect(una).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un texto distinto la mueve, aunque mida lo mismo', () => {
    // Una revisión que reemplaza una cota por otra deja el largo igual: por eso
    // entra el texto completo y no su largo.
    expect(huellaDocumentacion([lamina(A01, '2,40')])).not.toBe(
      huellaDocumentacion([lamina(A01, '2,60')]),
    );
  });

  it('una lámina nueva la mueve', () => {
    expect(huellaDocumentacion([lamina(A01, 'PLANTA PB')])).not.toBe(
      huellaDocumentacion([lamina(A01, 'PLANTA PB'), lamina(A02, 'PLANILLA')]),
    );
  });

  it('la lámina que pasa de bloqueada a analizada la mueve', () => {
    // Recién ahora es candidata a releerse: el dato puede estar ahí.
    expect(
      huellaDocumentacion([lamina(A01, 'PLANTA PB', { estadoAnalisis: 'bloqueada_escala' })]),
    ).not.toBe(huellaDocumentacion([lamina(A01, 'PLANTA PB')]));
  });

  it('reclasificar la lámina la mueve', () => {
    expect(huellaDocumentacion([lamina(A01, 'x', { tipo: 'planilla' })])).not.toBe(
      huellaDocumentacion([lamina(A01, 'x')]),
    );
  });

  it('el texto de una lámina no puede hacerse pasar por otra lámina', () => {
    // El texto extraído de un PDF es libre: puede traer comillas, saltos de
    // línea, `|`, `::` o lo que sea. Ninguna de esas cosas puede fusionar dos
    // filas en la huella de otra documentación — por eso las filas se
    // serializan en vez de concatenarse con un separador.
    const dos = huellaDocumentacion([lamina(A01, 'uno'), lamina(A02, 'dos')]);
    const disfrazada = huellaDocumentacion([
      lamina(A01, `uno"::|\n${A02}|planta|analizada|dos`),
    ]);

    expect(disfrazada).not.toBe(dos);
  });

  it('sin láminas es una huella válida, no una excepción', () => {
    expect(huellaDocumentacion([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
