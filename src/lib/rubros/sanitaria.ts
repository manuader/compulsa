/**
 * Rubro instalación sanitaria: cañerías, accesorios y artefactos.
 *
 * Tres cuentas, ninguna estimada:
 *
 *  - **Cañería** (`tramo`): metros lineales por **sistema + diámetro**, que es
 *    como se compra y como se cotiza. La presentación es la tira de 4 m, así que
 *    6,5 ml de Ø20 son 2 tiras, no 6,5 m sueltos.
 *  - **Accesorios** (`accesorio`): unidades por **tipo + diámetro**. Un codo de
 *    Ø20 y uno de Ø110 no son el mismo ítem ni para el corralón ni para el
 *    plomero.
 *  - **Artefactos** (`artefacto`): unidades por tipo de artefacto.
 *
 * Los metros de cañería que unen un artefacto con su desagüe **no se estiman**:
 * si el recorrido no está dibujado, no hay tramo, y no hay ítem. Lo único que el
 * rubro hace con esa ausencia es avisarla (control del §22, abajo).
 *
 * Un tramo al que le falta el sistema, el diámetro o la longitud no se computa:
 * sale como consulta bloqueante y sus metros no entran a ninguna cuenta (P4,
 * mismo criterio que el tabique sin altura en `seco.ts`).
 */
import { slug } from '@/lib/analysis/tipos';
import type { EntidadPersistida, LaminaDeComputo } from '@/lib/computo/engine';
import { armarItem, fuentesDeEntidades, type ModoCompra, type Presentacion } from '@/lib/computo/presentacion';
import { redondear2, redondearEntero } from '@/lib/computo/unidades';
import {
  alcanceDeReforma,
  hallazgoDatoFaltante,
  hallazgoInconsistencia,
  leerMedida,
  leerNumero,
  leerTexto,
} from '@/lib/hallazgos/taxonomia';
import type { PlantillaRubro, ResultadoComputo } from '@/lib/rubros/index';
import type { DatoObraResuelto, HallazgoDetectado, ItemComputo, TipoObra, Unidad } from '@/types/domain';

const RUBRO = 'sanitaria';

/** Datos de la plantilla (editables acá, nunca en el engine). */
const DESPERDICIO_CANIERIA_PCT = 5;
const TIRA: Presentacion = { singular: 'tira', plural: 'tiras', contenido: 4, detalle: '4 m' };

/**
 * Accesorios y artefactos se cuentan de a uno y se compran sueltos: no hay
 * bulto que redondear, así que la cantidad de compra es la neta.
 */
const SIN_BULTO: ModoCompra = { tipo: 'global' };

const SISTEMAS = ['af', 'ac', 'cloacal', 'pluvial'] as const;
type SistemaSanitario = (typeof SISTEMAS)[number];

/** La etiqueta lleva la preposición adentro: "Cañería de agua fría" / "Cañería cloacal". */
const ETIQUETA_SISTEMA: Record<SistemaSanitario, string> = {
  af: 'de agua fría',
  ac: 'de agua caliente',
  cloacal: 'cloacal',
  pluvial: 'pluvial',
};

const TIPOS_ACCESORIO = ['codo90', 'codo45', 'te', 'valvula'] as const;
type TipoAccesorio = (typeof TIPOS_ACCESORIO)[number];

const ETIQUETA_ACCESORIO: Record<TipoAccesorio, string> = {
  codo90: 'Codo 90°',
  codo45: 'Codo 45°',
  te: 'Te',
  valvula: 'Válvula',
};

/** El sistema que tiene que acompañar a un artefacto (control del §22). */
const SISTEMA_DESAGUE: SistemaSanitario = 'cloacal';

/** Orden de las familias en la planilla: primero la cañería, después las piezas. */
const FAMILIA_CANIERIA = 0;
const FAMILIA_ACCESORIO = 1;
const FAMILIA_ARTEFACTO = 2;

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/**
 * El diámetro, en la forma en la que dos diámetros son el mismo ítem: en
 * minúsculas, sin el símbolo `ø` y sin la unidad. `"Ø110"`, `"110 mm"` y `"110"`
 * son la misma cañería, y con el texto crudo eran tres ítems distintos en la
 * planilla (y tres pedidos distintos al corralón).
 */
