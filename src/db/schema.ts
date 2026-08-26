/**
 * Esquema Drizzle de Compulsa (PRD §10, subconjunto de la fase F0).
 *
 * Nombres de tablas y columnas en español, idénticos al PRD. Cada tipo cerrado
 * es un `pgEnum` cuyos valores salen de `src/types/domain.ts` — una sola fuente
 * de verdad para el dominio TypeScript y para Postgres (ver `src/db/CLAUDE.md`).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  CANALES,
  DISCIPLINAS,
  ESTADOS_ANALISIS,
  ESTADOS_COMPULSA,
  ESTADOS_CONTACTO,
  ESTADOS_DEDUCCION,
  ESTADOS_HALLAZGO,
  ESTADOS_REFORMA,
  ESTADOS_RUBRO,
  MATCHES_CONCILIACION,
  ORIGENES,
  REGLAS_DEDUCCION,
  ROLES_USUARIO,
  RUBROS,
  TIPOS_ENTIDAD,
  TIPOS_HALLAZGO,
  TIPOS_LAMINA,
  TIPOS_OBRA,
  UNIDADES,
  type CondicionesRfq,
  type ConfigEstudio,
  type EntidadDetectada,
  type Fuente,
  type ItemRfq,
  type LineaPresupuesto,
  type Mandato,
  type RolUsuario,
  // Import relativo a propósito: `drizzle-kit generate` bundlea este archivo con
  // esbuild y no resuelve el alias `@/` del tsconfig.
} from '../types/domain';

// `rol_usuario` ya era enum de DB antes de F1; ahora la lista vive en el dominio
// (los cores de roles la necesitan sin importar el esquema). Se re-exporta para
// no romper a quien la venía importando de acá.
export { ROLES_USUARIO, type RolUsuario };

// --- Enums que no viven en el dominio compartido (son de plataforma) --------

export const ESTADOS_OBRA = ['activa', 'archivada'] as const;
export const TIPOS_DOCUMENTO = ['plano', 'pliego', 'planilla', 'memoria', 'foto', 'otro'] as const;
export const ESTADOS_ITEM = ['activo', 'anulado'] as const;
export const ACTORES = ['usuario', 'agente'] as const;
export const ORIGENES_PROVEEDOR = ['agenda', 'manual', 'historico'] as const;
export const DIRECCIONES_MENSAJE = ['saliente', 'entrante'] as const;
export const ESTADOS_COTIZACION = ['recibida', 'conciliada', 'descartada'] as const;
export const RESULTADOS_NEGOCIACION = [
  'pendiente',
  'aceptada',
  'rechazada',
  'contraoferta',
] as const;

export type EstadoObra = (typeof ESTADOS_OBRA)[number];
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number];
export type EstadoItem = (typeof ESTADOS_ITEM)[number];
export type ActorTipo = (typeof ACTORES)[number];
export type OrigenProveedor = (typeof ORIGENES_PROVEEDOR)[number];
export type DireccionMensaje = (typeof DIRECCIONES_MENSAJE)[number];
export type EstadoCotizacion = (typeof ESTADOS_COTIZACION)[number];
export type ResultadoNegociacion = (typeof RESULTADOS_NEGOCIACION)[number];

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
// F1–F4
export const origenProveedorEnum = pgEnum('origen_proveedor', ORIGENES_PROVEEDOR);
export const estadoCompulsaEnum = pgEnum('estado_compulsa', ESTADOS_COMPULSA);
export const canalEnum = pgEnum('canal', CANALES);
export const estadoContactoEnum = pgEnum('estado_contacto', ESTADOS_CONTACTO);
export const direccionMensajeEnum = pgEnum('direccion_mensaje', DIRECCIONES_MENSAJE);
export const estadoCotizacionEnum = pgEnum('estado_cotizacion', ESTADOS_COTIZACION);
export const matchConciliacionEnum = pgEnum('match_conciliacion', MATCHES_CONCILIACION);
export const resultadoNegociacionEnum = pgEnum('resultado_negociacion', RESULTADOS_NEGOCIACION);
export const reglaDeduccionEnum = pgEnum('regla_deduccion', REGLAS_DEDUCCION);
export const estadoDeduccionEnum = pgEnum('estado_deduccion', ESTADOS_DEDUCCION);

// --- Tablas ----------------------------------------------------------------

export const estudios = pgTable('estudios', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: text('nombre').notNull(),
  /**
   * Overrides del estudio, **parciales**: lo que no está acá lo pone
   * `zConfigEstudio` al parsear (`CONFIG_ESTUDIO_DEFAULT`). Guardar la config
   * completa obligaría a migrar todas las filas cada vez que el PRD agrega una
   * clave; guardar solo lo pisado, no.
   */
  configJson: jsonb('config_json').$type<Partial<ConfigEstudio>>().notNull().default({}),
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
  /** Baja lógica (RF-1201): la auditoría lo sigue nombrando, pero no entra más. */
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Invitación a sumarse a un estudio con un rol. El código es la PK: es lo que
 * viaja en el link, y así no hay manera de aceptar una invitación adivinando un
 * id secuencial.
 */
