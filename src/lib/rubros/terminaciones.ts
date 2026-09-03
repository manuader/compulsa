/**
 * Rubro terminaciones: solados, zócalos, cielorrasos, revestimientos,
 * contrapiso y carpeta.
 *
 * Dos fuentes, la misma cuenta:
 *
 *  - el **ambiente**, que declara sus terminaciones como atributos (`solado`,
 *    `zocalo`, `cielorraso`, `revestimiento`) y aporta la superficie y el
 *    perímetro con los que se miden;
 *  - la **terminación** suelta (`tipo: 'terminacion'`), que es como el análisis
 *    lee un cuadro de locales: `ubicacion` (`piso`, `cielorraso`,
 *    `revestimiento`), `material` y sus m².
 *
 * ## Sin material declarado el rubro no aplica
 *
 * Un ambiente que no dice qué solado lleva no genera un ítem ni una consulta.
 * No es un hueco como la altura de un tabique —ahí hay un ítem esperando un
 * número—: es documentación que no habla del rubro, y preguntarle al arquitecto
 * el material de cada ambiente de cada obra llenaría la bandeja de preguntas
 * que él no hizo. Cuando el material está, se computa; cuando no, este rubro no
 * tiene nada que decir. Lo que sí es un hueco es un material declarado **sin la
 * medida** que lo cuantifica: eso sale como consulta bloqueante.
 *
 * ## Por qué la compra es "a granel" y no un bulto
 *
 * El corralón vende el porcelanato por caja, pero cuántos m² trae la caja
 * depende de la pieza, y la pieza no está en la documentación. Inventar un
 * contenido sería inventar un número de compra (P2): se compra por m² enteros
 * —que es como se pide un revestimiento en el mostrador— y el bulto lo cierra
 * el proveedor cuando cotiza. El contrapiso y la carpeta no se compran: se
 * contratan por m², y por eso salen `global` y sin desperdicio.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { armarItem } from '@/lib/computo/presentacion';
import { redondear2 } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  datoEnFrase,
  hallazgoDatoFaltante,
  leerMedida,
  leerTexto,
} from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import {
  ALTURA_REVESTIMIENTO,
  cadenaDeRespaldo,
  conFuentesDeDato,
  conOrigenes,
  type DatosObra,
} from '@/lib/rubros/respaldo';
import type { HallazgoDetectado, ItemComputo, TipoObra, Unidad } from '@/types/domain';

const RUBRO = 'terminaciones';

/** Datos de la plantilla: el desperdicio de cada familia. */
const DESPERDICIO_SOLADO_PCT = 10;
const DESPERDICIO_ZOCALO_PCT = 5;
const DESPERDICIO_CIELORRASO_PCT = 12;
const DESPERDICIO_REVESTIMIENTO_PCT = 10;
/** El contrapiso y la carpeta se contratan por m²: no hay material que sobre. */
const DESPERDICIO_BASE_PCT = 0;

/** El del solado, que es el ítem que manda el rubro. */
const DESPERDICIO_DEFAULT_PCT = DESPERDICIO_SOLADO_PCT;

/** Se compra por m² (o ml) enteros: el bulto lo cierra el proveedor. */
const POR_ENTEROS = 1;

type Familia = 'solado' | 'zocalo' | 'cielorraso' | 'revestimiento';

interface DatosFamilia {
  unidad: Unidad;
  desperdicioPct: number;
  descripcion: (material: string) => string;
}

const FAMILIAS: Record<Familia, DatosFamilia> = {
  solado: {
    unidad: 'm2',
    desperdicioPct: DESPERDICIO_SOLADO_PCT,
    descripcion: (material) => `Solado de ${material}`,
  },
  zocalo: {
    unidad: 'ml',
    desperdicioPct: DESPERDICIO_ZOCALO_PCT,
    descripcion: (material) => `Zócalo de ${material}`,
  },
  cielorraso: {
    unidad: 'm2',
    desperdicioPct: DESPERDICIO_CIELORRASO_PCT,
    descripcion: (material) => `Cielorraso de ${material}`,
  },
  revestimiento: {
    unidad: 'm2',
    desperdicioPct: DESPERDICIO_REVESTIMIENTO_PCT,
    descripcion: (material) => `Revestimiento de ${material}`,
  },
};

