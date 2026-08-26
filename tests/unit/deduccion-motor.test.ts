/**
 * El motor: lo que ninguna regla individual puede saltear.
 *
 * Prioridad entre reglas (una entidad + campo recibe a lo sumo UNA propuesta),
 * mínimo de dos fuentes documentales, umbral de confianza 0,7 y lista blanca de
 * campos (RF-506).
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { redondear2 } from '@/lib/computo/unidades';
import {
  CAMPOS_DEDUCIBLES,
  deducir,
  FACTOR_POR_REGLA,
  MINIMO_FUENTES,
  PRIORIDAD_REGLAS,
  UMBRAL_DEDUCCION,
  type LaminaResumen,
} from '@/lib/deduccion/motor';
import { REGLAS_DEDUCCION } from '@/types/domain';

const LAMINAS: LaminaResumen[] = [
  { id: 'L-pb', tipo: 'planta', codigo: 'A-01' },
  { id: 'L-pa', tipo: 'planta', codigo: 'A-02' },
  { id: 'L-corte', tipo: 'corte', codigo: 'A-03' },
  { id: 'L-planilla', tipo: 'planilla', codigo: 'A-05' },
];

function entidad(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L-pb',
    tipo: 'abertura',
    nombre: 'V2a',
    bbox: [0.1, 0.1, 0.05, 0.05],
    confianza: 0.96,
    estadoReforma: 'na',
    atributos: { tag: 'V2a', tipologia: 'ventana' },
    ...over,
  };
}

describe('motor de deducción · parámetros pinneados', () => {
  it('los factores por regla son los del contrato', () => {
    expect(FACTOR_POR_REGLA).toEqual({
      planilla_plano: 0.95,
      planta_corte: 0.9,
      continuidad: 0.85,
      idem_tipologia: 0.75,
      cierre_cotas: 0.9,
    });
    expect(UMBRAL_DEDUCCION).toBe(0.7);
    expect(MINIMO_FUENTES).toBe(2);
  });

  it('la prioridad cubre las cinco reglas, sin sobras ni faltantes', () => {
    expect([...PRIORIDAD_REGLAS]).toEqual([
      'planilla_plano',
      'planta_corte',
      'continuidad',
      'idem_tipologia',
      'cierre_cotas',
    ]);
    expect([...PRIORIDAD_REGLAS].sort()).toEqual([...REGLAS_DEDUCCION].sort());
  });

  it('la lista blanca de campos es exactamente la del contrato (RF-506)', () => {
    expect([...CAMPOS_DEDUCIBLES]).toEqual([
      'anchoM',
      'altoM',
      'alturaM',
      'largoM',
      'superficieM2',
      'perimetroM',
      'vanosM2',
      'caras',
    ]);
  });

  it('una obra sin entidades no deduce nada', () => {
    expect(deducir([], LAMINAS)).toEqual({ propuestas: [], inconsistencias: [] });
  });
});

describe('motor de deducción · una entidad + campo, una sola propuesta', () => {
  /** V2a sin acotar, con tres reglas distintas listas para completarle el ancho. */
  const v2aSinAncho = entidad({ id: 'v2a' });

  const v2aEnPlanilla = entidad({
    id: 'v2a-planilla',
    laminaId: 'L-planilla',
    bbox: [0.4, 0.3, 0.2, 0.04],
    atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 0.8 },
  });

  const v2aEnPa = entidad({
    id: 'v2a-pa',
    laminaId: 'L-pa',
    bbox: [0.1, 0.6, 0.05, 0.05],
    atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 1 },
  });

  const v2Acotada = entidad({
    id: 'v2',
    nombre: 'V2',
    bbox: [0.7, 0.1, 0.05, 0.05],
    atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.5 },
  });

  it('gana la planilla, que es la fuente más directa', () => {
    const { propuestas } = deducir([v2aSinAncho, v2aEnPlanilla, v2aEnPa, v2Acotada], LAMINAS);

    const delAncho = propuestas.filter((p) => p.entidadId === 'v2a' && p.campo === 'anchoM');
    expect(delAncho).toHaveLength(1);
    expect(delAncho[0]!.regla).toBe('planilla_plano');
    expect(delAncho[0]!.valor).toBe(0.8);
  });

  it('sin planilla gana continuidad sobre ídem tipología', () => {
    const { propuestas } = deducir([v2aSinAncho, v2aEnPa, v2Acotada], LAMINAS);

    const delAncho = propuestas.filter((p) => p.entidadId === 'v2a' && p.campo === 'anchoM');
    expect(delAncho).toHaveLength(1);
    expect(delAncho[0]!.regla).toBe('continuidad');
    expect(delAncho[0]!.valor).toBe(1);
  });

  it('sin nada más queda ídem tipología, la más floja', () => {
    const { propuestas } = deducir([v2aSinAncho, v2Acotada], LAMINAS);

    expect(propuestas.map((p) => [p.regla, p.valor])).toEqual([['idem_tipologia', 1.5]]);
  });

  it('planta ↔ corte le gana a continuidad', () => {
    const enPb = entidad({ id: 'estar-pb', tipo: 'ambiente', nombre: 'Estar', atributos: {} });
    const enCorte = entidad({
      id: 'estar-corte',
      tipo: 'ambiente',
      nombre: 'Estar',
      laminaId: 'L-corte',
      bbox: [0.3, 0.4, 0.25, 0.2],
      atributos: { alturaM: 2.6 },
    });
    const enPa = entidad({
      id: 'estar-pa',
      tipo: 'ambiente',
      nombre: 'Estar',
      laminaId: 'L-pa',
      bbox: [0.3, 0.7, 0.25, 0.2],
      atributos: { alturaM: 2.6 },
    });

    const { propuestas } = deducir([enPb, enCorte, enPa], LAMINAS);

    const altura = propuestas.filter((p) => p.entidadId === 'estar-pb');
    expect(altura.map((p) => p.regla)).toEqual(['planta_corte']);
  });
});

