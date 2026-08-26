/**
 * Overrides de la configuración del estudio sobre las plantillas de rubro.
 *
 * El PRD (P2) pide que el desperdicio sea "default por material, **configurable**".
 * Los defaults son dato de la plantilla (`src/lib/rubros/*`) y el engine no los
 * conoce: `computarRubro()` recibe una plantilla y la corre. Este módulo agrega
 * la capa que faltaba **sin tocar ni el engine ni las plantillas** —
 * `plantillasConConfig(config)` devuelve las mismas plantillas envueltas, y el
 * llamador sigue usando `computarRubro(entidades, plantilla, tipoObra)` igual
 * que siempre.
 *
 * ## Por qué se re-arma la compra en vez de recomputar el rubro
 *
 * El desperdicio no cambia **nada** de lo que la plantilla decide: ni la
 * cantidad neta, ni las fuentes, ni la confianza, ni qué ítems se emiten. Solo
 * cambia `cantCompra` y el texto de la presentación, que salen de
 * `cantNeta × (1 + pct/100)` redondeado hacia arriba al bulto. Por eso el
 * override es post-proceso del ítem y no un parámetro que habría que enhebrar
 * por las cuatro plantillas y el engine.
 *
 * Lo que sí hace falta es saber **cómo se compra** el ítem, y eso la plantilla
 * ya lo escribió en su presentación ("11 placas de 2,88 m²", "4,5 m³ a granel
 * (múltiplos de 0,5 m³)", "1 lata 20 L"). `recomputarCompra()` lee ese texto de
 * vuelta: es el mismo camino inverso que usa la edición inline de la planilla
 * —que vive en `src/app/obras/[obraId]/computo/actions.ts` y delega acá— así
 * que editar un ítem a mano y configurar el desperdicio del estudio dan
 * exactamente el mismo número. Duplicar la lógica sería garantizar que un día
 * dejen de coincidir.
 *
 * Módulo puro: sin base, sin Next, sin red.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import {
  ceilAPresentacion,
  describirLatas,
  describirPresentacion,
  latasParaLitros,
} from '@/lib/computo/presentacion';
import { ETIQUETA_UNIDAD, formatearNumero, redondear2 } from '@/lib/computo/unidades';
import { PLANTILLAS, type PlantillaRubro, type ResultadoComputo } from '@/lib/rubros/index';
import { RUBROS, type ConfigEstudio, type ItemComputo, type RubroId, type TipoObra, type Unidad } from '@/types/domain';

// ---------------------------------------------------------------------------
// Núcleo puro: recálculo de la compra cuando cambia el desperdicio
// ---------------------------------------------------------------------------

export interface EntradaCompra {
  unidad: Unidad;
  /** Cantidad neta del ítem (el desperdicio no la toca). */
  cantNeta: number;
  /** Desperdicio a aplicar, en porcentaje. */
  desperdicioPct: number;
  /** La presentación con la que se emitió el ítem ("11 placas de 2,88 m²"). */
  presentacion: string;
  /** La compra vigente: de ella sale cuánto trae cada bulto. */
  cantCompraActual: number;
}

export interface CompraCalculada {
  cantCompra: number;
  presentacion: string;
}

/**
 * Lee un número escrito en es-AR: coma decimal y punto de miles (`1.234,5`), o
 * punto decimal si es lo único que hay (`30.5`). `null` si no hay número.
 */
