/**
 * El flujo de una compulsa, de punta a punta: lanzarla, registrar lo que
 * contesta el proveedor, conciliar el presupuesto y proponer la negociación.
 *
 * ## Por qué esto NO vive en un archivo `'use server'`
 *
 * Misma razón que `src/lib/proveedores/gestion.ts`: en un archivo `'use server'`
 * **todo export es un endpoint HTTP** con el payload que el cliente quiera.
 * Estas funciones reciben `db` y `actor` por parámetro; expuestas como endpoint,
 * cualquiera podría lanzar una compulsa en la obra de otro estudio firmando con
 * el rol que se le antoje. Los envoltorios `*Action` son de P8 y sacan el actor
 * de la sesión, nunca del payload.
 *
 * ## Las tres reglas que este módulo hace cumplir
 *
 * 1. **RF-701 — lo que se manda es lo que se aprobó.** El snapshot congela los
 *    ítems del cómputo aprobado y viaja con su hash. Si mañana la planilla se
 *    edita, el hash deja de coincidir y volver a lanzar **no corrige** la
 *    compulsa vieja: crea la versión N+1 y cierra la anterior, que queda
 *    visible con lo que efectivamente se pidió.
 * 2. **§13 — el opt-out es una pared.** Un proveedor que pidió no ser
 *    contactado no entra a la compulsa, y no desaparece en silencio: sale en
 *    `excluidos` con el motivo. El canal es `manual`: el sistema escribe, la
 *    persona manda.
 * 3. **RF-1002 — una sustitución de especificación escala.** Si el proveedor
 *    cotizó otra cosa, la conciliación lo marca, el contacto queda con bandera
 *    y la negociación automática se frena: eso lo decide el arquitecto.
 *
 * ## Lo que este módulo NO hace
 *
 * - **No notifica.** Las notificaciones son de P7: acá hay un hook opcional
 *   `deps.notificar` con default no-op. Cuando `src/lib/plataforma/notificaciones.ts`
 *   aterrice, los `*Action` de P8 se lo pasan y nada más cambia (P11 lo usa para
 *   poblar el seed).
 * - **No usa transacciones.** Igual que el resto de los cores del repo
 *   (`obras/gestion.ts`, `pipeline/procesar.ts`): `registrarAuditoria()` resuelve
 *   su propia conexión con `getDb()` y mezclarlo con una transacción explícita
 *   sería peor que el hueco que cierra. Los pasos están ordenados para que un
 *   corte a mitad deje datos incompletos pero no mentirosos (la compulsa existe
 *   sin recortes, no al revés).
 */
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { Db } from '@/db/client';
import {
  compulsas,
  computoItems,
  computoRubros,
  conciliacionItems,
  contactosCompulsa,
  cotizaciones,
  entidades,
  estudios,
  laminas,
  mensajes,
  negociaciones,
  priceIndex,
  proveedores,
  type Compulsa,
  type ComputoItem,
  type ContactoCompulsa,
  type Cotizacion,
  type Negociacion,
  type Proveedor,
  type RolUsuario,
} from '@/db/schema';
import {
  getPresupuestoProvider,
  METADATOS_VACIOS,
  type MetadatosPresupuesto,
  type PresupuestoProvider,
} from '@/lib/analysis/presupuesto-tipos';
import { registrarAuditoria } from '@/lib/audit';
import { requireObraCore } from '@/lib/auth/guards';
import { conciliar, precioUnitarioDe, type ResultadoConciliacion } from '@/lib/compulsa/conciliacion';
import { generarRecortes, type LaminaRecorte } from '@/lib/compulsa/recortes';
import {
  crearSnapshot,
  SPECS_CRITICAS_POR_RUBRO,
  type AtributosEntidad,
} from '@/lib/compulsa/snapshot';
import { generarTextoRfq } from '@/lib/compulsa/texto-rfq';
import { acumularMuestra } from '@/lib/indice/percentiles';
import { proponerContraoferta, type MotivoNoProcede } from '@/lib/negociacion/motor';
import { componerCuerpo, getCanal, type CanalOutreach } from '@/lib/outreach/canal';
import { requireContactoCore, requireCotizacionCore } from '@/lib/outreach/threads';
import { MIME_PDF } from '@/lib/pipeline/refs';
import { puedeContactarsePorWhatsapp, requireProveedorCore } from '@/lib/proveedores/gestion';
import { PLANTILLAS } from '@/lib/rubros/index';
import type { StorageAdapter } from '@/lib/storage/index';
import {
  zConfigEstudio,
  type Canal,
  type CondicionesRfq,
  type ItemComputo,
  type ItemRfq,
  type LineaPresupuesto,
  type Mandato,
  type RubroId,
  type TipoEntidad,
} from '@/types/domain';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/**
 * Quién hace el cambio. Lleva `estudioId` —a diferencia de `ActorProveedor`—
 * porque la cadena de compulsa se valida desde el otro extremo: un `contactoId`
 * suelto solo se puede resolver sabiendo de qué estudio es quien lo pide.
 */
export interface ActorCompulsa {
  usuarioId: string;
  email: string;
  rol: RolUsuario;
  estudioId: string;
}

/** Lo que pasó, para que P7 lo convierta en notificación (RF-1201/§8). */
export type EventoCompulsa =
  | { tipo: 'compulsa_lanzada'; obraId: string; compulsaId: string; rubro: RubroId; version: number; contactos: number }
  | { tipo: 'cotizacion_conciliada'; obraId: string; compulsaId: string; contactoId: string; cotizacionId: string; score: number; sustituciones: number }
  | { tipo: 'negociacion_propuesta'; obraId: string; compulsaId: string; contactoId: string; cotizacionId: string; ronda: number }
  | { tipo: 'negociacion_escalada'; obraId: string; compulsaId: string; contactoId: string; cotizacionId: string; motivo: MotivoNoProcede };

