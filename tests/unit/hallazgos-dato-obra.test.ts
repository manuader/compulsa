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
  datoEnFrase,
  esDatoObraFaltante,
  etiquetaDeDatoObra,
  fusionarDatoObraFaltante,
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
    bloqueante: true,
  });

  it('es UNO solo para las cuatro entidades', () => {
    expect(hallazgo.clave).toBe('dato_obra.altura_local.PB');
    expect(hallazgo.clave.startsWith(PREFIJO_DATO_OBRA)).toBe(true);
    expect(hallazgo.tipo).toBe('faltante');
    expect(hallazgo.rubro).toBe('seco');
  });

  /**
   * El bloqueo lo decide **quien computa**, no el constructor: el rubro que
   * emitió ítems sin estas entidades está mandando a compulsa un número corto,
   * y aprobarlo es comprar de menos. El rubro que no computó nada no tiene
   * ningún ítem corto que frenar (lo que impide aprobarlo es no tener ítems).
   */
  it('bloquea o no según se lo pidan: el que dejó ítems cortos, sí', () => {
    expect(hallazgo.bloqueante).toBe(true);

    const sinItems = hallazgoDatoObraFaltante({
      rubro: 'seco',
      claveDato: 'altura_local.PB',
      unidad: 'm',
      descripcion: 'No encontré la altura de local de planta baja.',
      entidades: cuatro,
      bloqueante: false,
    });
    expect(sinItems.bloqueante).toBe(false);
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
      bloqueante: true,
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
      bloqueante: false,
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

/**
 * El mismo hecho lo pide más de un rubro: a `altura_local.PB` la abren seco
 * (por los tabiques), gruesa (por el muro) y pintura (por los ambientes). Una
 * consulta sola es lo correcto —el arquitecto contesta una vez y se computa
 * todo—, pero quedarse con **la primera** hace que la tarjeta prometa menos de
 * lo que hace: dice «Afecta a T1 y T2» y responderla también computa el muro.
 *
 * `fusionarDatoObraFaltante` es lo que el conciliador de hallazgos tiene que
 * llamar en vez de descartar la segunda.
 */
describe('fusionarDatoObraFaltante', () => {
  const deSeco = hallazgoDatoObraFaltante({
    rubro: 'seco',
    claveDato: 'altura_local.PB',
    unidad: 'm',
    descripcion: 'No encontré la altura de estos tabiques.',
    entidades: [tabique('t1', 'T1'), tabique('t2', 'T2')],
    bloqueante: true,
  });
  const deGruesa = hallazgoDatoObraFaltante({
    rubro: 'gruesa',
    claveDato: 'altura_local.PB',
    unidad: 'm',
    descripcion: 'No encontré la altura de estos muros.',
    entidades: [tabique('m1', 'M1'), tabique('t2', 'T2')],
    bloqueante: false,
  });

  const fusionado = fusionarDatoObraFaltante(deSeco, deGruesa);

  it('une los afectados sin repetirlos: el número de la tarjeta deja de mentir', () => {
    expect(fusionado.targetDato).toEqual({
      clave: 'altura_local.PB',
      unidad: 'm',
      entidades: ['t1', 't2', 'm1'],
    });
  });

  it('la descripción fusionada no clava una lista que quedó corta', () => {
    expect(fusionado.descripcion).not.toContain('T1');
    expect(fusionado.descripcion).not.toContain('M1');
    expect(fusionado.descripcion).toContain('Altura de local en PB');
  });

  /**
   * El gate mira `rubro` y nada más. Si el fusionado se quedara con «seco»,
   * gruesa aprobaría un cómputo al que le falta el mismo muro que la consulta
   * está pidiendo. Un dato de obra es, por definición, un hecho de la obra: el
   * que dejó ítems cortos en más de un rubro los frena a todos.
   */
  it('si bloquea y cruza rubros, pasa a ser de obra', () => {
    expect(fusionado.bloqueante).toBe(true);
    expect(fusionado.rubro).toBeNull();
  });

  it('dos del mismo rubro conservan el rubro', () => {
    const otroDeSeco = hallazgoDatoObraFaltante({
      rubro: 'seco',
      claveDato: 'altura_local.PB',
      unidad: 'm',
      descripcion: 'No encontré la altura de estos tabiques.',
      entidades: [tabique('t9', 'T9')],
      bloqueante: false,
    });
    expect(fusionarDatoObraFaltante(deSeco, otroDeSeco).rubro).toBe('seco');
  });

  it('ninguno bloqueante: el fusionado tampoco', () => {
    const a = hallazgoDatoObraFaltante({
      rubro: 'seco',
      claveDato: 'altura_local.PB',
      descripcion: 'a',
      entidades: [tabique('t1', 'T1')],
      bloqueante: false,
    });
    const b = hallazgoDatoObraFaltante({
      rubro: 'pintura',
      claveDato: 'altura_local.PB',
      descripcion: 'b',
      entidades: [tabique('a1', 'A1')],
      bloqueante: false,
    });
    expect(fusionarDatoObraFaltante(a, b).bloqueante).toBe(false);
  });

  it('fusionar dos claves distintas es un bug, y avisa', () => {
    const otraClave = hallazgoDatoObraFaltante({
      rubro: 'seco',
      claveDato: 'altura_local.P1',
      descripcion: 'otra',
      entidades: [tabique('t5', 'T5')],
      bloqueante: true,
    });
    expect(() => fusionarDatoObraFaltante(deSeco, otraClave)).toThrow();
  });

  it('`esDatoObraFaltante` reconoce a los fusionables y a nadie más', () => {
    expect(esDatoObraFaltante(deSeco)).toBe(true);
    expect(esDatoObraFaltante(fusionado)).toBe(true);
    expect(
      esDatoObraFaltante({
        tipo: 'faltante',
        rubro: 'seco',
        descripcion: 'falta el largo',
        clave: 'seco.largo_tabiques.T1',
        bloqueante: true,
        fuentes: [],
      }),
    ).toBe(false);
  });
});

/**
 * La misma etiqueta, pero adentro de una frase: «no encontré … ni **altura de
 * local en PB**». Lo único que cambia es la primera letra — bajarle el tono a
 * la clave entera dejaría «altura de local en pb».
 */
describe('datoEnFrase', () => {
  it('arranca en minúscula y no toca el sufijo', () => {
    expect(datoEnFrase('altura_local.PB')).toBe('altura de local en PB');
    expect(datoEnFrase('altura_local.general')).toBe('altura de local');
    expect(datoEnFrase('altura_revestimiento.Baño')).toBe('altura de revestimiento en Baño');
  });
});
