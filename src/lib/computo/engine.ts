/**
 * Motor de cómputo: la única entrada pública del dominio.
 *
 * Recibe las entidades detectadas de una obra y devuelve ítems de cómputo y
 * hallazgos. Es **puro y determinístico**: no toca base, ni archivos, ni red;
 * las mismas entidades dan siempre el mismo resultado (condición para el
 * golden set y para el recómputo incremental).
 *
 * Lo que hace el engine, y solo esto:
 *   1. corre la plantilla de cada rubro pedido (los números viven en `rubros/`);
 *   2. aplica la regla de oro §11.b — un ítem con confianza por debajo del
 *      umbral no se emite y se degrada a consulta bloqueante;
 *   3. suma los sanity checks de obra;
 *   4. deduplica hallazgos por clave, que es única por obra (idempotencia);
 *   5. marca con el **peor origen de los campos que usó** cada ítem que se apoyó
 *      en un dato que no está escrito en la documentación (§11, P6 y §5.5).
 */
import { sanityChecks } from '@/lib/computo/sanity';
import {
  hallazgoBajaConfianza,
  propuestaDeLectura,
  UMBRAL_CONFIANZA,
} from '@/lib/hallazgos/taxonomia';
import { PLANTILLAS, type PlantillaRubro, type ResultadoComputo } from '@/lib/rubros/index';
import type {
  EntidadDetectada,
  HallazgoDetectado,
  ItemComputo,
  Origen,
  RubroId,
  TipoLamina,
  TipoObra,
} from '@/types/domain';
import { RUBROS } from '@/types/domain';

/**
 * Una entidad ya guardada: lo que detectó el análisis (`EntidadDetectada`) más
 * su identidad en la base y la lámina de la que salió. El motor necesita las
 * dos cosas: `laminaId` + `bbox` arman la `Fuente` de cada ítem (P1) e `id`
 * permite que un hallazgo apunte al campo exacto que hay que completar.
 */
export type EntidadPersistida = EntidadDetectada & { id: string; laminaId: string };

/**
 * Lo único que una plantilla necesita saber de una lámina: **de qué tipo es**.
 *
 * Existe porque una entidad no alcanza para saber qué significa: la misma V2
 * dibujada en la planta y listada en la planilla de carpinterías es UNA sola
 * ventana, y sin el tipo de lámina el motor no puede distinguir "hay dos" de
 * "la misma, dicha dos veces" (ver `src/lib/rubros/aberturas.ts`).
 *
 * Es un subconjunto estructural de `LaminaResumen` (`@/lib/deduccion/motor`) y
 * de la fila de `laminas`: quien ya tenga una de las dos puede pasarla tal cual.
 */
export interface LaminaDeComputo {
  id: string;
  tipo: TipoLamina | null;
}

/** Default de todo el motor: sin láminas, cada plantilla computa como siempre. */
const SIN_LAMINAS: readonly LaminaDeComputo[] = [];

export type { ResultadoComputo };
export { UMBRAL_CONFIANZA };

/**
 * Corre una plantilla y aplica la regla de confianza (§11.b): el ítem que se
 * apoya en datos por debajo del umbral no se emite —el sistema no computa lo
 * que no está seguro de haber leído— y sale como consulta bloqueante con la
 * provenance del ítem que se cayó, para que el arquitecto vea qué mirar.
 *
 * Cuando el ítem se apoya en **una** entidad (`entidadRef`), la consulta lleva
 * además lo que esa entidad ya tiene leído como propuesta: el dato no se tira,
 * se ofrece para confirmar. Un ítem **agregado** (la suma de varios ambientes,
 * por ejemplo) no lleva target ni propuesta, y es lo honesto: no hay UNA
 * entidad que confirmar, hay que ir a mirar cuál de todas está mal leída.
 */
