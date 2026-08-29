import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { plantillaSeco } from '@/lib/rubros/seco';
import type { DatoObraResuelto, Fuente, ItemComputo } from '@/types/domain';

function tabique(over: Partial<EntidadPersistida> & { id: string }): EntidadPersistida {
  return {
    laminaId: 'L1',
    tipo: 'tabique',
    nombre: 'T1',
    bbox: [0.1, 0.1, 0.4, 0.02],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: { largoM: 5, alturaM: 2.6, caras: 2, tipo: 'durlock' },
    ...over,
  };
}

function porClave(items: ItemComputo[]): Record<string, ItemComputo> {
  return Object.fromEntries(items.map((item) => [item.claveItem, item]));
}

/** La altura que el corte declara para todo el local, ya resuelta. */
const FUENTE_CORTE: Fuente = { laminaId: 'L9', bbox: [0.2, 0.3, 0.5, 0.4], detalle: 'Corte A-A' };

function alturaDeLocal(over: Partial<DatoObraResuelto> = {}): Map<string, DatoObraResuelto> {
  const dato: DatoObraResuelto = {
    clave: 'altura_local.general',
    valor: 2.6,
    unidad: 'm',
    origen: 'deducido',
    fuentes: [FUENTE_CORTE],
    confianza: 0.9,
    ...over,
  };
  return new Map([[dato.clave, dato]]);
}

/** Cuatro tabiques de 3 m del mismo local, sin altura acotada en la planta. */
function cuatroSinAltura(): EntidadPersistida[] {
  return ['T1', 'T2', 'T3', 'T4'].map((nombre, i) =>
    tabique({
      id: `t${i + 1}`,
      nombre,
      bbox: [0.1, 0.1 + i * 0.1, 0.3, 0.02],
      atributos: { largoM: 3, caras: 2, tipo: 'durlock' },
    }),
  );
}

describe('plantilla seco: tabique de 5 × 2,60 m a dos caras (26 m²)', () => {
  const { items, hallazgos } = plantillaSeco.computar([tabique({ id: 't1' })], 'nueva');
  const item = porClave(items);

  it('emite los seis ítems del tabique de durlock, sin hallazgos', () => {
    expect(hallazgos).toEqual([]);
    expect(items.map((i) => i.claveItem)).toEqual([
      'seco.placas',
      'seco.soleras',
      'seco.montantes',
      'seco.tornillos',
      'seco.masilla',
      'seco.cinta',
    ]);
  });

  it('placas: 26 m² + 12% = 29,12 → 11 placas de 2,88 m² = 31,68 m²', () => {
    const placas = item['seco.placas']!;
    expect(placas.unidad).toBe('m2');
    expect(placas.cantNeta).toBe(26);
    expect(placas.desperdicioPct).toBe(12);
    expect(placas.cantCompra).toBe(31.68);
    expect(placas.presentacion).toBe('11 placas de 2,88 m²');
    expect(placas.descripcion).toContain('Placa');
    expect(placas.origen).toBe('explicito');
    expect(placas.confianza).toBe(0.9);
    expect(placas.fuentes).toEqual([{ laminaId: 'L1', bbox: [0.1, 0.1, 0.4, 0.02], detalle: 'T1' }]);
  });

  it('soleras: 2 × 5 m = 10 ml → 4 barras de 2,60 m', () => {
    const soleras = item['seco.soleras']!;
    expect(soleras.unidad).toBe('ml');
    expect(soleras.cantNeta).toBe(10);
    expect(soleras.desperdicioPct).toBe(0);
    expect(soleras.cantCompra).toBe(10.4);
    expect(soleras.presentacion).toBe('4 barras de 2,60 m');
  });

  it('montantes: ceil(5 / 0,40) + 1 = 14 tiras', () => {
    const montantes = item['seco.montantes']!;
    expect(montantes.unidad).toBe('u');
    expect(montantes.cantNeta).toBe(14);
    expect(montantes.cantCompra).toBe(14);
    expect(montantes.presentacion).toBe('14 tiras de 2,60 m');
  });

  it('tornillos: 15 × 26 m² = 390 u → 1 caja de 500 u', () => {
    const tornillos = item['seco.tornillos']!;
    expect(tornillos.unidad).toBe('u');
    expect(tornillos.cantNeta).toBe(390);
    expect(tornillos.cantCompra).toBe(500);
    expect(tornillos.presentacion).toBe('1 caja de 500 u');
  });

  it('masilla: 0,9 × 26 m² = 23,4 kg → 2 baldes de 15 kg', () => {
    const masilla = item['seco.masilla']!;
    expect(masilla.unidad).toBe('kg');
    expect(masilla.cantNeta).toBe(23.4);
    expect(masilla.cantCompra).toBe(30);
    expect(masilla.presentacion).toBe('2 baldes de 15 kg');
  });

  it('cinta: 2,3 × 26 m² = 59,8 ml → 1 rollo de 90 m', () => {
    const cinta = item['seco.cinta']!;
    expect(cinta.unidad).toBe('ml');
    expect(cinta.cantNeta).toBe(59.8);
    expect(cinta.cantCompra).toBe(90);
    expect(cinta.presentacion).toBe('1 rollo de 90 m');
  });
});

