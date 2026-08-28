/**
 * Contratos compartidos del dominio (fuente de verdad del proyecto).
 *
 * Los tipos de este archivo son el contrato entre TODAS las tareas: providers de
 * análisis, motor de cómputo, pipeline, DB y UI usan exactamente estos nombres.
 * Están copiados verbatim del plan (`contratos.md`) — no los renombres ni los
 * "mejores" sin actualizar el plan primero.
 */
import { z } from 'zod';

export type BBox = [number, number, number, number]; // [x, y, ancho, alto] normalizados 0–1, origen arriba-izquierda
export interface Fuente { laminaId: string; bbox: BBox; detalle?: string }
export type Origen = 'explicito' | 'deducido' | 'supuesto' | 'inferido';
export type EstadoReforma = 'existente' | 'demoler' | 'nueva' | 'na';
export type TipoObra = 'nueva' | 'reforma' | 'ampliacion';
export type RubroId =
  | 'aberturas'
  | 'seco'
  | 'pintura'
  | 'gruesa'
  | 'terminaciones'
  | 'sanitaria'
  | 'electrica'
  | 'demolicion';
export type Unidad = 'u' | 'm' | 'ml' | 'm2' | 'm3' | 'l' | 'kg';
export type TipoEntidad =
  | 'ambiente'
  | 'muro'
  | 'tabique'
  | 'abertura'
  | 'artefacto'
  | 'terminacion'
  | 'cota'
  | 'otro'
  | 'tramo'
  | 'accesorio'
  | 'boca';
export type Disciplina = 'arquitectura' | 'estructura' | 'instalaciones' | 'otra';
export type TipoLamina = 'planta' | 'corte' | 'vista' | 'detalle' | 'planilla' | 'otra';
export type EstadoAnalisis = 'pendiente' | 'procesando' | 'analizada' | 'bloqueada_escala' | 'error';
export type TipoHallazgo = 'faltante' | 'inconsistencia' | 'existente_confirmar' | 'supuesto';
export type EstadoHallazgo = 'abierto' | 'respondido' | 'descartado';
export type EstadoRubro = 'borrador' | 'revision' | 'aprobado';

export interface EntidadDetectada {
  tipo: TipoEntidad;
  nombre: string;                       // "Dormitorio 1", "V2", "Tabique T1"
  bbox: BBox;
  confianza: number;                    // 0–1
  estadoReforma: EstadoReforma;         // 'na' en obra nueva
  atributos: Record<string, number | string | boolean | null>;
}
// Atributos convencionales por tipo (claves exactas):
//   ambiente:  superficieM2, perimetroM, alturaM?, vanosM2?,
//              nivel?, solado?, zocalo?, cielorraso?, revestimiento?, alturaRevestimientoM?
//   abertura:  tag, tipologia ('ventana'|'puerta'|'paño fijo'), anchoM?, altoM?, material?, vidrio?
//   tabique:   largoM, alturaM?, caras? (default 2), tipo ('durlock')
//   muro:      largoM, alturaM?, espesorM?, tipo ('mamposteria')
//   terminacion: superficieM2, ubicacion ('piso'|'cielorraso'|'pared'), ambiente (nombre), material?
//   tramo:     sistema ('af'|'ac'|'cloacal'|'pluvial'), diametro (string, ej. "20", "110"), longitudM?, material?
//   accesorio: tipo ('codo90'|'codo45'|'te'|'valvula'), sistema, diametro
//   boca:      tipo ('toma'|'luz'|'caja'|'tablero'|'datos'), circuito?

export interface RotuloDetectado {
  titulo: string | null; codigo: string | null;
  disciplina: Disciplina | null; tipoLamina: TipoLamina | null;
  escala: string | null;            // "1:100"
  escalaConfiable: boolean;
  revision: string | null; confianza: number;
}

export interface LaminaInput {
  laminaId: string;
  pdfBytes: Uint8Array;             // PDF de UNA página
  documentoNombre: string;          // nombre del archivo original subido
  numeroPagina: number;             // 1-based dentro del original
  textoExtraido?: string;
}

/**
 * Una lámina del expediente vista desde el índice que se le pasa al prompt.
 *
 * Es un subconjunto estructural de la fila de `laminas` (mismos nombres de
 * campo): quien ya tenga la fila la pasa tal cual, sin mapear.
 */