describe('motor de deducción · las tres reglas de oro', () => {
  it('≥ 2 fuentes: dos lecturas de la misma lámina y la misma caja son una sola fuente', () => {
    // Mismo laminaId y mismo bbox ⇒ `fuentesDeEntidades` las colapsa: la
    // deducción se quedaría apoyada en un único lugar del expediente.
    const v2a = entidad({ id: 'v2a' });
    const v2 = entidad({ id: 'v2', nombre: 'V2', atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.5 } });

    expect(v2a.bbox).toEqual(v2.bbox);
    expect(deducir([v2a, v2], LAMINAS).propuestas).toEqual([]);
  });

  it('confianza < 0,7: la propuesta no sale y tampoco genera inconsistencia', () => {
    const dudosa = entidad({ id: 'v2a', confianza: 0.6 });
    const enPlanilla = entidad({
      id: 'v2a-planilla',
      laminaId: 'L-planilla',
      bbox: [0.4, 0.3, 0.2, 0.04],
      confianza: 1,
      atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 0.8 },
    });

    // 0,95 × 0,6 = 0,57
    expect(deducir([dudosa, enPlanilla], LAMINAS)).toEqual({ propuestas: [], inconsistencias: [] });
  });

  it('el gate mira el número crudo: 0,69825 no pasa aunque redondee a 0,70', () => {
    // El redondeo es de presentación y no puede correr la línea que decide si
    // el sistema propone algo o lo manda a la bandeja (P4). Con el gate del
    // lado equivocado, esta deducción salía con «confianza 0,70» en pantalla.
    const casi = (confianzaDudosa: number) => {
      const dudosa = entidad({ id: 'v2a', confianza: confianzaDudosa });
      const enPlanilla = entidad({
        id: 'v2a-planilla',
        laminaId: 'L-planilla',
        bbox: [0.4, 0.3, 0.2, 0.04],
        confianza: 1,
        atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 0.8 },
      });
      return deducir([dudosa, enPlanilla], LAMINAS).propuestas;
    };

    // 0,95 × 0,735 = 0,69825, que redondeado a dos decimales da exactamente el
    // umbral. Crudo está por debajo, así que no sale.
    expect(redondear2(0.95 * 0.735)).toBe(UMBRAL_DEDUCCION);
    expect(casi(0.735)).toEqual([]);

    // Un pelo más arriba —0,95 × 0,74 = 0,703— sí llega, y se muestra con el
    // mismo 0,70: el número en pantalla es el mismo, la decisión no.
    const [propuesta] = casi(0.74);
    expect(propuesta.campo).toBe('anchoM');
    expect(propuesta.confianza).toBe(0.7);
  });

  it('RF-506: ningún campo fuera de la lista blanca se propone', () => {
    const sinDatos = entidad({ id: 't1', tipo: 'tabique', nombre: 'T1', atributos: {} });
    const conEstructura = entidad({
      id: 't1-pa',
      tipo: 'tabique',
      nombre: 'T1',
      laminaId: 'L-pa',
      bbox: [0.1, 0.6, 0.3, 0.05],
      atributos: {
        largoM: 4.2,
        cargaKg: 850, // estructural: consultá al profesional competente
        seccionViga: '20x40',
        espesorLosaM: 0.12,
      },
    });

    const { propuestas } = deducir([sinDatos, conEstructura], LAMINAS);

    expect(propuestas.map((p) => p.campo)).toEqual(['largoM']);
  });

  it('RF-506: `valorM` solo se propone sobre una cota, nunca sobre un muro', () => {
    const muroSinNada = entidad({ id: 'm1', tipo: 'muro', nombre: 'M1', atributos: {} });
    const muroConValor = entidad({
      id: 'm1-pa',
      tipo: 'muro',
      nombre: 'M1',
      laminaId: 'L-pa',
      bbox: [0.1, 0.6, 0.3, 0.05],
      atributos: { valorM: 5 },
    });

    expect(deducir([muroSinNada, muroConValor], LAMINAS).propuestas).toEqual([]);
  });
});