export function numeroEsAr(texto: string): number | null {
  const limpio = texto.replace(/[\s\u00a0]/g, '');
  if (limpio === '') return null;

  // Con coma presente, los puntos son separadores de miles; sin coma, un punto
  // solo es el separador decimal.
  const normalizado = limpio.includes(',') ? limpio.replace(/\./g, '').replace(',', '.') : limpio;

  if (!/^[+-]?\d*\.?\d+$/.test(normalizado)) return null;
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

/**
 * Cómo se compra el ítem, deducido de su propia presentación. Las plantillas
 * escriben esos textos con `describirPresentacion()`, `describirLatas()` y el
 * formato de granel de `presentacion.ts`: acá se hace el camino inverso para no
 * duplicar los números de las plantillas.
 */
type ModoLeido =
  | { tipo: 'bulto'; singular: string; plural: string; detalle: string; contenido: number }
  | { tipo: 'granel'; multiplo: number }
  | { tipo: 'latas' }
  | { tipo: 'global' }
  | { tipo: 'medida' }
  /** No reconocí la presentación: se aplica desperdicio y se deja el texto como está. */
  | { tipo: 'desconocido' };

/** "11 placas de 2,88 m²" → unidades, nombre del bulto y detalle. */
const BULTO_RE = /^([\d.,]+)\s+(\p{L}+)\s+de\s+(.+)$/u;
/** "4,5 m³ a granel (múltiplos de 0,5 m³)". */
const GRANEL_RE = /múltiplos de\s+([\d.,]+)/u;
/** "1 lata 20 L + 2 latas 1 L". */
const LATAS_RE = /\blatas?\b/u;
/** "2,88 m²" → contenido y etiqueta de unidad del bulto. */
const DETALLE_RE = /^([\d.,]+)\s*(\S+)$/u;

/**
 * Cuánto trae el bulto. La fuente de verdad es la compra vigente dividida por
 * los bultos que se compraron: el detalle es texto comercial y puede no ser el
 * contenido (una tira de montante son 2,60 m pero el ítem se compra por unidad).
 * Recién si no hay compra vigente se mira el detalle, y solo cuando su unidad
 * coincide con la del ítem.
 */
function contenidoDelBulto(
  unidades: number | null,
  detalle: string,
  entrada: EntradaCompra,
): number | null {
  if (unidades !== null && unidades > 0 && entrada.cantCompraActual > 0) {
    const contenido = redondear2(entrada.cantCompraActual / unidades);
    if (contenido > 0) return contenido;
  }

  const partes = DETALLE_RE.exec(detalle.trim());
  if (!partes || partes[2] !== ETIQUETA_UNIDAD[entrada.unidad]) return null;
  const contenido = numeroEsAr(partes[1]!);
  return contenido !== null && contenido > 0 ? contenido : null;
}

function leerModo(entrada: EntradaCompra): ModoLeido {
  const texto = entrada.presentacion.trim();
  if (texto === 'global') return { tipo: 'global' };
  if (texto === 'a medida') return { tipo: 'medida' };
  if (entrada.unidad === 'l' && (LATAS_RE.test(texto) || texto === 'sin compra')) {
    return { tipo: 'latas' };
  }

  const granel = GRANEL_RE.exec(texto);
  if (granel) {
    const multiplo = numeroEsAr(granel[1]!);
    if (multiplo !== null && multiplo > 0) return { tipo: 'granel', multiplo };
    return { tipo: 'desconocido' };
  }

  const bulto = BULTO_RE.exec(texto);
  if (!bulto) return { tipo: 'desconocido' };

  const unidades = numeroEsAr(bulto[1]!);
  const nombre = bulto[2]!;
  const detalle = bulto[3]!;
  const contenido = contenidoDelBulto(unidades, detalle, entrada);
  if (contenido === null) return { tipo: 'desconocido' };

  // El plural es regular en todos los bultos del corralón (placa/placas,
  // caja/cajas, pallet/pallets): con la forma que ya está escrita alcanza.
  const singular = unidades === 1 ? nombre : nombre.replace(/s$/u, '');
  const plural = unidades === 1 ? `${nombre}s` : nombre;
  return { tipo: 'bulto', singular, plural, detalle, contenido };
}

/**
 * Cantidad de compra y presentación para una neta y un desperdicio dados.
 *
 * `cantCompra = ceilAPresentacion(cantNeta × (1 + desperdicio/100))` con la
 * presentación del ítem. Si no la reconozco, la compra es la neta con
 * desperdicio redondeada a 2 decimales y la presentación queda como estaba —
 * antes que inventar un bulto, se muestra el número honesto.
 */
export function recomputarCompra(entrada: EntradaCompra): CompraCalculada {
  const cantNeta = redondear2(Math.max(0, entrada.cantNeta));
  const conDesperdicio = redondear2(cantNeta * (1 + entrada.desperdicioPct / 100));
  const modo = leerModo(entrada);

  switch (modo.tipo) {
    case 'bulto': {
      const { unidades, cantCompra } = ceilAPresentacion(conDesperdicio, modo.contenido);
      return {
        cantCompra,
        presentacion: describirPresentacion(unidades, {
          singular: modo.singular,
          plural: modo.plural,
          contenido: modo.contenido,
          detalle: modo.detalle,
        }),
      };
    }
    case 'granel': {
      const { cantCompra } = ceilAPresentacion(conDesperdicio, modo.multiplo);
      const etiqueta = ETIQUETA_UNIDAD[entrada.unidad];
      return {
        cantCompra,
        presentacion: `${formatearNumero(cantCompra)} ${etiqueta} a granel (múltiplos de ${formatearNumero(modo.multiplo)} ${etiqueta})`,
      };
    }
    case 'latas': {
      const { latas, litrosTotales } = latasParaLitros(conDesperdicio);
      return { cantCompra: litrosTotales, presentacion: describirLatas(latas) };
    }
    case 'global':
      return { cantCompra: conDesperdicio, presentacion: 'global' };
    case 'medida':
      return { cantCompra: conDesperdicio, presentacion: 'a medida' };
    case 'desconocido':
      return { cantCompra: conDesperdicio, presentacion: entrada.presentacion };
  }
}

// ---------------------------------------------------------------------------
// Plantillas con la configuración del estudio aplicada
// ---------------------------------------------------------------------------

/**
 * El desperdicio que le corresponde al ítem según la configuración.
 *
 * `desperdiciosPct` acepta **dos clases de clave**, y en ese orden de prioridad:
 *
 *  1. **Por ítem** (`"seco.placas"`), que es como lo tipó P1 y lo que un día
 *     va a querer un estudio que compra las placas a un proveedor puntual.
 *  2. **Por rubro** (`"seco"`), que es lo que el formulario de configuración
 *     ofrece, porque nadie quiere llenar seis campos por rubro.
 *
 * El override por rubro **solo pisa a los ítems que la plantilla emitió con el
 * desperdicio de referencia del rubro**. Las soleras, los montantes y los
 * tornillos salen con 0% porque no se desperdician: subir "el desperdicio de
 * seco" a 15% y que de golpe se compren 15% más de tornillos sería otra cosa,
 * y no la que el usuario pidió.
 *
 * `0` es un valor, no un "sin configurar": la pregunta es si la clave **está**,
 * no si el número es truthy.
 */
export function desperdicioEfectivo(
  item: ItemComputo,
  plantilla: Pick<PlantillaRubro, 'id' | 'desperdicioDefaultPct'>,
  desperdiciosPct: Readonly<Record<string, number>>,
): number {
  const porItem = desperdiciosPct[item.claveItem];
  if (porItem !== undefined) return porItem;

  const porRubro = desperdiciosPct[plantilla.id];
  if (porRubro !== undefined && item.desperdicioPct === plantilla.desperdicioDefaultPct) {
    return porRubro;
  }

  return item.desperdicioPct;
}

/** El ítem con otro desperdicio: la neta no se toca, la compra se rehace. */
export function aplicarDesperdicio(item: ItemComputo, desperdicioPct: number): ItemComputo {
  if (desperdicioPct === item.desperdicioPct) return item;

  const compra = recomputarCompra({
    unidad: item.unidad,
    cantNeta: item.cantNeta,
    desperdicioPct,
    presentacion: item.presentacion,
    cantCompraActual: item.cantCompra,
  });

  return { ...item, desperdicioPct, ...compra };
}

/** Una plantilla que aplica los overrides del estudio a lo que emite. */
function conConfig(
  plantilla: PlantillaRubro,
  desperdiciosPct: Readonly<Record<string, number>>,
): PlantillaRubro {
  return {
    id: plantilla.id,
    nombre: plantilla.nombre,
    desperdicioDefaultPct: plantilla.desperdicioDefaultPct,
    computar(
      entidades: readonly EntidadPersistida[],
      tipoObra: TipoObra,
      laminas?: readonly LaminaDeComputo[],
    ): ResultadoComputo {
      const { items, hallazgos } = plantilla.computar(entidades, tipoObra, laminas);
      return {
        items: items.map((item) =>
          aplicarDesperdicio(item, desperdicioEfectivo(item, plantilla, desperdiciosPct)),
        ),
        // Los hallazgos no dependen del desperdicio: pasan tal cual.
        hallazgos,
      };
    },
  };
}

/**
 * Las cuatro plantillas con la configuración del estudio aplicada.
 *
 * Es la entrada que el pipeline usa en lugar de `PLANTILLAS` cuando computa una
 * obra: `recomputarObra` llama a `computarObraConPlantillas(…,
 * plantillasConConfig(config))`, así que el desperdicio configurado por el
 * estudio llega al cómputo. (Hasta P11 no era así y esto quedaba sin usar; si
 * alguna vez ves un rubro computado con el desperdicio de fábrica, el lugar a
 * mirar es esa llamada.)
 *
 * No muta `PLANTILLAS`: devuelve objetos nuevos.
 */
export function plantillasConConfig(config: ConfigEstudio): Record<RubroId, PlantillaRubro> {
  const desperdiciosPct = config.desperdiciosPct;
  const salida = {} as Record<RubroId, PlantillaRubro>;
  for (const rubro of RUBROS) salida[rubro] = conConfig(PLANTILLAS[rubro], desperdiciosPct);
  return salida;
}