function normalizarDiametro(valor: string): string {
  return valor
    .toLowerCase()
    .replace(/ø/g, '')
    .replace(/\s+/g, '')
    .replace(/(mm|cm|m)$/, '');
}

/** El diámetro de la entidad, o `null` si no está. Tolera que venga como número. */
function leerDiametro(entidad: EntidadPersistida): string | null {
  const texto = leerTexto(entidad, 'diametro');
  if (texto !== null) {
    const normalizado = normalizarDiametro(texto);
    return normalizado === '' ? null : normalizado;
  }
  const numero = leerNumero(entidad, 'diametro');
  return numero === null ? null : String(numero);
}

/** Un sistema que el rubro sabe computar, o `null` (no declarado o desconocido). */
function leerSistema(entidad: EntidadPersistida): SistemaSanitario | null {
  const texto = leerTexto(entidad, 'sistema')?.toLowerCase() ?? null;
  return SISTEMAS.find((sistema) => sistema === texto) ?? null;
}

/**
 * Cómo se llama el artefacto para agrupar: su `tipo` si lo declara, y si no su
 * nombre. Dos inodoros llamados "Inodoro 1" e "Inodoro 2" son dos unidades del
 * mismo ítem, no dos ítems de uno.
 */
function etiquetaArtefacto(entidad: EntidadPersistida): string {
  return leerTexto(entidad, 'tipo') ?? entidad.nombre;
}

// ---------------------------------------------------------------------------
// Agrupación
// ---------------------------------------------------------------------------

interface Grupo {
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  desperdicioPct: number;
  compra: ModoCompra;
  /** Orden en la planilla: familia, posición dentro de la familia, diámetro. */
  orden: [number, number, number];
  cantidad: number;
  entidades: EntidadPersistida[];
}

type NuevoGrupo = Omit<Grupo, 'cantidad' | 'entidades'>;

/** Los diámetros ordenan por número (Ø40 antes que Ø110), no por texto. */
function ordenDeDiametro(diametro: string): number {
  const numero = Number(diametro.replace(',', '.'));
  return Number.isFinite(numero) ? numero : Number.POSITIVE_INFINITY;
}

function compararGrupos(a: Grupo, b: Grupo): number {
  for (let i = 0; i < a.orden.length; i += 1) {
    const diferencia = a.orden[i]! - b.orden[i]!;
    if (diferencia !== 0) return diferencia;
  }
  if (a.claveItem === b.claveItem) return 0;
  return a.claveItem < b.claveItem ? -1 : 1;
}

// ---------------------------------------------------------------------------
// La plantilla
// ---------------------------------------------------------------------------

