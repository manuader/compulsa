/**
 * Lectura de los hilos con los proveedores (para las pantallas de P8) y
 * resolución **tenant-validada** de los objetos de la cadena de compulsa.
 *
 * Dos cosas viven acá y no en el core de flujo a propósito:
 *
 * 1. **`requireContactoCore` / `requireCompulsaCore` / `requireCotizacionCore`.**
 *    Un `contactoId` que llega de una URL o de un payload no nombra nada hasta
 *    que se prueba que cuelga de una obra de **este** estudio
 *    (`contacto → compulsa → obra → estudio`). Un id ajeno y un id inventado
 *    dan el mismo error: no se filtra existencia (RNF-4, misma regla que
 *    `requireObraCore` y `requireProveedorCore`).
 * 2. **El estado de un mensaje.** `mensajes` (P1) no tiene columna de estado, y
 *    el flujo manual necesita distinguir un borrador de algo ya mandado. La
 *    invariante que este módulo define y `flujo.ts` sostiene es:
 *
 *        saliente + registrado_por NULL  ⇒ 'pendiente_envio_manual' (borrador)
 *        saliente + registrado_por SET   ⇒ 'enviado' (esa persona lo mandó)
 *        entrante                        ⇒ 'recibido'
 *
 *    Es la lectura literal de la columna que dejó P1 ("quien lo cargó a mano;
 *    `null` ⇒ lo escribió el sistema"): el sistema escribe el borrador, la
 *    persona lo manda y al registrarlo firma. Si algún día hace falta un estado
 *    de verdad (envíos automáticos, fallidos, reintentos), es una columna nueva
 *    en `mensajes` y esta función es el único lugar a tocar.
 *
 * Módulo de solo lectura: no escribe nada y no chequea rol (mirar el hilo lo
 * puede hacer cualquier rol, `lectura` incluido).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import {
  compulsas,
  conciliacionItems,
  contactosCompulsa,
  cotizaciones,
  mensajes,
  obras,
  proveedores,
  type Compulsa,
  type ContactoCompulsa,
  type Cotizacion,
  type Mensaje,
  type Obra,
  type Proveedor,
} from '@/db/schema';
import { esUuid } from '@/lib/auth/guards';

import { partirCuerpo } from './canal';

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export class ContactoNoEncontradoError extends Error {
  constructor(readonly contactoId: string) {
    super('No encontré ese contacto de compulsa en una obra de este estudio.');
    this.name = 'ContactoNoEncontradoError';
  }
}

export class CompulsaNoEncontradaError extends Error {
  constructor(readonly compulsaId: string) {
    super('No encontré esa compulsa en una obra de este estudio.');
    this.name = 'CompulsaNoEncontradaError';
  }
}

export class CotizacionNoEncontradaError extends Error {
  constructor(readonly cotizacionId: string) {
    super('No encontré esa cotización en una obra de este estudio.');
    this.name = 'CotizacionNoEncontradaError';
  }
}

// ---------------------------------------------------------------------------
// Estado de un mensaje
// ---------------------------------------------------------------------------

export type EstadoMensaje = 'pendiente_envio_manual' | 'enviado' | 'recibido';

/** Ver el encabezado del módulo: el estado se lee de `direccion` + `registrado_por`. */
export function estadoMensaje(mensaje: Pick<Mensaje, 'direccion' | 'registradoPor'>): EstadoMensaje {
  if (mensaje.direccion === 'entrante') return 'recibido';
  return mensaje.registradoPor === null ? 'pendiente_envio_manual' : 'enviado';
}

// ---------------------------------------------------------------------------
// Resolución tenant-validada
// ---------------------------------------------------------------------------

export interface ContextoContacto {
  contacto: ContactoCompulsa;
  compulsa: Compulsa;
  obra: Obra;
  proveedor: Proveedor;
}