describe('plantilla seco: varios tabiques y datos faltantes', () => {
  it('suma los tabiques computables en un solo juego de ítems', () => {
    const otro = tabique({ id: 't2', nombre: 'T2', bbox: [0.1, 0.5, 0.4, 0.02], confianza: 0.75 });
    const { items } = plantillaSeco.computar([tabique({ id: 't1' }), otro], 'nueva');
    const item = porClave(items);

    expect(item['seco.placas']!.cantNeta).toBe(52);
    expect(item['seco.placas']!.cantCompra).toBe(60.48); // 52 × 1,12 = 58,24 → 21 placas
    expect(item['seco.soleras']!.cantNeta).toBe(20);
    expect(item['seco.montantes']!.cantNeta).toBe(28);
    expect(item['seco.tornillos']!.cantNeta).toBe(780);
    expect(item['seco.placas']!.confianza).toBe(0.75); // la peor de las entidades usadas
    expect(item['seco.placas']!.fuentes).toHaveLength(2);
  });

  it('sin alturaM y sin dato de obra el tabique NO se computa: consulta de dato de obra', () => {
    const sinAltura = tabique({
      id: 't3',
      nombre: 'T3',
      atributos: { largoM: 4, caras: 2, tipo: 'durlock' },
    });
    const { items, hallazgos } = plantillaSeco.computar([tabique({ id: 't1' }), sinAltura], 'nueva');

    expect(porClave(items)['seco.placas']!.cantNeta).toBe(26); // solo T1
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('dato_obra.altura_local.general');
    expect(hallazgos[0]!.tipo).toBe('faltante');
    expect(hallazgos[0]!.rubro).toBe('seco');
    expect(hallazgos[0]!.targetDato).toEqual({
      clave: 'altura_local.general',
      unidad: 'm',
      entidades: ['t3'],
    });
  });

  it('sin ningún tabique computable no emite ítems en cero', () => {
    const sinAltura = tabique({ id: 't3', nombre: 'T3', atributos: { largoM: 4 } });
    const { items } = plantillaSeco.computar([sinAltura], 'nueva');
    expect(items).toEqual([]);
  });

  it('respeta las caras declaradas en la entidad', () => {
    const unaCara = tabique({ id: 't4', atributos: { largoM: 5, alturaM: 2.6, caras: 1, tipo: 'durlock' } });
    const { items } = plantillaSeco.computar([unaCara], 'nueva');
    expect(porClave(items)['seco.placas']!.cantNeta).toBe(13);
  });

  it('un tabique existente no se computa (reforma)', () => {
    const existente = tabique({ id: 't5', estadoReforma: 'existente' });
    const { items, hallazgos } = plantillaSeco.computar([existente], 'reforma');
    expect(items).toEqual([]);
    expect(hallazgos).toEqual([]);
  });

  it('un tabique que no es de durlock no se computa a ciegas', () => {
    const otroSistema = tabique({
      id: 't6',
      nombre: 'T6',
      atributos: { largoM: 5, alturaM: 2.6, tipo: 'mamposteria' },
    });
    const { items, hallazgos } = plantillaSeco.computar([otroSistema], 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.clave).toBe('seco.sistema_tabique.T6');
    expect(hallazgos[0]!.bloqueante).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cadena de respaldo: atributo → dato de obra → UNA pregunta
// ---------------------------------------------------------------------------

describe('plantilla seco: la altura la pone el dato de obra', () => {
  const entidades = cuatroSinAltura();
  const { items, hallazgos, origenPorEntidad } = plantillaSeco.computar(
    entidades,
    'nueva',
    undefined,
    alturaDeLocal(),
  );
  const item = porClave(items);

  it('computa los cuatro tabiques con la altura del local y no pregunta nada', () => {
    expect(hallazgos).toEqual([]);
    // 4 tabiques × 3 m × 2,60 m × 2 caras = 62,4 m²; +12 % = 69,89 → 25 placas.
    expect(item['seco.placas']!.cantNeta).toBe(62.4);
    expect(item['seco.placas']!.cantCompra).toBe(72);
    expect(item['seco.placas']!.presentacion).toBe('25 placas de 2,88 m²');
    expect(item['seco.soleras']!.cantNeta).toBe(24); // 2 × 3 m × 4 tabiques
  });

  it('el ítem cita la lámina del dato además de las de los tabiques (P1)', () => {
    const placas = item['seco.placas']!;
    expect(placas.fuentes).toHaveLength(5); // 4 tabiques + el corte
    expect(placas.fuentes.at(-1)).toEqual(FUENTE_CORTE);
  });

  it('los ítems que NO usan la altura no citan el corte', () => {
    // Las soleras salen del largo: la altura no entra en la cuenta, así que el
    // corte no es fuente de ese número.
    expect(item['seco.soleras']!.fuentes).toHaveLength(4);
    expect(item['seco.montantes']!.fuentes).toHaveLength(4);
  });

  it('anota alturaM con el origen del dato en cada entidad (no es explícito)', () => {
    expect(origenPorEntidad).toBeDefined();
    expect([...origenPorEntidad!.keys()]).toEqual(['t1', 't2', 't3', 't4']);
    for (const campos of origenPorEntidad!.values()) {
      expect([...campos]).toEqual([['alturaM', 'deducido']]);
    }
  });

  it('un dato cargado por el usuario deja el campo explícito', () => {
    const { origenPorEntidad: origenes } = plantillaSeco.computar(
      entidades,
      'nueva',
      undefined,
      alturaDeLocal({ origen: 'explicito' }),
    );
    expect(origenes!.get('t1')!.get('alturaM')).toBe('explicito');
  });

  it('el atributo de la entidad gana: con altura propia el dato ni se mira', () => {
    const { items: propios, origenPorEntidad: origenes } = plantillaSeco.computar(
      [tabique({ id: 't1' })],
      'nueva',
      undefined,
      alturaDeLocal({ valor: 9 }),
    );
    expect(porClave(propios)['seco.placas']!.cantNeta).toBe(26); // 5 × 2,60 × 2
    expect(origenes).toBeUndefined();
  });
});

describe('plantilla seco: sin dato de obra, UNA sola pregunta', () => {
  it('agrupa los cuatro tabiques en un único hallazgo de dato de obra', () => {
    const { items, hallazgos } = plantillaSeco.computar(cuatroSinAltura(), 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    const consulta = hallazgos[0]!;
    expect(consulta.clave).toBe('dato_obra.altura_local.general');
    expect(consulta.tipo).toBe('faltante');
    expect(consulta.targetDato).toEqual({
      clave: 'altura_local.general',
      unidad: 'm',
      entidades: ['t1', 't2', 't3', 't4'],
    });
    // Un hecho de obra que falta no frena la aprobación del rubro, y no se lo
    // leyó en ninguna lámina: no hay bbox honesto que citar.
    expect(consulta.bloqueante).toBe(false);
    expect(consulta.fuentes).toEqual([]);
    expect(consulta.descripcion).toContain('T1, T2, T3 y T4');
    expect(consulta.targetRef).toBeUndefined();
  });

  it('pregunta por el nivel de la entidad cuando lo declara', () => {
    const enPB = cuatroSinAltura().map((entidad) => ({
      ...entidad,
      atributos: { ...entidad.atributos, nivel: 'PB' },
    }));
    const { hallazgos } = plantillaSeco.computar(enPB, 'nueva');

    expect(hallazgos.map((h) => h.clave)).toEqual(['dato_obra.altura_local.PB']);
    expect(hallazgos[0]!.targetDato?.clave).toBe('altura_local.PB');
  });

  it('la altura general respalda a un tabique de PB si no hay una de PB', () => {
    const enPB = cuatroSinAltura().map((entidad) => ({
      ...entidad,
      atributos: { ...entidad.atributos, nivel: 'PB' },
    }));
    const { items, hallazgos } = plantillaSeco.computar(enPB, 'nueva', undefined, alturaDeLocal());

    expect(hallazgos).toEqual([]);
    expect(porClave(items)['seco.placas']!.cantNeta).toBe(62.4);
  });

  it('cada nivel pregunta lo suyo: dos claves, dos grupos de afectados', () => {
    // El caso que rompe una implementación que guarda "la" clave en vez de un
    // mapa: dos tabiques de PB y dos sin nivel, en la misma corrida.
    const [t1, t2, t3, t4] = cuatroSinAltura();
    const enPB = [t1!, t2!].map((entidad) => ({
      ...entidad,
      atributos: { ...entidad.atributos, nivel: 'PB' },
    }));
    const { hallazgos } = plantillaSeco.computar([...enPB, t3!, t4!], 'nueva');

    expect(hallazgos.map((h) => h.clave)).toEqual([
      'dato_obra.altura_local.PB',
      'dato_obra.altura_local.general',
    ]);
    expect(hallazgos[0]!.targetDato?.entidades).toEqual(['t1', 't2']);
    expect(hallazgos[1]!.targetDato?.entidades).toEqual(['t3', 't4']);
    expect(hallazgos[0]!.descripcion).toContain('T1 y T2');
    expect(hallazgos[1]!.descripcion).toContain('T3 y T4');
  });

  it('una altura por nivel le gana a la general', () => {
    const enPB = cuatroSinAltura().map((entidad) => ({
      ...entidad,
      atributos: { ...entidad.atributos, nivel: 'PB' },
    }));
    const datos = alturaDeLocal();
    datos.set('altura_local.PB', {
      clave: 'altura_local.PB',
      valor: 3,
      unidad: 'm',
      origen: 'explicito',
      fuentes: [FUENTE_CORTE],
      confianza: 1,
    });
    const { items } = plantillaSeco.computar(enPB, 'nueva', undefined, datos);

    expect(porClave(items)['seco.placas']!.cantNeta).toBe(72); // 4 × 3 × 3 × 2
  });
});