export interface LaminaIndice {
  codigo: string | null;            // "A-01"
  titulo: string | null;            // "PLANTA PB"
  tipo: TipoLamina | null;
}

/**
 * Lo que el análisis sabe de la obra cuando mira UNA lámina.
 *
 * `obraId` y `tipoObra` son obligatorios desde F0. Todo lo demás es **aditivo y
 * opcional**: un provider que no lo mire se comporta igual que antes, y el mock
 * de láminas lo ignora. Lo arma el pipeline (`analizarLamina`) leyendo la obra,
 * su resumen ejecutivo, su índice de láminas y la configuración del estudio
 * (`ConfigEstudio.instruccionesExtraccion`).
 */
export interface ObraContexto {
  obraId: string;
  tipoObra: TipoObra;
  /** Titular del resumen ejecutivo de la obra, si ya se generó. */
  resumen?: string;
  /** Las otras láminas del expediente, para que el modelo sepa dónde mirar. */
  indiceLaminas?: LaminaIndice[];
  /** Instrucciones de extracción del estudio, ya resueltas a texto plano. */
  instruccionesEstudio?: string;
  /**
   * Nombre de la obra (`obras.nombre`). Aditivo y opcional como los tres de
   * arriba: los providers de lámina lo ignoran. Lo usa el **cruce**, que es una
   * llamada por obra y no por lámina, para dos cosas: nombrarla en el prompt y
   * —en el mock— resolver la clave de su fixture (`slug(nombreObra)`). Sin él,
   * el mock del cruce no encuentra fixture y devuelve vacío.
   */
  nombreObra?: string;
}

export interface ItemComputo {
  rubro: RubroId; descripcion: string; unidad: Unidad;
  cantNeta: number; desperdicioPct: number; cantCompra: number;
  presentacion: string; origen: Origen; fuentes: Fuente[];
  confianza: number; entidadRef?: string;
  claveItem: string;                // estable para diff/golden, ej. "seco.placas", "aberturas.V2"
}
/** De dónde salió una propuesta. Ver `ValorPropuesto`. */
export type OrigenPropuesto = 'lectura_baja_confianza' | 'rotulo' | 'busqueda_dirigida';

/**
 * Lo que el sistema **propone** para cerrar un hallazgo, sin escribirlo.
 *
 * Es el contrato de "proponer en vez de bloquear": el dato ya se leyó (con poca
 * confianza, del rótulo o de una búsqueda dirigida en la documentación) pero
 * **no entra a la entidad hasta que el arquitecto confirma** — P4 sigue en pie,
 * la propuesta es una sugerencia con provenance, no un valor computado.
 *
 * `valores` es plural a propósito: una carpintería sin acotar necesita ancho
 * **y** alto, y preguntarlos de a uno hace reaparecer la consulta. Las claves
 * son los campos del `targetRef` del mismo hallazgo.
 */
export interface ValorPropuesto {
  /** `campo → valor propuesto`. Las claves salen de `camposDelTarget()`. */
  valores: Record<string, number | string>;
  /** Dónde se leyó (lámina + bbox). Opcional: el rótulo no siempre tiene bbox útil. */
  fuente?: Fuente;
  /** Confianza de la lectura, 0–1. */
  confianza?: number;
  origen: OrigenPropuesto;
}

/**
 * "Ya busqué esto en la documentación y el dato no estaba."
 *
 * Es lo contrario de `ValorPropuesto` y por eso vive en su propia columna
 * (`hallazgos.busqueda_json`) y no adentro de la propuesta: una propuesta dice
 * qué proponer, y esto dice que **no hay nada que proponer**. Meterlo en
 * `valor_propuesto_json` obligaría a todo lector de propuestas —la tarjeta de
 * la bandeja, el merge del recompute, `zValorPropuesto`— a distinguir una
 * propuesta real de una marca de vacío.
 *
 * Existe por plata: sin esto, cada `procesarDocumento` vuelve a pagar hasta
 * ocho llamadas al modelo por una consulta que la documentación simplemente no
 * puede responder, para siempre.
 *
 * **Cómo caduca.** No por reloj —el dato no aparece porque pase el tiempo—
 * sino por `huella`: la marca vale mientras la documentación de la obra sea la
 * misma que se leyó. Si el arquitecto sube una lámina nueva, o una que estaba
 * bloqueada pasa a analizada, la huella cambia, la marca deja de aplicar y el
 * dato se vuelve a buscar. Un reproceso del mismo documento no la cambia, que
 * es justo el caso que había que dejar de pagar.
 */
