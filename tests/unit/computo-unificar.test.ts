/**
 * `unificarPorElemento()`: el mismo tabique dicho en dos láminas es UN tabique.
 *
 * Es el módulo que evita que la obra se compre dos veces. Lo que hay que
 * proteger no es solo el número —que se computa una sola vez— sino las tres
 * cosas que lo hacen honesto: que el ítem siga citando las dos láminas (P1), que
 * la confianza no suba por fusionar, y que dos lecturas distintas del mismo
 * campo **no se elijan en silencio**.
 *
 * Dominio puro: sin base, sin fixtures.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { mismaLectura, unificarPorElemento } from '@/lib/computo/unificar';

const ELEMENTO = 'elem-1';

function tabique(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'lam-planta',
    tipo: 'tabique',
    nombre: 'T1',
    bbox: [0.1, 0.1, 0.4, 0.02],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: {},
    ...over,
  };
}

/** El T1 de la planta: sabe el largo, no la altura. */
function enPlanta(over: Partial<EntidadPersistida> = {}): EntidadPersistida {
  return tabique({
    id: 'ent-planta',
    laminaId: 'lam-planta',
    bbox: [0.1, 0.1, 0.4, 0.02],
    elementoId: ELEMENTO,
    atributos: { largoM: 5, tipo: 'durlock' },
    ...over,
  });
}

/** El T1 del corte: sabe la altura, no el largo. */
function enCorte(over: Partial<EntidadPersistida> = {}): EntidadPersistida {
  return tabique({
    id: 'ent-corte',
    laminaId: 'lam-corte',
    bbox: [0.2, 0.3, 0.5, 0.4],
    elementoId: ELEMENTO,
    atributos: { alturaM: 2.6 },
    ...over,
  });
}

describe('unificarPorElemento: sin elemento_id no toca nada', () => {
  it('devuelve las mismas entidades, sin copiarlas', () => {
    const sueltas = [tabique({ id: 'a' }), tabique({ id: 'b', nombre: 'T2' })];

    const { entidades, conflictos, aportes } = unificarPorElemento(sueltas);

    expect(entidades).toHaveLength(2);
    expect(entidades[0]).toBe(sueltas[0]);
    expect(entidades[1]).toBe(sueltas[1]);
    expect(conflictos).toEqual([]);
    expect(aportes.size).toBe(0);
  });

  it('un elemento con una sola entidad tampoco se toca', () => {
    const sola = enPlanta();
    expect(unificarPorElemento([sola]).entidades[0]).toBe(sola);
  });
});

describe('unificarPorElemento: dos láminas, un tabique', () => {
  const planta = enPlanta();
  const corte = enCorte();
  const { entidades, conflictos, aportes } = unificarPorElemento([planta, corte]);
  const unificada = entidades[0]!;

  it('emite UNA entidad, en el lugar de la primera del grupo', () => {
    expect(entidades).toHaveLength(1);
    expect(conflictos).toEqual([]);
  });

  it('completa los huecos de la base con lo que dice la hermana', () => {
    // El largo lo dice la planta, la altura el corte: juntos hacen el tabique.
    expect(unificada.atributos).toEqual({ largoM: 5, tipo: 'durlock', alturaM: 2.6 });
  });

  it('la base es la de mayor confianza', () => {
    const alRevés = unificarPorElemento([enPlanta({ confianza: 0.8 }), enCorte({ confianza: 0.95 })]);
    expect(alRevés.entidades[0]!.id).toBe('ent-corte');
    expect(alRevés.entidades[0]!.laminaId).toBe('lam-corte');
  });

  it('con empate gana la de id menor, no la primera del arreglo', () => {
    // El orden en que Postgres devuelve las filas cambia solo (un `UPDATE`
    // mueve la fila al final del heap): la base no puede depender de eso.
    const conPlantaPrimero = unificarPorElemento([enPlanta(), enCorte()]);
    const conCortePrimero = unificarPorElemento([enCorte(), enPlanta()]);

    expect(conPlantaPrimero.entidades[0]!.id).toBe('ent-corte');
    expect(conCortePrimero.entidades[0]!.id).toBe('ent-corte');
    // El lugar en la lista sí es el de la primera aparición; la base, no.
    expect(conPlantaPrimero.entidades[0]!.laminaId).toBe('lam-corte');
  });

  it('se queda con las fuentes de las dos: el ítem cita las dos láminas (P1)', () => {
    expect(unificada.fuentesUnificadas).toEqual([
      { laminaId: 'lam-planta', bbox: [0.1, 0.1, 0.4, 0.02], detalle: 'T1' },
    ]);
  });

  it('anota qué campo aportó cuál hermana, para no perder su marca de origen', () => {
    // Con el empate gana `ent-corte`, así que lo que se aporta es el largo.
    expect([...aportes.get('ent-corte')!]).toEqual([
      ['largoM', 'ent-planta'],
      ['tipo', 'ent-planta'],
    ]);
  });

  it('la confianza es la peor del grupo, no la de la base', () => {
    // Con la máxima, un dato leído al 0,5 se colaría por el gate del §11.b
    // escondido detrás de la lectura buena.
    const { entidades: mezcla } = unificarPorElemento([
      enPlanta({ confianza: 0.9 }),
      enCorte({ confianza: 0.5 }),
    ]);
    expect(mezcla[0]!.confianza).toBe(0.5);
  });

  it('la peor del grupo aunque esa hermana no haya aportado ningún campo', () => {
    // No depende de qué entidad quedó de base: con las confianzas empatadas la
    // base es una elección arbitraria, y el número del ítem no puede depender
    // de eso.
    const { entidades: mezcla } = unificarPorElemento([
      enPlanta({ confianza: 0.9 }),
      enCorte({ confianza: 0.5, atributos: { largoM: 5 } }),
    ]);
    expect(mezcla[0]!.confianza).toBe(0.5);
    expect(mezcla[0]!.atributos).toEqual({ largoM: 5, tipo: 'durlock' });
  });

  it('el estado de reforma es el de la base', () => {
    const { entidades: mezcla } = unificarPorElemento([
      enPlanta({ estadoReforma: 'nueva' }),
      enCorte({ confianza: 0.5, estadoReforma: 'demoler' }),
    ]);
    expect(mezcla[0]!.estadoReforma).toBe('nueva');
  });
});

