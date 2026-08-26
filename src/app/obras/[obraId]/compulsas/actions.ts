'use server';

/**
 * Endpoints y consultas de las pantallas de compulsa (PRD §8.6).
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** con el
 * payload que el cliente quiera. Por eso acá no hay lógica de dominio: el flujo
 * vive en `@/lib/compulsa/flujo` (P5) y lo que se agrega son las cuatro líneas
 * que faltan —sesión, obra del estudio, actor con el rol de la sesión (nunca del
 * payload) y revalidación— más los **núcleos de pantalla**, que reciben la base
 * y el actor por parámetro y por eso fallan cerrados si alguien los invoca desde
 * afuera (no hay forma de serializar un cliente de Drizzle en un body).
 *
 * ## Los núcleos que viven acá, y por qué no están en `flujo.ts`
 *
 * Son preguntas de pantalla, no pasos del flujo: qué proveedores ofrecer, si el
 * cómputo cambió desde la última compulsa, cómo se vería el presupuesto **antes**
 * de guardarlo, quién está en silencio. Ninguno escribe salvo dos, que lo dicen
 * en el nombre (`cargarTotalCotizacionCore`, `notificar*`).
 *
 * ## Dos cosas que este archivo produce y P7 dejó declaradas
 *
 *  - **«Cotización conciliada»**: se engancha al hook `deps.notificar` del flujo.
 *  - **«Compulsa sin respuesta hace 7+ días»**: es una **consulta** que corre al
 *    abrir la pantalla (no hay cron en el producto), y la notificación se escribe
 *    la primera vez que se detecta. El dedup no tiene columna donde apoyarse:
 *    se busca si ya existe una notificación **con el mismo `link`** en el
 *    estudio. Está explicado en `notificarSinRespuestaCore`.
 */
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '@/db/client';
import {
  compulsas,
  computoItems,
  computoRubros,
  contactosCompulsa,
  cotizaciones,
  mensajes,
  notificaciones,
  proveedores,
  usuarios,
  type Cotizacion,
  type Proveedor,
} from '@/db/schema';
import {
  getPresupuestoProvider,
  METADATOS_VACIOS,
  sanearPresupuesto,
  type MetadatosPresupuesto,
} from '@/lib/analysis/presupuesto-tipos';
import { registrarAuditoria } from '@/lib/audit';
import { esUuid, ObraNoEncontradaError, requireObra, requireObraCore, requireUser } from '@/lib/auth/guards';
import { conciliar, precioUnitarioDe } from '@/lib/compulsa/conciliacion';
import {
  CompulsaVigenteError,
  CotizacionYaConciliadaError,
  lanzarCompulsa,
  NegociacionImposibleError,
  proponerNegociacion,
  registrarCotizacion,
  registrarEnvio,
  requireRolCore,
  RolInsuficienteError,
  RubroNoAprobadoError,
  SinItemsError,
  SinMensajePendienteError,
  SinProveedoresContactablesError,
  type ActorCompulsa,
  type EventoCompulsa,
} from '@/lib/compulsa/flujo';
import { CanalNoConfiguradoError } from '@/lib/outreach/canal';
import {
  ContactoNoEncontradoError,
  CotizacionNoEncontradaError,
  requireContactoCore,
  requireCotizacionCore,
} from '@/lib/outreach/threads';
import { igualJson } from '@/lib/pipeline/json';
import { leerConfig } from '@/lib/plataforma/config-estudio';
import { crearNotificacion } from '@/lib/plataforma/notificaciones';
import { listarProveedores } from '@/lib/proveedores/gestion';
import { armarShortlist, type ProveedorRankeado } from '@/lib/proveedores/shortlist';
import { PLANTILLAS } from '@/lib/rubros/index';
import { getStorage } from '@/lib/storage/index';
import {
  RUBROS,
  zCondicionesRfq,
  zLineaPresupuesto,
  zMandato,
  type CondicionesRfq,
  type EstadoContacto,
  type ItemRfq,
  type LineaPresupuesto,
  type Mandato,
  type MatchConciliacion,
  type RubroId,
  type Unidad,
} from '@/types/domain';

// ---------------------------------------------------------------------------
// Tipos (todo serializable: cruzan la frontera server → cliente)
// ---------------------------------------------------------------------------

export type ResultadoAccionCompulsa = { ok: true } | { ok: false; error: string };

export interface SeleccionProveedores {
  rankeados: ProveedorRankeado<Proveedor>[];
  /** Los que no se pueden contactar hoy, con el motivo a la vista (§13). */
  excluidos: { proveedorId: string; nombre: string; motivo: string }[];
}

export interface ItemPrevisto {
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  cantidad: number;
  presentacion: string;
}