export interface MarcaBusqueda {
  /** Los campos que se buscaron y volvieron vacíos. */
  campos: string[];
  /** Huella de la documentación sobre la que se buscó. Ver `huellaDocumentacion`. */
  huella: string;
  /** Cuándo se buscó (ISO). Informativo: la caducidad la decide la huella. */
  at: string;
  /**
   * Quién buscó (`BusquedaProvider.nombre`). La marca de un provider **no vale
   * para otro**: una obra procesada sin `ANTHROPIC_API_KEY` la busca el mock,
   * que sin fixture devuelve `[]` y marcaría toda la obra como "no está en la
   * documentación" con la huella real — y al configurar la key, el provider de
   * verdad no saldría a buscar nunca, porque la huella no cambió.
   *
   * Opcional porque las marcas escritas antes de esto no lo traen: sin
   * `provider` la marca no coincide con ninguno y el dato se vuelve a buscar
   * una vez, que es el lado seguro del error.
   */
  provider?: string;
}

/**
 * A qué campos de qué entidad apunta un hallazgo. Se escribe siempre en plural.
 *
 * **Nunca lo leas directo**: `camposDelTarget()` (`src/lib/hallazgos/target.ts`)
 * es el único lector válido, porque las filas viejas guardaron `campo` singular.
 */
export interface TargetRef { entidadId: string; campos: string[] }

/**
 * El `target_ref` tal como puede venir de la base: filas anteriores a T0 traen
 * `campo` singular, las nuevas traen `campos`. Retrocompat **de lectura**.
 */
export interface TargetRefPersistido { entidadId: string; campo?: string; campos?: string[] }

export interface HallazgoDetectado {
  tipo: TipoHallazgo; rubro: RubroId | null; descripcion: string;
  clave: string;                    // única por obra para idempotencia, ej. "seco.altura_tabiques.T1"
  checklistItem?: string; bloqueante: boolean; fuentes: Fuente[];
  targetRef?: TargetRef;            // si responderlo actualiza una entidad
  valorPropuesto?: ValorPropuesto;  // lo que el sistema propone para esos campos
  targetDato?: TargetDato;          // si responderlo escribe un dato de obra en vez de una entidad
}

// ---------------------------------------------------------------------------
// El expediente como conjunto: datos de obra, precios y fases del análisis.
// Contratos copiados verbatim del plan (`task-1-brief.md` §«Contratos
// compartidos nuevos»): los consumen T2–T11. No los renombres.
// ---------------------------------------------------------------------------

/** Un hecho que vale para toda la obra. Clave convencional: `altura_local.PB`, `nivel.PB`, `altura_revestimiento.general`. */
export interface DatoObraValor { valor: number | string; unidad?: Unidad }

/**
 * Un dato de obra ya resuelto, listo para que una plantilla lo use como
 * respaldo: trae su origen, sus fuentes y su confianza, que se suman al ítem
 * que se apoye en él (P1: nada entra al cómputo sin provenance).
 */
export interface DatoObraResuelto { clave: string; valor: number | string; unidad?: Unidad; origen: Origen; fuentes: Fuente[]; confianza: number; metodo?: string }

/** Un hallazgo puede apuntar a un dato de obra en vez de a una entidad. Responderlo escribe `datos_obra` y el recompute propaga. */
export interface TargetDato { clave: string; unidad?: Unidad; entidades: string[] }  // entidades = ids afectadas (informativo, para la tarjeta)

/**
 * El precio unitario que el sistema le pone a un ítem, con de dónde salió.
 *
 * La IA **jamás** pone un precio: `fuente` solo puede ser el precio manual del
 * ítem, la lista de referencia del estudio o el índice de precios propio.
 */
export interface PrecioEstimado { unitario: number; moneda: string; fuente: 'manual' | 'lista' | 'indice'; fechaPrecio: string }

