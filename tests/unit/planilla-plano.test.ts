/**
 * Qué plano deja abierto la planilla después de que la grilla cambia.
 *
 * La planilla es split view desde este arreglo: la grilla a la izquierda y el
 * `PanelVisor` a la derecha, igual que las dos solapas de la bandeja. Era el
 * pedido explícito del arquitecto —«que se vea la lista y al clickear se
 * resalte en el plano, todo en la misma página, sin ir de link en link»— y la
 * planilla, que es LA pantalla de la lista, era la única que seguía navegando.
 *
 * Con el split view viene el mismo problema que la bandeja resolvió con
 * `miradaVigente`: anular un ítem, cambiar de rubro o filtrar por origen
 * revalida la pantalla, la fila desaparece de la grilla y el panel se quedaba
 * mostrando «A-04 · Placa de roca de yeso» de un ítem que ya no está a la
 * vista. `miradaVigente` es puro y vive en `planilla-rubro.tsx`, que es un
 * `'use client'`: acá se prueba sin render, que es donde está la lógica.
 */
import { describe, expect, it } from 'vitest';

import type { ItemPlanilla } from '@/components/planilla/fila-item';
import { miradaVigente, type MiradaEnPlanilla } from '@/components/planilla/planilla-rubro';
import type { BBox } from '@/types/domain';

const A04 = '11111111-1111-4111-8111-111111111111';
const ZONA: BBox = [0.1, 0.2, 0.3, 0.1];

const PLACAS = '22222222-2222-4222-8222-222222222222';
const PERFILES = '33333333-3333-4333-8333-333333333333';

function item(id: string): ItemPlanilla {
  return {
    id,
    claveItem: 'seco.placas',
    descripcion: 'Placa de roca de yeso 12,5 mm',
    unidad: 'm2',
    cantNeta: 24,
    desperdicioPct: 10,
    cantCompra: 27,
    presentacion: '10 placas de 1,20 × 2,40 m',
    origen: 'explicito',
    confianza: 0.9,
    anulado: false,
    editado: false,
    laminas: [{ laminaId: A04, etiqueta: 'A-04' }],
    fuentes: [{ laminaId: A04, bbox: ZONA }],
    escalaAsumida: null,
    precio: null,
    precioEditable: '',
    origenDetalle: null,
  };
}

const MIRADA: MiradaEnPlanilla = {
  itemId: PLACAS,
  laminaId: A04,
  destacados: [ZONA],
  etiqueta: 'A-04 · Placa de roca de yeso 12,5 mm',
};

describe('miradaVigente: el ítem del panel sigue en la grilla', () => {
  it('el ítem que sigue a la vista mantiene el panel, con la MISMA referencia', () => {
    // La referencia estable es lo que `Overlay` necesita: scrollea en un
    // `useEffect([destacados])` y un objeto nuevo por render scrollearía de más.
    expect(miradaVigente(MIRADA, [item(PLACAS)])).toBe(MIRADA);
  });

  it('el ítem que se fue de la grilla cierra el panel', () => {
    expect(miradaVigente(MIRADA, [item(PERFILES)])).toBeNull();
    expect(miradaVigente(MIRADA, [])).toBeNull();
  });

  it('sin nada elegido no hay panel que mantener', () => {
    expect(miradaVigente(null, [item(PLACAS)])).toBeNull();
  });
});
