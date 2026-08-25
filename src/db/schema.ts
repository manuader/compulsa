/**
 * Esquema Drizzle de Compulsa (PRD §10, subconjunto de la fase F0).
 *
 * Nombres de tablas y columnas en español, idénticos al PRD. Cada tipo cerrado
 * es un `pgEnum` cuyos valores salen de `src/types/domain.ts` — una sola fuente
 * de verdad para el dominio TypeScript y para Postgres (ver `src/db/CLAUDE.md`).
 */
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  DISCIPLINAS,
  ESTADOS_ANALISIS,
  ESTADOS_HALLAZGO,
  ESTADOS_REFORMA,
  ESTADOS_RUBRO,
  ORIGENES,
  RUBROS,
  TIPOS_ENTIDAD,
  TIPOS_HALLAZGO,
  TIPOS_LAMINA,
  TIPOS_OBRA,
  UNIDADES,
  type EntidadDetectada,
  type Fuente,
  // Import relativo a propósito: `drizzle-kit generate` bundlea este archivo con
  // esbuild y no resuelve el alias `@/` del tsconfig.
} from '../types/domain';

// --- Enums que no viven en el dominio compartido (son de plataforma) --------

export const ROLES_USUARIO = ['titular', 'colaborador', 'lectura'] as const;
export const ESTADOS_OBRA = ['activa', 'archivada'] as const;
export const TIPOS_DOCUMENTO = ['plano', 'pliego', 'planilla', 'memoria', 'foto', 'otro'] as const;
export const ESTADOS_ITEM = ['activo', 'anulado'] as const;
export const ACTORES = ['usuario', 'agente'] as const;

export type RolUsuario = (typeof ROLES_USUARIO)[number];
export type EstadoObra = (typeof ESTADOS_OBRA)[number];
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number];
export type EstadoItem = (typeof ESTADOS_ITEM)[number];
export type ActorTipo = (typeof ACTORES)[number];

// --- pgEnums ---------------------------------------------------------------

export const rolUsuarioEnum = pgEnum('rol_usuario', ROLES_USUARIO);
export const tipoObraEnum = pgEnum('tipo_obra', TIPOS_OBRA);
export const estadoObraEnum = pgEnum('estado_obra', ESTADOS_OBRA);
export const tipoDocumentoEnum = pgEnum('tipo_documento', TIPOS_DOCUMENTO);
export const disciplinaEnum = pgEnum('disciplina', DISCIPLINAS);
export const tipoLaminaEnum = pgEnum('tipo_lamina', TIPOS_LAMINA);
export const estadoAnalisisEnum = pgEnum('estado_analisis', ESTADOS_ANALISIS);
export const tipoEntidadEnum = pgEnum('tipo_entidad', TIPOS_ENTIDAD);
export const estadoReformaEnum = pgEnum('estado_reforma', ESTADOS_REFORMA);
export const rubroEnum = pgEnum('rubro', RUBROS);
export const unidadEnum = pgEnum('unidad', UNIDADES);
export const origenItemEnum = pgEnum('origen_item', ORIGENES);
export const estadoItemEnum = pgEnum('estado_item', ESTADOS_ITEM);
export const estadoRubroEnum = pgEnum('estado_rubro', ESTADOS_RUBRO);
export const tipoHallazgoEnum = pgEnum('tipo_hallazgo', TIPOS_HALLAZGO);
export const estadoHallazgoEnum = pgEnum('estado_hallazgo', ESTADOS_HALLAZGO);
export const actorTipoEnum = pgEnum('actor_tipo', ACTORES);

// --- Tablas ----------------------------------------------------------------