export function computarRubro(
  entidades: readonly EntidadPersistida[],
  plantilla: PlantillaRubro,
  tipoObra: TipoObra,
  laminas: readonly LaminaDeComputo[] = SIN_LAMINAS,
): ResultadoComputo {
  const { items, hallazgos } = plantilla.computar(entidades, tipoObra, laminas);
  const emitidos: ItemComputo[] = [];
  const degradados: HallazgoDetectado[] = [];
  const porId = new Map(entidades.map((entidad) => [entidad.id, entidad]));

  for (const item of items) {
    if (item.confianza < UMBRAL_CONFIANZA) {
      const respaldo = item.entidadRef === undefined ? undefined : porId.get(item.entidadRef);
      const propuesta = respaldo === undefined ? null : propuestaDeLectura(respaldo);
      degradados.push(
        hallazgoBajaConfianza({
          rubro: item.rubro,
          claveItem: item.claveItem,
          descripcion: item.descripcion,
          confianza: item.confianza,
          fuentes: item.fuentes,
          ...(propuesta ? { propuesta } : {}),
        }),
      );
      continue;
    }
    emitidos.push(item);
  }

  return { items: emitidos, hallazgos: [...hallazgos, ...degradados] };
}

// ---------------------------------------------------------------------------
// Origen por campo (§11, §5.5): qué ítems se apoyaron en un dato no escrito
// ---------------------------------------------------------------------------

/**
 * Atributos de cada entidad cuyo valor NO está escrito en la documentación,
 * **con el origen de cada uno**: `entidadId → campo → origen`.
 *
 * Un campo puede haber entrado por una deducción que el arquitecto validó
 * (`deducido`), por una medición sobre el dibujo (`inferido`, §5.5) o por un
 * supuesto declarado (`supuesto`). Un campo mapeado a `explicito` está en el
 * mapa pero no ensucia nada: es lo que dice la documentación.
 *
 * El engine no sabe de la tabla `deducciones` ni quiere saber: recibe el mapa ya
 * armado (lo arma `recomputarObra`) y con eso alcanza.
 */
export type CamposDeducidos = ReadonlyMap<string, ReadonlyMap<string, Origen>>;

/** Default de `computarObra`: sin deducciones validadas nada cambia de origen. */
const SIN_DEDUCCIONES: CamposDeducidos = new Map();

/**
 * Los orígenes que un campo le puede contagiar a un ítem, **del peor al mejor**.
 *
 * La precedencia del §5.5 es `explicito < supuesto < deducido < inferido`: el
 * ítem sale con el peor origen de los campos que usó. `explicito` no está en la
 * lista porque no contagia nada —es el piso—, y por eso el orden de las pasadas
 * de control es exactamente este: la primera que marca un ítem gana.
 */
const ORIGENES_CONTAGIOSOS = ['inferido', 'deducido', 'supuesto'] as const;

/** `entidadId → campos` con exactamente ese origen (vacío si no hay ninguno). */
function camposConOrigen(
  camposDeducidos: CamposDeducidos,
  origen: Origen,
): Map<string, Set<string>> {
  const porEntidad = new Map<string, Set<string>>();
  for (const [entidadId, campos] of camposDeducidos) {
    const suyos = new Set<string>();
    for (const [campo, suyo] of campos) if (suyo === origen) suyos.add(campo);
    if (suyos.size > 0) porEntidad.set(entidadId, suyos);
  }
  return porEntidad;
}

/** Las mismas entidades, pero sin los atributos que aportó una deducción. */
function sinCampos(
  entidades: readonly EntidadPersistida[],
  porEntidad: ReadonlyMap<string, ReadonlySet<string>>,
): EntidadPersistida[] {
  return entidades.map((entidad) => {
    const campos = porEntidad.get(entidad.id);
    if (campos === undefined || campos.size === 0) return entidad;
    const atributos = { ...entidad.atributos };
    for (const campo of campos) delete atributos[campo];
    return { ...entidad, atributos };
  });
}

