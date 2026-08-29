/**
 * Ida y vuelta de la presentación comercial: lo que **escribe** el motor tiene
 * que ser legible por lo que lo **lee** la planilla.
 *
 * Las plantillas de rubro emiten un texto de presentación ("11 placas de
 * 2,88 m²", "1 lata 20 L + 2 latas 1 L", "5,5 m³ a granel (múltiplos de
 * 0,5 m³)") con `describirPresentacion()`, `describirLatas()` y el formato de
 * granel. Cuando el arquitecto edita la cantidad neta de un ítem,
 * `recalcularCompra()` hace el camino inverso: parsea ese texto con
 * `inferirModoCompra()` para saber cómo se compra y recalcular el bulto.
 *
 * Es un contrato entre dos módulos que **no se importan entre sí**: el acuerdo
 * es el formato del string. Si alguien reescribe `describirPresentacion` para
 * que diga "11 × placa (2,88 m²)", o cambia `describirLatas`, o le saca el
 * paréntesis al granel, `inferirModoCompra` deja de reconocerlo y cae en
 * `desconocido`. Nada explota: la planilla empieza a mostrar la neta con
 * desperdicio a secas —sin redondear al bulto que vende el corralón— y P2 se
 * pierde en silencio, ítem por ítem, sin un solo test en rojo.
 *
 * Este test es ese test. Corre las plantillas sobre entidades sintéticas
 * completas, cubre todas las formas de compra del catálogo (placas, barras,
 * tiras, cajas, baldes, rollos, pallets, bolsas, latas, granel —por múltiplos
 * de m³ y por m² o ml enteros—, global y a medida) y le devuelve a
 * `recalcularCompra` cada ítem **sin cambiarle nada**:
 * misma neta, mismo desperdicio. La compra y la presentación que salen tienen
 * que ser idénticas a las que entraron.
 */
import { describe, expect, it } from 'vitest';

import { recalcularCompra } from '@/app/obras/[obraId]/computo/actions';
import type { EntidadPersistida } from '@/lib/computo/engine';
import { PLANTILLAS } from '@/lib/rubros/index';
import { RUBROS, type ItemComputo, type RubroId } from '@/types/domain';

// ---------------------------------------------------------------------------
// Entidades sintéticas: completas a propósito, para que cada plantilla emita
// todos sus ítems y ninguno se caiga a hallazgo.
// ---------------------------------------------------------------------------

function entidad(
  id: string,
  tipo: EntidadPersistida['tipo'],
  nombre: string,
  atributos: EntidadPersistida['atributos'],
  estadoReforma: EntidadPersistida['estadoReforma'] = 'nueva',
): EntidadPersistida {
  return {
    id,
    laminaId: 'L1',
    tipo,
    nombre,
    bbox: [0.1, 0.1, 0.2, 0.05],
    confianza: 0.95,
    estadoReforma,
    atributos,
  };
}

const ENTIDADES: readonly EntidadPersistida[] = [
  // aberturas → 'a medida'; la que se retira (P9) es del rubro demolición
  entidad('a1', 'abertura', 'V2', { tag: 'V2', tipologia: 'ventana', anchoM: 1.5, altoM: 1.2 }),
  entidad('a2', 'abertura', 'P1', { tag: 'P1', tipologia: 'puerta', anchoM: 0.9, altoM: 2.05 }),
  entidad('a3', 'abertura', 'P9', { tag: 'P9', tipologia: 'puerta' }, 'demoler'),
  // seco → placas, barras, tiras, cajas, baldes, rollos
  entidad('t1', 'tabique', 'T1', { largoM: 5, alturaM: 2.6, caras: 2, tipo: 'durlock' }),
  entidad('t2', 'tabique', 'T2', { largoM: 3.3, alturaM: 2.45, caras: 1, tipo: 'durlock' }),
  // pintura → latas; terminaciones → granel por m² y por ml
  entidad('m1', 'ambiente', 'Estar', {
    superficieM2: 23.4,
    perimetroM: 19.6,
    alturaM: 2.6,
    vanosM2: 4.3,
    solado: 'porcelanato',
    zocalo: 'madera',
    cielorraso: 'yeso',
    revestimiento: 'cerámica',
    alturaRevestimientoM: 2.1,
  }),
  entidad('m2', 'ambiente', 'Dormitorio', {
    superficieM2: 12.75,
    perimetroM: 14.2,
    alturaM: 2.55,
    vanosM2: 2.9,
  }),
  // gruesa → pallets, bolsas (50 kg y 25 kg) y granel; el muro a demoler es
  // del rubro demolición, que lo contrata global
  entidad('u1', 'muro', 'M1', { largoM: 7.4, alturaM: 2.7, tipo: 'mampostería' }),
  entidad('u2', 'muro', 'M2', { largoM: 4.15, alturaM: 2.7, tipo: 'mampostería' }),
  entidad('u3', 'muro', 'M9', { largoM: 3.6, alturaM: 2.7, tipo: 'mampostería' }, 'demoler'),
];

/** Las once formas de compra que el catálogo de F0 sabe escribir. */
const FORMAS_ESPERADAS: Record<string, RegExp> = {
  placas: /^\d+ placas? de 2,88 m²$/,
  barras: /^\d+ barras? de 2,60 m$/,
  tiras: /^\d+ tiras? de 2,60 m$/,
  cajas: /^\d+ cajas? de 500 u$/,
  baldes: /^\d+ baldes? de 15 kg$/,
  rollos: /^\d+ rollos? de 90 m$/,
  pallets: /^\d+ pallets? de 198 u$/,
  'bolsas de cemento': /^\d+ bolsas? de 50 kg$/,
  'bolsas de cal': /^\d+ bolsas? de 25 kg$/,
  latas: /^\d+ latas? \d+ L( \+ \d+ latas? \d+ L)*$/,
  granel: /^[\d.,]+ m³ a granel \(múltiplos de 0,5 m³\)$/,
  'granel por m²': /^[\d.,]+ m² a granel \(múltiplos de 1 m²\)$/,
  'granel por ml': /^[\d.,]+ ml a granel \(múltiplos de 1 ml\)$/,
  global: /^global$/,
  'a medida': /^a medida$/,
};