/** El orden en el que el rubro se lee en la planilla. */
const ORDEN: readonly Familia[] = ['solado', 'zocalo', 'cielorraso', 'revestimiento'];

/** `ubicacion` de una entidad `terminacion` → familia del rubro. */
const FAMILIA_POR_UBICACION: Record<string, Familia | undefined> = {
  piso: 'solado',
  solado: 'solado',
  cielorraso: 'cielorraso',
  revestimiento: 'revestimiento',
};

/** Clave de ítem a partir del material: minúsculas, sin acentos, con guión bajo. */
function slugMaterial(material: string): string {
  return material
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface Acumulado {
  material: string;
  cantidad: number;
  entidades: EntidadPersistida[];
}

/** `familia → slug del material → lo acumulado`. */
type Acumulados = Map<Familia, Map<string, Acumulado>>;

function acumular(
  acumulados: Acumulados,
  familia: Familia,
  material: string,
  cantidad: number,
  entidad: EntidadPersistida,
): void {
  const porMaterial = acumulados.get(familia) ?? new Map<string, Acumulado>();
  const slug = slugMaterial(material);
  const previo = porMaterial.get(slug) ?? { material, cantidad: 0, entidades: [] };
  previo.cantidad += cantidad;
  previo.entidades.push(entidad);
  porMaterial.set(slug, previo);
  acumulados.set(familia, porMaterial);
}

/** La superficie está declarada pero no la medida que la cuantifica. */
function faltaSuperficie(entidad: EntidadPersistida): HallazgoDetectado {
  return hallazgoDatoFaltante({
    rubro: RUBRO,
    clave: `${RUBRO}.superficie.${entidad.nombre}`,
    checklistItem: `${RUBRO}.superficie`,
    descripcion:
      `${entidad.nombre} declara su terminación pero no encontré la superficie: sin m² no la puedo computar. ` +
      'Cargá el dato o indicá la planilla de locales.',
    entidad,
    campos: ['superficieM2'],
  });
}

/** Ídem con el perímetro, que es lo que mide el zócalo y el revestimiento. */
function faltaPerimetro(entidad: EntidadPersistida): HallazgoDetectado {
  return hallazgoDatoFaltante({
    rubro: RUBRO,
    clave: `${RUBRO}.perimetro.${entidad.nombre}`,
    checklistItem: `${RUBRO}.perimetro`,
    descripcion:
      `${entidad.nombre} declara zócalo o revestimiento pero no encontré el perímetro: sin él no los puedo computar. ` +
      'Cargá el dato o indicá la planta donde está acotado.',
    entidad,
    campos: ['perimetroM'],
  });
}

export const plantillaTerminaciones = {
  id: RUBRO,
  nombre: 'Terminaciones',
  desperdicioDefaultPct: DESPERDICIO_DEFAULT_PCT,

  computar(
    entidades: readonly EntidadPersistida[],
    _tipoObra: TipoObra,
    _laminas?: readonly LaminaDeComputo[],
    datosObra?: DatosObra,
  ): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const cadena = cadenaDeRespaldo(datosObra);
    const acumulados: Acumulados = new Map();

    /** Un ambiente que declara sus terminaciones como atributos. */
    const leerAmbiente = (entidad: EntidadPersistida): void => {
      const solado = leerTexto(entidad, 'solado');
      const zocalo = leerTexto(entidad, 'zocalo');
      const cielorraso = leerTexto(entidad, 'cielorraso');
      const revestimiento = leerTexto(entidad, 'revestimiento');
      if (solado === null && zocalo === null && cielorraso === null && revestimiento === null) {
        return; // la documentación no habla del rubro en este ambiente
      }

      const superficie = leerMedida(entidad, 'superficieM2');
      const perimetro = leerMedida(entidad, 'perimetroM');

      if (superficie === null && (solado !== null || cielorraso !== null)) {
        hallazgos.push(faltaSuperficie(entidad));
      }
      if (perimetro === null && (zocalo !== null || revestimiento !== null)) {
        hallazgos.push(faltaPerimetro(entidad));
      }

      if (solado !== null && superficie !== null) {
        acumular(acumulados, 'solado', solado, superficie, entidad);
      }
      if (cielorraso !== null && superficie !== null) {
        acumular(acumulados, 'cielorraso', cielorraso, superficie, entidad);
      }
      if (zocalo !== null && perimetro !== null) {
        acumular(acumulados, 'zocalo', zocalo, perimetro, entidad);
      }
      if (revestimiento !== null && perimetro !== null) {
        // Perímetro × la altura hasta donde llega el revestimiento, que suele
        // estar declarada una vez para toda la obra (`altura_revestimiento`).
        const altura = cadena.medida(entidad, 'alturaRevestimientoM', ALTURA_REVESTIMIENTO);
        if (altura !== null) {
          acumular(acumulados, 'revestimiento', revestimiento, perimetro * altura, entidad);
        }
      }
    };

    /**
     * Una terminación suelta, como sale de un cuadro de locales: ya viene con
     * sus m², así que no necesita altura ni perímetro. El zócalo no se computa
     * por acá —una terminación trae superficie, no metros lineales— y sale del
     * ambiente, que sí tiene perímetro.
     */
    const leerTerminacion = (entidad: EntidadPersistida): void => {
      const ubicacion = leerTexto(entidad, 'ubicacion');
      const material = leerTexto(entidad, 'material');
      if (ubicacion === null || material === null) return;
      const familia = FAMILIA_POR_UBICACION[ubicacion.toLowerCase()];
      if (familia === undefined) return;

      const superficie = leerMedida(entidad, 'superficieM2');
      if (superficie === null) {
        hallazgos.push(faltaSuperficie(entidad));
        return;
      }
      acumular(acumulados, familia, material, superficie, entidad);
    };

    for (const entidad of entidades) {
      if (alcanceDeReforma(entidad.estadoReforma) !== 'completo') continue;
      if (entidad.tipo === 'ambiente') leerAmbiente(entidad);
      else if (entidad.tipo === 'terminacion') leerTerminacion(entidad);
    }

    const items: ItemComputo[] = [];

    for (const familia of ORDEN) {
      const porMaterial = acumulados.get(familia);
      if (porMaterial === undefined) continue;
      const datos = FAMILIAS[familia];

      for (const [slug, acumulado] of porMaterial) {
        const item = armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.${familia}.${slug}`,
          descripcion: datos.descripcion(acumulado.material),
          unidad: datos.unidad,
          cantNeta: redondear2(acumulado.cantidad),
          desperdicioPct: datos.desperdicioPct,
          compra: { tipo: 'granel', multiplo: POR_ENTEROS },
          entidades: acumulado.entidades,
        });
        items.push(
          familia === 'revestimiento'
            ? conFuentesDeDato(item, cadena.fuentesDe(acumulado.entidades, 'alturaRevestimientoM'))
            : item,
        );
      }
    }

    // Debajo de cada m² de solado hay un contrapiso y una carpeta: son la misma
    // superficie, sin importar de qué material sea el piso que va arriba.
    const solados = [...(acumulados.get('solado')?.values() ?? [])];
    const m2Solado = redondear2(solados.reduce((total, acumulado) => total + acumulado.cantidad, 0));
    if (m2Solado > 0) {
      const bajoSolado = solados.flatMap((acumulado) => acumulado.entidades);
      items.push(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.contrapiso`,
          descripcion: 'Contrapiso bajo solado',
          unidad: 'm2',
          cantNeta: m2Solado,
          desperdicioPct: DESPERDICIO_BASE_PCT,
          compra: { tipo: 'global' },
          entidades: bajoSolado,
        }),
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.carpeta`,
          descripcion: 'Carpeta de nivelación bajo solado',
          unidad: 'm2',
          cantNeta: m2Solado,
          desperdicioPct: DESPERDICIO_BASE_PCT,
          compra: { tipo: 'global' },
          entidades: bajoSolado,
        }),
      );
    }

    // Al final, porque bloquea según lo emitido: el solado y el cielorraso del
    // mismo ambiente no usan la altura y salen igual, así que el rubro puede
    // tener ítems con los m² de revestimiento cortos o directamente ausentes.
    hallazgos.push(
      ...cadena.hallazgosFaltantes({
        rubro: RUBRO,
        unidad: 'm',
        computados: items,
        descripcion: (clave) =>
          `No encontré hasta qué altura llega el revestimiento y en el expediente tampoco hay ${datoEnFrase(clave)}. ` +
          'Cargá la altura una sola vez y la aplico a todos los ambientes que la esperan.',
      }),
    );

    return { items, hallazgos, ...conOrigenes(cadena.origenPorEntidad()) };
  },
} satisfies PlantillaRubro;