/** Todo lo del ítem menos su `origen`: si esto cambió, el dato deducido se usó. */
function huellaDeItem(item: ItemComputo): string {
  return JSON.stringify([
    item.rubro,
    item.descripcion,
    item.unidad,
    item.cantNeta,
    item.desperdicioPct,
    item.cantCompra,
    item.presentacion,
    item.confianza,
    item.fuentes.map((fuente) => [fuente.laminaId, fuente.bbox]),
  ]);
}

/**
 * Marca con `origen` los ítems que **efectivamente** usaron un campo de ese
 * origen.
 *
 * La prueba no es "la entidad tiene algún campo deducido" sino "el ítem sale
 * distinto sin ese campo": se computa una segunda vez con esos campos borrados
 * y se comparan las dos salidas. Un ítem que no cambia no se apoyó en el dato y
 * sigue siendo explícito —una altura deducida no vuelve deducidos a los ítems de
 * pintura que solo miran la superficie—, y una deducción que repite el default
 * de la plantilla (`caras: 2`) tampoco ensucia nada.
 *
 * Qué ítem se deja marcar depende del origen de la pasada, y la asimetría es
 * deliberada (decisión de producto sobre §5.5):
 *
 *  - un ítem `explicito` lo marca cualquier pasada;
 *  - un ítem que la plantilla emitió **`supuesto`** lo marca solo la pasada
 *    `inferido`. Un ítem que se apoya en una medida sacada del dibujo tiene que
 *    llevar el badge honesto —`inferido` es más débil que `supuesto`, y el más
 *    débil manda—. En cambio `deducido` **no** lo pisa: deducir cita una fuente
 *    documentada, y decir "se computó sobre un supuesto declarado" sigue siendo
 *    la advertencia más fuerte de las dos;
 *  - un ítem ya marcado por una pasada anterior no se toca, y como las pasadas
 *    van del peor origen al mejor, la primera marca es la que manda.
 */
function marcarOrigen(
  items: readonly ItemComputo[],
  control: readonly ItemComputo[],
  origen: Origen,
): ItemComputo[] {
  const huellas = new Map(control.map((item) => [item.claveItem, huellaDeItem(item)]));
  const marcable = (item: ItemComputo): boolean =>
    item.origen === 'explicito' || (origen === 'inferido' && item.origen === 'supuesto');

  return items.map((item) => {
    if (!marcable(item)) return item;
    const previa = huellas.get(item.claveItem);
    if (previa !== undefined && previa === huellaDeItem(item)) return item;
    return { ...item, origen };
  });
}

/** Deja el primer hallazgo de cada clave: la clave es única por obra. */
function deduplicarPorClave(hallazgos: readonly HallazgoDetectado[]): HallazgoDetectado[] {
  const vistas = new Set<string>();
  const unicos: HallazgoDetectado[] = [];
  for (const hallazgo of hallazgos) {
    if (vistas.has(hallazgo.clave)) continue;
    vistas.add(hallazgo.clave);
    unicos.push(hallazgo);
  }
  return unicos;
}

/**
 * Una pasada completa del motor sobre un juego de entidades.
 *
 * Los rubros se corren siempre en el orden canónico de `RUBROS` (no en el que
 * los pida el llamador) para que el resultado sea comparable entre corridas.
 * Los sanity checks son de obra, no de rubro: corren aunque se pida un solo
 * rubro, y sus hallazgos salen con `rubro: null`.
 */
function correrPlantillas(
  entidades: readonly EntidadPersistida[],
  tipoObra: TipoObra,
  plantillas: Record<RubroId, PlantillaRubro>,
  rubros: readonly RubroId[],
  laminas: readonly LaminaDeComputo[],
): ResultadoComputo {
  const items: ItemComputo[] = [];
  const hallazgos: HallazgoDetectado[] = [];

  for (const rubro of RUBROS) {
    if (!rubros.includes(rubro)) continue;
    const resultado = computarRubro(entidades, plantillas[rubro], tipoObra, laminas);
    items.push(...resultado.items);
    hallazgos.push(...resultado.hallazgos);
  }

  hallazgos.push(...sanityChecks(entidades));

  return { items, hallazgos: deduplicarPorClave(hallazgos) };
}