export interface DepsFlujo {
  /**
   * **Hook de P7 (notificaciones), default no-op.** El core no sabe de campanas
   * ni de mails: avisa que algo pasó y quien escuche decide. P11 lo usa para que
   * el seed deje notificaciones coherentes con lo que sembró.
   */
  notificar?: (evento: EventoCompulsa) => Promise<void>;
  /** Parser de presupuestos. Default: `getPresupuestoProvider()` (mock en tests). */
  presupuesto?: PresupuestoProvider;
  /** Canal de salida. Default: el del contacto (hoy siempre `manual`). */
  canal?: CanalOutreach;
  /** El reloj, para que el mes del índice de precios sea testeable. */
  ahora?: () => Date;
}

export interface OpcionesLanzamiento {
  /** Default: las condiciones del estudio (`config_json`, PRD §13). */
  condiciones?: CondicionesRfq;
  /** Default: el mandato del estudio. `null` explícito ⇒ sin negociación. */
  mandato?: Mandato | null;
  proveedorIds: readonly string[];
}

/** Un proveedor que quedó afuera, con el motivo en castellano. */
export interface ProveedorExcluido {
  proveedorId: string;
  nombre: string;
  motivo: string;
}

export interface RecorteGuardado {
  claveItem: string;
  laminaId: string;
  /** Ref del storage, bajo la obra: `…/compulsas/<id>/recortes/NN-clave.pdf`. */
  ref: string;
}

export interface ResultadoLanzamiento {
  compulsa: Compulsa;
  contactos: ContactoCompulsa[];
  excluidos: ProveedorExcluido[];
  /** El texto del pedido, listo para copiar (sin el bloque de adjuntos). */
  texto: string;
  recortes: RecorteGuardado[];
  /** `true` si el cómputo cambió desde la compulsa anterior (RF-701). */
  recompulsa: boolean;
  versionAnterior: number | null;
  /** Contactos cuyo canal no aceptó el mensaje. Con el canal manual, vacío. */
  fallosDeEnvio: { contactoId: string; motivo: string }[];
}

/** Lo que se registra como respuesta del proveedor. Texto **o** líneas ya leídas. */
export interface EntradaCotizacion {
  /** Nombre del archivo o del pegote: es la clave del fixture y va a la auditoría. */
  nombre: string;
  texto?: string;
  pdfBytes?: Uint8Array;
  /** Líneas ya parseadas (preview confirmado en la UI): se usan tal cual. */
  lineas?: readonly LineaPresupuesto[];
  /** Lo que el usuario corrigió a mano: pisa lo que haya leído el provider. */
  metadatos?: Partial<MetadatosPresupuesto>;
}

export interface ResultadoCotizacion {
  cotizacion: Cotizacion;
  conciliacion: ResultadoConciliacion;
  /** Repreguntas que quedaron como borrador saliente. */
  repreguntasCreadas: number;
  /** Cuántas líneas alimentaron el índice de precios (RF-1103). */
  muestrasIndice: number;
  /** Hay una sustitución de especificación: la decide una persona (RF-1002). */
  requiereDecision: boolean;
}

export type ResultadoNegociacion =
  | { procede: false; motivo: MotivoNoProcede; requiereDecision: boolean }
  | {
      procede: true;
      negociacion: Negociacion;
      mensajeId: string;
      texto: string;
      objetivoTotal: number;
      ronda: number;
    };

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export class RolInsuficienteError extends Error {
  constructor(
    readonly rol: RolUsuario,
    readonly minimo: RolUsuario,
  ) {
    super(
      minimo === 'titular'
        ? 'Lanzar una compulsa es del titular del estudio.'
        : 'Tu rol es de solo lectura: la compulsa la manejan los colaboradores y el titular.',
    );
    this.name = 'RolInsuficienteError';
  }
}

export class RubroNoAprobadoError extends Error {
  constructor(
    readonly rubro: RubroId,
    readonly estado: string,
  ) {
    super(
      `El cómputo de ${PLANTILLAS[rubro].nombre.toLowerCase()} todavía no está aprobado (está en ${estado}). ` +
        'Aprobalo antes de pedir precios: lo que se manda es lo que se aprobó.',
    );
    this.name = 'RubroNoAprobadoError';
  }
}

export class SinItemsError extends Error {
  constructor(readonly rubro: RubroId) {
    super(
      `No hay ítems activos de ${PLANTILLAS[rubro].nombre.toLowerCase()} en la planilla: un pedido de cotización vacío no se manda.`,
    );
    this.name = 'SinItemsError';
  }
}

export class CompulsaVigenteError extends Error {
  constructor(
    readonly compulsaId: string,
    readonly version: number,
  ) {
    super(
      `Ya hay una compulsa de este rubro en curso (versión ${version}) con el mismo cómputo. ` +
        'Sumá proveedores a esa, o editá la planilla si querés pedir otra cosa.',
    );
    this.name = 'CompulsaVigenteError';
  }
}

export class SinProveedoresContactablesError extends Error {
  constructor(readonly excluidos: ProveedorExcluido[]) {
    super('Ninguno de los proveedores elegidos se puede contactar: la compulsa no se lanzó.');
    this.name = 'SinProveedoresContactablesError';
  }
}

export class SinMensajePendienteError extends Error {
  constructor(readonly contactoId: string) {
    super('Ese contacto no tiene ningún mensaje pendiente de envío.');
    this.name = 'SinMensajePendienteError';
  }
}

export class CotizacionYaConciliadaError extends Error {
  constructor(readonly cotizacionId: string) {
    super('Esa cotización ya está conciliada: volver a conciliarla duplicaría el índice y las repreguntas.');
    this.name = 'CotizacionYaConciliadaError';
  }
}

export class NegociacionImposibleError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'NegociacionImposibleError';
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const JERARQUIA: Record<RolUsuario, number> = { lectura: 0, colaborador: 1, titular: 2 };

/**
 * El rol del actor alcanza, o no se hace nada.
 *
 * **TODO(P7): unificar.** Igual que la copia de `src/lib/proveedores/gestion.ts`,
 * esta función se borra cuando aterrice `src/lib/plataforma/roles.ts` con la
 * tabla completa de permisos. Misma jerarquía (`lectura < colaborador <
 * titular`), misma semántica (falla cerrado, lanza, no devuelve booleano). Los
 * bloques de roles de `tests/integration/flujo-compulsa.test.ts` son los que
 * tienen que seguir pasando sin tocarse.
 *
 * El reparto que aplica este módulo (RF-1201): **lanzar la compulsa es del
 * titular**; registrar envíos, respuestas, cotizaciones y negociaciones es de
 * `colaborador` para arriba.
 */