/** Fase del análisis en curso, para la UI del expediente (`obras.analisis_json`). */
export interface FaseAnalisis { fase: 'inventario' | 'extraccion' | 'cruce' | 'relectura' | 'listo' | 'error'; total?: number; completadas?: number; detalle?: string }

// ---------------------------------------------------------------------------
// Contratos de F1–F4 (compulsa, conciliación, negociación, deducción).
// Copiados verbatim de `contratos-y-formulas.md`: son el contrato entre P1 y
// todas las tareas que vienen después. No los renombres ni los "mejores".
// ---------------------------------------------------------------------------

export type EstadoCompulsa = 'borrador' | 'lanzada' | 'cerrada' | 'adjudicada';
export type EstadoContacto = 'pendiente' | 'contactado' | 'cotizo' | 'negociando' | 'cerrado' | 'sin_respuesta';
export type Canal = 'manual' | 'whatsapp' | 'voz' | 'email';
export type MatchConciliacion = 'exacto' | 'parcial' | 'sustituto' | 'no_cotizado' | 'extra';
export type EstadoDeduccion = 'propuesta' | 'validada' | 'rechazada';
export type ReglaDeduccion =
  | 'planilla_plano'
  | 'planta_corte'
  | 'continuidad'
  | 'idem_tipologia'
  | 'cierre_cotas'
  | 'cruce'
  | 'medicion_grafica';
export type RolUsuario = 'titular' | 'colaborador' | 'lectura'; // ya existe como enum de DB; exportar acá

export interface CondicionesRfq {
  ivaDiscriminado: true;               // siempre; el tipo lo documenta
  separarManoObraMateriales: boolean;
  validezMinimaDias: number;           // default 7
  plazoEntregaDias: number | null;
  notas: string | null;
}
export interface ItemRfq {
  claveItem: string; descripcion: string; unidad: Unidad;
  cantidad: number; presentacion: string;
  specsCriticas: Record<string, string>; // ej. { vidrio: 'DVH' } — sustituir esto = 'sustituto'
}
export interface Mandato {
  objetivoMejoraPct: number;           // ej. 5 = buscar 5% de mejora
  palancas: Array<'volumen' | 'plazo_pago' | 'fecha' | 'adjudicacion_inmediata'>;
  maxRondas: 2;                        // fijo por PRD (RF-1001)
}
export interface LineaPresupuesto {
  descripcion: string; unidad: string | null; cantidad: number | null;
  precioUnitario: number | null; precioTotal: number | null;
  claveItemSugerida: string | null;    // si el proveedor citó el código
  notas: string | null;
}

/** Pesos del ranking multicriterio (RF-1101). Los defaults son 0,5 / 0,3 / 0,2. */
export interface PesosRanking { total: number; fidelidad: number; plazo: number }

/**
 * Las instrucciones que el estudio le da al analizador de láminas.
 *
 * Es la sistematización de los prompts manuales del arquitecto: lo que hoy
 * escribe a mano cada vez ("las medidas de las carpinterías están en la
 * planilla DET00", "las cotas están en cm") pasa a ser configuración del
 * estudio y viaja con `ObraContexto.instruccionesEstudio` en cada llamada.
 *
 * Las dos viajan en **cada** llamada de extracción: `general` tal cual, y las de
 * `porRubro` como una línea etiquetada con el nombre del rubro
 * (`textoInstrucciones` en `src/lib/analysis/prompt.ts`), que es lo que le dice
 * al modelo a qué aplica cada una. No hay ningún "rubro en foco" —el análisis
 * lee la lámina entera, no un rubro por vez—, y la etiqueta es justamente lo
 * que hace que eso no sea un problema. Ambos vacíos por default: sin
 * configurar, el prompt es el de siempre.
 */
export interface InstruccionesExtraccion {
  general: string;
  porRubro: Partial<Record<RubroId, string>>;
}

/**
 * Configuración por estudio (`estudios.config_json`).
 *
 * Se guarda **parcial** —solo lo que el estudio pisó— y se lee completa por
 * `zConfigEstudio.parse(...)`, que rellena cada hueco con el default del PRD.
 * Por eso la columna es `Partial<ConfigEstudio>` y este tipo es el resultado de
 * parsearla, no lo que hay en la base.
 */
