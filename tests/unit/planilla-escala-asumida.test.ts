/**
 * Qué ítem de la planilla se computó sobre una escala que nadie verificó.
 *
 * Desde la decisión 1 del plan, una lámina con escala declarada pero sin
 * verificar **se computa igual**. El aviso quedó viviendo solo en la bandeja,
 * en otra pantalla: la planilla mostraba esos números como cualquier otro. El
 * cruce que los distingue no necesita ninguna columna nueva —sale de las
 * `fuentes_json` del ítem contra el `escala_confiable` de sus láminas— y es
 * puro, así que se pinnea acá y no en un render.
 */
import { describe, expect, it } from 'vitest';

import {
  escalaAsumidaDelItem,
  textoEscalaAsumida,
  type LaminaDeFuente,
} from '@/components/planilla/escala-asumida';
import type { BBox, Fuente } from '@/types/domain';

const A01 = '11111111-1111-4111-8111-111111111111';
const A04 = '44444444-4444-4444-8444-444444444444';
const DET00 = '55555555-5555-4555-8555-555555555555';
const BORRADA = '99999999-9999-4999-8999-999999999999';

const ZONA: BBox = [0.1, 0.2, 0.3, 0.1];

function fuente(laminaId: string): Fuente {
  return { laminaId, bbox: ZONA };
}

/**
 * A-01 verificada contra cotas; A-04 declara 1:20 y nadie la verificó; DET00 es
 * la planilla de carpinterías, que no declara escala y no la necesita.
 */
const LAMINAS = new Map<string, LaminaDeFuente>([
  [A01, { laminaId: A01, etiqueta: 'A-01', escala: '1:100', escalaConfiable: true, tipo: 'planta' }],
  [A04, { laminaId: A04, etiqueta: 'A-04', escala: '1:20', escalaConfiable: false, tipo: 'planta' }],
  [
    DET00,
    { laminaId: DET00, etiqueta: 'DET00', escala: null, escalaConfiable: false, tipo: 'planilla' },
  ],
]);

describe('escalaAsumidaDelItem', () => {
  it('marca el ítem que tiene una fuente en una lámina de escala asumida', () => {
    expect(escalaAsumidaDelItem([fuente(A04)], LAMINAS)).toEqual({
      laminaId: A04,
      etiqueta: 'A-04',
      escala: '1:20',
    });
  });

  it('no marca el ítem cuyas fuentes están todas verificadas', () => {
    expect(escalaAsumidaDelItem([fuente(A01), fuente(A01)], LAMINAS)).toBeNull();
  });

  it('no marca el ítem sin fuentes: cargado a mano no se computó sobre ninguna escala', () => {
    expect(escalaAsumidaDelItem([], LAMINAS)).toBeNull();
  });

  it('alcanza con una sola fuente asumida entre varias verificadas', () => {
    // El ítem se computa con las dos láminas: si una escala está asumida, el
    // número que sale de ahí también lo está.
    expect(escalaAsumidaDelItem([fuente(A01), fuente(A04)], LAMINAS)?.etiqueta).toBe('A-04');
  });

  it('no marca el ítem que sale de una planilla: sus medidas están escritas, no medidas', () => {
    // Una planilla de carpinterías casi nunca declara escala y desde el arreglo
    // de la revisión final se analiza igual. Avisar que ese número "se computó
    // sin una escala verificada" sería mentir sobre el dato más confiable que
    // tiene la obra.
    expect(escalaAsumidaDelItem([fuente(DET00)], LAMINAS)).toBeNull();
  });

  it('la planilla no tapa el plano sin verificar que también respalda al ítem', () => {
    // La deducción planilla↔plano deja ítems con las dos fuentes: la planilla
    // no aplica, pero el plano sí, y el aviso tiene que salir por el plano.
    expect(escalaAsumidaDelItem([fuente(DET00), fuente(A04)], LAMINAS)?.etiqueta).toBe('A-04');
  });

  it('ignora la fuente que apunta a una lámina que ya no está en la obra', () => {
    expect(escalaAsumidaDelItem([fuente(BORRADA)], LAMINAS)).toBeNull();
  });

  it('también marca la lámina sin ninguna escala declarada', () => {
    // No debería tener ítems —el pipeline la bloquea y le saca las entidades—,
    // pero uno colgado de una corrida vieja tiene que decirlo igual.
    const sinEscala = new Map<string, LaminaDeFuente>([
      [A04, { laminaId: A04, etiqueta: 'A-04', escala: null, escalaConfiable: false, tipo: 'corte' }],
    ]);
    expect(escalaAsumidaDelItem([fuente(A04)], sinEscala)?.escala).toBeNull();
  });
});

describe('textoEscalaAsumida', () => {
  it('nombra la lámina, la escala asumida y qué hacer con eso', () => {
    expect(textoEscalaAsumida({ laminaId: A04, etiqueta: 'A-04', escala: '1:20' })).toBe(
      'A-04: se computó asumiendo 1:20, sin verificar contra cotas. Confirmala o corregila en la lámina.',
    );
  });

  it('sin escala declarada no dice una que no leyó', () => {
    expect(textoEscalaAsumida({ laminaId: A04, etiqueta: 'A-04', escala: null })).toBe(
      'A-04: se computó sin una escala verificada. Confirmala o corregila en la lámina.',
    );
  });
});
