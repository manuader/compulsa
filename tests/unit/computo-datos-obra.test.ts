/**
 * El camino completo del dato de obra: `computarObraConPlantillas(..., datosObra)`.
 *
 * La cadena de respaldo (§5.2) está probada plantilla por plantilla
 * (`rubro-seco.test.ts`), pero eso no alcanza: el **origen del ítem** lo decide
 * el engine, y hasta esta tarea el único insumo de esa decisión eran las
 * deducciones validadas. Un `alturaM` que puso un dato de obra deducido tiene
 * que dejar el ítem `deducido` atravesando el motor entero, no solo la plantilla.
 *
 * La pasada de control es la que lo prueba: se vuelve a computar **sin los datos
 * de obra de ese origen** y se compara. Un ítem que sin el dato no existiría
 * depende del dato, y se marca.
 *
 * Dominio puro: sin base, sin fixtures.
 */
import { describe, expect, it } from 'vitest';

import { computarObra, type EntidadPersistida } from '@/lib/computo/engine';
import type { DatoObraResuelto, Fuente, ItemComputo, Origen } from '@/types/domain';

const LAMINA_PLANTA = 'lam-planta';

/** La altura que el corte declara para todo el local. */
const FUENTE_CORTE: Fuente = { laminaId: 'lam-corte', bbox: [0.2, 0.3, 0.5, 0.4], detalle: 'Corte A-A' };

function tabique(id: string, nombre: string): EntidadPersistida {
  return {
    id,
    laminaId: LAMINA_PLANTA,
    tipo: 'tabique',
    nombre,
    bbox: [0.1, 0.1, 0.3, 0.02],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: { largoM: 3, caras: 2, tipo: 'durlock' },
  };
}

/** Cuatro tabiques de 3 m del mismo local, sin altura acotada en la planta. */
function cuatroSinAltura(): EntidadPersistida[] {
  return ['T1', 'T2', 'T3', 'T4'].map((nombre, i) => tabique(`t${i + 1}`, nombre));
}

function alturaDeLocal(origen: Origen): Map<string, DatoObraResuelto> {
  return new Map([
    [
      'altura_local.general',
      {
        clave: 'altura_local.general',
        valor: 2.6,
        unidad: 'm' as const,
        origen,
        fuentes: [FUENTE_CORTE],
        confianza: 0.9,
      },
    ],
  ]);
}

function porClave(items: readonly ItemComputo[], clave: string): ItemComputo | undefined {
  return items.find((item) => item.claveItem === clave);
}

function computar(datos?: Map<string, DatoObraResuelto>) {
  return computarObra(cuatroSinAltura(), 'nueva', undefined, undefined, undefined, datos);
}

describe('computarObra con datos de obra', () => {
  it('sin datos de obra no hay cómputo de seco: hay UNA consulta', () => {
    const { items, hallazgos } = computar();

    expect(items).toEqual([]);
    expect(hallazgos.filter((h) => h.clave.startsWith('dato_obra.'))).toHaveLength(1);
  });

  it('el dato deducido computa los cuatro tabiques y deja el ítem `deducido`', () => {
    const { items, hallazgos } = computar(alturaDeLocal('deducido'));

    const placas = porClave(items, 'seco.placas');
    // 4 tabiques × 3 m × 2,60 m × 2 caras = 62,4 m²
    expect(placas?.cantNeta).toBe(62.4);
    expect(placas?.origen).toBe('deducido');
    // P1: el ítem cita el corte del que salió la altura, además de los tabiques.
    expect(placas?.fuentes.at(-1)).toEqual(FUENTE_CORTE);
    expect(hallazgos.filter((h) => h.clave.startsWith('dato_obra.'))).toEqual([]);
  });

  it('un dato que cargó el usuario deja el ítem explícito: nada que advertir', () => {
    const { items } = computar(alturaDeLocal('explicito'));

    expect(porClave(items, 'seco.placas')?.origen).toBe('explicito');
    expect(porClave(items, 'seco.placas')?.cantNeta).toBe(62.4);
  });

  it('un dato medido sobre el dibujo deja el ítem `inferido`, que es más débil', () => {
    const { items } = computar(alturaDeLocal('inferido'));

    expect(porClave(items, 'seco.placas')?.origen).toBe('inferido');
  });

  it('los ítems que sin el dato no existirían también quedan marcados', () => {
    // Las soleras salen del largo y no citan el corte (no lo usan para su
    // número), pero sin la altura el tabique entero no se computa: sin el dato
    // este ítem no estaría. Decir que es explícito sería mentir sobre de qué
    // depende la planilla.
    const { items } = computar(alturaDeLocal('deducido'));

    expect(porClave(items, 'seco.soleras')?.cantNeta).toBe(24);
    expect(porClave(items, 'seco.soleras')?.origen).toBe('deducido');
  });

  it('un tabique con su altura acotada no se contagia del dato', () => {
    const propios = cuatroSinAltura().map((entidad) => ({
      ...entidad,
      atributos: { ...entidad.atributos, alturaM: 2.6 },
    }));

    const { items } = computarObra(
      propios,
      'nueva',
      undefined,
      undefined,
      undefined,
      alturaDeLocal('inferido'),
    );

    expect(porClave(items, 'seco.placas')?.cantNeta).toBe(62.4);
    expect(porClave(items, 'seco.placas')?.origen).toBe('explicito');
  });
});