export interface ConfigEstudio {
  /** `claveItem` → % de desperdicio que pisa el default del rubro. */
  desperdiciosPct: Record<string, number>;
  condicionesDefault: CondicionesRfq;
  mandatoDefault: Mandato;
  pesosRanking: PesosRanking;
  /** Dólar MEP de referencia del estudio; `null` ⇒ no cotiza en dólares. */
  mepReferencia: { valor: number; fecha: string } | null;
  /** Qué mirar y cómo leerlo al analizar las láminas de este estudio. */
  instruccionesExtraccion: InstruccionesExtraccion;
}

// ---------------------------------------------------------------------------
// Valores de cada unión cerrada. `schema.ts` los usa para sus `pgEnum` y los
// providers para sus schemas Zod: una sola lista por tipo, en un solo lugar.
// ---------------------------------------------------------------------------

// Todas estas listas son el orden de valores de su `pgEnum`: lo nuevo va
// SIEMPRE al final (`ALTER TYPE … ADD VALUE`). Reordenarlas rompe la migración
// sobre datos vivos.
export const ORIGENES = ['explicito', 'deducido', 'supuesto', 'inferido'] as const satisfies readonly Origen[];
export const ESTADOS_REFORMA = ['existente', 'demoler', 'nueva', 'na'] as const satisfies readonly EstadoReforma[];
export const TIPOS_OBRA = ['nueva', 'reforma', 'ampliacion'] as const satisfies readonly TipoObra[];
export const RUBROS = [
  'aberturas',
  'seco',
  'pintura',
  'gruesa',
  'terminaciones',
  'sanitaria',
  'electrica',
  'demolicion',
] as const satisfies readonly RubroId[];
export const UNIDADES = ['u', 'm', 'ml', 'm2', 'm3', 'l', 'kg'] as const satisfies readonly Unidad[];
// Lo que se agregó después va al final a propósito —`'cota'` en F1 (regla de
// cierre de cotas), los tres de instalaciones ahora—: el orden de esta lista es
// el orden de valores del `pgEnum` `tipo_entidad`, y agregar al final es lo que
// hace que la migración sea un `ALTER TYPE … ADD VALUE` y no una recreación del
// tipo. Reordenarla rompería la migración sobre datos vivos.
export const TIPOS_ENTIDAD = [
  'ambiente',
  'muro',
  'tabique',
  'abertura',
  'artefacto',
  'terminacion',
  'otro',
  'cota',
  // Los tres de instalaciones, después de `cota` y por la misma razón.
  'tramo',
  'accesorio',
  'boca',
] as const satisfies readonly TipoEntidad[];
export const DISCIPLINAS = ['arquitectura', 'estructura', 'instalaciones', 'otra'] as const satisfies readonly Disciplina[];
export const TIPOS_LAMINA = ['planta', 'corte', 'vista', 'detalle', 'planilla', 'otra'] as const satisfies readonly TipoLamina[];
export const ESTADOS_ANALISIS = ['pendiente', 'procesando', 'analizada', 'bloqueada_escala', 'error'] as const satisfies readonly EstadoAnalisis[];
export const TIPOS_HALLAZGO = ['faltante', 'inconsistencia', 'existente_confirmar', 'supuesto'] as const satisfies readonly TipoHallazgo[];
export const ESTADOS_HALLAZGO = ['abierto', 'respondido', 'descartado'] as const satisfies readonly EstadoHallazgo[];
export const ESTADOS_RUBRO = ['borrador', 'revision', 'aprobado'] as const satisfies readonly EstadoRubro[];
export const ORIGENES_PROPUESTOS = [
  'lectura_baja_confianza',
  'rotulo',
  'busqueda_dirigida',
] as const satisfies readonly OrigenPropuesto[];

