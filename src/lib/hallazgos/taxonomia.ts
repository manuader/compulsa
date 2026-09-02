/**
 * Taxonomía de huecos (PRD §11) y constructores de hallazgos.
 *
 * Todo dato que un rubro necesita cae en exactamente una de cinco clases:
 * `explicito`, `deducible`, `supuesto`, `existente`, `faltante`. La regla dura
 * es P4: **el sistema jamás rellena un dato**. Lo que no está y no se deduce
 * sale como hallazgo a la bandeja, nunca como un número inventado.
 *
 * Acá viven también los lectores de atributos (`leerNumero`, `leerMedida`,
 * `leerTexto`): decidir si un dato está o no está ES la clasificación, y las
 * cuatro plantillas de rubro necesitan tomar esa decisión igual.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { fuentesDeEntidades } from '@/lib/computo/presentacion';
import type {
  DatoObraResuelto,
  EstadoReforma,
  Fuente,
  HallazgoDetectado,
  RubroId,
  TipoHallazgo,
  Unidad,
  ValorPropuesto,
} from '@/types/domain';

// ---------------------------------------------------------------------------
// Las cinco clases (§11)
// ---------------------------------------------------------------------------

export type ClaseHueco = 'explicito' | 'deducible' | 'supuesto' | 'existente' | 'faltante';

export const CLASES_HUECO = [
  'explicito',
  'deducible',
  'supuesto',
  'existente',
  'faltante',
] as const satisfies readonly ClaseHueco[];

/** Qué tipo de hallazgo genera cada clase (las resueltas no generan ninguno). */
export const TIPO_POR_CLASE: Record<ClaseHueco, TipoHallazgo | null> = {
  explicito: null,
  deducible: null,
  supuesto: 'supuesto',
  existente: 'existente_confirmar',
  faltante: 'faltante',
};

/** Solo el faltante real frena la aprobación del rubro (RF-404). */
export const BLOQUEANTE_POR_CLASE: Record<ClaseHueco, boolean> = {
  explicito: false,
  deducible: false,
  supuesto: false,
  existente: false,
  faltante: true,
};

/** Umbral de la regla de oro §11.b: por debajo, todo degrada a consulta. */
export const UMBRAL_CONFIANZA = 0.7;

export interface EntradaHueco {
  /** El dato tal como aparece en la documentación, si aparece. */
  valorExplicito?: number | string | boolean | null;
  /** Deducción documental (≥ 2 fuentes de la misma doc) con su regla. */
  deduccion?: { valor: number | string; regla: string; fuentes: Fuente[]; confianza: number };
  /** Supuesto normativo/estándar aplicable, citando la norma. */
  supuestoEstandar?: { valor: number | string; norma: string };
  /** Contexto de reforma: si el elemento ya está construido, el dato no falta. */
  estadoReforma?: EstadoReforma;
  /** Datos de índole estructural o de seguridad (RF-506). */
  estructural?: boolean;
}

export interface Clasificacion {
  clase: ClaseHueco;
  tipo: TipoHallazgo | null;
  bloqueante: boolean;
  motivo: string;
}

/**
 * Clasifica un dato faltante según §11. El orden importa: lo explícito manda,
 * después el contexto de reforma, después RF-506 (nada estructural se
 * auto-deduce), y recién ahí deducción → supuesto → faltante real.
 */