/** El contacto, con su compulsa, su obra y su proveedor — o "no existe". */
export async function requireContactoCore(
  db: Db,
  estudioId: string,
  contactoId: string,
): Promise<ContextoContacto> {
  if (!esUuid(contactoId)) throw new ContactoNoEncontradoError(contactoId);

  const [fila] = await db
    .select({
      contacto: contactosCompulsa,
      compulsa: compulsas,
      obra: obras,
      proveedor: proveedores,
    })
    .from(contactosCompulsa)
    .innerJoin(compulsas, eq(compulsas.id, contactosCompulsa.compulsaId))
    .innerJoin(obras, eq(obras.id, compulsas.obraId))
    .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
    .where(and(eq(contactosCompulsa.id, contactoId), eq(obras.estudioId, estudioId)));

  if (!fila) throw new ContactoNoEncontradoError(contactoId);
  return fila;
}

/** La compulsa con su obra — o "no existe". */
export async function requireCompulsaCore(
  db: Db,
  estudioId: string,
  compulsaId: string,
): Promise<{ compulsa: Compulsa; obra: Obra }> {
  if (!esUuid(compulsaId)) throw new CompulsaNoEncontradaError(compulsaId);

  const [fila] = await db
    .select({ compulsa: compulsas, obra: obras })
    .from(compulsas)
    .innerJoin(obras, eq(obras.id, compulsas.obraId))
    .where(and(eq(compulsas.id, compulsaId), eq(obras.estudioId, estudioId)));

  if (!fila) throw new CompulsaNoEncontradaError(compulsaId);
  return fila;
}

/** La cotización con todo su contexto — o "no existe". */
export async function requireCotizacionCore(
  db: Db,
  estudioId: string,
  cotizacionId: string,
): Promise<{ cotizacion: Cotizacion; contexto: ContextoContacto }> {
  if (!esUuid(cotizacionId)) throw new CotizacionNoEncontradaError(cotizacionId);

  const [fila] = await db
    .select({ cotizacion: cotizaciones, contactoId: contactosCompulsa.id })
    .from(cotizaciones)
    .innerJoin(contactosCompulsa, eq(contactosCompulsa.id, cotizaciones.contactoId))
    .innerJoin(compulsas, eq(compulsas.id, contactosCompulsa.compulsaId))
    .innerJoin(obras, eq(obras.id, compulsas.obraId))
    .where(and(eq(cotizaciones.id, cotizacionId), eq(obras.estudioId, estudioId)));

  if (!fila) throw new CotizacionNoEncontradaError(cotizacionId);
  return {
    cotizacion: fila.cotizacion,
    contexto: await requireContactoCore(db, estudioId, fila.contactoId),
  };
}

// ---------------------------------------------------------------------------
// Hilos
// ---------------------------------------------------------------------------

export interface MensajeHilo {
  id: string;
  direccion: Mensaje['direccion'];
  canal: Mensaje['canal'];
  estado: EstadoMensaje;
  /** El texto que ve el proveedor, ya sin el bloque de adjuntos. */
  texto: string;
  /** Refs del storage de los recortes que acompañan al mensaje. */
  adjuntos: string[];
  registradoPor: string | null;
  at: Date;
}

export interface Hilo {
  contexto: ContextoContacto;
  mensajes: MensajeHilo[];
  /** Borradores salientes que todavía nadie mandó. */
  pendientes: number;
}

/**
 * El bloque de adjuntos se parte **solo en los salientes**.
 *
 * `componerCuerpo`/`partirCuerpo` son un par y el único que compone es el
 * sistema, al escribir un borrador. Un entrante lo pega una persona: si copia
 * la respuesta citando el pedido —cosa que hace cualquiera que contesta un
 * mail—, el cuerpo trae el texto del RFQ **con su `MARCA_ADJUNTOS` adentro**, y
 * partirlo truncaría en silencio lo que dijo el proveedor y le colgaría refs
 * nuestras como si fueran archivos suyos. Un entrante se muestra crudo y
 * completo, siempre.
 */
function comoMensajeHilo(fila: Mensaje): MensajeHilo {
  const { texto, adjuntos } =
    fila.direccion === 'saliente'
      ? partirCuerpo(fila.cuerpo)
      : { texto: fila.cuerpo, adjuntos: [] as string[] };
  return {
    id: fila.id,
    direccion: fila.direccion,
    canal: fila.canal,
    estado: estadoMensaje(fila),
    texto,
    adjuntos,
    registradoPor: fila.registradoPor,
    at: fila.at,
  };
}

