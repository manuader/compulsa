/**
 * Rubro construcción en seco: tabiques de durlock.
 *
 * Datos de la plantilla (editables acá, nunca en el engine): placa de
 * 1,20 × 2,40 m = 2,88 m² con 12% de desperdicio, perfiles en barras/tiras de
 * 2,60 m, montantes cada 0,40 m, y los rendimientos de tornillos, masilla y
 * cinta por m² de placa colocada.
 *
 * Los ítems se emiten con clave fija (`seco.placas`, `seco.soleras`, …) sumando
 * todos los tabiques computables de la obra: el corralón cotiza el total del
 * rubro, no tabique por tabique.
 *
 * La altura pasa por la **cadena de respaldo** (`respaldo.ts`): el atributo del
 * tabique, si no está el dato de obra del local (`altura_local.<nivel>`) y, si
 * tampoco, UNA consulta para todos los tabiques que la esperan — la altura de
 * un local se dibuja en el corte una vez, y preguntarla por tabique era
 * preguntar lo mismo cuatro veces.
 */
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { armarItem, type Presentacion } from '@/lib/computo/presentacion';
import { redondear2, redondearEntero } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  hallazgoDatoFaltante,
  leerMedida,
  leerNumero,
  leerTexto,
} from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import {
  cadenaDeRespaldo,
  clavesAlturaLocal,
  conFuentesDeDato,
  conOrigenes,
  sufijoDeClave,
  type DatosObra,
} from '@/lib/rubros/respaldo';
import type { HallazgoDetectado, ItemComputo, TipoObra } from '@/types/domain';

const RUBRO = 'seco';

/** Datos de la plantilla. */
const CARAS_DEFAULT = 2;
const DESPERDICIO_PLACAS_PCT = 12;
const SEPARACION_MONTANTES_M = 0.4;
const TORNILLOS_POR_M2 = 15;
const MASILLA_KG_POR_M2 = 0.9;
const CINTA_ML_POR_M2 = 2.3;
const SISTEMA_ESPERADO = 'durlock';

const PLACA: Presentacion = { singular: 'placa', plural: 'placas', contenido: 2.88, detalle: '2,88 m²' };
const BARRA: Presentacion = { singular: 'barra', plural: 'barras', contenido: 2.6, detalle: '2,60 m' };
const TIRA: Presentacion = { singular: 'tira', plural: 'tiras', contenido: 1, detalle: '2,60 m' };
const CAJA: Presentacion = { singular: 'caja', plural: 'cajas', contenido: 500, detalle: '500 u' };
const BALDE: Presentacion = { singular: 'balde', plural: 'baldes', contenido: 15, detalle: '15 kg' };
const ROLLO: Presentacion = { singular: 'rollo', plural: 'rollos', contenido: 90, detalle: '90 m' };

/** Ruido binario: `2 / 0,4` da 5.000000000000001 y compraría un montante de más. */
const EPSILON = 1e-9;

