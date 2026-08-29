/**
 * Override de desperdicio por configuración del estudio.
 *
 * El PRD (P2) dice que el desperdicio es "default por material, **configurable**".
 * Los defaults viven en la plantilla del rubro (`src/lib/rubros/*`) y el engine
 * no los conoce; el estudio pisa los que quiera desde `/estudio/configuracion`,
 * que se guardan en `estudios.config_json.desperdiciosPct` indexados por
 * `claveItem`.
 *
 * `plantillasConConfig(config)` devuelve las mismas plantillas con esos
 * porcentajes aplicados: el engine sigue sin saber nada de configuración y
 * `computarRubro()` se llama igual que siempre.
 *
 * El pin de este archivo es el que pide el brief: **12% → 15% mueve la cantidad
 * de compra**, y la mueve cruzando un bulto entero, que es lo único que un
 * corralón factura distinto.
 */
import { describe, expect, it } from 'vitest';

import { computarRubro, type EntidadPersistida } from '@/lib/computo/engine';
import { plantillasConConfig, recomputarCompra } from '@/lib/rubros/overrides';
import { PLANTILLAS } from '@/lib/rubros/index';
import {
  CONFIG_ESTUDIO_DEFAULT,
  zConfigEstudio,
  zMandato,
  type ConfigEstudio,
  type DatoObraResuelto,
  type Fuente,
} from '@/types/domain';

/** 5,02 × 2,50 m a dos caras = 25,10 m² netos de placa. */
function tabique(): EntidadPersistida {
  return {
    id: 't1',
    laminaId: 'L1',
    tipo: 'tabique',
    nombre: 'T1',
    bbox: [0.1, 0.1, 0.4, 0.02],
    confianza: 0.9,
    estadoReforma: 'nueva',
    atributos: { largoM: 5.02, alturaM: 2.5, caras: 2, tipo: 'durlock' },
  };
}

function config(desperdiciosPct: Record<string, number>): ConfigEstudio {
  return { ...CONFIG_ESTUDIO_DEFAULT, desperdiciosPct };
}

function placasCon(desperdiciosPct: Record<string, number>) {
  const plantillas = plantillasConConfig(config(desperdiciosPct));
  const { items } = computarRubro([tabique()], plantillas.seco, 'nueva');
  const placas = items.find((item) => item.claveItem === 'seco.placas');
  if (!placas) throw new Error('la plantilla no emitió seco.placas');
  return placas;
}