export function requireRolCore(actor: ActorCompulsa, minimo: RolUsuario): void {
  if (JERARQUIA[actor.rol] < JERARQUIA[minimo]) throw new RolInsuficienteError(actor.rol, minimo);
}

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

const SIN_NOTIFICAR = async (): Promise<void> => {};

function auditar(
  actor: ActorCompulsa,
  obraId: string | undefined,
  accion: string,
  targetRef: string,
  diff: Record<string, unknown>,
): Promise<void> {
  return registrarAuditoria({
    obraId,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion,
    targetRef,
    diff,
  });
}

/**
 * Mes calendario `YYYY-MM` **en hora argentina**, que es donde se cotiza. Con
 * UTC, un presupuesto cargado un 31 a la noche caería en el mes siguiente.
 */
const FORMATO_MES = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
});

export function mesDe(fecha: Date): string {
  return FORMATO_MES.format(fecha);
}

/** La fila de `computo_items` como el `ItemComputo` que espera el dominio. */
function comoItemComputo(fila: ComputoItem): ItemComputo {
  return {
    rubro: fila.rubro,
    descripcion: fila.descripcion,
    unidad: fila.unidad,
    cantNeta: fila.cantNeta,
    desperdicioPct: fila.desperdicioPct,
    cantCompra: fila.cantCompra,
    presentacion: fila.presentacion,
    origen: fila.origen,
    fuentes: fila.fuentesJson,
    confianza: fila.confianza,
    ...(fila.entidadId !== null ? { entidadRef: fila.entidadId } : {}),
    claveItem: fila.claveItem,
  };
}

/**
 * Qué entidades alimenta cada rubro. Es **dato** —igual que
 * `SPECS_CRITICAS_POR_RUBRO`— y solo se usa para los ítems **agregados**, que no
 * tienen una entidad de origen única (las placas de todos los tabiques juntas).
 */
const TIPOS_ENTIDAD_POR_RUBRO: Record<RubroId, readonly TipoEntidad[]> = {
  aberturas: ['abertura'],
  seco: ['tabique'],
  gruesa: ['muro'],
  pintura: ['ambiente', 'terminacion'],
};

/**
 * Las specs críticas del rubro **si todas las entidades coinciden**.
 *
 * Si los tabiques de la obra son todos durlock, el pedido dice durlock; si hay
 * durlock y mampostería, el pedido no dice nada. Un valor mayoritario sería una
 * spec inventada, y una spec inventada genera sustituciones falsas que frenan
 * la negociación (RF-1002).
 */
function specsUnanimes(
  atributos: readonly AtributosEntidad[],
  claves: readonly string[],
): AtributosEntidad {
  const specs: AtributosEntidad = {};
  for (const clave of claves) {
    const valores = new Set<string>();
    for (const atributo of atributos) {
      const valor = atributo[clave];
      if (typeof valor === 'string' && valor.trim() !== '') valores.add(valor.trim());
    }
    if (valores.size === 1) specs[clave] = [...valores][0];
  }
  return specs;
}

/**
 * El mapa que `crearSnapshot` necesita: `entidadRef → atributos` para los ítems
 * que salen de una entidad y `claveItem → specs` para los agregados (P2a).
 */
async function atributosDeLosItems(
  db: Db,
  obraId: string,
  rubro: RubroId,
  items: readonly ItemComputo[],
): Promise<Map<string, AtributosEntidad>> {
  const mapa = new Map<string, AtributosEntidad>();

  const ids = [...new Set(items.map((item) => item.entidadRef).filter((ref): ref is string => !!ref))];
  if (ids.length > 0) {
    const filas = await db
      .select()
      .from(entidades)
      .where(and(eq(entidades.obraId, obraId), inArray(entidades.id, ids)));
    for (const fila of filas) mapa.set(fila.id, fila.atributosJson);
  }

  const agregados = items.filter((item) => item.entidadRef === undefined);
  if (agregados.length === 0) return mapa;

  const tipos = [...TIPOS_ENTIDAD_POR_RUBRO[rubro]];
  const delRubro = await db
    .select({ atributos: entidades.atributosJson })
    .from(entidades)
    .where(and(eq(entidades.obraId, obraId), inArray(entidades.tipo, tipos)));

  const specs = specsUnanimes(
    delRubro.map((fila) => fila.atributos),
    SPECS_CRITICAS_POR_RUBRO[rubro],
  );
  if (Object.keys(specs).length === 0) return mapa;
  for (const item of agregados) mapa.set(item.claveItem, specs);
  return mapa;
}