export const estudios = pgTable('estudios', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: text('nombre').notNull(),
  configJson: jsonb('config_json').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usuarios = pgTable('usuarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  estudioId: uuid('estudio_id')
    .notNull()
    .references(() => estudios.id),
  email: text('email').notNull().unique(),
  nombre: text('nombre').notNull(),
  passwordHash: text('password_hash').notNull(),
  rol: rolUsuarioEnum('rol').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Sesión de cookie. Su vida útil la define `expira_at`; no lleva `created_at`. */
export const sesiones = pgTable('sesiones', {
  token: text('token').primaryKey(),
  usuarioId: uuid('usuario_id')
    .notNull()
    .references(() => usuarios.id),
  expiraAt: timestamp('expira_at', { withTimezone: true }).notNull(),
});

export const obras = pgTable('obras', {
  id: uuid('id').primaryKey().defaultRandom(),
  estudioId: uuid('estudio_id')
    .notNull()
    .references(() => estudios.id),
  nombre: text('nombre').notNull(),
  zona: text('zona').notNull(),
  tipo: tipoObraEnum('tipo').notNull(),
  moneda: text('moneda').notNull().default('ARS'),
  estado: estadoObraEnum('estado').notNull().default('activa'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Archivo subido por el usuario. Inmutable: los derivados son registros nuevos. */
export const documentos = pgTable('documentos', {
  id: uuid('id').primaryKey().defaultRandom(),
  obraId: uuid('obra_id')
    .notNull()
    .references(() => obras.id),
  nombreArchivo: text('nombre_archivo').notNull(),
  tipo: tipoDocumentoEnum('tipo').notNull(),
  archivoRef: text('archivo_ref').notNull(),
  mime: text('mime').notNull(),
  hash: text('hash').notNull(),
  version: integer('version').notNull().default(1),
  subidoPor: uuid('subido_por')
    .notNull()
    .references(() => usuarios.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Una página del documento original, con su rótulo leído y su estado de análisis. */
export const laminas = pgTable('laminas', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentoId: uuid('documento_id')
    .notNull()
    .references(() => documentos.id),
  obraId: uuid('obra_id')
    .notNull()
    .references(() => obras.id),
  numeroPagina: integer('numero_pagina').notNull(),
  codigo: text('codigo'),
  titulo: text('titulo'),
  disciplina: disciplinaEnum('disciplina'),
  tipo: tipoLaminaEnum('tipo'),
  escala: text('escala'),
  escalaConfiable: boolean('escala_confiable').notNull().default(false),
  revision: text('revision'),
  estadoAnalisis: estadoAnalisisEnum('estado_analisis').notNull().default('pendiente'),
  errorDetalle: text('error_detalle'),
  archivoRef: text('archivo_ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entidades = pgTable('entidades', {
  id: uuid('id').primaryKey().defaultRandom(),
  obraId: uuid('obra_id')
    .notNull()
    .references(() => obras.id),
  laminaId: uuid('lamina_id')
    .notNull()
    .references(() => laminas.id),
  tipo: tipoEntidadEnum('tipo').notNull(),
  nombre: text('nombre').notNull(),
  atributosJson: jsonb('atributos_json').$type<EntidadDetectada['atributos']>().notNull(),
  estadoReforma: estadoReformaEnum('estado_reforma').notNull().default('na'),
  /** Provenance (P1): lámina + bbox normalizado. Nunca vacío para datos de agente. */
  fuentesJson: jsonb('fuentes_json').$type<Fuente[]>().notNull(),
  confianza: real('confianza').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const computoItems = pgTable('computo_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  obraId: uuid('obra_id')
    .notNull()
    .references(() => obras.id),
  rubro: rubroEnum('rubro').notNull(),
  entidadId: uuid('entidad_id').references(() => entidades.id),
  claveItem: text('clave_item').notNull(),
  descripcion: text('descripcion').notNull(),
  unidad: unidadEnum('unidad').notNull(),
  cantNeta: numeric('cant_neta', { precision: 12, scale: 2, mode: 'number' }).notNull(),
  desperdicioPct: numeric('desperdicio_pct', { precision: 5, scale: 2, mode: 'number' }).notNull(),
  cantCompra: numeric('cant_compra', { precision: 12, scale: 2, mode: 'number' }).notNull(),
  presentacion: text('presentacion').notNull(),
  origen: origenItemEnum('origen').notNull(),
  /** Provenance (P1). Único caso legítimo de `[]`: ítem creado a mano por el usuario. */
  fuentesJson: jsonb('fuentes_json').$type<Fuente[]>().notNull(),
  confianza: real('confianza').notNull(),
  estado: estadoItemEnum('estado').notNull().default('activo'),
  /** `null` ⇒ ítem de agente: el recompute puede reemplazarlo. Seteado ⇒ intocable. */
  editadoPor: uuid('editado_por').references(() => usuarios.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Estado de aprobación por rubro de una obra (RF-404). */
export const computoRubros = pgTable(
  'computo_rubros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    rubro: rubroEnum('rubro').notNull(),
    estado: estadoRubroEnum('estado').notNull().default('borrador'),
    aprobadoPor: uuid('aprobado_por').references(() => usuarios.id),
    aprobadoAt: timestamp('aprobado_at', { withTimezone: true }),
  },
  (t) => [unique('computo_rubros_obra_rubro_uq').on(t.obraId, t.rubro)],
);

export const hallazgos = pgTable(
  'hallazgos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    /** Estable por obra: el recompute hace upsert por `(obra_id, clave)`. */
    clave: text('clave').notNull(),
    tipo: tipoHallazgoEnum('tipo').notNull(),
    rubro: rubroEnum('rubro'),
    descripcion: text('descripcion').notNull(),
    checklistItem: text('checklist_item'),
    /** Láminas citadas CON su bbox: es el `fuentes: Fuente[]` de `HallazgoDetectado`. */
    laminasJson: jsonb('laminas_json').$type<Fuente[]>().notNull(),
    targetRef: jsonb('target_ref').$type<{ entidadId: string; campo: string }>(),
    bloqueante: boolean('bloqueante').notNull(),
    estado: estadoHallazgoEnum('estado').notNull().default('abierto'),
    respuestaJson: jsonb('respuesta_json').$type<Record<string, unknown>>(),
    resueltoPor: uuid('resuelto_por').references(() => usuarios.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('hallazgos_obra_clave_uq').on(t.obraId, t.clave)],
);

/** Toda escritura de agente o acción sensible del usuario deja rastro acá. */
export const auditoria = pgTable('auditoria', {
  id: uuid('id').primaryKey().defaultRandom(),
  obraId: uuid('obra_id').references(() => obras.id),
  actorTipo: actorTipoEnum('actor_tipo').notNull(),
  actorNombre: text('actor_nombre').notNull(),
  accion: text('accion').notNull(),
  targetRef: text('target_ref'),
  diffJson: jsonb('diff_json').$type<Record<string, unknown>>(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

// --- Tipos de fila ---------------------------------------------------------

export type Estudio = typeof estudios.$inferSelect;
export type Usuario = typeof usuarios.$inferSelect;
export type Sesion = typeof sesiones.$inferSelect;
export type Obra = typeof obras.$inferSelect;
export type Documento = typeof documentos.$inferSelect;
export type Lamina = typeof laminas.$inferSelect;
export type Entidad = typeof entidades.$inferSelect;
export type ComputoItem = typeof computoItems.$inferSelect;
export type ComputoRubro = typeof computoRubros.$inferSelect;
export type Hallazgo = typeof hallazgos.$inferSelect;
export type RegistroAuditoria = typeof auditoria.$inferSelect;

export type NuevoEstudio = typeof estudios.$inferInsert;
export type NuevoUsuario = typeof usuarios.$inferInsert;
export type NuevaObra = typeof obras.$inferInsert;
export type NuevoDocumento = typeof documentos.$inferInsert;
export type NuevaLamina = typeof laminas.$inferInsert;
export type NuevaEntidad = typeof entidades.$inferInsert;
export type NuevoComputoItem = typeof computoItems.$inferInsert;
export type NuevoHallazgo = typeof hallazgos.$inferInsert;