describe('motor de deducción · determinismo', () => {
  it('la misma obra da exactamente el mismo resultado', () => {
    const entidades = [
      entidad({ id: 'v2a' }),
      entidad({
        id: 'v2a-planilla',
        laminaId: 'L-planilla',
        bbox: [0.4, 0.3, 0.2, 0.04],
        atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 0.8, altoM: 1.1 },
      }),
      entidad({ id: 'estar-pb', tipo: 'ambiente', nombre: 'Estar', bbox: [0.2, 0.2, 0.3, 0.25], atributos: {} }),
      entidad({
        id: 'estar-corte',
        tipo: 'ambiente',
        nombre: 'Estar',
        laminaId: 'L-corte',
        bbox: [0.3, 0.4, 0.25, 0.2],
        atributos: { alturaM: 2.6 },
      }),
      entidad({
        id: 'cota-total',
        tipo: 'cota',
        nombre: 'Cota total',
        bbox: [0.1, 0.9, 0.3, 0.02],
        atributos: { sobre: 'muro M1', tramo: 'total', valorM: 5 },
      }),
      entidad({
        id: 'cota-t1',
        tipo: 'cota',
        nombre: 'Cota T1',
        bbox: [0.1, 0.94, 0.15, 0.02],
        atributos: { sobre: 'muro M1', tramo: 'T1', valorM: 3.5 },
      }),
      entidad({
        id: 'cota-t2',
        tipo: 'cota',
        nombre: 'Cota T2',
        bbox: [0.3, 0.94, 0.15, 0.02],
        atributos: { sobre: 'muro M1', tramo: 'T2' },
      }),
    ];

    const primera = deducir(entidades, LAMINAS);
    const segunda = deducir(entidades, LAMINAS);

    expect(segunda).toEqual(primera);
    expect(primera.propuestas.map((p) => [p.entidadId, p.campo, p.regla, p.valor])).toEqual([
      ['v2a', 'anchoM', 'planilla_plano', 0.8],
      ['v2a', 'altoM', 'planilla_plano', 1.1],
      ['estar-pb', 'alturaM', 'planta_corte', 2.6],
      ['cota-t2', 'valorM', 'cierre_cotas', 1.5],
    ]);
    expect(primera.inconsistencias).toEqual([]);
  });

  it('una lámina que el llamador no declaró no rompe nada: la explicación dice "sin código"', () => {
    const v2a = entidad({ id: 'v2a', laminaId: 'L-fantasma' });
    const v2aEnPlanilla = entidad({
      id: 'v2a-planilla',
      laminaId: 'L-planilla',
      bbox: [0.4, 0.3, 0.2, 0.04],
      atributos: { tag: 'V2a', tipologia: 'ventana', anchoM: 0.8 },
    });

    const { propuestas } = deducir([v2a, v2aEnPlanilla], LAMINAS);

    expect(propuestas).toHaveLength(1);
    expect(propuestas[0]!.explicacion).toBe(
      'El ancho 0,80 m de V2a sale de la planilla de carpinterías (lámina A-05); ' +
        'en el plano (lámina sin código) la abertura está sin acotar.',
    );
  });
});