describe('desperdicio configurable: el pin 12% → 15%', () => {
  it('sin override, seco.placas mantiene el 12% de la plantilla: 25,10 → 28,11 → 10 placas', () => {
    const placas = placasCon({});

    expect(placas.cantNeta).toBe(25.1);
    expect(placas.desperdicioPct).toBe(12);
    expect(placas.cantCompra).toBe(28.8);
    expect(placas.presentacion).toBe('10 placas de 2,88 m²');
  });

  it('con 15% configurado: 25,10 → 28,87 → 11 placas de 2,88 m² = 31,68', () => {
    const placas = placasCon({ 'seco.placas': 15 });

    expect(placas.cantNeta).toBe(25.1); // la neta NO se toca: el desperdicio es compra
    expect(placas.desperdicioPct).toBe(15);
    expect(placas.cantCompra).toBe(31.68);
    expect(placas.presentacion).toBe('11 placas de 2,88 m²');
  });

  it('el override de un ítem no toca a los otros ítems del rubro', () => {
    const plantillas = plantillasConConfig(config({ 'seco.placas': 15 }));
    const { items } = computarRubro([tabique()], plantillas.seco, 'nueva');
    const soleras = items.find((item) => item.claveItem === 'seco.soleras');

    expect(soleras?.desperdicioPct).toBe(0);
    expect(soleras?.cantCompra).toBe(10.4); // 2 × 5,02 = 10,04 ml → 4 barras de 2,60 m
    expect(soleras?.presentacion).toBe('4 barras de 2,60 m');
  });

  it('sube el desperdicio de un ítem que la plantilla emitía en 0', () => {
    const plantillas = plantillasConConfig(config({ 'seco.soleras': 10 }));
    const { items } = computarRubro([tabique()], plantillas.seco, 'nueva');
    const soleras = items.find((item) => item.claveItem === 'seco.soleras');

    // 10,04 ml + 10% = 11,04 → 5 barras de 2,60 m = 13
    expect(soleras?.desperdicioPct).toBe(10);
    expect(soleras?.cantCompra).toBe(13);
    expect(soleras?.presentacion).toBe('5 barras de 2,60 m');
  });

  it('un override de 0 baja el desperdicio (0 es un valor, no un "sin configurar")', () => {
    const placas = placasCon({ 'seco.placas': 0 });

    expect(placas.desperdicioPct).toBe(0);
    expect(placas.cantCompra).toBe(25.92); // 25,10 → 9 placas de 2,88
    expect(placas.presentacion).toBe('9 placas de 2,88 m²');
  });

  it('el override POR RUBRO pisa el desperdicio de referencia del rubro', () => {
    // Es lo que ofrece el formulario de configuración: un % por rubro.
    const placas = placasCon({ seco: 15 });

    expect(placas.desperdicioPct).toBe(15);
    expect(placas.cantCompra).toBe(31.68);
  });

  it('el override por rubro NO toca a los ítems que la plantilla emitió en 0', () => {
    // Las soleras, los montantes y los tornillos no se desperdician: subir "el
    // desperdicio de seco" no puede hacer que se compren 15% más de tornillos.
    const plantillas = plantillasConConfig(config({ seco: 15 }));
    const { items } = computarRubro([tabique()], plantillas.seco, 'nueva');
    const porClave = Object.fromEntries(items.map((item) => [item.claveItem, item]));

    expect(porClave['seco.soleras']?.desperdicioPct).toBe(0);
    expect(porClave['seco.montantes']?.desperdicioPct).toBe(0);
    expect(porClave['seco.tornillos']?.desperdicioPct).toBe(0);
    expect(porClave['seco.placas']?.desperdicioPct).toBe(15);
  });

  it('el override por ítem le gana al del rubro', () => {
    expect(placasCon({ seco: 15, 'seco.placas': 0 }).desperdicioPct).toBe(0);
  });

  it('un override de un ítem que la plantilla no emite no rompe nada', () => {
    const placas = placasCon({ 'gruesa.ladrillos': 25, 'seco.no_existe': 40 });

    expect(placas.desperdicioPct).toBe(12);
    expect(placas.cantCompra).toBe(28.8);
  });
});

describe('plantillasConConfig: sin overrides es la identidad observable', () => {
  it('devuelve exactamente los mismos ítems que PLANTILLAS para los cuatro rubros', () => {
    const plantillas = plantillasConConfig(CONFIG_ESTUDIO_DEFAULT);

    for (const rubro of ['aberturas', 'seco', 'pintura', 'gruesa'] as const) {
      const original = computarRubro([tabique()], PLANTILLAS[rubro], 'nueva');
      const conConfig = computarRubro([tabique()], plantillas[rubro], 'nueva');
      expect(conConfig).toEqual(original);
    }
  });

  it('conserva id, nombre y desperdicio de referencia de cada plantilla', () => {
    const plantillas = plantillasConConfig(config({ 'seco.placas': 15 }));

    expect(plantillas.seco.id).toBe('seco');
    expect(plantillas.seco.nombre).toBe(PLANTILLAS.seco.nombre);
    expect(plantillas.seco.desperdicioDefaultPct).toBe(PLANTILLAS.seco.desperdicioDefaultPct);
  });

  it('no muta el registro global PLANTILLAS', () => {
    plantillasConConfig(config({ 'seco.placas': 15 }));
    const { items } = computarRubro([tabique()], PLANTILLAS.seco, 'nueva');

    expect(items.find((item) => item.claveItem === 'seco.placas')?.desperdicioPct).toBe(12);
  });

  it('pasa los hallazgos de la plantilla tal cual', () => {
    const sinAltura: EntidadPersistida = {
      ...tabique(),
      atributos: { largoM: 5, caras: 2, tipo: 'durlock' },
    };
    const plantillas = plantillasConConfig(config({ 'seco.placas': 15 }));
    const { items, hallazgos } = computarRubro([sinAltura], plantillas.seco, 'nueva');

    expect(items).toEqual([]);
    expect(hallazgos.map((h) => h.clave)).toEqual(['dato_obra.altura_local.general']);
  });

  it('los datos de obra llegan a la plantilla envuelta (cadena de respaldo)', () => {
    // Si la envoltura se comiera el cuarto parámetro, el pipeline preguntaría
    // alturas que la obra ya tiene resueltas y el ítem saldría sin la fuente
    // del corte: el override de desperdicio no puede costar eso.
    const sinAltura: EntidadPersistida = {
      ...tabique(),
      atributos: { largoM: 5, caras: 2, tipo: 'durlock' },
    };
    const corte: Fuente = { laminaId: 'L9', bbox: [0.2, 0.3, 0.5, 0.4], detalle: 'Corte A-A' };
    const datosObra = new Map<string, DatoObraResuelto>([
      [
        'altura_local.general',
        {
          clave: 'altura_local.general',
          valor: 2.5,
          unidad: 'm',
          origen: 'deducido',
          fuentes: [corte],
          confianza: 0.9,
        },
      ],
    ]);

    const plantillas = plantillasConConfig(config({ 'seco.placas': 15 }));
    const { items, hallazgos, origenPorEntidad } = plantillas.seco.computar(
      [sinAltura],
      'nueva',
      undefined,
      datosObra,
    );
    const placas = items.find((item) => item.claveItem === 'seco.placas')!;

    expect(hallazgos).toEqual([]);
    expect(placas.cantNeta).toBe(25); // 5 × 2,50 × 2 caras
    expect(placas.desperdicioPct).toBe(15); // el override sigue aplicándose
    expect(placas.fuentes.at(-1)).toEqual(corte);
    expect(origenPorEntidad!.get('t1')!.get('alturaM')).toBe('deducido');
  });
});