export interface AvisoCompulsaVigente {
  /** `vigente` ⇒ hay una en curso con el mismo cómputo; `cambio` ⇒ RF-701. */
  tipo: 'vigente' | 'cambio';
  compulsaId: string;
  version: number;
  versionNueva: number;
}

export interface PreviewRubro {
  aprobado: boolean;
  /** Los ítems activos del rubro, ordenados por clave (como el snapshot). */
  items: ItemPrevisto[];
  condiciones: CondicionesRfq;
  mandato: Mandato | null;
  aviso: AvisoCompulsaVigente | null;
}

export interface EntradaPreviewPresupuesto {
  nombre: string;
  texto?: string;
  lineas?: LineaPresupuesto[];
  metadatos?: Partial<MetadatosPresupuesto>;
}

/** Una fila de la tabla del preview: qué ítem del pedido matcheó con qué línea. */
export interface FilaConciliada {
  claveItem: string | null;
  descripcionRfq: string | null;
  descripcionLinea: string | null;
  match: MatchConciliacion;
  motivo: string;
  cantidadRfq: number | null;
  cantidadCotizada: number | null;
  precioUnitario: number | null;
}

export interface PreviewPresupuesto {
  lineas: LineaPresupuesto[];
  metadatos: MetadatosPresupuesto;
  /** Cuántas líneas ilegibles va a descartar el saneo al guardar (P5). */
  lineasDescartadas: number;
  /** Qué metadatos imposibles va a anular el saneo al guardar (P5). */
  metadatosCorregidos: string[];
  score: number;
  matches: Partial<Record<MatchConciliacion, number>>;
  sustituciones: string[];
  noCotizados: string[];
  alertas: string[];
  repreguntas: string[];
  filas: FilaConciliada[];
}

export interface AvisoSinRespuesta {
  contactoId: string;
  compulsaId: string;
  proveedor: string;
  rubro: RubroId;
  dias: number;
}

export type ResultadoLanzamientoAction =
  | { ok: true; compulsaId: string; contactos: number; excluidos: number; version: number }
  | { ok: false; error: string };

export type ResultadoPreviewAction =
  | { ok: true; preview: PreviewPresupuesto }
  | { ok: false; error: string };

export type ResultadoCotizacionAction =
  | { ok: true; cotizacionId: string; score: number; requiereDecision: boolean; repreguntas: number }
  | { ok: false; error: string };

export type ResultadoNegociacionAction =
  | { ok: true; procede: true; texto: string; ronda: number; objetivoTotal: number }
  | { ok: true; procede: false; motivo: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

/** Días de silencio a partir de los cuales la pantalla avisa (PRD §8.6). */
const DIAS_SIN_RESPUESTA = 7;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Estados que ya no esperan una respuesta. `sin_respuesta` **sí** sigue en la
 * lista de los que esperan: que alguien lo haya marcado no cambia que el
 * silencio siga corriendo, y el aviso no se duplica porque la notificación
 * deduplica por link.
 */
const ESTADOS_QUE_YA_CONTESTARON: readonly EstadoContacto[] = ['cotizo', 'negociando', 'cerrado'];

/**
 * El motivo de exclusión, con el mismo texto que usa `lanzarCompulsa`.
 *
 * Está duplicado a propósito y en una sola línea: la función de `flujo.ts` es
 * privada del core y exportarla sería ampliar la superficie de un módulo que no
 * es de esta tarea. Si algún día son tres motivos, el lugar es `flujo.ts`.
 */
const MOTIVO_OPT_OUT = 'Pidió no ser contactado.';

const MOTIVO_NO_PROCEDE: Record<string, string> = {
  dentro_de_objetivo:
    'El precio ya está dentro del objetivo del mandato: no hay contraoferta que hacer.',
  max_rondas: 'Ya se usaron las dos rondas de negociación que permite el mandato (RF-1001).',
  escala_spec:
    'El proveedor cotizó otra especificación: eso lo decidís vos, el motor no negocia sobre una sustitución.',
};

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');
const zRubro = z.enum(RUBROS);

const PAYLOAD_ILEGIBLE = 'No pude leer los datos de la compulsa.';

/** Sesión + obra del estudio + actor con el rol de la sesión. */
async function contexto(obraId: string): Promise<{ db: Db; obraId: string; actor: ActorCompulsa }> {
  const { usuario, estudio } = await requireUser();
  const obra = await requireObra(obraId);
  return {
    db: await getDb(),
    obraId: obra.id,
    actor: { usuarioId: usuario.id, email: usuario.email, rol: usuario.rol, estudioId: estudio.id },
  };
}

/**
 * Traduce a texto de pantalla los errores de dominio del flujo. Lo que no es de
 * dominio se relanza: un 500 honesto es mejor que un cartel genérico que esconde
 * un bug.
 */
function mensajeDeDominio(error: unknown): string | null {
  if (
    error instanceof RolInsuficienteError ||
    error instanceof RubroNoAprobadoError ||
    error instanceof SinItemsError ||
    error instanceof CompulsaVigenteError ||
    error instanceof SinProveedoresContactablesError ||
    error instanceof SinMensajePendienteError ||
    error instanceof CotizacionYaConciliadaError ||
    error instanceof NegociacionImposibleError ||
    error instanceof CanalNoConfiguradoError ||
    error instanceof ContactoNoEncontradoError ||
    error instanceof CotizacionNoEncontradaError ||
    error instanceof ObraNoEncontradaError ||
    error instanceof RangeError
  ) {
    return error.message;
  }
  return null;
}

async function revalidar(obraId: string, compulsaId?: string): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath(`/obras/${obraId}/compulsas`);
  revalidatePath(`/obras/${obraId}/conversaciones`);
  revalidatePath(`/obras/${obraId}`);
  if (compulsaId) revalidatePath(`/obras/${obraId}/compulsas/${compulsaId}`);
}