describe('unificarPorElemento: cuando las dos láminas no coinciden', () => {
  it('conserva el valor de la base y emite el conflicto, con la base primero', () => {
    const planta = enPlanta({ atributos: { largoM: 5, alturaM: 2.6 } });
    const corte = enCorte({ confianza: 0.8, atributos: { alturaM: 2.4 } });

    const { entidades, conflictos } = unificarPorElemento([planta, corte]);

    expect(entidades[0]!.atributos.alturaM).toBe(2.6);
    expect(conflictos).toEqual([
      {
        elementoId: ELEMENTO,
        campo: 'alturaM',
        valores: [2.6, 2.4],
        entidadIds: ['ent-planta', 'ent-corte'],
        origenes: ['explicito', 'explicito'],
      },
    ]);
  });

  it('una diferencia de menos del 1 % son dos lápices, no dos alturas', () => {
    // 2,60 y 2,62 sobre el mismo muro: |0,02| / 2,62 = 0,76 %.
    const { conflictos } = unificarPorElemento([
      enPlanta({ atributos: { alturaM: 2.6 } }),
      enCorte({ confianza: 0.8, atributos: { alturaM: 2.62 } }),
    ]);
    expect(conflictos).toEqual([]);
  });

  it('el mismo texto escrito distinto no es un conflicto', () => {
    const { conflictos } = unificarPorElemento([
      enPlanta({ atributos: { tipo: 'Durlock' } }),
      enCorte({ confianza: 0.8, atributos: { tipo: ' durlock ' } }),
    ]);
    expect(conflictos).toEqual([]);
  });

  it('tres lecturas distintas del mismo campo son UN conflicto con las tres', () => {
    // La clave del hallazgo es por elemento y campo: dos conflictos del mismo
    // campo colisionarían en la bandeja.
    const { conflictos } = unificarPorElemento([
      enPlanta({ atributos: { alturaM: 2.6 } }),
      enCorte({ id: 'ent-corte', confianza: 0.8, atributos: { alturaM: 2.4 } }),
      enCorte({ id: 'ent-detalle', laminaId: 'lam-detalle', confianza: 0.7, atributos: { alturaM: 3 } }),
    ]);

    expect(conflictos).toHaveLength(1);
    expect(conflictos[0]!.valores).toEqual([2.6, 2.4, 3]);
    expect(conflictos[0]!.entidadIds).toEqual(['ent-planta', 'ent-corte', 'ent-detalle']);
  });

  it('un campo en pugna no impide que los demás se completen', () => {
    const { entidades } = unificarPorElemento([
      enPlanta({ atributos: { largoM: 5, alturaM: 2.6 } }),
      enCorte({ confianza: 0.8, atributos: { alturaM: 2.4, caras: 1 } }),
    ]);
    expect(entidades[0]!.atributos).toEqual({ largoM: 5, alturaM: 2.6, caras: 1 });
  });
});

