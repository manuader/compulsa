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
export type TipoEntidad = 'ambiente' | 'muro' | 'tabique' | 'abertura' | 'artefacto' | 'terminacion' | 'otro';
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
// Valores de cada unión cerrada. `schema.ts` los usa para sus `pgEnum` y los
// providers para sus schemas Zod: una sola lista por tipo, en un solo lugar.
// ---------------------------------------------------------------------------

export const ORIGENES = ['explicito', 'deducido', 'supuesto'] as const satisfies readonly Origen[];
export const ESTADOS_REFORMA = ['existente', 'demoler', 'nueva', 'na'] as const satisfies readonly EstadoReforma[];
export const TIPOS_OBRA = ['nueva', 'reforma', 'ampliacion'] as const satisfies readonly TipoObra[];
export const RUBROS = ['aberturas', 'seco', 'pintura', 'gruesa'] as const satisfies readonly RubroId[];
export const UNIDADES = ['u', 'm', 'ml', 'm2', 'm3', 'l', 'kg'] as const satisfies readonly Unidad[];
export const TIPOS_ENTIDAD = ['ambiente', 'muro', 'tabique', 'abertura', 'artefacto', 'terminacion', 'otro'] as const satisfies readonly TipoEntidad[];
export const DISCIPLINAS = ['arquitectura', 'estructura', 'instalaciones', 'otra'] as const satisfies readonly Disciplina[];
export const TIPOS_LAMINA = ['planta', 'corte', 'vista', 'detalle', 'planilla', 'otra'] as const satisfies readonly TipoLamina[];
export const ESTADOS_ANALISIS = ['pendiente', 'procesando', 'analizada', 'bloqueada_escala', 'error'] as const satisfies readonly EstadoAnalisis[];
export const TIPOS_HALLAZGO = ['faltante', 'inconsistencia', 'existente_confirmar', 'supuesto'] as const satisfies readonly TipoHallazgo[];
export const ESTADOS_HALLAZGO = ['abierto', 'respondido', 'descartado'] as const satisfies readonly EstadoHallazgo[];
export const ESTADOS_RUBRO = ['borrador', 'revision', 'aprobado'] as const satisfies readonly EstadoRubro[];

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
>;