function auditar(
  actor: ActorCompulsa,
  obraId: string,
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

// ---------------------------------------------------------------------------
// Wizard: proveedores a ofrecer (RF-802, §13)
// ---------------------------------------------------------------------------

/**
 * La shortlist del rubro más los que no se pueden contactar.
 *
 * `armarShortlist` (P4) **filtra** el opt-out y no lo devuelve, que es lo
 * correcto para el ranking: un filtro no se puede empatar. Pero la pantalla
 * tiene que mostrarlos igual —si el corralón de siempre no aparece, el usuario
 * cree que se perdió la agenda— así que se leen aparte, con el motivo escrito.
 */
export async function armarSeleccionProveedoresCore(
  db: Db,
  estudioId: string,
  rubro: RubroId,
  zona: string,
): Promise<SeleccionProveedores> {
  const agenda = await listarProveedores(db, estudioId, { rubro });

  const historico = await historicoDeCotizaciones(db, estudioId);
  const rankeados = armarShortlist(agenda, rubro, zona, historico);

  const excluidos = agenda
    .filter((proveedor) => proveedor.optOut)
    .map((proveedor) => ({
      proveedorId: proveedor.id,
      nombre: proveedor.nombre,
      motivo: MOTIVO_OPT_OUT,
    }));

  return { rankeados, excluidos };
}

/** `proveedorId` → cuántas cotizaciones le mandó al estudio (una sola consulta). */
async function historicoDeCotizaciones(
  db: Db,
  estudioId: string,
): Promise<Map<string, number>> {
  const filas = await db
    .select({ proveedorId: contactosCompulsa.proveedorId, cuantas: count(cotizaciones.id) })
    .from(cotizaciones)
    .innerJoin(contactosCompulsa, eq(contactosCompulsa.id, cotizaciones.contactoId))
    .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
    .where(eq(proveedores.estudioId, estudioId))
    .groupBy(contactosCompulsa.proveedorId);

  return new Map(filas.map((fila) => [fila.proveedorId, Number(fila.cuantas)]));
}

// ---------------------------------------------------------------------------
// Wizard: qué se va a congelar y el aviso RF-701
// ---------------------------------------------------------------------------

/**
 * Lo que la pantalla de armado necesita saber de un rubro: si está aprobado,
 * qué ítems se van a congelar, con qué condiciones y mandato por default, y si
 * ya hay una compulsa en curso.
 *
 * ## Por qué el aviso compara ítems y no hashes
 *
 * El hash del snapshot (RF-701) incluye las `specsCriticas`, que salen de los
 * atributos de las entidades por una regla que vive **privada** en `flujo.ts`
 * (`atributosDeLosItems`). Recalcularla acá sería una segunda copia de esa regla
 * y, el día que se desincronicen, la pantalla avisaría cualquier cosa. Así que
 * este aviso compara lo que la pantalla **muestra** —clave, descripción, unidad,
 * cantidad y presentación de cada ítem, más las condiciones— y el hash lo decide
 * el server al lanzar, que es donde tiene que decidirse.
 *
 * Consecuencia conocida: si lo único que cambió es una especificación crítica
 * (el tabique pasó de durlock a mampostería sin cambiar cantidades), la pantalla
 * dice «ya hay una en curso» y lanzar igual crea la versión N+1. No se pierde
 * nada —el resultado es el correcto y el error del server sale inline—, pero el
 * aviso previo se queda corto. Cerrarlo del todo pide exportar esa regla desde
 * `flujo.ts`.
 */
export async function previewRubroCore(
  db: Db,
  estudioId: string,
  obraId: string,
  rubro: RubroId,
): Promise<PreviewRubro> {
  const obra = await requireObraCore(db, estudioId, obraId);
  const config = await leerConfig(db, estudioId);

  const [aprobacion] = await db
    .select()
    .from(computoRubros)
    .where(and(eq(computoRubros.obraId, obra.id), eq(computoRubros.rubro, rubro)));

  const aprobado = aprobacion?.estado === 'aprobado';
  if (!aprobado) {
    return {
      aprobado: false,
      items: [],
      condiciones: config.condicionesDefault,
      mandato: config.mandatoDefault,
      aviso: null,
    };
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

  const items: ItemPrevisto[] = filas.map((fila) => ({
    claveItem: fila.claveItem,
    descripcion: fila.descripcion,
    unidad: fila.unidad,
    cantidad: fila.cantCompra,
    presentacion: fila.presentacion,
  }));

  const [ultima] = await db
    .select()
    .from(compulsas)
    .where(and(eq(compulsas.obraId, obra.id), eq(compulsas.rubro, rubro)))
    .orderBy(desc(compulsas.version))
    .limit(1);

  let aviso: AvisoCompulsaVigente | null = null;
  if (ultima && (ultima.estado === 'lanzada' || ultima.estado === 'borrador')) {
    // `igualJson` y no `JSON.stringify` pelado: `condiciones_json` es jsonb y
    // Postgres devuelve las claves en **su** orden, no en el que se guardaron.
    const igual =
      mismosItems(items, ultima.itemsJson) &&
      igualJson(config.condicionesDefault, ultima.condicionesJson);
    aviso = {
      tipo: igual ? 'vigente' : 'cambio',
      compulsaId: ultima.id,
      version: ultima.version,
      versionNueva: ultima.version + 1,
    };
  }

  return { aprobado: true, items, condiciones: config.condicionesDefault, mandato: config.mandatoDefault, aviso };
}

/** Los cinco campos del ítem que el snapshot congela y la pantalla muestra. */
function mismosItems(items: readonly ItemPrevisto[], congelados: readonly ItemRfq[]): boolean {
  const comparable = (fila: ItemPrevisto | ItemRfq) =>
    [fila.claveItem, fila.descripcion, fila.unidad, fila.cantidad, fila.presentacion];

  const orden = (a: { claveItem: string }, b: { claveItem: string }) =>
    a.claveItem.localeCompare(b.claveItem);

  return (
    JSON.stringify([...items].sort(orden).map(comparable)) ===
    JSON.stringify([...congelados].sort(orden).map(comparable))
  );
}

// ---------------------------------------------------------------------------
// Preview del presupuesto (parsear sin persistir)
// ---------------------------------------------------------------------------

/**
 * Lee el presupuesto y lo concilia **sin escribir nada**, para que el usuario
 * confirme lo que va a quedar guardado.
 *
 * `registrarCotizacion` parsea y persiste en un solo paso (es lo correcto: una
 * cotización sin conciliar deja la comparativa mintiendo), así que el preview no
 * puede llamarlo. Lo que hace es correr **los mismos tres pasos** —provider,
 * `sanearPresupuesto` del borde de escritura y `conciliar`— y devolver lo que
 * cada uno decidió, incluido lo que el saneo va a descartar. Después, confirmar
 * manda las líneas por el camino `entrada.lineas`, que el core vuelve a sanear.
 *
 * Si esta función y `registrarCotizacion` se desincronizan, el usuario confirma
 * una cosa y se guarda otra: por eso el orden de los pasos está copiado tal cual
 * y no "mejorado".
 */
export async function previsualizarPresupuestoCore(
  db: Db,
  actor: ActorCompulsa,
  contactoId: string,
  entrada: EntradaPreviewPresupuesto,
): Promise<PreviewPresupuesto> {
  requireRolCore(actor, 'colaborador');
  const hilo = await requireContactoCore(db, actor.estudioId, contactoId);

  let lineas: LineaPresupuesto[];
  let metadatos: MetadatosPresupuesto;

  if (entrada.lineas !== undefined) {
    lineas = [...entrada.lineas];
    metadatos = { ...METADATOS_VACIOS };
  } else if (entrada.texto !== undefined && entrada.texto.trim() !== '') {
    const parseado = await getPresupuestoProvider().parsear({
      nombre: entrada.nombre,
      texto: entrada.texto,
    });
    lineas = parseado.lineas;
    metadatos = parseado.metadatos;
  } else {
    throw new RangeError(
      'Pegá el presupuesto que mandó el proveedor: sin texto no hay nada que leer.',
    );
  }

  // Lo que el usuario corrigió a mano pisa lo leído, clave por clave y salteando
  // las ausentes: mismo criterio que `metadatosPisados` en `registrarCotizacion`.
  if (entrada.metadatos) {
    const pisables = metadatos as unknown as Record<string, unknown>;
    for (const [clave, valor] of Object.entries(entrada.metadatos)) {
      if (valor !== undefined) pisables[clave] = valor;
    }
  }

  const antesDelSaneo = metadatos;
  const saneo = sanearPresupuesto({ lineas, metadatos });
  lineas = saneo.presupuesto.lineas;
  metadatos = saneo.presupuesto.metadatos;

  const metadatosCorregidos = (Object.keys(antesDelSaneo) as (keyof MetadatosPresupuesto)[]).filter(
    (clave) => antesDelSaneo[clave] !== metadatos[clave],
  );

  const resultado = conciliar(hilo.compulsa.itemsJson, lineas);

  const matches: Partial<Record<MatchConciliacion, number>> = {};
  for (const item of resultado.items) matches[item.match] = (matches[item.match] ?? 0) + 1;

  return {
    lineas,
    metadatos,
    lineasDescartadas: saneo.lineasDescartadas,
    metadatosCorregidos,
    score: resultado.score,
    matches,
    sustituciones: resultado.sustituciones.map((item) => item.claveItem ?? ''),
    noCotizados: resultado.items
      .filter((item) => item.match === 'no_cotizado')
      .map((item) => item.claveItem ?? ''),
    alertas: resultado.alertas.map((alerta) => alerta.mensaje),
    repreguntas: resultado.repreguntas.map((repregunta) => repregunta.texto),
    filas: resultado.items.map((item) => ({
      claveItem: item.claveItem,
      descripcionRfq: item.itemRfq?.descripcion ?? null,
      descripcionLinea: item.linea?.descripcion ?? null,
      match: item.match,
      motivo: item.motivo,
      cantidadRfq: item.itemRfq?.cantidad ?? null,
      cantidadCotizada: item.linea?.cantidad ?? null,
      precioUnitario: item.linea ? precioUnitarioDe(item.linea) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Cargar el total a mano (P5, decisión 8)
// ---------------------------------------------------------------------------

/**
 * Escribe el total que el proveedor no declaró.
 *
 * `cotizaciones.total` es **el total declarado, nunca una suma** (P5): si el
 * presupuesto no lo trae, la columna queda `null` y la negociación no puede
 * arrancar. Alguien tiene que leerlo del PDF y cargarlo, y eso es esto — con la
 * misma política de saneo que el resto: un importe imposible no entra, no se
 * clampea.
 *
 * **TODO(P11):** su lugar natural es `@/lib/compulsa/flujo`, al lado de
 * `registrarCotizacion`. Vive acá porque `flujo.ts` no es de esta tarea; cuando
 * se mude, este export se borra y la action llama al core.
 */
export async function cargarTotalCotizacionCore(
  db: Db,
  actor: ActorCompulsa,
  cotizacionId: string,
  total: number,
): Promise<Cotizacion> {
  requireRolCore(actor, 'colaborador');
  const { cotizacion, contexto: hilo } = await requireCotizacionCore(db, actor.estudioId, cotizacionId);

  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError(
      'El total tiene que ser un importe mayor a cero: si el presupuesto no lo dice, pediéselo al proveedor.',
    );
  }
  const redondeado = Math.round(total * 100) / 100;

  const [actualizada] = await db
    .update(cotizaciones)
    .set({ total: redondeado })
    .where(eq(cotizaciones.id, cotizacion.id))
    .returning();

  await auditar(actor, hilo.obra.id, 'cotizacion_total_cargado', `cotizaciones:${cotizacion.id}`, {
    contactoId: hilo.contacto.id,
    proveedor: hilo.proveedor.nombre,
    total: { antes: cotizacion.total, despues: redondeado },
    moneda: cotizacion.moneda,
  });

  return actualizada;
}

// ---------------------------------------------------------------------------
// Sin respuesta hace 7+ días (consulta, no cron)
// ---------------------------------------------------------------------------

/**
 * Los contactos de la obra que llevan `DIAS_SIN_RESPUESTA` o más sin contestar.
 *
 * El reloj arranca en el **último mensaje saliente que alguien mandó de verdad**
 * (`registrado_por` no nulo, invariante de `estadoMensaje` en P5): un borrador
 * que quedó sin mandar no es silencio del proveedor, es trabajo pendiente
 * nuestro. Y si hay cualquier entrante posterior a ese envío, no hay silencio
 * que avisar aunque todavía no haya cotizado.
 *
 * Una sola consulta de mensajes para todos los contactos de la obra: la pantalla
 * los muestra a todos y con una por contacto serían N+1.
 */
export async function detectarSinRespuestaCore(
  db: Db,
  estudioId: string,
  obraId: string,
  ahora: Date,
): Promise<AvisoSinRespuesta[]> {
  const obra = await requireObraCore(db, estudioId, obraId);

  const filas = await db
    .select({
      contactoId: contactosCompulsa.id,
      compulsaId: compulsas.id,
      rubro: compulsas.rubro,
      estado: contactosCompulsa.estado,
      proveedor: proveedores.nombre,
    })
    .from(contactosCompulsa)
    .innerJoin(compulsas, eq(compulsas.id, contactosCompulsa.compulsaId))
    .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
    .where(eq(compulsas.obraId, obra.id));

  const esperan = filas.filter((fila) => !ESTADOS_QUE_YA_CONTESTARON.includes(fila.estado));
  if (esperan.length === 0) return [];

  const hilos = await db
    .select({
      contactoId: mensajes.contactoId,
      direccion: mensajes.direccion,
      registradoPor: mensajes.registradoPor,
      at: mensajes.at,
    })
    .from(mensajes)
    .where(
      inArray(
        mensajes.contactoId,
        esperan.map((fila) => fila.contactoId),
      ),
    );

  const avisos: AvisoSinRespuesta[] = [];
  for (const fila of esperan) {
    const suyos = hilos.filter((mensaje) => mensaje.contactoId === fila.contactoId);

    const envios = suyos.filter(
      (mensaje) => mensaje.direccion === 'saliente' && mensaje.registradoPor !== null,
    );
    if (envios.length === 0) continue;

    const ultimoEnvio = envios.reduce((mayor, mensaje) =>
      mensaje.at.getTime() > mayor.at.getTime() ? mensaje : mayor,
    ).at;

    const contesto = suyos.some(
      (mensaje) => mensaje.direccion === 'entrante' && mensaje.at.getTime() >= ultimoEnvio.getTime(),
    );
    if (contesto) continue;

    const dias = Math.floor((ahora.getTime() - ultimoEnvio.getTime()) / MS_POR_DIA);
    if (dias < DIAS_SIN_RESPUESTA) continue;

    avisos.push({
      contactoId: fila.contactoId,
      compulsaId: fila.compulsaId,
      proveedor: fila.proveedor,
      rubro: fila.rubro,
      dias,
    });
  }

  return avisos.sort((a, b) => b.dias - a.dias || a.proveedor.localeCompare(b.proveedor, 'es-AR'));
}

/** El link de la notificación **es** la clave de deduplicación. Ver abajo. */
function linkDelAviso(aviso: AvisoSinRespuesta, obraId: string): string {
  return `/obras/${obraId}/compulsas/${aviso.compulsaId}#contacto-${aviso.contactoId}`;
}

/**
 * Le avisa al titular del silencio, **una sola vez por contacto**.
 *
 * ## El dedup, explicado (porque no tiene columna donde apoyarse)
 *
 * No hay dónde marcar "de este contacto ya avisé": `contactos_compulsa` no tiene
 * columna para eso y agregarla es una migración de P1. Lo que sí es único y
 * estable es el **link** de la notificación —lleva la compulsa y el contacto—,
 * así que la marca es la notificación misma: si ya existe una con ese link en el
 * estudio, no se escribe otra. Alcanza porque la notificación no se borra (solo
 * se marca leída) y el link no cambia.
 *
 * **Limitación conocida:** si el proveedor contesta, se lo vuelve a contactar y
 * se calla de nuevo, no hay segundo aviso — la primera notificación sigue ahí. Se
 * arregla con una columna (`contactos_compulsa.aviso_silencio_at`) el día que
 * moleste; mientras tanto, avisar de más en la campanita es peor que avisar una
 * vez y que el estado esté en la pantalla, que es donde vive el dato real.
 */
export async function notificarSinRespuestaCore(
  db: Db,
  estudioId: string,
  obraId: string,
  avisos: readonly AvisoSinRespuesta[],
): Promise<number> {
  let escritas = 0;
  for (const aviso of avisos) {
    const link = linkDelAviso(aviso, obraId);

    const [yaAvisada] = await db
      .select({ id: notificaciones.id })
      .from(notificaciones)
      .innerJoin(usuarios, eq(usuarios.id, notificaciones.usuarioId))
      .where(and(eq(usuarios.estudioId, estudioId), eq(notificaciones.link, link)))
      .limit(1);
    if (yaAvisada) continue;

    escritas += await crearNotificacion(
      db,
      { estudioId, roles: ['titular'] },
      {
        titulo: `${aviso.proveedor} está sin respuesta hace ${aviso.dias} días`,
        cuerpo:
          `El pedido de ${PLANTILLAS[aviso.rubro].nombre.toLowerCase()} se mandó hace ${aviso.dias} días ` +
          'y todavía no contestó. Insistí, o marcá el contacto como cerrado.',
        link,
      },
    );
  }

  return escritas;
}

// ---------------------------------------------------------------------------
// Notificación de cotización conciliada (productor que P7 dejó declarado)
// ---------------------------------------------------------------------------

/**
 * Le avisa al equipo que entró una cotización, **menos al que la cargó**: quien
 * la acaba de registrar está mirando el resultado en la pantalla y una campanita
 * contándole lo que hizo hace dos segundos es ruido que enseña a ignorar la
 * campanita.
 */
export async function notificarCotizacionConciliadaCore(
  db: Db,
  actor: ActorCompulsa,
  evento: Extract<EventoCompulsa, { tipo: 'cotizacion_conciliada' }>,
): Promise<number> {
  const hilo = await requireContactoCore(db, actor.estudioId, evento.contactoId);

  const equipo = await db
    .select({ id: usuarios.id })
    .from(usuarios)
    .where(and(eq(usuarios.estudioId, actor.estudioId), eq(usuarios.activo, true)));

  const destinatarios = equipo.map((fila) => fila.id).filter((id) => id !== actor.usuarioId);

  const fidelidad = `${Math.round(evento.score * 100)}%`;
  const sustituciones =
    evento.sustituciones === 0
      ? ''
      : evento.sustituciones === 1
        ? ' Hay 1 sustitución de especificación: esa la decidís vos.'
        : ` Hay ${evento.sustituciones} sustituciones de especificación: esas las decidís vos.`;

  return crearNotificacion(db, destinatarios, {
    titulo: `${hilo.proveedor.nombre} cotizó ${PLANTILLAS[hilo.compulsa.rubro].nombre.toLowerCase()}`,
    cuerpo:
      `En ${hilo.obra.nombre}, la cotización quedó conciliada con una fidelidad de ${fidelidad} ` +
      `del pedido.${sustituciones}`,
    link: `/obras/${hilo.obra.id}/compulsas/${hilo.compulsa.id}`,
  });
}

// ---------------------------------------------------------------------------
// Server Actions
// ---------------------------------------------------------------------------

const zLanzamiento = z.object({
  obraId: zUuid,
  rubro: zRubro,
  condiciones: zCondicionesRfq,
  mandato: zMandato.nullable(),
  proveedorIds: z.array(zUuid).min(1, 'Elegí al menos un proveedor.'),
});

/**
 * Lanza la compulsa (rol titular, lo exige el core) y devuelve a dónde ir.
 *
 * El payload se valida entero con los schemas del dominio: las condiciones y el
 * mandato llegan de un formulario y `zCondicionesRfq`/`zMandato` son los mismos
 * que valida la configuración del estudio (§7 de `src/app/CLAUDE.md`).
 */
export async function lanzarCompulsaAction(entrada: unknown): Promise<ResultadoLanzamientoAction> {
  const parseo = zLanzamiento.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? PAYLOAD_ILEGIBLE };
  }
  const { obraId, rubro, condiciones, mandato, proveedorIds } = parseo.data;

  const ctx = await contexto(obraId);

  try {
    const resultado = await lanzarCompulsa(
      ctx.db,
      getStorage(),
      ctx.actor,
      ctx.obraId,
      rubro,
      { condiciones, mandato, proveedorIds },
      { notificar: (evento) => notificarDelFlujo(ctx.db, ctx.actor, evento) },
    );

    await revalidar(ctx.obraId, resultado.compulsa.id);
    return {
      ok: true,
      compulsaId: resultado.compulsa.id,
      contactos: resultado.contactos.length,
      excluidos: resultado.excluidos.length,
      version: resultado.compulsa.version,
    };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}

/**
 * El hook de notificaciones del flujo (P5 `deps.notificar`, P7
 * `crearNotificacion`). Hoy produce una sola: la cotización conciliada. Las
 * otras tres del evento quedan sin destinatario a propósito —lanzar y negociar
 * las hace la persona que está mirando la pantalla—.
 */
async function notificarDelFlujo(
  db: Db,
  actor: ActorCompulsa,
  evento: EventoCompulsa,
): Promise<void> {
  if (evento.tipo !== 'cotizacion_conciliada') return;
  await notificarCotizacionConciliadaCore(db, actor, evento);
}

const zContacto = z.object({ obraId: zUuid, contactoId: zUuid });

/** «Marcar como enviado»: firma el borrador más viejo con quién lo mandó. */
export async function registrarEnvioAction(entrada: unknown): Promise<ResultadoAccionCompulsa> {
  const parseo = zContacto.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };

  const ctx = await contexto(parseo.data.obraId);
  try {
    const { contacto } = await registrarEnvio(ctx.db, ctx.actor, parseo.data.contactoId);
    await revalidar(ctx.obraId, contacto.compulsaId);
    return { ok: true };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}

const zPreview = z.object({
  obraId: zUuid,
  contactoId: zUuid,
  nombre: z.string().min(1).max(200),
  texto: z.string().min(1, 'Pegá el presupuesto.').max(200_000, 'El texto es demasiado largo.'),
});

/** Paso 1 de «Registrar respuesta»: leer el presupuesto sin guardarlo. */
export async function previsualizarRespuestaAction(entrada: unknown): Promise<ResultadoPreviewAction> {
  const parseo = zPreview.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? PAYLOAD_ILEGIBLE };
  }

  const ctx = await contexto(parseo.data.obraId);
  try {
    const preview = await previsualizarPresupuestoCore(ctx.db, ctx.actor, parseo.data.contactoId, {
      nombre: parseo.data.nombre,
      texto: parseo.data.texto,
    });
    return { ok: true, preview };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}

const zConfirmacion = z.object({
  obraId: zUuid,
  contactoId: zUuid,
  nombre: z.string().min(1).max(200),
  texto: z.string().max(200_000),
  lineas: z.array(zLineaPresupuesto),
  metadatos: z.object({
    total: z.number().nullable(),
    incluyeIva: z.boolean().nullable(),
    validezDias: z.number().nullable(),
    plazoDias: z.number().nullable(),
    formaPago: z.string().nullable(),
  }),
});

/**
 * Paso 2: guardar lo que el usuario confirmó.
 *
 * Va por `entrada.lineas` —el camino que gana sobre el texto (P5)— porque lo que
 * se guarda es lo que el usuario vio y confirmó, no un segundo parseo que podría
 * dar otra cosa. El `texto` viaja igual para quedar como `raw_texto`: poder
 * volver a leer el original sin pedírselo de nuevo al proveedor. **El server no
 * confía en el payload**: `registrarCotizacion` vuelve a sanear las líneas y los
 * metadatos en el borde de escritura.
 */
export async function confirmarCotizacionAction(entrada: unknown): Promise<ResultadoCotizacionAction> {
  const parseo = zConfirmacion.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? PAYLOAD_ILEGIBLE };
  }
  const { obraId, contactoId, nombre, texto, lineas, metadatos } = parseo.data;

  const ctx = await contexto(obraId);
  try {
    const resultado = await registrarCotizacion(
      ctx.db,
      ctx.actor,
      contactoId,
      {
        nombre,
        texto: texto === '' ? undefined : texto,
        lineas,
        metadatos,
      },
      { notificar: (evento) => notificarDelFlujo(ctx.db, ctx.actor, evento) },
    );

    const [contacto] = await ctx.db
      .select({ compulsaId: contactosCompulsa.compulsaId })
      .from(contactosCompulsa)
      .where(eq(contactosCompulsa.id, contactoId));
    await revalidar(ctx.obraId, contacto?.compulsaId);
    const { revalidatePath } = await import('next/cache');
    revalidatePath(`/obras/${ctx.obraId}/conversaciones/${contactoId}`);

    return {
      ok: true,
      cotizacionId: resultado.cotizacion.id,
      score: resultado.conciliacion.score,
      requiereDecision: resultado.requiereDecision,
      repreguntas: resultado.repreguntasCreadas,
    };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}

const zCotizacion = z.object({ obraId: zUuid, cotizacionId: zUuid });

/** «Proponer negociación»: devuelve el texto del motor, o por qué no procede. */
export async function proponerNegociacionAction(entrada: unknown): Promise<ResultadoNegociacionAction> {
  const parseo = zCotizacion.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };

  const ctx = await contexto(parseo.data.obraId);
  try {
    const resultado = await proponerNegociacion(ctx.db, ctx.actor, parseo.data.cotizacionId);
    await revalidar(ctx.obraId);

    if (!resultado.procede) {
      return {
        ok: true,
        procede: false,
        motivo: MOTIVO_NO_PROCEDE[resultado.motivo] ?? 'El motor no propuso una contraoferta.',
      };
    }
    return {
      ok: true,
      procede: true,
      texto: resultado.texto,
      ronda: resultado.ronda,
      objetivoTotal: resultado.objetivoTotal,
    };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}

const zTotal = z.object({
  obraId: zUuid,
  cotizacionId: zUuid,
  total: z.number(),
});

/** Carga a mano el total que el proveedor no declaró (P5, decisión 8). */
export async function cargarTotalCotizacionAction(entrada: unknown): Promise<ResultadoAccionCompulsa> {
  const parseo = zTotal.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? PAYLOAD_ILEGIBLE };
  }

  const ctx = await contexto(parseo.data.obraId);
  try {
    await cargarTotalCotizacionCore(ctx.db, ctx.actor, parseo.data.cotizacionId, parseo.data.total);
    await revalidar(ctx.obraId);
    return { ok: true };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}