/** Qué forma le toca a cada ítem que emiten las plantillas. */
const FORMA_POR_ITEM: Record<string, keyof typeof FORMAS_ESPERADAS> = {
  'aberturas.V2': 'a medida',
  'aberturas.P1': 'a medida',
  'seco.placas': 'placas',
  'seco.soleras': 'barras',
  'seco.montantes': 'tiras',
  'seco.tornillos': 'cajas',
  'seco.masilla': 'baldes',
  'seco.cinta': 'rollos',
  'pintura.latex_paredes': 'latas',
  'pintura.latex_cielorrasos': 'latas',
  'gruesa.ladrillos': 'pallets',
  'gruesa.cemento': 'bolsas de cemento',
  'gruesa.cal': 'bolsas de cal',
  'gruesa.arena': 'granel',
  'terminaciones.solado.porcelanato': 'granel por m²',
  'terminaciones.zocalo.madera': 'granel por ml',
  'terminaciones.cielorraso.yeso': 'granel por m²',
  'terminaciones.revestimiento.ceramica': 'granel por m²',
  'terminaciones.contrapiso': 'global',
  'terminaciones.carpeta': 'global',
  'demolicion.muros': 'global',
  'demolicion.carpinterias': 'global',
};

function computarTodo(): ItemComputo[] {
  return RUBROS.flatMap((rubro: RubroId) => PLANTILLAS[rubro].computar(ENTIDADES, 'reforma').items);
}

const ITEMS = computarTodo();

// ---------------------------------------------------------------------------

describe('las entidades sintéticas ejercitan todo el catálogo de presentaciones', () => {
  it('emite un ítem por cada forma de compra que el motor sabe escribir', () => {
    expect(ITEMS.map((item) => item.claveItem).sort()).toEqual(Object.keys(FORMA_POR_ITEM).sort());

    const cubiertas = new Set(Object.values(FORMA_POR_ITEM));
    expect([...cubiertas].sort()).toEqual(Object.keys(FORMAS_ESPERADAS).sort());
  });

  it('cada presentación emitida tiene la forma que el parser espera', () => {
    for (const item of ITEMS) {
      const forma = FORMA_POR_ITEM[item.claveItem]!;
      expect(
        FORMAS_ESPERADAS[forma]!.test(item.presentacion),
        `«${item.presentacion}» (${item.claveItem}) no tiene la forma de ${forma}`,
      ).toBe(true);
    }
  });
});

/**
 * `global` y `a medida` no tienen bulto: su texto es constante y no cambia con
 * la cantidad. El resto sí, y de eso se aprovecha la sonda de abajo.
 */
const SIN_BULTO = new Set<keyof typeof FORMAS_ESPERADAS>(['global', 'a medida']);

describe('round-trip: recalcularCompra sin cambios devuelve el ítem intacto', () => {
  // Un `it` por ítem: si alguien reescribe `describirLatas()`, el test que
  // falla nombra el ítem y la presentación que dejó de parsearse.
  for (const item of ITEMS) {
    it(`${item.claveItem} — «${item.presentacion}»`, async () => {
      const entrada = {
        unidad: item.unidad,
        desperdicioPct: item.desperdicioPct,
        presentacion: item.presentacion,
        cantCompraActual: item.cantCompra,
      };

      // Idéntico: ni un bulto de más, ni una degradación al fallback
      // `desconocido` (que devolvería la neta con desperdicio a secas).
      const vuelta = await recalcularCompra({ ...entrada, cantNeta: item.cantNeta });
      expect(vuelta.cantCompra).toBe(item.cantCompra);
      expect(vuelta.presentacion).toBe(item.presentacion);

      // Que salga igual no alcanza como prueba: el fallback `desconocido`
      // devuelve la presentación **tal cual**, así que un ítem sin desperdicio
      // y con bultos de contenido 1 (los montantes) round-tripearía igual sin
      // que el parser lo haya entendido. La sonda: con la neta en 0, una
      // presentación reconocida se reescribe ("0 placas…", "sin compra"); el
      // fallback la deja intacta. `global` y `a medida` son constantes y no
      // participan.
      if (SIN_BULTO.has(FORMA_POR_ITEM[item.claveItem]!)) return;
      const enCero = await recalcularCompra({ ...entrada, cantNeta: 0 });
      expect(enCero.presentacion).not.toBe(item.presentacion);
    });
  }

  it('y el fallback existe, pero acá no se usa: ningún ítem cayó en él', async () => {
    // Prueba de que el test muerde: una presentación que el parser no reconoce
    // devuelve la neta con desperdicio y NO la compra redondeada al bulto.
    const placas = ITEMS.find((i) => i.claveItem === 'seco.placas')!;
    const degradado = await recalcularCompra({
      unidad: placas.unidad,
      cantNeta: placas.cantNeta,
      desperdicioPct: placas.desperdicioPct,
      presentacion: '11 × placa (2,88 m²)', // el mismo dato, otro formato
      cantCompraActual: placas.cantCompra,
    });

    expect(degradado.presentacion).toBe('11 × placa (2,88 m²)');
    expect(degradado.cantCompra).not.toBe(placas.cantCompra);
  });
});
