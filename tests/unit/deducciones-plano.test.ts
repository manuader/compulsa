/**
 * Qué plano deja abierto la bandeja de deducciones después de decidir.
 *
 * La pantalla de deducciones es split view igual que la bandeja de consultas:
 * lista a la izquierda, `PanelVisor` a la derecha. Y tiene el mismo problema
 * que la bandeja resolvió con `miradaVigente`: validar o rechazar revalida la
 * pantalla, la propuesta desaparece de la lista y el panel se quedaba con el
 * plano y la etiqueta —«A-01 · PLANTA REFORMA · alto = 1,00 m»— de una
 * deducción que ya no existe. Mostrar el fantasma de una decisión ya tomada es
 * peor que no mostrar nada: invita a validar dos veces lo mismo.
 *
 * `seleccionVigente` es puro y vive en el `ui.tsx` de deducciones, que es un
 * `'use client'`: acá se testea sin render, que es donde está la lógica.
 */
import { describe, expect, it } from 'vitest';

import {
  seleccionVigente,
  type DeduccionVista,
  type GrupoElemento,
  type Seleccion,
} from '@/app/obras/[obraId]/deducciones/ui';
import type { BBox } from '@/types/domain';

const A01 = '11111111-1111-4111-8111-111111111111';
const A05 = '22222222-2222-4222-8222-222222222222';

const HUECO: BBox = [0.1, 0.2, 0.05, 0.1];

const ALTO_V5 = '33333333-3333-4333-8333-333333333333';
const ANCHO_V5 = '44444444-4444-4444-8444-444444444444';

/** Una propuesta del motor con lo mínimo, y lo que el test necesite encima. */
function deduccion(id: string, extra: Partial<DeduccionVista> = {}): DeduccionVista {
  return {
    id,
    campo: 'altoM',
    etiqueta: 'alto',
    valor: '1,00 m',
    regla: 'planilla_plano',
    tituloRegla: 'Planilla ↔ plano',
    explicacion: 'El alto 1,00 m de V5 sale de cruzar A-01 y A-05.',
    confianza: 0.86,
    laminas: [
      { laminaId: A01, etiqueta: 'A-01 · PLANTA REFORMA' },
      { laminaId: A05, etiqueta: 'A-05 · PLANILLA DE CARPINTERÍAS' },
    ],
    fuentes: [{ laminaId: A01, bbox: HUECO }],
    ...extra,
  };
}

/** Un grupo «Abertura V5» con las deducciones que se le pasen. */
function grupos(deducciones: DeduccionVista[]): GrupoElemento[] {
  return [
    {
      clave: 'abertura:V5',
      titulo: 'Abertura V5',
      vistas: [
        {
          entidadId: '55555555-5555-4555-8555-555555555555',
          laminaId: A01,
          lamina: 'A-01 · PLANTA REFORMA',
          deducciones,
        },
      ],
    },
  ];
}

const SELECCION: Seleccion = {
  deduccionId: ALTO_V5,
  laminaId: A01,
  destacados: [HUECO],
  etiqueta: 'A-01 · PLANTA REFORMA · alto = 1,00 m',
};

describe('seleccionVigente: la deducción del panel sigue en la lista', () => {
  it('la deducción que sigue en la lista mantiene el panel, con la MISMA referencia', () => {
    const vigente = seleccionVigente(SELECCION, grupos([deduccion(ALTO_V5)]));
    expect(vigente).toBe(SELECCION); // la referencia estable que `Overlay` necesita
  });

  it('la deducción ya validada cierra el panel', () => {
    // Queda la hermana (el ancho): la lista no está vacía, así que el split
    // view sigue en pantalla y el panel es lo único que tiene que vaciarse.
    expect(seleccionVigente(SELECCION, grupos([deduccion(ANCHO_V5)]))).toBeNull();
    expect(seleccionVigente(SELECCION, [])).toBeNull();
  });

  it('sin nada elegido no hay panel que mantener', () => {
    expect(seleccionVigente(null, grupos([deduccion(ALTO_V5)]))).toBeNull();
  });

  it('la busca en todas las vistas de todos los grupos, no solo en la primera', () => {
    const otros: GrupoElemento[] = [
      { clave: 'tabique:T1', titulo: 'Tabique T1', vistas: [] },
      ...grupos([deduccion(ANCHO_V5), deduccion(ALTO_V5)]),
    ];
    expect(seleccionVigente(SELECCION, otros)).toBe(SELECCION);
  });
});