/** `seco.placas` → `seco-placas`: nombre de archivo sin sorpresas. */
function comoNombreDeArchivo(claveItem: string): string {
  return claveItem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function prefijoRecortes(estudioId: string, obraId: string, compulsaId: string): string {
  return `estudios/${estudioId}/obras/${obraId}/compulsas/${compulsaId}/recortes`;
}

/**
 * ¿Se le puede escribir a este proveedor por este canal, hoy?
 *
 * El `opt_out` es una pared para cualquier canal. El opt-in de WhatsApp solo se
 * exige cuando el canal **es** WhatsApp: por el canal manual el mensaje lo manda
 * una persona por donde ya tiene trato con el proveedor, y ahí el consentimiento
 * lo da esa relación, no un flag (§13).
 */
function motivoDeExclusion(proveedor: Proveedor, canal: Canal): string | null {
  if (proveedor.optOut) return 'Pidió no ser contactado.';
  if (canal === 'whatsapp' && !puedeContactarsePorWhatsapp(proveedor)) {
    return 'No registró el opt-in de WhatsApp.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lanzar la compulsa (RF-701, RF-702, RF-703)
// ---------------------------------------------------------------------------

/**
 * Congela el cómputo aprobado del rubro, arma el pedido y deja un borrador por
 * proveedor listo para mandar.
 *
 * Pasos, en orden y por un motivo: **todo lo que puede fallar va antes de la
 * primera escritura**. Cerrar la compulsa anterior y descubrir después que un
 * proveedor de la selección no existe dejaría al estudio sin compulsa vigente
 * por un id mal tipeado.
 *
 * 1. rol titular y obra del estudio;
 * 2. rubro `aprobado` y sus ítems activos;
 * 3. snapshot + hash;
 * 4. proveedores: existen, son de este estudio y se pueden contactar;
 * 5. recién ahí, la versión (RF-701): si el hash cambió, N+1 y la anterior se
 *    cierra;
 * 6. la compulsa se escribe **antes** que los recortes porque los recortes
 *    cuelgan de su id; una lámina que no se puede leer del storage se saltea y
 *    queda contada en la auditoría, no frena el pedido;
 * 7. un mensaje saliente por contacto, en estado borrador
 *    (`pendiente_envio_manual`), con el texto y las refs de los recortes.
 */
export async function lanzarCompulsa(
  db: Db,
  storage: StorageAdapter,
  actor: ActorCompulsa,
  obraId: string,
  rubro: RubroId,
  opciones: OpcionesLanzamiento,
  deps: DepsFlujo = {},
): Promise<ResultadoLanzamiento> {
  requireRolCore(actor, 'titular');

  const obra = await requireObraCore(db, actor.estudioId, obraId);
  const [estudio] = await db.select().from(estudios).where(eq(estudios.id, actor.estudioId));
  const notificar = deps.notificar ?? SIN_NOTIFICAR;

  // --- 1. El cómputo aprobado ------------------------------------------------
  const [aprobacion] = await db
    .select()
    .from(computoRubros)
    .where(and(eq(computoRubros.obraId, obra.id), eq(computoRubros.rubro, rubro)));
  if (!aprobacion || aprobacion.estado !== 'aprobado') {
    throw new RubroNoAprobadoError(rubro, aprobacion?.estado ?? 'borrador');
  }

  const filas = await db
    .select()
    .from(computoItems)
    .where(
      and(
        eq(computoItems.obraId, obra.id),
        eq(computoItems.rubro, rubro),
        eq(computoItems.estado, 'activo'),
      ),
    )
    .orderBy(asc(computoItems.claveItem));
  if (filas.length === 0) throw new SinItemsError(rubro);

  const items = filas.map(comoItemComputo);
  const config = zConfigEstudio.parse(estudio.configJson);
  const condiciones = opciones.condiciones ?? config.condicionesDefault;
  const mandato = opciones.mandato === undefined ? config.mandatoDefault : opciones.mandato;

  const atributos = await atributosDeLosItems(db, obra.id, rubro, items);
  const snapshot = crearSnapshot(items, condiciones, atributos);

  // --- 2. Proveedores contactables (§13) ------------------------------------
  //
  // Antes de tocar nada: si un proveedor no existe (o es de otro estudio) esto
  // tiene que reventar **antes** de cerrar la compulsa anterior. Un id repetido
  // en la selección es un contacto, no dos (el UNIQUE de la tabla lo prohíbe).
  const excluidos: ProveedorExcluido[] = [];
  const contactables: Proveedor[] = [];
  for (const proveedorId of [...new Set(opciones.proveedorIds)]) {
    const proveedor = await requireProveedorCore(db, actor.estudioId, proveedorId);
    const motivo = motivoDeExclusion(proveedor, 'manual');
    if (motivo === null) contactables.push(proveedor);
    else excluidos.push({ proveedorId: proveedor.id, nombre: proveedor.nombre, motivo });
  }
  if (contactables.length === 0) throw new SinProveedoresContactablesError(excluidos);

  // --- 3. Versión (RF-701) ---------------------------------------------------
  const [anterior] = await db
    .select()
    .from(compulsas)
    .where(and(eq(compulsas.obraId, obra.id), eq(compulsas.rubro, rubro)))
    .orderBy(desc(compulsas.version))
    .limit(1);

  let version = 1;
  let recompulsa = false;
  const versionAnterior = anterior?.version ?? null;

  if (anterior) {
    const vigente = anterior.estado === 'lanzada' || anterior.estado === 'borrador';
    if (vigente && anterior.snapshotHash === snapshot.hash) {
      throw new CompulsaVigenteError(anterior.id, anterior.version);
    }
    version = anterior.version + 1;
    recompulsa = anterior.snapshotHash !== snapshot.hash;

    if (vigente) {
      await db.update(compulsas).set({ estado: 'cerrada' }).where(eq(compulsas.id, anterior.id));
      await auditar(actor, obra.id, 'compulsa_cerrada', `compulsas:${anterior.id}`, {
        rubro,
        version: anterior.version,
        motivo: recompulsa
          ? 'El cómputo cambió: se recompulsa con una versión nueva.'
          : 'Se lanzó una compulsa nueva del mismo rubro.',
        estado: { antes: anterior.estado, despues: 'cerrada' },
      });
    }
  }

  // --- 4. La compulsa --------------------------------------------------------
  const [compulsa] = await db
    .insert(compulsas)
    .values({
      obraId: obra.id,
      rubro,
      estado: 'lanzada',
      snapshotHash: snapshot.hash,
      itemsJson: snapshot.itemsRfq,
      condicionesJson: condiciones,
      mandatoJson: mandato,
      version,
      aprobadoPor: actor.usuarioId,
    })
    .returning();

  // --- 5. Texto y recortes ---------------------------------------------------
  const texto = generarTextoRfq(
    { rubro, zona: obra.zona, itemsRfq: snapshot.itemsRfq, condiciones },
    estudio.nombre,
  );

  const { recortes, laminasIlegibles } = await guardarRecortes(
    db,
    storage,
    actor.estudioId,
    obra.id,
    compulsa.id,
    snapshot.itemsRfq,
    items,
  );

  // --- 6. Un borrador por contacto -------------------------------------------
  const cuerpo = componerCuerpo(
    texto,
    recortes.map((recorte) => recorte.ref),
  );
  const contactos: ContactoCompulsa[] = [];
  const fallosDeEnvio: { contactoId: string; motivo: string }[] = [];

  for (const proveedor of contactables) {
    const [contacto] = await db
      .insert(contactosCompulsa)
      .values({ compulsaId: compulsa.id, proveedorId: proveedor.id, canal: 'manual', estado: 'pendiente' })
      .returning();

    await db.insert(mensajes).values({
      contactoId: contacto.id,
      direccion: 'saliente',
      canal: contacto.canal,
      cuerpo,
      // `null` = borrador: lo escribió el sistema y todavía nadie lo mandó.
      registradoPor: null,
    });

    const canal = deps.canal ?? getCanal(contacto.canal);
    const envio = await canal.enviar({
      contactoId: contacto.id,
      canal: contacto.canal,
      cuerpo: texto,
      adjuntos: recortes.map((recorte) => recorte.ref),
    });
    if (!envio.ok) fallosDeEnvio.push({ contactoId: contacto.id, motivo: envio.motivo });

    contactos.push(contacto);
  }

  await auditar(
    actor,
    obra.id,
    recompulsa ? 'compulsa_recompulsada' : 'compulsa_lanzada',
    `compulsas:${compulsa.id}`,
    {
      rubro,
      version,
      versionAnterior,
      snapshotHash: snapshot.hash,
      items: snapshot.itemsRfq.length,
      condiciones,
      mandato,
      contactos: contactos.map((contacto) => contacto.id),
      proveedores: contactables.map((proveedor) => proveedor.nombre),
      excluidos,
      recortes: recortes.map((recorte) => recorte.ref),
      laminasIlegibles,
      fallosDeEnvio,
    },
  );

  await notificar({
    tipo: 'compulsa_lanzada',
    obraId: obra.id,
    compulsaId: compulsa.id,
    rubro,
    version,
    contactos: contactos.length,
  });

  return { compulsa, contactos, excluidos, texto, recortes, recompulsa, versionAnterior, fallosDeEnvio };
}

/**
 * Recorta cada ítem sobre su lámina de origen y lo guarda bajo la obra.
 *
 * Una lámina que no se puede leer del storage **no frena el pedido**: el texto
 * del RFQ es lo que se cotiza y el recorte es ayuda visual. Las que fallan
 * vuelven contadas para que queden en la auditoría.
 */
async function guardarRecortes(
  db: Db,
  storage: StorageAdapter,
  estudioId: string,
  obraId: string,
  compulsaId: string,
  itemsRfq: readonly ItemRfq[],
  items: readonly ItemComputo[],
): Promise<{ recortes: RecorteGuardado[]; laminasIlegibles: number }> {
  const fuentesPorItem = new Map(items.map((item) => [item.claveItem, item.fuentes]));
  const laminaIds = [
    ...new Set(items.flatMap((item) => item.fuentes.map((fuente) => fuente.laminaId))),
  ];
  if (laminaIds.length === 0) return { recortes: [], laminasIlegibles: 0 };

  const filas = await db
    .select({ id: laminas.id, archivoRef: laminas.archivoRef })
    .from(laminas)
    .where(and(eq(laminas.obraId, obraId), inArray(laminas.id, laminaIds)));

  const disponibles: LaminaRecorte[] = [];
  let laminasIlegibles = 0;
  for (const fila of filas) {
    try {
      disponibles.push({ laminaId: fila.id, pdfBytes: await storage.leer(fila.archivoRef) });
    } catch {
      laminasIlegibles += 1;
    }
  }

  const generados = await generarRecortes(itemsRfq, disponibles, fuentesPorItem);

  const prefijo = prefijoRecortes(estudioId, obraId, compulsaId);
  const recortes: RecorteGuardado[] = [];
  for (const [indice, recorte] of generados.entries()) {
    const nombre = `${String(indice + 1).padStart(2, '0')}-${comoNombreDeArchivo(recorte.claveItem)}.pdf`;
    const ref = await storage.guardar(`${prefijo}/${nombre}`, recorte.pdfBytes, MIME_PDF);
    recortes.push({ claveItem: recorte.claveItem, laminaId: recorte.laminaId, ref });
  }
  return { recortes, laminasIlegibles };
}

// ---------------------------------------------------------------------------
// El hilo con el proveedor
// ---------------------------------------------------------------------------

/**
 * El usuario mandó el borrador: se firma el mensaje con quién lo mandó y el
 * contacto pasa a `contactado`.
 *
 * El estado del contacto **no retrocede**: registrar el envío de una repregunta
 * a alguien que ya cotizó no lo devuelve a `contactado`.
 */
export async function registrarEnvio(
  db: Db,
  actor: ActorCompulsa,
  contactoId: string,
  // El bag va por uniformidad de firma con el resto del flujo: registrar un
  // envío no depende de nada externo (ni provider, ni canal, ni reloj).
  _deps: DepsFlujo = {},
): Promise<{ mensajeId: string; contacto: ContactoCompulsa }> {
  requireRolCore(actor, 'colaborador');
  const contexto = await requireContactoCore(db, actor.estudioId, contactoId);

  const [pendiente] = await db
    .select()
    .from(mensajes)
    .where(
      and(
        eq(mensajes.contactoId, contactoId),
        eq(mensajes.direccion, 'saliente'),
        isNull(mensajes.registradoPor),
      ),
    )
    .orderBy(asc(mensajes.at), asc(mensajes.id))
    .limit(1);
  if (!pendiente) throw new SinMensajePendienteError(contactoId);

  await db
    .update(mensajes)
    .set({ registradoPor: actor.usuarioId })
    .where(eq(mensajes.id, pendiente.id));

  let contacto = contexto.contacto;
  if (contacto.estado === 'pendiente') {
    [contacto] = await db
      .update(contactosCompulsa)
      .set({ estado: 'contactado' })
      .where(eq(contactosCompulsa.id, contactoId))
      .returning();
  }

  await auditar(actor, contexto.obra.id, 'mensaje_enviado', `mensajes:${pendiente.id}`, {
    contactoId,
    proveedor: contexto.proveedor.nombre,
    canal: contacto.canal,
    estadoContacto: { antes: contexto.contacto.estado, despues: contacto.estado },
  });

  return { mensajeId: pendiente.id, contacto };
}

/**
 * El proveedor contestó y alguien lo transcribe (canal manual).
 *
 * El contacto **no cambia de estado**: que haya escrito no significa que haya
 * cotizado. La cotización la registra el paso siguiente, con el presupuesto en
 * la mano.
 */
export async function registrarMensajeEntrante(
  db: Db,
  actor: ActorCompulsa,
  contactoId: string,
  cuerpo: string,
  /** Ver `registrarEnvio`: va por uniformidad de firma. */
  _deps: DepsFlujo = {},
): Promise<{ mensajeId: string; contacto: ContactoCompulsa }> {
  requireRolCore(actor, 'colaborador');
  const contexto = await requireContactoCore(db, actor.estudioId, contactoId);

  const texto = cuerpo.trim();
  if (texto === '') {
    throw new RangeError('Un mensaje entrante vacío no se registra: escribí lo que contestó el proveedor.');
  }

  const [mensaje] = await db
    .insert(mensajes)
    .values({
      contactoId,
      direccion: 'entrante',
      canal: contexto.contacto.canal,
      cuerpo: texto,
      registradoPor: actor.usuarioId,
    })
    .returning();

  await auditar(actor, contexto.obra.id, 'mensaje_entrante_registrado', `mensajes:${mensaje.id}`, {
    contactoId,
    proveedor: contexto.proveedor.nombre,
    canal: contexto.contacto.canal,
    caracteres: texto.length,
  });

  return { mensajeId: mensaje.id, contacto: contexto.contacto };
}

// ---------------------------------------------------------------------------
// Cotización y conciliación (RF-902 / RF-903 / RF-1103)
// ---------------------------------------------------------------------------

/** Lo que el usuario corrigió a mano, sin las claves ausentes. */
function metadatosPisados(
  leidos: MetadatosPresupuesto,
  correcciones: Partial<MetadatosPresupuesto> | undefined,
): MetadatosPresupuesto {
  if (!correcciones) return leidos;
  const pisados = { ...leidos };
  for (const [clave, valor] of Object.entries(correcciones)) {
    if (valor !== undefined) (pisados as Record<string, unknown>)[clave] = valor;
  }
  return pisados;
}

/**
 * Registra el presupuesto que mandó el proveedor y lo concilia contra el
 * pedido, en un solo paso: una cotización sin conciliar no sirve para nada y
 * dejarla a medias es dejar la comparativa mintiendo.
 *
 * `entrada.lineas` gana sobre `entrada.texto`: si la UI ya mostró el preview y
 * el usuario lo confirmó (o lo corrigió), eso es lo que se guarda — volver a
 * parsear pisaría la corrección.
 */
export async function registrarCotizacion(
  db: Db,
  actor: ActorCompulsa,
  contactoId: string,
  entrada: EntradaCotizacion,
  deps: DepsFlujo = {},
): Promise<ResultadoCotizacion> {
  requireRolCore(actor, 'colaborador');
  const contexto = await requireContactoCore(db, actor.estudioId, contactoId);

  let lineas: LineaPresupuesto[];
  let metadatos: MetadatosPresupuesto;
  let via: 'lineas' | 'provider';

  if (entrada.lineas !== undefined) {
    lineas = [...entrada.lineas];
    metadatos = { ...METADATOS_VACIOS };
    via = 'lineas';
  } else if (entrada.texto !== undefined || entrada.pdfBytes !== undefined) {
    const provider = deps.presupuesto ?? getPresupuestoProvider();
    const parseado = await provider.parsear({
      nombre: entrada.nombre,
      texto: entrada.texto,
      pdfBytes: entrada.pdfBytes,
    });
    lineas = parseado.lineas;
    metadatos = parseado.metadatos;
    via = 'provider';
  } else {
    throw new RangeError(
      `No hay nada que registrar del presupuesto "${entrada.nombre}": mandá el texto, el PDF o las líneas ya leídas.`,
    );
  }

  metadatos = metadatosPisados(metadatos, entrada.metadatos);

  const [cotizacion] = await db
    .insert(cotizaciones)
    .values({
      contactoId,
      moneda: contexto.obra.moneda,
      // La columna es NOT NULL y el proveedor puede no haberlo dicho. `false` es
      // lo que pide el RFQ (IVA discriminado, §13) y lo conservador para
      // comparar; que no lo haya declarado queda en la auditoría (`ivaDeclarado`).
      incluyeIva: metadatos.incluyeIva ?? false,
      validezDias: metadatos.validezDias,
      plazoDias: metadatos.plazoDias,
      formaPago: metadatos.formaPago,
      total: metadatos.total,
      lineasJson: lineas,
      rawTexto: entrada.texto ?? null,
      estado: 'recibida',
    })
    .returning();

  await auditar(actor, contexto.obra.id, 'cotizacion_registrada', `cotizaciones:${cotizacion.id}`, {
    contactoId,
    proveedor: contexto.proveedor.nombre,
    nombreArchivo: entrada.nombre,
    via,
    lineas: lineas.length,
    total: metadatos.total,
    ivaDeclarado: metadatos.incluyeIva,
    validezDias: metadatos.validezDias,
    plazoDias: metadatos.plazoDias,
  });

  return conciliarCotizacion(db, actor, cotizacion.id, deps);
}

/**
 * Concilia una cotización contra el snapshot de su compulsa y deja todo escrito:
 * la clasificación ítem por ítem, el score, las repreguntas como borradores
 * salientes y las muestras del índice de precios.
 *
 * Corre **una sola vez** por cotización: repetirla duplicaría las repreguntas y
 * contaría dos veces el mismo precio en el índice.
 */
export async function conciliarCotizacion(
  db: Db,
  actor: ActorCompulsa,
  cotizacionId: string,
  deps: DepsFlujo = {},
): Promise<ResultadoCotizacion> {
  requireRolCore(actor, 'colaborador');
  const { cotizacion, contexto } = await requireCotizacionCore(db, actor.estudioId, cotizacionId);
  if (cotizacion.estado === 'conciliada') throw new CotizacionYaConciliadaError(cotizacionId);

  const notificar = deps.notificar ?? SIN_NOTIFICAR;
  const ahora = deps.ahora?.() ?? new Date();

  const resultado = conciliar(contexto.compulsa.itemsJson, cotizacion.lineasJson);

  // --- 1. La conciliación, ítem por ítem ------------------------------------
  await db.insert(conciliacionItems).values(
    resultado.items.map((item) => ({
      cotizacionId: cotizacion.id,
      claveItem: item.claveItem,
      lineaIdx: item.lineaIndice === null ? null : item.lineaIndice - 1,
      match: item.match,
      desvioJson: item.desvio === null ? null : { ...item.desvio },
      nota: item.motivo,
    })),
  );

  const [conciliada] = await db
    .update(cotizaciones)
    .set({ scoreFidelidad: resultado.score, estado: 'conciliada' })
    .where(eq(cotizaciones.id, cotizacion.id))
    .returning();

  // --- 2. Repreguntas como borrador saliente --------------------------------
  //
  // Van en un solo `insert` y por lo tanto comparten el `at` (es `now()`, el
  // reloj de la transacción). **El orden entre ellas no está garantizado**:
  // `mensajes` no tiene columna de orden y el desempate termina siendo por
  // uuid. No es un problema para mandarlas —cada una se explica sola y cita su
  // ítem—, pero si la pantalla necesita mostrarlas en el orden del pedido, el
  // orden está en `conciliacion_items` (por `clave_item`), no acá.
  if (resultado.repreguntas.length > 0) {
    await db.insert(mensajes).values(
      resultado.repreguntas.map((repregunta) => ({
        contactoId: contexto.contacto.id,
        direccion: 'saliente' as const,
        canal: contexto.contacto.canal,
        cuerpo: repregunta.texto,
        registradoPor: null,
      })),
    );
  }

  // --- 3. Índice de precios (RF-1103) ---------------------------------------
  const mes = mesDe(ahora);
  let muestrasIndice = 0;
  for (const item of resultado.items) {
    if (item.match !== 'exacto' && item.match !== 'parcial') continue;
    if (item.claveItem === null || item.linea === null) continue;

    const precio = precioUnitarioDe(item.linea);
    // P2b: `acumularMuestra` lanza con ≤ 0 o no finito. Una línea sin precio
    // utilizable no es un error de la compulsa: es una repregunta.
    if (precio === null || !Number.isFinite(precio) || precio <= 0) continue;

    const [existente] = await db
      .select()
      .from(priceIndex)
      .where(
        and(
          eq(priceIndex.estudioId, actor.estudioId),
          eq(priceIndex.claveItem, item.claveItem),
          eq(priceIndex.zona, contexto.obra.zona),
          eq(priceIndex.mes, mes),
        ),
      );

    const acumulada = acumularMuestra(existente?.muestrasJson ?? [], precio);
    await db
      .insert(priceIndex)
      .values({
        estudioId: actor.estudioId,
        claveItem: item.claveItem,
        zona: contexto.obra.zona,
        mes,
        p25: acumulada.p25,
        p50: acumulada.p50,
        p75: acumulada.p75,
        n: acumulada.n,
        muestrasJson: acumulada.muestras,
      })
      .onConflictDoUpdate({
        target: [priceIndex.estudioId, priceIndex.claveItem, priceIndex.zona, priceIndex.mes],
        set: {
          p25: acumulada.p25,
          p50: acumulada.p50,
          p75: acumulada.p75,
          n: acumulada.n,
          muestrasJson: acumulada.muestras,
        },
      });
    muestrasIndice += 1;
  }

  // --- 4. El contacto cotizó (con bandera si hubo sustitución) --------------
  const [contacto] = await db
    .update(contactosCompulsa)
    .set({ estado: 'cotizo' })
    .where(eq(contactosCompulsa.id, contexto.contacto.id))
    .returning();

  await auditar(actor, contexto.obra.id, 'cotizacion_conciliada', `cotizaciones:${cotizacion.id}`, {
    contactoId: contacto.id,
    proveedor: contexto.proveedor.nombre,
    score: resultado.score,
    matches: resultado.items.reduce<Record<string, number>>((acc, item) => {
      acc[item.match] = (acc[item.match] ?? 0) + 1;
      return acc;
    }, {}),
    sustituciones: resultado.sustituciones.map((item) => item.claveItem),
    repreguntas: resultado.repreguntas.map((repregunta) => repregunta.clave),
    alertas: resultado.alertas.map((alerta) => alerta.clave),
    muestrasIndice,
    mes,
  });

  await notificar({
    tipo: 'cotizacion_conciliada',
    obraId: contexto.obra.id,
    compulsaId: contexto.compulsa.id,
    contactoId: contacto.id,
    cotizacionId: cotizacion.id,
    score: resultado.score,
    sustituciones: resultado.sustituciones.length,
  });

  return {
    cotizacion: conciliada,
    conciliacion: resultado,
    repreguntasCreadas: resultado.repreguntas.length,
    muestrasIndice,
    requiereDecision: resultado.sustituciones.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Negociación (RF-1001 / RF-1002 / RF-1003)
// ---------------------------------------------------------------------------

/** El símbolo de cada moneda que el sistema sabe nombrar. */
const MONEDAS: Record<string, { simbolo: string; nombre: string }> = {
  ARS: { simbolo: '$', nombre: 'pesos argentinos' },
  USD: { simbolo: 'US$', nombre: 'dólares' },
};

/**
 * El texto del motor no lleva símbolo de moneda (decisión de P2b: la entrada
 * pinneada no tiene `moneda`). Se lo agregamos acá, al renderizar, con una
 * línea al pie: meterlo pegado a cada importe obligaría a duplicar el formateo
 * de montos del motor y a mantener dos formatos sincronizados.
 */
function conMoneda(texto: string, moneda: string): string {
  const codigo = moneda.trim().toUpperCase();
  const conocida = MONEDAS[codigo];
  const cola = conocida
    ? `Los importes de este mensaje están en ${conocida.nombre} (${conocida.simbolo}).`
    : `Los importes de este mensaje están en ${codigo}.`;
  return `${texto}\n\n${cola}`;
}

/**
 * Propone la contraoferta de la ronda que corresponda, o dice por qué no.
 *
 * El comparable es el **total más bajo de la misma compulsa** entre las
 * cotizaciones ya conciliadas: comparar contra otra obra u otro rubro sería
 * comparar cualquier cosa. Ese número **no viaja al proveedor** (el motor solo
 * le muestra su total y el objetivo).
 *
 * Si la cotización tiene una sustitución de especificación, el motor devuelve
 * `escala_spec` y acá **no se escribe ningún mensaje**: queda auditado como
 * escalado y el resultado dice `requiereDecision`.
 */
export async function proponerNegociacion(
  db: Db,
  actor: ActorCompulsa,
  cotizacionId: string,
  deps: DepsFlujo = {},
): Promise<ResultadoNegociacion> {
  requireRolCore(actor, 'colaborador');
  const { cotizacion, contexto } = await requireCotizacionCore(db, actor.estudioId, cotizacionId);
  const notificar = deps.notificar ?? SIN_NOTIFICAR;

  if (cotizacion.estado !== 'conciliada') {
    throw new NegociacionImposibleError(
      'Esa cotización todavía no está conciliada: sin saber qué cotizó no se puede negociar el precio.',
    );
  }
  if (cotizacion.total === null || cotizacion.total <= 0) {
    throw new NegociacionImposibleError(
      'Esa cotización no tiene total: cargalo (o pedíselo al proveedor) antes de negociar.',
    );
  }
  const mandato = contexto.compulsa.mandatoJson;
  if (!mandato) {
    throw new NegociacionImposibleError(
      'Esta compulsa se lanzó sin mandato de negociación: el motor no propone contraofertas sin uno.',
    );
  }

  // --- 1. El mejor comparable de la misma compulsa --------------------------
  const comparables = await db
    .select({ total: cotizaciones.total })
    .from(cotizaciones)
    .innerJoin(contactosCompulsa, eq(contactosCompulsa.id, cotizaciones.contactoId))
    .where(
      and(
        eq(contactosCompulsa.compulsaId, contexto.compulsa.id),
        eq(cotizaciones.estado, 'conciliada'),
      ),
    );

  const totales = comparables
    .map((fila) => fila.total)
    .filter((total): total is number => total !== null && Number.isFinite(total) && total > 0);
  if (totales.length === 0) {
    throw new NegociacionImposibleError(
      'No hay ninguna cotización con total en esta compulsa: no hay contra qué comparar.',
    );
  }
  const mejorTotalComparable = Math.min(...totales);

  // --- 2. Sustituciones y ronda ---------------------------------------------
  const [sustituciones] = await db
    .select({ cuantas: count() })
    .from(conciliacionItems)
    .where(
      and(eq(conciliacionItems.cotizacionId, cotizacion.id), eq(conciliacionItems.match, 'sustituto')),
    );

  const [rondasPrevias] = await db
    .select({ cuantas: count() })
    .from(negociaciones)
    .where(eq(negociaciones.cotizacionId, cotizacion.id));
  const ronda = Number(rondasPrevias?.cuantas ?? 0) + 1;

  const decision = proponerContraoferta({
    totalCotizado: cotizacion.total,
    mejorTotalComparable,
    tieneSustituciones: Number(sustituciones?.cuantas ?? 0) > 0,
    ronda,
    mandato,
    proveedorNombre: contexto.proveedor.nombre,
    rubroNombre: PLANTILLAS[contexto.compulsa.rubro].nombre,
  });

  if (!decision.procede) {
    await auditar(actor, contexto.obra.id, 'negociacion_escalada', `cotizaciones:${cotizacion.id}`, {
      contactoId: contexto.contacto.id,
      proveedor: contexto.proveedor.nombre,
      motivo: decision.motivo,
      ronda,
      totalCotizado: cotizacion.total,
    });
    await notificar({
      tipo: 'negociacion_escalada',
      obraId: contexto.obra.id,
      compulsaId: contexto.compulsa.id,
      contactoId: contexto.contacto.id,
      cotizacionId: cotizacion.id,
      motivo: decision.motivo,
    });
    return {
      procede: false,
      motivo: decision.motivo,
      requiereDecision: decision.motivo === 'escala_spec',
    };
  }

  // --- 3. La ronda queda escrita, gane o pierda (RF-1003) -------------------
  const texto = conMoneda(decision.texto, cotizacion.moneda);

  const [negociacion] = await db
    .insert(negociaciones)
    .values({
      cotizacionId: cotizacion.id,
      ronda,
      ofertaJson: {
        objetivoTotal: decision.objetivoTotal,
        totalCotizado: cotizacion.total,
        moneda: cotizacion.moneda,
        palancas: mandato.palancas,
        objetivoMejoraPct: mandato.objetivoMejoraPct,
      },
      resultado: 'pendiente',
      logJson: {
        propuestaPor: actor.email,
        at: (deps.ahora?.() ?? new Date()).toISOString(),
        // El comparable se guarda para poder auditar la decisión; NO viaja al texto.
        mejorTotalComparable,
      },
    })
    .returning();

  const [mensaje] = await db
    .insert(mensajes)
    .values({
      contactoId: contexto.contacto.id,
      direccion: 'saliente',
      canal: contexto.contacto.canal,
      cuerpo: componerCuerpo(texto),
      registradoPor: null,
    })
    .returning();

  await db
    .update(contactosCompulsa)
    .set({ estado: 'negociando' })
    .where(eq(contactosCompulsa.id, contexto.contacto.id));

  await auditar(actor, contexto.obra.id, 'negociacion_propuesta', `negociaciones:${negociacion.id}`, {
    contactoId: contexto.contacto.id,
    cotizacionId: cotizacion.id,
    proveedor: contexto.proveedor.nombre,
    ronda,
    totalCotizado: cotizacion.total,
    objetivoTotal: decision.objetivoTotal,
    mejorTotalComparable,
    palancas: mandato.palancas,
    mensajeId: mensaje.id,
  });

  await notificar({
    tipo: 'negociacion_propuesta',
    obraId: contexto.obra.id,
    compulsaId: contexto.compulsa.id,
    contactoId: contexto.contacto.id,
    cotizacionId: cotizacion.id,
    ronda,
  });

  return {
    procede: true,
    negociacion,
    mensajeId: mensaje.id,
    texto,
    objetivoTotal: decision.objetivoTotal,
    ronda,
  };
}