/**
 * Computa la obra entera.
 *
 * `camposDeducidos` es opcional y por defecto está vacío: sin deducciones
 * validadas el motor corre exactamente una vez y devuelve lo mismo de siempre.
 * Con deducciones validadas corre una pasada "de control" por cada origen en
 * juego, sin esos datos, para saber qué ítems dependen de ellos y marcarlos con
 * el peor origen de los campos que usaron.
 *
 * `laminas` también es opcional y por defecto está vacío: sin él, una plantilla
 * que mira el tipo de lámina (hoy solo aberturas) se comporta como antes de que
 * existiera el parámetro. **El pipeline siempre lo pasa** — una obra real sabe
 * qué lámina es cuál, y sin eso la misma carpintería se contaría dos veces.
 */
export function computarObra(
  entidades: readonly EntidadPersistida[],
  tipoObra: TipoObra,
  rubros: readonly RubroId[] = RUBROS,
  camposDeducidos: CamposDeducidos = SIN_DEDUCCIONES,
  laminas: readonly LaminaDeComputo[] = SIN_LAMINAS,
): ResultadoComputo {
  return computarObraConPlantillas(entidades, tipoObra, PLANTILLAS, {
    rubros,
    camposDeducidos,
    laminas,
  });
}

export interface OpcionesComputo {
  rubros?: readonly RubroId[];
  camposDeducidos?: CamposDeducidos;
  laminas?: readonly LaminaDeComputo[];
}

/**
 * Lo mismo que `computarObra`, pero con **otras plantillas**.
 *
 * Existe para que el pipeline pueda computar con la configuración del estudio
 * aplicada (`plantillasConConfig(config)` de `src/lib/rubros/overrides.ts`): el
 * desperdicio de cada rubro es configurable por PRD (P2) y el motor no tiene por
 * qué enterarse de que existe una tabla `estudios` — recibe las plantillas ya
 * armadas y las corre.
 *
 * `computarObra` es el caso por defecto de esta función, con `PLANTILLAS`.
 */
export function computarObraConPlantillas(
  entidades: readonly EntidadPersistida[],
  tipoObra: TipoObra,
  plantillas: Record<RubroId, PlantillaRubro>,
  opciones: OpcionesComputo = {},
): ResultadoComputo {
  const rubros = opciones.rubros ?? RUBROS;
  const camposDeducidos = opciones.camposDeducidos ?? SIN_DEDUCCIONES;
  const laminas = opciones.laminas ?? SIN_LAMINAS;

  const resultado = correrPlantillas(entidades, tipoObra, plantillas, rubros, laminas);
  if (camposDeducidos.size === 0) return resultado;

  // Una pasada de control por origen presente, del peor al mejor: cada una
  // responde "¿este ítem cambia si le saco los campos de ESTE origen?". Con un
  // solo origen en juego —el caso de siempre— es exactamente una pasada extra.
  let items = resultado.items;
  for (const origen of ORIGENES_CONTAGIOSOS) {
    const campos = camposConOrigen(camposDeducidos, origen);
    if (campos.size === 0) continue;
    const control = correrPlantillas(
      sinCampos(entidades, campos),
      tipoObra,
      plantillas,
      rubros,
      laminas,
    );
    items = marcarOrigen(items, control.items, origen);
  }

  // Los hallazgos son los de la pasada real: la de control es una hipótesis
  // ("¿qué pasaría si el dato deducido no estuviera?"), no el estado de la obra.
  return { items, hallazgos: resultado.hallazgos };
}