export const invitaciones = pgTable('invitaciones', {
  codigo: text('codigo').primaryKey(),
  estudioId: uuid('estudio_id')
    .notNull()
    .references(() => estudios.id),
  rol: rolUsuarioEnum('rol').notNull(),
  /** `null` ⇒ sin usar. Seteado ⇒ quemada, aunque no haya vencido. */
  usadaPor: uuid('usada_por').references(() => usuarios.id),
  expiraAt: timestamp('expira_at', { withTimezone: true }).notNull(),
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
  /** Resumen cacheado del tablero (totales por rubro, ahorro). `null` ⇒ sin calcular. */
  resumenJson: jsonb('resumen_json').$type<Record<string, unknown>>(),
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
export const laminas = pgTable(
  'laminas',
  {
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
    /** Texto del PDF de la página. Lo persiste el pipeline; el Q&A (RF-106) lo cita. */
    textoExtraido: text('texto_extraido'),
    /**
     * Cuándo la tomó la corrida que la dejó en `procesando`. Es el reloj del
     * rescate por TTL: `null` mientras nadie la tenga tomada. Antes esto se leía
     * de `auditoria`, que era el único reloj disponible en F0.
     */
    procesandoDesde: timestamp('procesando_desde', { withTimezone: true }),
    archivoRef: text('archivo_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('laminas_obra_idx').on(t.obraId)],
);

export const entidades = pgTable(
  'entidades',
  {
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
  },
  (t) => [index('entidades_obra_idx').on(t.obraId)],
);

export const computoItems = pgTable(
  'computo_items',
  {
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
  },
  (t) => [
    // El índice único es parcial: no sirve para las queries que traen la
    // planilla entera (activos + anulados), así que el de `obra_id` va aparte.
    index('computo_items_obra_idx').on(t.obraId),
    /**
     * Una sola fila **activa** por `(obra, clave_item)` — la deuda de F0.
     *
     * Parcial a propósito: los `anulado` son el historial (CLAUDE.md §7, nada de
     * deletes físicos) y la misma clave puede repetirse ahí tantas veces como
     * el recompute la haya dado de baja. La unicidad que importa es la de la
     * planilla, que solo muestra activos. El recompute hace update-by-id y
     * revive el anulado en lugar de insertar otro, así que este índice le
     * confirma la invariante en vez de pelearla.
     */
    uniqueIndex('computo_items_obra_clave_activo_uq')
      .on(t.obraId, t.claveItem)
      .where(sql`${t.estado} = 'activo'`),
  ],
);

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
  (t) => [
    unique('hallazgos_obra_clave_uq').on(t.obraId, t.clave),
    index('hallazgos_obra_idx').on(t.obraId),
  ],
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

/**
 * Cada corrida del recompute con lo que cambió. La auditoría guarda el detalle
 * por ítem; esto guarda la corrida entera, que es lo que la pantalla de la obra
 * muestra como "se recalculó porque…".
 */
export const recomputos = pgTable('recomputos', {
  id: uuid('id').primaryKey().defaultRandom(),
  obraId: uuid('obra_id')
    .notNull()
    .references(() => obras.id),
  diffJson: jsonb('diff_json').$type<Record<string, unknown>>().notNull(),
  motivo: text('motivo').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

// --- F1: compulsa ----------------------------------------------------------

/**
 * Proveedor de la agenda del estudio (PRD §10).
 *
 * `opt_in_wa` y `opt_out` no son preferencias de UI: son el registro de
 * consentimiento que el compliance de §13 exige antes de mandarle nada por
 * WhatsApp. `opt_in_registrado_en` fecha ese consentimiento.
 */
export const proveedores = pgTable('proveedores', {
  id: uuid('id').primaryKey().defaultRandom(),
  estudioId: uuid('estudio_id')
    .notNull()
    .references(() => estudios.id),
  nombre: text('nombre').notNull(),
  rubros: rubroEnum('rubros').array().notNull(),
  zona: text('zona').notNull(),
  /** Canales del proveedor: `{ telefono, email, whatsapp, contacto }`. */
  contactosJson: jsonb('contactos_json').$type<Record<string, unknown>>().notNull().default({}),
  optInWa: boolean('opt_in_wa').notNull().default(false),
  optInRegistradoEn: timestamp('opt_in_registrado_en', { withTimezone: true }),
  optOut: boolean('opt_out').notNull().default(false),
  /** Reputación calculada por el estudio; `null` ⇒ todavía no cotizó nada. */
  score: real('score'),
  origen: origenProveedorEnum('origen').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Una compulsa **es** el snapshot del RFQ (así se llama `snapshots_rfq` puertas
 * adentro): congela los ítems y las condiciones que se mandaron.
 *
 * `snapshot_hash` es el sha256 de `{ items ordenados por claveItem, condiciones }`
 * (RF-701): si el cómputo aprobado se edita después, el hash deja de coincidir y
 * hay que crear una **versión nueva**, no pisar esta. Por eso no hay UNIQUE por
 * `(obra, rubro)`: las versiones conviven.
 */
export const compulsas = pgTable('compulsas', {
  id: uuid('id').primaryKey().defaultRandom(),
  obraId: uuid('obra_id')
    .notNull()
    .references(() => obras.id),
  rubro: rubroEnum('rubro').notNull(),
  estado: estadoCompulsaEnum('estado').notNull().default('borrador'),
  snapshotHash: text('snapshot_hash').notNull(),
  itemsJson: jsonb('items_json').$type<ItemRfq[]>().notNull(),
  condicionesJson: jsonb('condiciones_json').$type<CondicionesRfq>().notNull(),
  /** `null` ⇒ sin mandato de negociación: el motor de F3 no propone contraofertas. */
  mandatoJson: jsonb('mandato_json').$type<Mandato>(),
  version: integer('version').notNull().default(1),
  aprobadoPor: uuid('aprobado_por').references(() => usuarios.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A quién se le mandó esta compulsa y en qué anda. Un proveedor, una vez. */
export const contactosCompulsa = pgTable(
  'contactos_compulsa',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    compulsaId: uuid('compulsa_id')
      .notNull()
      .references(() => compulsas.id),
    proveedorId: uuid('proveedor_id')
      .notNull()
      .references(() => proveedores.id),
    canal: canalEnum('canal').notNull().default('manual'),
    estado: estadoContactoEnum('estado').notNull().default('pendiente'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('contactos_compulsa_compulsa_proveedor_uq').on(t.compulsaId, t.proveedorId),
    index('contactos_compulsa_compulsa_idx').on(t.compulsaId),
  ],
);

/**
 * El hilo con el proveedor. `registrado_por` es quien lo cargó a mano (canal
 * `manual`, el único activo); `null` ⇒ lo escribió el sistema.
 */
export const mensajes = pgTable(
  'mensajes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactoId: uuid('contacto_id')
      .notNull()
      .references(() => contactosCompulsa.id),
    direccion: direccionMensajeEnum('direccion').notNull(),
    canal: canalEnum('canal').notNull(),
    cuerpo: text('cuerpo').notNull(),
    registradoPor: uuid('registrado_por').references(() => usuarios.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mensajes_contacto_idx').on(t.contactoId)],
);

/**
 * El presupuesto que mandó el proveedor. `lineas_json` es lo que se leyó del
 * texto (crudo, sin conciliar); `raw_texto`/`raw_ref` guardan el original para
 * poder volver a leerlo sin pedírselo de nuevo al proveedor.
 */
export const cotizaciones = pgTable(
  'cotizaciones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactoId: uuid('contacto_id')
      .notNull()
      .references(() => contactosCompulsa.id),
    moneda: text('moneda').notNull().default('ARS'),
    incluyeIva: boolean('incluye_iva').notNull(),
    validezDias: integer('validez_dias'),
    plazoDias: integer('plazo_dias'),
    formaPago: text('forma_pago'),
    total: numeric('total', { precision: 14, scale: 2, mode: 'number' }),
    lineasJson: jsonb('lineas_json').$type<LineaPresupuesto[]>().notNull(),
    rawTexto: text('raw_texto'),
    rawRef: text('raw_ref'),
    /** RF-903: `(exactos + 0,5×parciales) / totalItemsRfq`. `null` ⇒ sin conciliar. */
    scoreFidelidad: numeric('score_fidelidad', { precision: 4, scale: 2, mode: 'number' }),
    estado: estadoCotizacionEnum('estado').notNull().default('recibida'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('cotizaciones_contacto_idx').on(t.contactoId)],
);

/**
 * Cómo se mapeó cada ítem del RFQ contra las líneas del presupuesto (RF-902).
 *
 * `clave_item` es `null` justo en las líneas `extra` (el proveedor cotizó algo
 * que nadie pidió): el UNIQUE no las pisa entre sí porque en Postgres los NULL
 * no chocan, y una cotización puede traer varias.
 */
export const conciliacionItems = pgTable(
  'conciliacion_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cotizacionId: uuid('cotizacion_id')
      .notNull()
      .references(() => cotizaciones.id),
    claveItem: text('clave_item'),
    /** Índice dentro de `cotizaciones.lineas_json`. `null` ⇒ ítem no cotizado. */
    lineaIdx: integer('linea_idx'),
    match: matchConciliacionEnum('match').notNull(),
    desvioJson: jsonb('desvio_json').$type<Record<string, unknown>>(),
    nota: text('nota'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('conciliacion_items_cotizacion_clave_uq').on(t.cotizacionId, t.claveItem),
    index('conciliacion_items_cotizacion_idx').on(t.cotizacionId),
  ],
);

/** Ronda de negociación (RF-1001: máximo 2). Todo queda escrito, gane o pierda. */
export const negociaciones = pgTable(
  'negociaciones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cotizacionId: uuid('cotizacion_id')
      .notNull()
      .references(() => cotizaciones.id),
    ronda: integer('ronda').notNull(),
    ofertaJson: jsonb('oferta_json').$type<Record<string, unknown>>().notNull(),
    resultado: resultadoNegociacionEnum('resultado').notNull().default('pendiente'),
    logJson: jsonb('log_json').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('negociaciones_cotizacion_idx').on(t.cotizacionId)],
);

/** Una compulsa se adjudica una sola vez. `confirmado_at` ⇒ la OC salió. */
export const adjudicaciones = pgTable(
  'adjudicaciones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    compulsaId: uuid('compulsa_id')
      .notNull()
      .references(() => compulsas.id),
    cotizacionId: uuid('cotizacion_id')
      .notNull()
      .references(() => cotizaciones.id),
    ocTexto: text('oc_texto').notNull(),
    confirmadoAt: timestamp('confirmado_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('adjudicaciones_compulsa_uq').on(t.compulsaId)],
);

/**
 * Índice de precios del estudio (RF-1103), un renglón por `(clave, zona, mes)`.
 *
 * `muestras_json` guarda la serie del mes: los percentiles son nearest-rank y se
 * recalculan agregando una muestra, cosa que no se puede hacer teniendo solo
 * p25/p50/p75. `n` es `muestras_json.length`, materializado para el `n ≥ 3` del
 * benchmark.
 */
export const priceIndex = pgTable(
  'price_index',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    estudioId: uuid('estudio_id')
      .notNull()
      .references(() => estudios.id),
    claveItem: text('clave_item').notNull(),
    zona: text('zona').notNull(),
    /** Mes calendario, `YYYY-MM`. */
    mes: text('mes').notNull(),
    p25: numeric('p25', { precision: 14, scale: 2, mode: 'number' }).notNull(),
    p50: numeric('p50', { precision: 14, scale: 2, mode: 'number' }).notNull(),
    p75: numeric('p75', { precision: 14, scale: 2, mode: 'number' }).notNull(),
    n: integer('n').notNull(),
    muestrasJson: jsonb('muestras_json').$type<number[]>().notNull().default([]),
  },
  (t) => [
    unique('price_index_estudio_clave_zona_mes_uq').on(t.estudioId, t.claveItem, t.zona, t.mes),
  ],
);

// --- F2: deducción y plataforma --------------------------------------------

/**
 * Una deducción propuesta por el motor de reglas (§11 PRD).
 *
 * Nunca se escribe sola en la entidad: nace `propuesta` y solo al validarla el
 * atributo baja a `entidades.atributos_json` (P4, deducir no es inventar).
 * `fuentes_json` lleva ≥ 2 láminas y `confianza < 0,7` no se propone.
 */
export const deducciones = pgTable(
  'deducciones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    entidadId: uuid('entidad_id')
      .notNull()
      .references(() => entidades.id),
    /** Nombre del atributo, tal cual va en `atributos_json` (ej. `alturaM`). */
    campo: text('campo').notNull(),
    regla: reglaDeduccionEnum('regla').notNull(),
    fuentesJson: jsonb('fuentes_json').$type<Fuente[]>().notNull(),
    /** `{ [campo]: valor }`: se mergea tal cual en `entidades.atributos_json`. */
    valorJson: jsonb('valor_json').$type<EntidadDetectada['atributos']>().notNull(),
    confianza: real('confianza').notNull(),
    estado: estadoDeduccionEnum('estado').notNull().default('propuesta'),
    validadoPor: uuid('validado_por').references(() => usuarios.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('deducciones_obra_entidad_campo_uq').on(t.obraId, t.entidadId, t.campo),
    index('deducciones_obra_idx').on(t.obraId),
  ],
);

/** Checklist por rubro que el estudio ajusta (RF-405). `activo=false` ⇒ no se chequea. */
export const checklistsEstudio = pgTable(
  'checklists_estudio',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    estudioId: uuid('estudio_id')
      .notNull()
      .references(() => estudios.id),
    rubro: rubroEnum('rubro').notNull(),
    itemId: text('item_id').notNull(),
    descripcion: text('descripcion').notNull(),
    bloqueante: boolean('bloqueante').notNull().default(false),
    activo: boolean('activo').notNull().default(true),
  },
  (t) => [unique('checklists_estudio_estudio_rubro_item_uq').on(t.estudioId, t.rubro, t.itemId)],
);

/**
 * Campana del workspace. `link` es la ruta interna a la que lleva, si lleva a
 * alguna.
 *
 * `clave_dedup` es la marca de "de esto ya avisé": el productor que no quiere
 * repetirse la manda y el UNIQUE `(usuario_id, clave_dedup)` lo garantiza sin
 * carreras (`ON CONFLICT DO NOTHING`, ver `crearNotificacion`). Va en su propia
 * columna y **no** sobre `link` porque el link no es único por evento: tres
 * proveedores cotizando la misma compulsa llevan al mismo lugar y son tres
 * avisos distintos. En `null` —el caso normal— no participa del UNIQUE, así que
 * un productor que no deduplica se comporta como siempre.
 */
export const notificaciones = pgTable(
  'notificaciones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id),
    titulo: text('titulo').notNull(),
    cuerpo: text('cuerpo').notNull(),
    link: text('link'),
    claveDedup: text('clave_dedup'),
    leida: boolean('leida').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notificaciones_usuario_idx').on(t.usuarioId),
    unique('notificaciones_usuario_dedup_uq').on(t.usuarioId, t.claveDedup),
  ],
);

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
export type Invitacion = typeof invitaciones.$inferSelect;
export type Recomputo = typeof recomputos.$inferSelect;
export type Proveedor = typeof proveedores.$inferSelect;
export type Compulsa = typeof compulsas.$inferSelect;
export type ContactoCompulsa = typeof contactosCompulsa.$inferSelect;
export type Mensaje = typeof mensajes.$inferSelect;
export type Cotizacion = typeof cotizaciones.$inferSelect;
export type ConciliacionItem = typeof conciliacionItems.$inferSelect;
export type Negociacion = typeof negociaciones.$inferSelect;
export type Adjudicacion = typeof adjudicaciones.$inferSelect;
export type PrecioIndice = typeof priceIndex.$inferSelect;
export type Deduccion = typeof deducciones.$inferSelect;
export type ChecklistEstudio = typeof checklistsEstudio.$inferSelect;
export type Notificacion = typeof notificaciones.$inferSelect;

export type NuevoEstudio = typeof estudios.$inferInsert;
export type NuevoUsuario = typeof usuarios.$inferInsert;
export type NuevaObra = typeof obras.$inferInsert;
export type NuevoDocumento = typeof documentos.$inferInsert;
export type NuevaLamina = typeof laminas.$inferInsert;
export type NuevaEntidad = typeof entidades.$inferInsert;
export type NuevoComputoItem = typeof computoItems.$inferInsert;
export type NuevoHallazgo = typeof hallazgos.$inferInsert;
export type NuevaInvitacion = typeof invitaciones.$inferInsert;
export type NuevoRecomputo = typeof recomputos.$inferInsert;
export type NuevoProveedor = typeof proveedores.$inferInsert;
export type NuevaCompulsa = typeof compulsas.$inferInsert;
export type NuevoContactoCompulsa = typeof contactosCompulsa.$inferInsert;
export type NuevoMensaje = typeof mensajes.$inferInsert;
export type NuevaCotizacion = typeof cotizaciones.$inferInsert;
export type NuevoConciliacionItem = typeof conciliacionItems.$inferInsert;
export type NuevaNegociacion = typeof negociaciones.$inferInsert;
export type NuevaAdjudicacion = typeof adjudicaciones.$inferInsert;
export type NuevoPrecioIndice = typeof priceIndex.$inferInsert;
export type NuevaDeduccion = typeof deducciones.$inferInsert;
export type NuevoChecklistEstudio = typeof checklistsEstudio.$inferInsert;
export type NuevaNotificacion = typeof notificaciones.$inferInsert;