export const plantillaSanitaria = {
  id: RUBRO,
  nombre: 'Instalación sanitaria',
  desperdicioDefaultPct: DESPERDICIO_CANIERIA_PCT,

  /**
   * `laminas` y `datosObra` se ignoran a propósito: acá no hay ningún campo que
   * la cadena de respaldo del §5.2 pueda completar (las alturas son de muros y
   * ambientes), y una lámina no cambia lo que significa un tramo.
   */
  computar(
    entidades: readonly EntidadPersistida[],
    _tipoObra: TipoObra,
    _laminas?: readonly LaminaDeComputo[],
    _datosObra?: ReadonlyMap<string, DatoObraResuelto>,
  ): ResultadoComputo {
    const hallazgos: HallazgoDetectado[] = [];
    const grupos = new Map<string, Grupo>();

    const sumar = (grupo: NuevoGrupo, cantidad: number, entidad: EntidadPersistida): void => {
      const previo = grupos.get(grupo.claveItem);
      if (previo) {
        previo.cantidad += cantidad;
        previo.entidades.push(entidad);
        return;
      }
      grupos.set(grupo.claveItem, { ...grupo, cantidad, entidades: [entidad] });
    };

    for (const entidad of entidades) {
      // Lo existente no está en el alcance y lo que se demuele lo computa el
      // rubro demolición: acá no se pregunta por ninguno de los dos.
      if (alcanceDeReforma(entidad.estadoReforma) !== 'completo') continue;

      if (entidad.tipo === 'tramo') {
        const sistema = leerSistema(entidad);
        if (sistema === null) {
          const declarado = leerTexto(entidad, 'sistema');
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.sistema_tramos.${entidad.nombre}`,
              checklistItem: `${RUBRO}.sistema_tramos`,
              descripcion:
                declarado === null
                  ? `El tramo ${entidad.nombre} no dice a qué sistema pertenece (agua fría, agua caliente, cloacal o pluvial). ` +
                    'Sin eso no sé qué cañería computarle: indicá el sistema o marcá la lámina donde está referenciado.'
                  : `El tramo ${entidad.nombre} figura como "${declarado}", que no es ninguno de los sistemas del rubro ` +
                    '(agua fría, agua caliente, cloacal o pluvial): no lo computo. Corregí el sistema o computalo en el rubro que corresponda.',
              entidad,
              campos: ['sistema'],
            }),
          );
          continue;
        }

        const diametro = leerDiametro(entidad);
        if (diametro === null) {
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.diametro_tramos.${entidad.nombre}`,
              checklistItem: `${RUBRO}.diametro_tramos`,
              descripcion:
                `No encontré el diámetro del tramo ${entidad.nombre}. Sin diámetro no sé qué cañería pedir: ` +
                'cargalo o indicá la lámina donde está escrito.',
              entidad,
              campos: ['diametro'],
            }),
          );
          continue;
        }

        const longitud = leerMedida(entidad, 'longitudM');
        if (longitud === null) {
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.longitud_tramos.${entidad.nombre}`,
              checklistItem: `${RUBRO}.longitud_tramos`,
              descripcion:
                `No encontré la longitud del tramo ${entidad.nombre}. Sin longitud no computo sus metros de cañería: ` +
                'cargá el dato o indicá la lámina donde está acotado.',
              entidad,
              campos: ['longitudM'],
            }),
          );
          continue;
        }

        sumar(
          {
            claveItem: `${RUBRO}.canieria.${sistema}.${diametro}`,
            descripcion: `Cañería ${ETIQUETA_SISTEMA[sistema]} Ø ${diametro}`,
            unidad: 'ml',
            desperdicioPct: DESPERDICIO_CANIERIA_PCT,
            compra: { tipo: 'bulto', presentacion: TIRA },
            orden: [FAMILIA_CANIERIA, SISTEMAS.indexOf(sistema), ordenDeDiametro(diametro)],
          },
          longitud,
          entidad,
        );
        continue;
      }

      if (entidad.tipo === 'accesorio') {
        const declarado = leerTexto(entidad, 'tipo')?.toLowerCase() ?? null;
        const tipo = TIPOS_ACCESORIO.find((candidato) => candidato === declarado) ?? null;
        if (tipo === null) {
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.tipo_accesorios.${entidad.nombre}`,
              checklistItem: `${RUBRO}.tipo_accesorios`,
              descripcion:
                declarado === null
                  ? `El accesorio ${entidad.nombre} no dice qué pieza es (codo 90°, codo 45°, te o válvula). ` +
                    'Sin eso no lo computo: cargá el tipo o indicá la lámina donde está referenciado.'
                  : `El accesorio ${entidad.nombre} figura como "${declarado}", que no es ninguna de las piezas del rubro ` +
                    '(codo 90°, codo 45°, te o válvula): no lo computo. Corregí el tipo o pedilo aparte.',
              entidad,
              campos: ['tipo'],
            }),
          );
          continue;
        }

        const diametro = leerDiametro(entidad);
        if (diametro === null) {
          hallazgos.push(
            hallazgoDatoFaltante({
              rubro: RUBRO,
              clave: `${RUBRO}.diametro_accesorios.${entidad.nombre}`,
              checklistItem: `${RUBRO}.diametro_accesorios`,
              descripcion:
                `No encontré el diámetro del accesorio ${entidad.nombre}. Sin diámetro no sé qué pieza pedir: ` +
                'cargalo o indicá la lámina donde está escrito.',
              entidad,
              campos: ['diametro'],
            }),
          );
          continue;
        }

        sumar(
          {
            claveItem: `${RUBRO}.accesorio.${tipo}.${diametro}`,
            descripcion: `${ETIQUETA_ACCESORIO[tipo]} Ø ${diametro}`,
            unidad: 'u',
            desperdicioPct: 0,
            compra: SIN_BULTO,
            orden: [FAMILIA_ACCESORIO, TIPOS_ACCESORIO.indexOf(tipo), ordenDeDiametro(diametro)],
          },
          1,
          entidad,
        );
        continue;
      }

      if (entidad.tipo === 'artefacto') {
        const etiqueta = etiquetaArtefacto(entidad);
        sumar(
          {
            claveItem: `${RUBRO}.artefacto.${slug(etiqueta)}`,
            descripcion: `Artefacto sanitario: ${etiqueta}`,
            unidad: 'u',
            desperdicioPct: 0,
            compra: SIN_BULTO,
            orden: [FAMILIA_ARTEFACTO, 0, 0],
          },
          1,
          entidad,
        );
      }
    }

    hallazgos.push(...correspondenciaDeArtefactos(entidades));

    const items: ItemComputo[] = [...grupos.values()].sort(compararGrupos).map((grupo) =>
      armarItem({
        rubro: RUBRO,
        claveItem: grupo.claveItem,
        descripcion: grupo.descripcion,
        unidad: grupo.unidad,
        cantNeta: grupo.unidad === 'u' ? redondearEntero(grupo.cantidad) : redondear2(grupo.cantidad),
        desperdicioPct: grupo.desperdicioPct,
        compra: grupo.compra,
        entidades: grupo.entidades,
      }),
    );

    return { items, hallazgos };
  },
} satisfies PlantillaRubro;