export function clasificarHueco(entrada: EntradaHueco): Clasificacion {
  const armar = (clase: ClaseHueco, motivo: string): Clasificacion => ({
    clase,
    tipo: TIPO_POR_CLASE[clase],
    bloqueante: BLOQUEANTE_POR_CLASE[clase],
    motivo,
  });

  if (entrada.valorExplicito !== undefined && entrada.valorExplicito !== null && entrada.valorExplicito !== '') {
    return armar('explicito', 'El dato está en la documentación.');
  }
  if (entrada.estadoReforma === 'existente') {
    return armar('existente', 'El elemento ya está construido: no está dentro del alcance de la obra.');
  }
  if (entrada.estructural) {
    return armar('faltante', 'Dato estructural o de seguridad: consultá al profesional competente.');
  }
  if (entrada.deduccion) {
    return entrada.deduccion.confianza >= UMBRAL_CONFIANZA
      ? armar('deducible', `Deducido por "${entrada.deduccion.regla}"; requiere validación.`)
      : armar('faltante', `La deducción "${entrada.deduccion.regla}" quedó por debajo del umbral de confianza.`);
  }
  if (entrada.supuestoEstandar) {
    return armar('supuesto', `Propuesto según ${entrada.supuestoEstandar.norma}; confirmalo antes de computar.`);
  }
  return armar('faltante', 'No hay fuente ni regla que lo resuelva.');
}

// ---------------------------------------------------------------------------
// Reglas de reforma
// ---------------------------------------------------------------------------

/** Qué computa una entidad según su estado en la reforma. */
export type AlcanceComputo = 'completo' | 'demolicion' | 'ninguno';

export function alcanceDeReforma(estado: EstadoReforma): AlcanceComputo {
  switch (estado) {
    case 'existente':
      return 'ninguno';
    case 'demoler':
      return 'demolicion';
    case 'nueva':
    case 'na':
      return 'completo';
  }
}

// ---------------------------------------------------------------------------
// Lectura de atributos: ¿el dato está, o es un hueco?
// ---------------------------------------------------------------------------

/** Número del atributo, o `null` si no está (tolera números escritos como texto). */
export function leerNumero(entidad: EntidadPersistida, campo: string): number | null {
  const valor = entidad.atributos[campo];
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim() !== '') {
    const parseado = Number(valor.replace(',', '.'));
    return Number.isFinite(parseado) ? parseado : null;
  }
  return null;
}

/** Medida física: además de estar, tiene que ser positiva. */
export function leerMedida(entidad: EntidadPersistida, campo: string): number | null {
  const valor = leerNumero(entidad, campo);
  return valor !== null && valor > 0 ? valor : null;
}