describe('unificarPorElemento: orden y grupos múltiples', () => {
  it('respeta el orden de aparición y no mezcla elementos', () => {
    const otro = tabique({
      id: 'ent-otro',
      nombre: 'T2',
      elementoId: 'elem-2',
      atributos: { largoM: 3 },
    });
    const gemelo = tabique({
      id: 'ent-otro-corte',
      nombre: 'T2',
      laminaId: 'lam-corte',
      elementoId: 'elem-2',
      confianza: 0.7,
      atributos: { alturaM: 2.6 },
    });
    const suelto = tabique({ id: 'ent-suelto', nombre: 'T3' });

    const { entidades } = unificarPorElemento([enPlanta(), otro, suelto, enCorte(), gemelo]);

    // El lugar es el de la primera aparición de cada grupo; el id es el de la
    // base que ganó adentro (empate ⇒ id menor).
    expect(entidades.map((entidad) => entidad.id)).toEqual([
      'ent-corte',
      'ent-otro',
      'ent-suelto',
    ]);
    expect(entidades[1]!.atributos).toEqual({ largoM: 3, alturaM: 2.6 });
  });
});

describe('mismaLectura', () => {
  it('compara números aunque vengan como texto', () => {
    expect(mismaLectura('2,60', 2.6)).toBe(true);
    expect(mismaLectura('2,60', 2.4)).toBe(false);
  });

  it('dos ceros son el mismo cero (y no una división por cero)', () => {
    expect(mismaLectura(0, 0)).toBe(true);
  });

  it('lo que no es número ni texto se compara por igualdad', () => {
    expect(mismaLectura(true, true)).toBe(true);
    expect(mismaLectura(true, false)).toBe(false);
  });
});

describe('unificarPorElemento: el nivel de evidencia manda sobre quién quedó de base', () => {
  // El caso que rompía: la planta trae el `largoM` que el pipeline **midió sobre
  // el dibujo** (§5.5, confianza 0,5 fija) y el corte lo trae **acotado**. Antes
  // ganaba la planta por ser la base, y la consulta le decía al arquitecto que
  // 6,12 era «la lectura más confiable» — es la evidencia más débil que el
  // sistema produce.
  const ORIGENES_MEDIDO = new Map([['ent-planta', new Map([['largoM', 'inferido' as const]])]]);

  it('un campo medido sobre el dibujo pierde contra la cota escrita en la hermana', () => {
    const planta = enPlanta({ atributos: { largoM: 6.12 } });
    const corte = enCorte({ confianza: 0.8, atributos: { largoM: 6 } });

    const { entidades, conflictos, aportes } = unificarPorElemento(
      [planta, corte],
      ORIGENES_MEDIDO,
    );

    expect(entidades[0]!.atributos.largoM).toBe(6);
    // No es una contradicción del expediente: es la cadena del §5.2 haciendo su
    // trabajo. Lo escrito le gana a lo medido, y no se molesta a nadie.
    expect(conflictos).toEqual([]);
    // El aporte queda registrado para que la marca de origen viaje con el valor.
    expect(aportes.get('ent-planta')!.get('largoM')).toBe('ent-corte');
  });

  it('sin el mapa de orígenes se comporta como siempre: gana la base', () => {
    const { entidades, conflictos } = unificarPorElemento([
      enPlanta({ atributos: { largoM: 6.12 } }),
      enCorte({ confianza: 0.8, atributos: { largoM: 6 } }),
    ]);

    expect(entidades[0]!.atributos.largoM).toBe(6.12);
    expect(conflictos).toHaveLength(1);
  });

  it('a igual nivel de evidencia gana la base y el conflicto se emite', () => {
    const origenes = new Map([
      ['ent-planta', new Map([['largoM', 'inferido' as const]])],
      ['ent-corte', new Map([['largoM', 'inferido' as const]])],
    ]);
    const { entidades, conflictos } = unificarPorElemento(
      [enPlanta({ atributos: { largoM: 6.12 } }), enCorte({ confianza: 0.8, atributos: { largoM: 6 } })],
      origenes,
    );

    expect(entidades[0]!.atributos.largoM).toBe(6.12);
    expect(conflictos[0]!.origenes).toEqual(['inferido', 'inferido']);
  });

  it('el mismo número dicho por las dos igual mueve el origen al que lo tiene escrito', () => {
    const { entidades, conflictos, aportes } = unificarPorElemento(
      [enPlanta({ atributos: { largoM: 6 } }), enCorte({ confianza: 0.8, atributos: { largoM: 6 } })],
      ORIGENES_MEDIDO,
    );

    expect(entidades[0]!.atributos.largoM).toBe(6);
    expect(conflictos).toEqual([]);
    expect(aportes.get('ent-planta')!.get('largoM')).toBe('ent-corte');
  });

  it('lo deducido le gana a lo medido, y lo escrito a los dos', () => {
    const origenes = new Map([
      ['ent-planta', new Map([['largoM', 'inferido' as const]])],
      ['ent-corte', new Map([['largoM', 'deducido' as const]])],
    ]);
    const { entidades } = unificarPorElemento(
      [enPlanta({ atributos: { largoM: 6.12 } }), enCorte({ confianza: 0.8, atributos: { largoM: 6 } })],
      origenes,
    );
    expect(entidades[0]!.atributos.largoM).toBe(6);
  });
});
