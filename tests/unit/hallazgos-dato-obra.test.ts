/**
 * Los dos ayudantes que las plantillas usan para hablar de **datos de obra**.
 *
 * `respaldoDeDatoObra` es el único lector válido del mapa: una plantilla no
 * toca la API de `Map` por su cuenta, igual que nadie lee `target_ref` sin
 * `camposDelTarget()`.
 *
 * `hallazgoDatoObraFaltante` es la deduplicación de preguntas hecha contrato: a
 * cuatro tabiques de PB les falta la misma altura y la bandeja recibe **una**
 * consulta, no cuatro. Por eso el hallazgo apunta a un `targetDato` (la clave
 * del dato + a quiénes afecta) y no a un `targetRef` de entidad.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import {
  etiquetaDeDatoObra,
  hallazgoDatoObraFaltante,
  PREFIJO_DATO_OBRA,
  respaldoDeDatoObra,
} from '@/lib/hallazgos/taxonomia';
import type { DatoObraResuelto } from '@/types/domain';

function tabique(id: string, nombre: string): EntidadPersistida {
  return {
    id,
    laminaId: 'lamina-pb',
    tipo: 'tabique',
    nombre,
    bbox: [0.1, 0.1, 0.2, 0.05],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: { largoM: 3, nivel: 'PB' },
  };
}

const ALTURA_PB: DatoObraResuelto = {
  clave: 'altura_local.PB',
  valor: 2.6,
  unidad: 'm',
  origen: 'explicito',
  fuentes: [{ laminaId: 'lamina-corte', bbox: [0.2, 0.3, 0.1, 0.4] }],
  confianza: 1,
};

describe('respaldoDeDatoObra', () => {
  it('devuelve el dato resuelto cuando la clave está', () => {
    const mapa = new Map([['altura_local.PB', ALTURA_PB]]);
    expect(respaldoDeDatoObra(mapa, 'altura_local.PB')).toEqual(ALTURA_PB);
  });

  it('devuelve null cuando la clave no está', () => {
    const mapa = new Map([['altura_local.PB', ALTURA_PB]]);
    expect(respaldoDeDatoObra(mapa, 'altura_local.P1')).toBeNull();
  });

  it('devuelve null sin mapa: una plantilla llamada sin datos de obra no rompe', () => {
    expect(respaldoDeDatoObra(undefined, 'altura_local.PB')).toBeNull();
  });
});

describe('hallazgoDatoObraFaltante', () => {
  const cuatro = [
    tabique('id-1', 'T1'),
    tabique('id-2', 'T2'),
    tabique('id-3', 'T3'),
    tabique('id-4', 'T4'),
  ];

  const hallazgo = hallazgoDatoObraFaltante({
    rubro: 'seco',
    claveDato: 'altura_local.PB',
    unidad: 'm',
    descripcion: 'No encontré la altura de local de planta baja.',
    entidades: cuatro,
  });

  it('es UNO solo para las cuatro entidades, y no bloquea', () => {
    expect(hallazgo.clave).toBe('dato_obra.altura_local.PB');
    expect(hallazgo.clave.startsWith(PREFIJO_DATO_OBRA)).toBe(true);
    expect(hallazgo.tipo).toBe('faltante');
    expect(hallazgo.rubro).toBe('seco');
    // No bloquea: el dato falta para toda la obra, y frenar la aprobación del
    // rubro por un hecho global es distinto de frenarla por una entidad rota.
    expect(hallazgo.bloqueante).toBe(false);
  });

  it('apunta al dato de obra, no a una entidad', () => {
    expect(hallazgo.targetDato).toEqual({
      clave: 'altura_local.PB',
      unidad: 'm',
      entidades: ['id-1', 'id-2', 'id-3', 'id-4'],
    });
    expect(hallazgo.targetRef).toBeUndefined();
    // Un dato de obra que falta no se leyó en ninguna lámina: no hay bbox que
    // citar, y citar uno cualquiera sería provenance inventada.
    expect(hallazgo.fuentes).toEqual([]);
  });

  it('la descripción enumera a los afectados en es-AR', () => {
    expect(hallazgo.descripcion).toBe(
      'No encontré la altura de local de planta baja. Afecta a T1, T2, T3 y T4.',
    );
  });

  it('con una sola entidad afectada, la enumeración no inventa comas', () => {
    const uno = hallazgoDatoObraFaltante({
      rubro: 'gruesa',
      claveDato: 'altura_local.P1',
      unidad: 'm',
      descripcion: 'No encontré la altura de local del primer piso.',
      entidades: [tabique('id-9', 'M7')],
    });
    expect(uno.descripcion).toBe(
      'No encontré la altura de local del primer piso. Afecta a M7.',
    );
    expect(uno.targetDato?.entidades).toEqual(['id-9']);
  });

  it('sin unidad, el target no la inventa', () => {
    const sinUnidad = hallazgoDatoObraFaltante({
      rubro: null,
      claveDato: 'nivel.PB',
      descripcion: 'No encontré el nivel de planta baja.',
      entidades: [tabique('id-1', 'T1')],
    });
    expect(sinUnidad.targetDato).toEqual({ clave: 'nivel.PB', entidades: ['id-1'] });
  });
});

/**
 * El nombre del dato en la tarjeta. La clave es nuestra convención, no el
 * castellano de nadie: un input que dice `altura_local.PB` es un identificador
 * de base de datos puesto adelante de una persona.
 */
describe('etiquetaDeDatoObra', () => {
  it('nombra la familia y el sufijo', () => {
    expect(etiquetaDeDatoObra('altura_local.PB')).toBe('Altura de local en PB');
    expect(etiquetaDeDatoObra('altura_revestimiento.baño')).toBe(
      'Altura de revestimiento en baño',
    );
    expect(etiquetaDeDatoObra('nivel.PA')).toBe('Nivel en PA');
  });

  it('`general` no se nombra: es el hecho que vale para toda la obra', () => {
    expect(etiquetaDeDatoObra('altura_local.general')).toBe('Altura de local');
    expect(etiquetaDeDatoObra('altura_revestimiento.general')).toBe('Altura de revestimiento');
  });

  it('una familia desconocida se muestra igual, con los guiones abiertos', () => {
    expect(etiquetaDeDatoObra('espesor_carpeta.PB')).toBe('Espesor carpeta en PB');
    expect(etiquetaDeDatoObra('solado')).toBe('Solado');
  });
});