/** Texto del atributo, o `null` si no está. */
export function leerTexto(entidad: EntidadPersistida, campo: string): string | null {
  const valor = entidad.atributos[campo];
  if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Constructores de hallazgos (una sola forma para todo el motor)
// ---------------------------------------------------------------------------

export interface EntradaDatoFaltante {
  rubro: RubroId | null;
  /** Única por obra, para idempotencia: "seco.altura_tabiques.T1". */
  clave: string;
  /** Familia de la clave, o sea el ítem del checklist: "seco.altura_tabiques". */
  checklistItem?: string;
  descripcion: string;
  entidad: EntidadPersistida;
  /**
   * Campos que se completan al responder el hallazgo, en el orden en que se
   * piden. **Todos** los que faltan, no el primero: una tarjeta con el ancho y
   * el alto juntos se responde una vez; de a uno, la consulta reaparece.
   */
  campos: string[];
}

/** Clase 5: faltante real. Bloquea la aprobación del rubro. */
export function hallazgoDatoFaltante(entrada: EntradaDatoFaltante): HallazgoDetectado {
  return {
    tipo: 'faltante',
    rubro: entrada.rubro,
    descripcion: entrada.descripcion,
    clave: entrada.clave,
    ...(entrada.checklistItem ? { checklistItem: entrada.checklistItem } : {}),
    bloqueante: true,
    fuentes: fuentesDeEntidades([entrada.entidad]),
    targetRef: { entidadId: entrada.entidad.id, campos: entrada.campos },
  };
}

export interface EntradaSupuesto {
  rubro: RubroId | null;
  clave: string;
  checklistItem?: string;
  descripcion: string;
  entidades: readonly EntidadPersistida[];
}

/** Clase 3: se computó sobre un supuesto declarado. No bloquea, pero se avisa. */
export function hallazgoSupuesto(entrada: EntradaSupuesto): HallazgoDetectado {
  return {
    tipo: 'supuesto',
    rubro: entrada.rubro,
    descripcion: entrada.descripcion,
    clave: entrada.clave,
    ...(entrada.checklistItem ? { checklistItem: entrada.checklistItem } : {}),
    bloqueante: false,
    fuentes: fuentesDeEntidades(entrada.entidades),
  };
}

export interface EntradaInconsistencia {
  rubro: RubroId | null;
  clave: string;
  checklistItem?: string;
  descripcion: string;
  fuentes: Fuente[];
}

/** Dos datos de la documentación que no cierran entre sí (sanity checks). */
export function hallazgoInconsistencia(entrada: EntradaInconsistencia): HallazgoDetectado {
  return {
    tipo: 'inconsistencia',
    rubro: entrada.rubro,
    descripcion: entrada.descripcion,
    clave: entrada.clave,
    ...(entrada.checklistItem ? { checklistItem: entrada.checklistItem } : {}),
    bloqueante: false,
    fuentes: entrada.fuentes,
  };
}

// ---------------------------------------------------------------------------
// Datos de obra: los hechos que valen para toda la obra
// ---------------------------------------------------------------------------

/** Namespace de las consultas que apuntan a un dato de obra: `dato_obra.<clave>`. */
export const PREFIJO_DATO_OBRA = 'dato_obra.';

/**
 * El único "campo" de una consulta de dato de obra.
 *
 * Un `targetRef` pide campos con nombre de dominio (`anchoM`, `altoM`); un
 * `targetDato` pide **un** valor, y qué valor es lo dice la clave del dato
 * (`altura_local.PB`). Inventarle un nombre de campo —`alturaM`— sería mentir
 * sobre a qué entidad pertenece: no pertenece a ninguna, es un hecho de la obra.
 *
 * Vive acá, en el módulo puro de la taxonomía, porque son tres los que tienen
 * que coincidir en la misma cadena y ninguno puede importar a los otros dos: la
 * búsqueda dirigida la usa para pedir el valor (`valores: { valor }`), el
 * resolver de la bandeja para leerlo al responder, y la pantalla para nombrar su
 * input. Si se separan, la tarjeta manda una clave que el server no acepta.
 */
export const CAMPO_DATO_OBRA = 'valor';

/** Cómo se llama en castellano cada familia de dato de obra. */
const FAMILIA_DATO_OBRA: Record<string, string> = {
  altura_local: 'Altura de local',
  altura_revestimiento: 'Altura de revestimiento',
  nivel: 'Nivel',
};

/**
 * El nombre del dato para la tarjeta de la bandeja: `altura_local.PB` ⇒
 * «Altura de local en PB», `altura_local.general` ⇒ «Altura de local».
 *
 * La clave es convencional y legible para nosotros, no para el arquitecto: un
 * input que dice `altura_local.PB` es un identificador de base de datos puesto
 * adelante de una persona. El sufijo `general` no se nombra —es el hecho que
 * vale para toda la obra cuando no hay uno más fino— y una familia que no
 * conozcamos se muestra tal cual, con los guiones bajos abiertos: peor que un
 * nombre feo es un input sin nombre.
 */
export function etiquetaDeDatoObra(clave: string): string {
  const punto = clave.indexOf('.');
  const familia = punto === -1 ? clave : clave.slice(0, punto);
  const sufijo = punto === -1 ? '' : clave.slice(punto + 1);
  const nombre =
    FAMILIA_DATO_OBRA[familia] ??
    familia.replace(/_/g, ' ').replace(/^./, (letra) => letra.toUpperCase());
  return sufijo === '' || sufijo === 'general' ? nombre : `${nombre} en ${sufijo}`;
}

/**
 * El dato de obra que respalda un campo, o `null` si no está.
 *
 * Es el **único lector válido** del mapa de datos de obra: una plantilla no
 * toca la API de `Map` por su cuenta, igual que nadie lee `target_ref` sin
 * `camposDelTarget()`. Acepta `undefined` porque `datosObra` es un parámetro
 * opcional de `computar()`: una plantilla llamada sin datos de obra —los tests
 * de rubro puro, por ejemplo— tiene que comportarse como si la obra no tuviera
 * ninguno, no romper.
 */
export function respaldoDeDatoObra(
  datosObra: ReadonlyMap<string, DatoObraResuelto> | undefined,
  clave: string,
): DatoObraResuelto | null {
  return datosObra?.get(clave) ?? null;
}

/**
 * `"T1"`, `"T1 y T2"`, `"T1, T2 y T3"` — enumeración es-AR.
 *
 * Duplicada del `enumerar()` de `src/lib/deduccion/motor.ts` **a propósito**:
 * ese módulo importa de este (`leerMedida`), así que traerlo de allá arma un
 * ciclo que `tsc` acepta y que revienta en runtime cuando el orden de
 * evaluación no acompaña. Tres líneas repetidas valen menos que ese riesgo
 * (mismo criterio que `normalizarTag` en `computo/tags.ts`).
 */
function enumerar(partes: readonly string[]): string {
  if (partes.length === 0) return '';
  if (partes.length === 1) return partes[0]!;
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
}

export interface EntradaDatoObraFaltante {
  rubro: RubroId | null;
  /** La clave del dato, sin prefijo: `altura_local.PB`, `nivel.PB`. */
  claveDato: string;
  /** Unidad del valor que se pide, si tiene una. */
  unidad?: Unidad;
  descripcion: string;
  /** Las entidades a las que les falta el dato. De acá salen los ids y los nombres. */
  entidades: readonly EntidadPersistida[];
}

/**
 * Un dato que le falta a **la obra**, no a una entidad: una sola consulta para
 * todos los afectados.
 *
 * Es la deduplicación de preguntas hecha contrato. A los cuatro tabiques de PB
 * les falta la misma altura de local; preguntarla cuatro veces es preguntar lo
 * mismo cuatro veces, y responderla cuatro veces es trabajo que el arquitecto
 * hace por un problema nuestro. Por eso el hallazgo apunta a un `targetDato`
 * —la clave del dato más a quiénes afecta, que es lo que la tarjeta muestra— y
 * responderlo escribe `datos_obra` una vez: el recompute lo propaga solo.
 *
 * **No bloquea.** Un faltante de entidad frena la aprobación del rubro porque
 * hay algo roto en un elemento concreto; un hecho global que falta es otra
 * cosa, y frenar el rubro entero por él dejaría la obra sin salida hasta que
 * alguien conteste. Y sale **sin fuentes**: el dato no se leyó en ninguna
 * lámina, así que no hay bbox honesto que citar (P1 no se cumple citando
 * cualquier cosa).
 */
export function hallazgoDatoObraFaltante(entrada: EntradaDatoObraFaltante): HallazgoDetectado {
  const nombres = entrada.entidades.map((entidad) => entidad.nombre);
  return {
    tipo: 'faltante',
    rubro: entrada.rubro,
    descripcion:
      nombres.length === 0
        ? entrada.descripcion
        : `${entrada.descripcion} Afecta a ${enumerar(nombres)}.`,
    clave: `${PREFIJO_DATO_OBRA}${entrada.claveDato}`,
    bloqueante: false,
    fuentes: [],
    targetDato: {
      clave: entrada.claveDato,
      ...(entrada.unidad ? { unidad: entrada.unidad } : {}),
      entidades: entrada.entidades.map((entidad) => entidad.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Propuestas: lo que ya se leyó y no alcanzó para computar
// ---------------------------------------------------------------------------

/**
 * Una propuesta lista para volcar en un hallazgo: a qué entidad apunta, qué
 * campos pide y qué valores sugiere.
 */
export interface PropuestaDeLectura {
  entidadId: string;
  campos: string[];
  valorPropuesto: ValorPropuesto;
}

/**
 * Lo que el análisis **ya leyó** de una entidad, ofrecido como propuesta.
 *
 * Una entidad con confianza por debajo del umbral no computa (§11.b), pero sus
 * medidas están leídas y guardadas: tirarlas y preguntar de cero es lo que
 * llenaba la bandeja de consultas que el sistema ya podía contestar. Acá se
 * empaquetan tal cual, con la lámina y el bbox de donde salieron, para que el
 * arquitecto confirme con un click en vez de tipear.
 *
 * No escribe nada (P4 intacto): la propuesta es una sugerencia con provenance,
 * el dato entra a la entidad recién cuando se confirma.
 *
 * Devuelve `null` si la entidad no tiene **ninguna** medida positiva leída: sin
 * nada que proponer, el hallazgo queda como estaba (una pregunta honesta).
 */
export function propuestaDeLectura(entidad: EntidadPersistida): PropuestaDeLectura | null {
  const campos: string[] = [];
  const valores: Record<string, number | string> = {};

  for (const campo of Object.keys(entidad.atributos)) {
    const medida = leerMedida(entidad, campo);
    if (medida === null) continue;
    campos.push(campo);
    valores[campo] = medida;
  }

  if (campos.length === 0) return null;

  return {
    entidadId: entidad.id,
    campos,
    valorPropuesto: {
      valores,
      fuente: { laminaId: entidad.laminaId, bbox: entidad.bbox },
      confianza: entidad.confianza,
      origen: 'lectura_baja_confianza',
    },
  };
}

export interface EntradaBajaConfianza {
  rubro: RubroId;
  /** Clave del ítem que NO se emitió: "seco.placas". */
  claveItem: string;
  descripcion: string;
  confianza: number;
  fuentes: Fuente[];
  /** Lo que se leyó de la entidad de respaldo, si hay una sola y tiene algo. */
  propuesta?: PropuestaDeLectura;
}

/**
 * Regla de oro §11.b: confianza por debajo del umbral ⇒ el ítem no se emite y
 * el dato se degrada a consulta bloqueante.
 *
 * Con `propuesta`, la consulta deja de ser "revisá la documentación" y pasa a
 * ser "leí esto, ¿lo confirmás?": el hallazgo apunta a la entidad de respaldo y
 * lleva los valores leídos. Confirmarlo sube la confianza de la entidad a 1 y
 * el ítem se emite (esa parte es de la bandeja, no de acá).
 */
export function hallazgoBajaConfianza(entrada: EntradaBajaConfianza): HallazgoDetectado {
  const prefijo = `${entrada.rubro}.`;
  const sufijo = entrada.claveItem.startsWith(prefijo)
    ? entrada.claveItem.slice(prefijo.length)
    : entrada.claveItem;
  const porcentaje = Math.round(entrada.confianza * 100);
  const umbral = Math.round(UMBRAL_CONFIANZA * 100);

  return {
    tipo: 'faltante',
    rubro: entrada.rubro,
    descripcion:
      `No computé "${entrada.descripcion}": los datos que lo sostienen tienen ${porcentaje}% de confianza, ` +
      `por debajo del ${umbral}% que hace falta para computarlo sin preguntar. Revisá la documentación y confirmá el dato.`,
    clave: `${entrada.rubro}.baja_confianza.${sufijo}`,
    checklistItem: `${entrada.rubro}.baja_confianza`,
    bloqueante: true,
    fuentes: entrada.fuentes,
    ...(entrada.propuesta
      ? {
          targetRef: {
            entidadId: entrada.propuesta.entidadId,
            campos: entrada.propuesta.campos,
          },
          valorPropuesto: entrada.propuesta.valorPropuesto,
        }
      : {}),
  };
}