/** El hilo completo de un contacto, del más viejo al más nuevo. */
export async function leerHilo(db: Db, estudioId: string, contactoId: string): Promise<Hilo> {
  const contexto = await requireContactoCore(db, estudioId, contactoId);
  const filas = await db
    .select()
    .from(mensajes)
    .where(eq(mensajes.contactoId, contactoId))
    .orderBy(asc(mensajes.at), asc(mensajes.id));

  const hilo = filas.map(comoMensajeHilo);
  return {
    contexto,
    mensajes: hilo,
    pendientes: hilo.filter((m) => m.estado === 'pendiente_envio_manual').length,
  };
}

/**
 * Todos los hilos de una compulsa, uno por contacto, ordenados por proveedor.
 *
 * Lee los mensajes de todos los contactos de una sola consulta: la pantalla de
 * la compulsa muestra el timeline de cada proveedor y con una query por contacto
 * serían N+1.
 */
export async function leerHilos(db: Db, estudioId: string, compulsaId: string): Promise<Hilo[]> {
  const { compulsa, obra } = await requireCompulsaCore(db, estudioId, compulsaId);

  const filas = await db
    .select({ contacto: contactosCompulsa, proveedor: proveedores })
    .from(contactosCompulsa)
    .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
    .where(eq(contactosCompulsa.compulsaId, compulsaId));

  if (filas.length === 0) return [];

  const todos = await db
    .select()
    .from(mensajes)
    .where(
      inArray(
        mensajes.contactoId,
        filas.map((fila) => fila.contacto.id),
      ),
    )
    .orderBy(asc(mensajes.at), asc(mensajes.id));

  const porContacto = new Map<string, MensajeHilo[]>();
  for (const fila of todos) {
    const lista = porContacto.get(fila.contactoId) ?? [];
    lista.push(comoMensajeHilo(fila));
    porContacto.set(fila.contactoId, lista);
  }

  return filas
    .map((fila) => {
      const hilo = porContacto.get(fila.contacto.id) ?? [];
      return {
        contexto: { contacto: fila.contacto, compulsa, obra, proveedor: fila.proveedor },
        mensajes: hilo,
        pendientes: hilo.filter((m) => m.estado === 'pendiente_envio_manual').length,
      };
    })
    .sort((a, b) => a.contexto.proveedor.nombre.localeCompare(b.contexto.proveedor.nombre, 'es-AR'));
}

// ---------------------------------------------------------------------------
// Banderas
// ---------------------------------------------------------------------------

/**
 * Una sustitución de especificación en las cotizaciones de un contacto
 * (RF-1002): el semáforo rojo que la pantalla del hilo tiene que mostrar y que
 * frena la negociación automática.
 */
export interface BanderaSustitucion {
  cotizacionId: string;
  claveItem: string;
  /** El motivo que escribió la conciliación, en es-AR y listo para mostrar. */
  nota: string;
}

/**
 * Las sustituciones que arrastra un contacto. Salen de `conciliacion_items`,
 * que es la fuente de verdad: no hay una bandera denormalizada que se pueda
 * desincronizar de la conciliación.
 */
export async function banderasDeContacto(
  db: Db,
  estudioId: string,
  contactoId: string,
): Promise<BanderaSustitucion[]> {
  await requireContactoCore(db, estudioId, contactoId);

  const filas = await db
    .select({
      cotizacionId: conciliacionItems.cotizacionId,
      claveItem: conciliacionItems.claveItem,
      nota: conciliacionItems.nota,
    })
    .from(conciliacionItems)
    .innerJoin(cotizaciones, eq(cotizaciones.id, conciliacionItems.cotizacionId))
    .where(and(eq(cotizaciones.contactoId, contactoId), eq(conciliacionItems.match, 'sustituto')))
    .orderBy(asc(conciliacionItems.claveItem));

  return filas.map((fila) => ({
    cotizacionId: fila.cotizacionId,
    claveItem: fila.claveItem ?? '',
    nota: fila.nota ?? 'El proveedor cotizó otra especificación.',
  }));
}