// ---------------------------------------------------------------------------
// Control §22: cada artefacto con su desagüe
// ---------------------------------------------------------------------------

/**
 * Un artefacto necesita un desagüe, y el desagüe se dibuja como un tramo
 * cloacal en el mismo ambiente. Cuando ese tramo no está, el rubro **avisa**:
 * inconsistencia **no bloqueante**, porque el desagüe puede estar dibujado en
 * otra lámina o simplemente faltar en el proyecto, y ninguna de las dos cosas
 * justifica frenar la aprobación del rubro entero.
 *
 * Lo que jamás pasa es que el tramo se cree solo (P4): el sistema no dibuja
 * cañerías que el proyectista no dibujó, ni computa los metros que tendrían.
 *
 * **El control se saltea cuando el artefacto no declara `ambiente`.** Sin ese
 * atributo no hay forma honesta de decir a qué desagüe le corresponde —cruzar
 * por bbox entre láminas distintas sería adivinar—, y avisar "no encontré el
 * desagüe" cuando lo que falta es el ambiente sería mandar al arquitecto a
 * buscar un problema que no existe.
 *
 * Un tramo cloacal **existente** cuenta como desagüe (en una reforma, el
 * desagüe que ya está construido sirve); uno a demoler, no.
 */
function correspondenciaDeArtefactos(entidades: readonly EntidadPersistida[]): HallazgoDetectado[] {
  const conDesague = new Set<string>();
  for (const entidad of entidades) {
    if (entidad.tipo !== 'tramo') continue;
    if (alcanceDeReforma(entidad.estadoReforma) === 'demolicion') continue;
    if (leerSistema(entidad) !== SISTEMA_DESAGUE) continue;
    const ambiente = leerTexto(entidad, 'ambiente');
    if (ambiente !== null) conDesague.add(slug(ambiente));
  }

  const hallazgos: HallazgoDetectado[] = [];
  for (const entidad of entidades) {
    if (entidad.tipo !== 'artefacto') continue;
    if (alcanceDeReforma(entidad.estadoReforma) !== 'completo') continue;
    const ambiente = leerTexto(entidad, 'ambiente');
    if (ambiente === null) continue;
    if (conDesague.has(slug(ambiente))) continue;

    hallazgos.push(
      hallazgoInconsistencia({
        rubro: RUBRO,
        clave: `${RUBRO}.correspondencia.${slug(entidad.nombre)}`,
        checklistItem: `${RUBRO}.correspondencia`,
        descripcion:
          `${entidad.nombre} está en ${ambiente} y no hay ningún tramo de desagüe cloacal en ese ambiente. ` +
          'Puede que el desagüe esté dibujado en otra lámina o que falte proyectarlo: revisalo. ' +
          'No agrego el tramo por mi cuenta ni computo sus metros.',
        fuentes: fuentesDeEntidades([entidad]),
      }),
    );
  }
  return hallazgos;
}