describe('recomputarCompra: el núcleo puro del recálculo', () => {
  it('reconoce el bulto a partir de la presentación y la compra vigente', () => {
    expect(
      recomputarCompra({
        unidad: 'm2',
        cantNeta: 30,
        desperdicioPct: 12,
        presentacion: '11 placas de 2,88 m²',
        cantCompraActual: 31.68,
      }),
    ).toEqual({ cantCompra: 34.56, presentacion: '12 placas de 2,88 m²' });
  });

  it('respeta granel, latas y contratos globales', () => {
    expect(
      recomputarCompra({
        unidad: 'm3',
        cantNeta: 4,
        desperdicioPct: 10,
        presentacion: '4,5 m³ a granel (múltiplos de 0,5 m³)',
        cantCompraActual: 4.5,
      }).cantCompra,
    ).toBe(4.5);

    expect(
      recomputarCompra({
        unidad: 'l',
        cantNeta: 25,
        desperdicioPct: 0,
        presentacion: '1 lata 20 L + 1 lata 4 L + 1 lata 1 L',
        cantCompraActual: 25,
      }).presentacion,
    ).toBe('1 lata 20 L + 1 lata 4 L + 1 lata 1 L');

    expect(
      recomputarCompra({
        unidad: 'm2',
        cantNeta: 12,
        desperdicioPct: 0,
        presentacion: 'global',
        cantCompraActual: 12,
      }),
    ).toEqual({ cantCompra: 12, presentacion: 'global' });
  });

  it('con una presentación que no reconoce deja el texto y aplica el desperdicio', () => {
    expect(
      recomputarCompra({
        unidad: 'u',
        cantNeta: 10,
        desperdicioPct: 10,
        presentacion: 'sin presentación',
        cantCompraActual: 10,
      }),
    ).toEqual({ cantCompra: 11, presentacion: 'sin presentación' });
  });
});

describe('zMandato: el objetivo de mejora no llega a 100', () => {
  it('rechaza 100 con un mensaje es-AR', () => {
    const parseo = zMandato.safeParse({
      objetivoMejoraPct: 100,
      palancas: ['volumen'],
      maxRondas: 2,
    });

    expect(parseo.success).toBe(false);
    expect(parseo.error?.issues[0]?.message).toBe(
      'El objetivo de mejora tiene que ser menor a 100%: con 100 le estarías pidiendo al proveedor que regale el rubro.',
    );
  });

  it('acepta 99,9 y 0, y rechaza los negativos', () => {
    const base = { palancas: [], maxRondas: 2 } as const;

    expect(zMandato.safeParse({ ...base, objetivoMejoraPct: 99.9 }).success).toBe(true);
    expect(zMandato.safeParse({ ...base, objetivoMejoraPct: 0 }).success).toBe(true);
    expect(zMandato.safeParse({ ...base, objetivoMejoraPct: -1 }).success).toBe(false);
  });

  it('la config del estudio hereda el límite: un mandato default con 100 no se guarda', () => {
    const parseo = zConfigEstudio.safeParse({
      mandatoDefault: { objetivoMejoraPct: 100, palancas: ['volumen'], maxRondas: 2 },
    });

    expect(parseo.success).toBe(false);
  });
});