// F1–F4
export const ROLES_USUARIO = ['titular', 'colaborador', 'lectura'] as const satisfies readonly RolUsuario[];
export const ESTADOS_COMPULSA = ['borrador', 'lanzada', 'cerrada', 'adjudicada'] as const satisfies readonly EstadoCompulsa[];
export const ESTADOS_CONTACTO = ['pendiente', 'contactado', 'cotizo', 'negociando', 'cerrado', 'sin_respuesta'] as const satisfies readonly EstadoContacto[];
export const CANALES = ['manual', 'whatsapp', 'voz', 'email'] as const satisfies readonly Canal[];
export const MATCHES_CONCILIACION = ['exacto', 'parcial', 'sustituto', 'no_cotizado', 'extra'] as const satisfies readonly MatchConciliacion[];
export const ESTADOS_DEDUCCION = ['propuesta', 'validada', 'rechazada'] as const satisfies readonly EstadoDeduccion[];
export const REGLAS_DEDUCCION = [
  'planilla_plano',
  'planta_corte',
  'continuidad',
  'idem_tipologia',
  'cierre_cotas',
  // Las dos que no son reglas documentales del §11: la primera la propone el
  // provider de cruce, la segunda la medición gráfica sobre el dibujo.
  'cruce',
  'medicion_grafica',
] as const satisfies readonly ReglaDeduccion[];
export const PALANCAS = ['volumen', 'plazo_pago', 'fecha', 'adjudicacion_inmediata'] as const satisfies readonly Mandato['palancas'][number][];

// ---------------------------------------------------------------------------
// Defaults del PRD para la configuración del estudio. `zConfigEstudio` los
// aplica al parsear, así que un estudio sin `config_json` se comporta como el
// PRD manda sin tener que escribir nada en la base.
// ---------------------------------------------------------------------------

/** IVA discriminado siempre (PRD §13); validez mínima 7 días. */
export const CONDICIONES_RFQ_DEFAULT: CondicionesRfq = {
  ivaDiscriminado: true,
  separarManoObraMateriales: true,
  validezMinimaDias: 7,
  plazoEntregaDias: null,
  notas: null,
};

/** Dos rondas fijas (RF-1001); 5% de mejora objetivo. */
export const MANDATO_DEFAULT: Mandato = {
  objetivoMejoraPct: 5,
  palancas: ['volumen', 'plazo_pago'],
  maxRondas: 2,
};

/** RF-1101: `0,5×(totalMínimo/total) + 0,3×fidelidad + 0,2×(plazoMínimo/plazo)`. */
export const PESOS_RANKING_DEFAULT: PesosRanking = { total: 0.5, fidelidad: 0.3, plazo: 0.2 };

/** Sin instrucciones propias: el prompt de extracción es el de siempre. */
export const INSTRUCCIONES_EXTRACCION_DEFAULT: InstruccionesExtraccion = {
  general: '',
  porRubro: {},
};

export const CONFIG_ESTUDIO_DEFAULT: ConfigEstudio = {
  desperdiciosPct: {},
  condicionesDefault: CONDICIONES_RFQ_DEFAULT,
  mandatoDefault: MANDATO_DEFAULT,
  pesosRanking: PESOS_RANKING_DEFAULT,
  mepReferencia: null,
  instruccionesExtraccion: INSTRUCCIONES_EXTRACCION_DEFAULT,
};

// ---------------------------------------------------------------------------
// Schemas Zod (v4). Los usan los providers de análisis para validar la salida
// del LLM / de los fixtures, y la API para validar payloads del cliente.
// ---------------------------------------------------------------------------

/** bbox normalizado 0–1 sobre la lámina: [x, y, ancho, alto]. */
export const zBBox = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);

export const zFuente = z.object({
  laminaId: z.string(),
  bbox: zBBox,
  detalle: z.string().optional(),
});

/**
 * Una propuesta del sistema, tal como se guarda en `hallazgos.valor_propuesto_json`
 * y como la valida la búsqueda dirigida antes de escribirla.
 */
export const zValorPropuesto = z.object({
  valores: z.record(z.string(), z.union([z.number(), z.string()])),
  fuente: zFuente.optional(),
  confianza: z.number().min(0).max(1).optional(),
  origen: z.enum(ORIGENES_PROPUESTOS),
});

export const zEntidadDetectada = z.object({
  tipo: z.enum(TIPOS_ENTIDAD),
  nombre: z.string(),
  bbox: zBBox,
  confianza: z.number().min(0).max(1),
  estadoReforma: z.enum(ESTADOS_REFORMA),
  atributos: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
});

/** `datos_obra.valor_json`: el hecho, con su unidad si la tiene. */
export const zDatoObraValor = z.object({
  valor: z.union([z.number(), z.string()]),
  unidad: z.enum(UNIDADES).optional(),
});

