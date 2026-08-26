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
export type Origen = 'explicito' | 'deducido' | 'supuesto';
export type EstadoReforma = 'existente' | 'demoler' | 'nueva' | 'na';
export type TipoObra = 'nueva' | 'reforma' | 'ampliacion';
export type RubroId = 'aberturas' | 'seco' | 'pintura' | 'gruesa';
export type Unidad = 'u' | 'm' | 'ml' | 'm2' | 'm3' | 'l' | 'kg';
export type TipoEntidad = 'ambiente' | 'muro' | 'tabique' | 'abertura' | 'artefacto' | 'terminacion' | 'cota' | 'otro';
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
//   ambiente:  superficieM2, perimetroM, alturaM?, vanosM2?
//   abertura:  tag, tipologia ('ventana'|'puerta'|'paño fijo'), anchoM?, altoM?, material?, vidrio?
//   tabique:   largoM, alturaM?, caras? (default 2), tipo ('durlock')
//   muro:      largoM, alturaM?, espesorM?, tipo ('mamposteria')
//   terminacion: superficieM2, ubicacion ('piso'|'cielorraso'|'pared'), ambiente (nombre), material?

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
export interface ObraContexto { obraId: string; tipoObra: TipoObra }

export interface ItemComputo {
  rubro: RubroId; descripcion: string; unidad: Unidad;
  cantNeta: number; desperdicioPct: number; cantCompra: number;
  presentacion: string; origen: Origen; fuentes: Fuente[];
  confianza: number; entidadRef?: string;
  claveItem: string;                // estable para diff/golden, ej. "seco.placas", "aberturas.V2"
}
export interface HallazgoDetectado {
  tipo: TipoHallazgo; rubro: RubroId | null; descripcion: string;
  clave: string;                    // única por obra para idempotencia, ej. "seco.altura_tabiques.T1"
  checklistItem?: string; bloqueante: boolean; fuentes: Fuente[];
  targetRef?: { entidadId: string; campo: string };  // si responderlo actualiza una entidad
}

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
export type ReglaDeduccion = 'planilla_plano' | 'planta_corte' | 'continuidad' | 'idem_tipologia' | 'cierre_cotas';
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
}

// ---------------------------------------------------------------------------
// Valores de cada unión cerrada. `schema.ts` los usa para sus `pgEnum` y los
// providers para sus schemas Zod: una sola lista por tipo, en un solo lugar.
// ---------------------------------------------------------------------------

export const ORIGENES = ['explicito', 'deducido', 'supuesto'] as const satisfies readonly Origen[];
export const ESTADOS_REFORMA = ['existente', 'demoler', 'nueva', 'na'] as const satisfies readonly EstadoReforma[];
export const TIPOS_OBRA = ['nueva', 'reforma', 'ampliacion'] as const satisfies readonly TipoObra[];
export const RUBROS = ['aberturas', 'seco', 'pintura', 'gruesa'] as const satisfies readonly RubroId[];
export const UNIDADES = ['u', 'm', 'ml', 'm2', 'm3', 'l', 'kg'] as const satisfies readonly Unidad[];
// `'cota'` va al final a propósito: el orden de esta lista es el orden de valores
// del `pgEnum` `tipo_entidad`, y agregar al final es lo que hace que la migración
// sea un `ALTER TYPE … ADD VALUE` y no una recreación del tipo (F1, regla de
// cierre de cotas). Reordenarla rompería la migración sobre datos vivos.
export const TIPOS_ENTIDAD = ['ambiente', 'muro', 'tabique', 'abertura', 'artefacto', 'terminacion', 'otro', 'cota'] as const satisfies readonly TipoEntidad[];
export const DISCIPLINAS = ['arquitectura', 'estructura', 'instalaciones', 'otra'] as const satisfies readonly Disciplina[];
export const TIPOS_LAMINA = ['planta', 'corte', 'vista', 'detalle', 'planilla', 'otra'] as const satisfies readonly TipoLamina[];
export const ESTADOS_ANALISIS = ['pendiente', 'procesando', 'analizada', 'bloqueada_escala', 'error'] as const satisfies readonly EstadoAnalisis[];
export const TIPOS_HALLAZGO = ['faltante', 'inconsistencia', 'existente_confirmar', 'supuesto'] as const satisfies readonly TipoHallazgo[];
export const ESTADOS_HALLAZGO = ['abierto', 'respondido', 'descartado'] as const satisfies readonly EstadoHallazgo[];
export const ESTADOS_RUBRO = ['borrador', 'revision', 'aprobado'] as const satisfies readonly EstadoRubro[];

// F1–F4
export const ROLES_USUARIO = ['titular', 'colaborador', 'lectura'] as const satisfies readonly RolUsuario[];
export const ESTADOS_COMPULSA = ['borrador', 'lanzada', 'cerrada', 'adjudicada'] as const satisfies readonly EstadoCompulsa[];
export const ESTADOS_CONTACTO = ['pendiente', 'contactado', 'cotizo', 'negociando', 'cerrado', 'sin_respuesta'] as const satisfies readonly EstadoContacto[];
export const CANALES = ['manual', 'whatsapp', 'voz', 'email'] as const satisfies readonly Canal[];
export const MATCHES_CONCILIACION = ['exacto', 'parcial', 'sustituto', 'no_cotizado', 'extra'] as const satisfies readonly MatchConciliacion[];
export const ESTADOS_DEDUCCION = ['propuesta', 'validada', 'rechazada'] as const satisfies readonly EstadoDeduccion[];
export const REGLAS_DEDUCCION = ['planilla_plano', 'planta_corte', 'continuidad', 'idem_tipologia', 'cierre_cotas'] as const satisfies readonly ReglaDeduccion[];
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

export const CONFIG_ESTUDIO_DEFAULT: ConfigEstudio = {
  desperdiciosPct: {},
  condicionesDefault: CONDICIONES_RFQ_DEFAULT,
  mandatoDefault: MANDATO_DEFAULT,
  pesosRanking: PESOS_RANKING_DEFAULT,
  mepReferencia: null,
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

export const zEntidadDetectada = z.object({
  tipo: z.enum(TIPOS_ENTIDAD),
  nombre: z.string(),
  bbox: zBBox,
  confianza: z.number().min(0).max(1),
  estadoReforma: z.enum(ESTADOS_REFORMA),
  atributos: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
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

/** Mandato de negociación. `maxRondas` es 2 y punto (RF-1001). */
export const zMandato = z.object({
  objetivoMejoraPct: z.number().min(0).max(100),
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
  | Difiere<z.infer<typeof zEntidadDetectada>, EntidadDetectada, 'zEntidadDetectada'>
  | Difiere<z.infer<typeof zRotuloDetectado>, RotuloDetectado, 'zRotuloDetectado'>
  | Difiere<z.infer<typeof zCondicionesRfq>, CondicionesRfq, 'zCondicionesRfq'>
  | Difiere<z.infer<typeof zItemRfq>, ItemRfq, 'zItemRfq'>
  | Difiere<z.infer<typeof zMandato>, Mandato, 'zMandato'>
  | Difiere<z.infer<typeof zLineaPresupuesto>, LineaPresupuesto, 'zLineaPresupuesto'>
  | Difiere<z.infer<typeof zConfigEstudio>, ConfigEstudio, 'zConfigEstudio'>
>;