export const plantillaSeco = {
  id: RUBRO,
  nombre: 'Construcción en seco',
  desperdicioDefaultPct: DESPERDICIO_PLACAS_PCT,

  computar(
    entidades: readonly EntidadPersistida[],
    _tipoObra: TipoObra,
    _laminas?: readonly LaminaDeComputo[],
    datosObra?: DatosObra,
  ): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const usadas: EntidadPersistida[] = [];
    const cadena = cadenaDeRespaldo(datosObra);
    let m2 = 0;
    let mlSoleras = 0;
    let montantes = 0;

    for (const entidad of entidades) {
      if (entidad.tipo !== 'tabique') continue;
      if (alcanceDeReforma(entidad.estadoReforma) !== 'completo') continue; // existente/demoler: fuera del rubro

      const sistema = leerTexto(entidad, 'tipo');
      if (sistema !== null && sistema.toLowerCase() !== SISTEMA_ESPERADO) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.sistema_tabique.${entidad.nombre}`,
            checklistItem: `${RUBRO}.sistema_tabique`,
            descripcion:
              `El tabique ${entidad.nombre} figura como "${sistema}", no como durlock: no lo computo con la plantilla de construcción en seco. ` +
              'Corregí el sistema constructivo o computalo en el rubro que corresponda.',
            entidad,
            campos: ['tipo'],
          }),
        );
        continue;
      }

      const altura = cadena.medida(entidad, 'alturaM', clavesAlturaLocal(entidad));
      if (altura === null) continue; // la consulta agrupada sale al final, una sola vez

      const largo = leerMedida(entidad, 'largoM');
      if (largo === null) {
        hallazgos.push(
          hallazgoDatoFaltante({
            rubro: RUBRO,
            clave: `${RUBRO}.largo_tabiques.${entidad.nombre}`,
            checklistItem: `${RUBRO}.largo_tabiques`,
            descripcion:
              `No encontré el largo del tabique ${entidad.nombre}. Sin largo no computo sus m² de placa: ` +
              'cargá el dato o indicá la planta donde está acotado.',
            entidad,
            campos: ['largoM'],
          }),
        );
        continue;
      }

      const caras = leerNumero(entidad, 'caras') ?? CARAS_DEFAULT;
      m2 += largo * altura * caras;
      mlSoleras += 2 * largo; // solera inferior + superior
      montantes += Math.ceil(largo / SEPARACION_MONTANTES_M - EPSILON) + 1;
      usadas.push(entidad);
    }

    // Una sola consulta por dato de obra que falta, con todos los tabiques que
    // la esperan adentro.
    hallazgos.push(
      ...cadena.hallazgosFaltantes({
        rubro: RUBRO,
        unidad: 'm',
        descripcion: (clave) =>
          `No encontré la altura de estos tabiques ni una altura de local declarada para «${sufijoDeClave(clave)}». ` +
          'Cargá la altura del local una sola vez y la aplico a todos, o indicá el corte donde está acotada.',
      }),
    );

    if (usadas.length === 0) return { items: [], hallazgos };

    /** El corte del que salió la altura, si la puso un dato de obra (P1). */
    const fuentesAltura = cadena.fuentesDe(usadas, 'alturaM');
    const conAltura = (item: ItemComputo): ItemComputo => conFuentesDeDato(item, fuentesAltura);

    const m2Netos = redondear2(m2);
    const items: ItemComputo[] = [
      // Los cuatro que salen de los m² llevan la fuente de la altura; las
      // soleras y los montantes salen del largo y no la necesitan.
      conAltura(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.placas`,
          descripcion: 'Placa de roca de yeso (1,20 × 2,40 m)',
          unidad: 'm2',
          cantNeta: m2Netos,
          desperdicioPct: DESPERDICIO_PLACAS_PCT,
          compra: { tipo: 'bulto', presentacion: PLACA },
          entidades: usadas,
        }),
      ),
      armarItem({
        rubro: RUBRO,
        claveItem: `${RUBRO}.soleras`,
        descripcion: 'Solera para tabique de durlock',
        unidad: 'ml',
        cantNeta: redondear2(mlSoleras),
        desperdicioPct: 0,
        compra: { tipo: 'bulto', presentacion: BARRA },
        entidades: usadas,
      }),
      armarItem({
        rubro: RUBRO,
        claveItem: `${RUBRO}.montantes`,
        descripcion: 'Montante para tabique de durlock (cada 0,40 m)',
        unidad: 'u',
        cantNeta: redondearEntero(montantes),
        desperdicioPct: 0,
        compra: { tipo: 'bulto', presentacion: TIRA },
        entidades: usadas,
      }),
      conAltura(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.tornillos`,
          descripcion: 'Tornillos para placa de roca de yeso',
          unidad: 'u',
          cantNeta: redondearEntero(TORNILLOS_POR_M2 * m2Netos),
          desperdicioPct: 0,
          compra: { tipo: 'bulto', presentacion: CAJA },
          entidades: usadas,
        }),
      ),
      conAltura(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.masilla`,
          descripcion: 'Masilla para juntas',
          unidad: 'kg',
          cantNeta: redondear2(MASILLA_KG_POR_M2 * m2Netos),
          desperdicioPct: 0,
          compra: { tipo: 'bulto', presentacion: BALDE },
          entidades: usadas,
        }),
      ),
      conAltura(
        armarItem({
          rubro: RUBRO,
          claveItem: `${RUBRO}.cinta`,
          descripcion: 'Cinta de papel para juntas',
          unidad: 'ml',
          cantNeta: redondear2(CINTA_ML_POR_M2 * m2Netos),
          desperdicioPct: 0,
          compra: { tipo: 'bulto', presentacion: ROLLO },
          entidades: usadas,
        }),
      ),
    ];

    return { items, hallazgos, ...conOrigenes(cadena.origenPorEntidad()) };
  },
} satisfies PlantillaRubro;