/** `hallazgos.target_dato`: a qué dato de obra apunta la consulta y a quiénes afecta. */
export const zTargetDato = z.object({
  clave: z.string().min(1),
  unidad: z.enum(UNIDADES).optional(),
  entidades: z.array(z.string()),
});

/** `computo_items.precio_json`: el precio con su procedencia. La IA no entra acá. */
export const zPrecioEstimado = z.object({
  unitario: z.number(),
  moneda: z.string(),
  fuente: z.enum(['manual', 'lista', 'indice']),
  fechaPrecio: z.string(),
});

export const zRotuloDetectado = z.object({
  titulo: z.string().nullable(),
  codigo: z.string().nullable(),
  disciplina: z.enum(DISCIPLINAS).nullable(),
  tipoLamina: z.enum(TIPOS_LAMINA).nullable(),
  escala: z.string().nullable(),
  escalaConfiable: z.boolean(),
  revision: z.string().nullable(),
  confianza: z.number().min(0).max(1),
});

// --- F1–F4 -----------------------------------------------------------------

/** Condiciones estándar del RFQ (PRD §13). `ivaDiscriminado` no es opcional. */
export const zCondicionesRfq = z.object({
  ivaDiscriminado: z.literal(true),
  separarManoObraMateriales: z.boolean(),
  validezMinimaDias: z.number().int().min(1),
  plazoEntregaDias: z.number().int().min(0).nullable(),
  notas: z.string().nullable(),
});

/** Un ítem del snapshot enviado a los proveedores (RF-701). */
export const zItemRfq = z.object({
  claveItem: z.string().min(1),
  descripcion: z.string().min(1),
  unidad: z.enum(UNIDADES),
  cantidad: z.number(),
  presentacion: z.string(),
  specsCriticas: z.record(z.string(), z.string()),
});

/**
 * Mandato de negociación. `maxRondas` es 2 y punto (RF-1001).
 *
 * `objetivoMejoraPct` es `[0, 100)`, con el 100 **excluido**: con 100 el
 * objetivo de precio da 0 y el motor le estaría pidiendo al proveedor que
 * regale el rubro. `src/lib/negociacion/motor.ts` ya lo rechazaba en runtime;
 * el schema tiene que rechazarlo antes, o el formulario de configuración deja
 * guardar un mandato que después revienta al negociar.
 */
export const zMandato = z.object({
  objetivoMejoraPct: z
    .number()
    .min(0, 'El objetivo de mejora no puede ser negativo.')
    .lt(100, 'El objetivo de mejora tiene que ser menor a 100%: con 100 le estarías pidiendo al proveedor que regale el rubro.'),
  palancas: z.array(z.enum(PALANCAS)),
  maxRondas: z.literal(2),
});

/** Una línea del presupuesto que mandó el proveedor, tal como se leyó. */
export const zLineaPresupuesto = z.object({
  descripcion: z.string(),
  unidad: z.string().nullable(),
  cantidad: z.number().nullable(),
  precioUnitario: z.number().nullable(),
  precioTotal: z.number().nullable(),
  claveItemSugerida: z.string().nullable(),
  notas: z.string().nullable(),
});

/**
 * `estudios.config_json`. Cada campo tiene su default, así que
 * `zConfigEstudio.parse({})` devuelve la configuración completa del PRD: la
 * columna guarda solo los overrides y el que lee nunca ve un `undefined`.
 */
/** Instrucciones de extracción del estudio. Los dos campos tienen default vacío. */
export const zInstruccionesExtraccion = z.object({
  general: z.string().default(''),
  porRubro: z.partialRecord(z.enum(RUBROS), z.string()).default({}),
});

export const zConfigEstudio = z.object({
  desperdiciosPct: z.record(z.string(), z.number().min(0).max(100)).default({}),
  condicionesDefault: zCondicionesRfq.default(CONDICIONES_RFQ_DEFAULT),
  mandatoDefault: zMandato.default(MANDATO_DEFAULT),
  pesosRanking: z
    .object({ total: z.number(), fidelidad: z.number(), plazo: z.number() })
    .default(PESOS_RANKING_DEFAULT),
  mepReferencia: z
    .object({ valor: z.number().positive(), fecha: z.string() })
    .nullable()
    .default(null),
  instruccionesExtraccion: zInstruccionesExtraccion.default(INSTRUCCIONES_EXTRACCION_DEFAULT),
});

// ---------------------------------------------------------------------------
// Chequeos de coherencia en tiempo de compilación (cero código en runtime).
// ---------------------------------------------------------------------------

/** `Assert<X>` no compila salvo que `X` sea `never`; el error nombra el sobrante. */
type Assert<T extends never> = T;

/** Valores de la unión `T` que la lista `V` deja afuera. */
type Faltantes<T extends string, V extends readonly T[]> = Exclude<T, V[number]>;

// `as const satisfies readonly X[]` ya prohíbe valores de más; esto prohíbe los de menos.
type _ListasCompletas = Assert<
  | Faltantes<Origen, typeof ORIGENES>
  | Faltantes<EstadoReforma, typeof ESTADOS_REFORMA>
  | Faltantes<TipoObra, typeof TIPOS_OBRA>
  | Faltantes<RubroId, typeof RUBROS>
  | Faltantes<Unidad, typeof UNIDADES>
  | Faltantes<TipoEntidad, typeof TIPOS_ENTIDAD>
  | Faltantes<Disciplina, typeof DISCIPLINAS>
  | Faltantes<TipoLamina, typeof TIPOS_LAMINA>
  | Faltantes<EstadoAnalisis, typeof ESTADOS_ANALISIS>
  | Faltantes<TipoHallazgo, typeof TIPOS_HALLAZGO>
  | Faltantes<EstadoHallazgo, typeof ESTADOS_HALLAZGO>
  | Faltantes<EstadoRubro, typeof ESTADOS_RUBRO>
  | Faltantes<OrigenPropuesto, typeof ORIGENES_PROPUESTOS>
  | Faltantes<RolUsuario, typeof ROLES_USUARIO>
  | Faltantes<EstadoCompulsa, typeof ESTADOS_COMPULSA>
  | Faltantes<EstadoContacto, typeof ESTADOS_CONTACTO>
  | Faltantes<Canal, typeof CANALES>
  | Faltantes<MatchConciliacion, typeof MATCHES_CONCILIACION>
  | Faltantes<EstadoDeduccion, typeof ESTADOS_DEDUCCION>
  | Faltantes<ReglaDeduccion, typeof REGLAS_DEDUCCION>
  | Faltantes<Mandato['palancas'][number], typeof PALANCAS>
>;

/** `never` si `A` y `B` son el mismo tipo; si no, el literal que delata la falla. */
type Difiere<A, B, Nombre extends string> = [A] extends [B]
  ? [B] extends [A]
    ? never
    : Nombre
  : Nombre;

// Cada schema Zod tiene que inferir exactamente su interface, ni más ni menos.
type _SchemasAlineados = Assert<
  | Difiere<z.infer<typeof zFuente>, Fuente, 'zFuente'>
  | Difiere<z.infer<typeof zValorPropuesto>, ValorPropuesto, 'zValorPropuesto'>
  | Difiere<z.infer<typeof zDatoObraValor>, DatoObraValor, 'zDatoObraValor'>
  | Difiere<z.infer<typeof zTargetDato>, TargetDato, 'zTargetDato'>
  | Difiere<z.infer<typeof zPrecioEstimado>, PrecioEstimado, 'zPrecioEstimado'>
  | Difiere<z.infer<typeof zInstruccionesExtraccion>, InstruccionesExtraccion, 'zInstruccionesExtraccion'>
  | Difiere<z.infer<typeof zEntidadDetectada>, EntidadDetectada, 'zEntidadDetectada'>
  | Difiere<z.infer<typeof zRotuloDetectado>, RotuloDetectado, 'zRotuloDetectado'>
  | Difiere<z.infer<typeof zCondicionesRfq>, CondicionesRfq, 'zCondicionesRfq'>
  | Difiere<z.infer<typeof zItemRfq>, ItemRfq, 'zItemRfq'>
  | Difiere<z.infer<typeof zMandato>, Mandato, 'zMandato'>
  | Difiere<z.infer<typeof zLineaPresupuesto>, LineaPresupuesto, 'zLineaPresupuesto'>
  | Difiere<z.infer<typeof zConfigEstudio>, ConfigEstudio, 'zConfigEstudio'>
>;
