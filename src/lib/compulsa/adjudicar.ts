/**
 * Adjudicar una compulsa: el núcleo (RF-1102 / RF-1104).
 *
 * Es el paso que cierra el circuito de F1 — de acá sale una orden de compra y
 * un número de ahorro— así que vive en `src/lib/` y **no** en un archivo
 * `'use server'`: recibe la base y el actor por parámetro, no sabe nada de
 * cookies ni de Next, y se puede probar entero contra PGlite. El envoltorio
 * `adjudicarAction` (`src/app/obras/[obraId]/comparativa/actions.ts`) aporta las
 * tres líneas que faltan: sesión, revalidación y traducción del error a texto.
 *
 * ## Dónde se guarda el ahorro: en ningún lado
 *
 * El esquema no tiene tabla de ahorro y **no se agregó una**. El ahorro de una
 * compulsa adjudicada es una función de datos que ya están escritos:
 *
 *     ahorro = (mediana de los totales comparables − total adjudicado)
 *              + Σ mejoras de negociación aceptadas
 *
 * — todo eso vive en `cotizaciones.total`, `adjudicaciones.cotizacion_id` y
 * `negociaciones`. Materializarlo sería crear un segundo lugar donde puede
 * estar mal: corregir el total de una cotización dejaría el contador mintiendo
 * hasta que alguien lo recalculara. Se calcula **al leer**
 * (`ahorroDeCompulsa` / `resumenCompulsasObra`) y se deja además en la
 * auditoría de la adjudicación, que es el registro de cuánto dio *ese día*.
 *
 * Costo de la decisión: el tablero hace una consulta por compulsa adjudicada de
 * la obra. Con el orden de magnitud de una obra (unidades, no cientos) es
 * irrelevante; si algún día molesta, el lugar para cachearlo es
 * `obras.resumen_json`, que ya existe para eso.
 *
 * ## Qué pasa con los otros proveedores
 *
 * Adjudicar cierra la compulsa entera: los contactos que estaban en juego pasan
 * a `cerrado`. Dejar a los perdedores en `negociando` sería mentirle a la
 * pantalla de conversaciones. Los que nunca contestaron se quedan en
 * `sin_respuesta`: eso es información sobre el proveedor, no un estado de esta
 * compulsa.
 */
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';

import type { Db } from '@/db/client';
import {
  adjudicaciones,
  compulsas,
  conciliacionItems,
  contactosCompulsa,
  cotizaciones,
  estudios,
  negociaciones,
  obras,
  priceIndex,
  proveedores,
  type Adjudicacion,
  type Compulsa,
  type Obra,
} from '@/db/schema';
import { acumularAhorros, calcularAhorro } from '@/lib/ahorro/calculo';
import { registrarAuditoria } from '@/lib/audit';
import {
  armarComparativa,
  entradasDeRanking,
  rankear,
  type Comparativa,
  type ConciliacionComparativa,
  type CotizacionComparativa,
  type FilaIndice,
  type PuestoRanking,
} from '@/lib/compulsa/comparativa';
import {
  generarOrdenCompra,
  type ItemOrdenCompra,
} from '@/lib/compulsa/orden-compra';
import { redondear2 } from '@/lib/computo/unidades';
import { requireCompulsaCore, requireCotizacionCore } from '@/lib/outreach/threads';
import { leerConfig } from '@/lib/plataforma/config-estudio';
import { crearNotificacion } from '@/lib/plataforma/notificaciones';
import { requireAccion, type UsuarioConRol } from '@/lib/plataforma/roles';
import { PLANTILLAS } from '@/lib/rubros';
import type { ConfigEstudio, PesosRanking } from '@/types/domain';

// ---------------------------------------------------------------------------
// Actor y errores
// ---------------------------------------------------------------------------

/** Quién adjudica. Lleva `estudioId` porque toda resolución arranca por ahí. */
export interface ActorAdjudicacion extends UsuarioConRol {
  usuarioId: string;
  email: string;
  estudioId: string;
}

export class CompulsaYaAdjudicadaError extends Error {
  constructor(readonly compulsaId: string) {
    super('Esta compulsa ya está adjudicada: no se puede adjudicar dos veces.');
    this.name = 'CompulsaYaAdjudicadaError';
  }
}

export class CotizacionNoConciliadaError extends Error {
  constructor(readonly cotizacionId: string) {
    super(
      'Esa cotización todavía no está conciliada contra el pedido: sin saber qué cotizó no se puede armar la orden de compra.',
    );
    this.name = 'CotizacionNoConciliadaError';
  }
}

export class AdjudicacionSinTotalError extends Error {
  constructor(readonly cotizacionId: string) {
    super(
      'Esa cotización no tiene total: cargalo (o pedíselo al proveedor) antes de adjudicar.',
    );
    this.name = 'AdjudicacionSinTotalError';
  }
}

export class AdjudicacionSinItemsError extends Error {
  constructor(readonly cotizacionId: string) {
    super(
      'Esa cotización no tiene ningún ítem comparable: revisá la conciliación antes de adjudicar.',
    );
    this.name = 'AdjudicacionSinItemsError';
  }
}

/** Violación del UNIQUE por compulsa: dos personas adjudicando a la vez. */
function esConflictoDeUnicidad(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

// ---------------------------------------------------------------------------
// Lectura: el cuadro comparativo con todo lo que la pantalla necesita
// ---------------------------------------------------------------------------

export interface DatosComparativa {
  obra: Obra;
  compulsa: Compulsa;
  estudioNombre: string;
  comparativa: Comparativa;
  ranking: PuestoRanking[];
  /** Cotizaciones que no entraron al ranking porque no tienen total utilizable. */
  sinRanking: string[];
  pesos: PesosRanking;
  mepReferencia: ConfigEstudio['mepReferencia'];
  adjudicacion: Adjudicacion | null;
}

export interface OpcionesLectura {
  ahora?: Date;
}

/**
 * El cuadro de una compulsa, leído de la base y con el tenant ya validado.
 *
 * Es la única lectura de la comparativa: la usan la pantalla, el reporte XLSX y
 * la propia adjudicación (que necesita los ítems y los precios unitarios para
 * escribir la orden de compra). Tener una sola hace que los tres muestren
 * exactamente los mismos números.
 */
export async function leerComparativa(
  db: Db,
  estudioId: string,
  compulsaId: string,
  opciones: OpcionesLectura = {},
): Promise<DatosComparativa> {
  const { compulsa, obra } = await requireCompulsaCore(db, estudioId, compulsaId);
  const ahora = opciones.ahora ?? new Date();

  const [filasCotizaciones, [estudio], [adjudicacion], config] = await Promise.all([
    db
      .select({ cotizacion: cotizaciones, proveedor: proveedores })
      .from(cotizaciones)
      .innerJoin(contactosCompulsa, eq(contactosCompulsa.id, cotizaciones.contactoId))
      .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
      .where(
        and(
          eq(contactosCompulsa.compulsaId, compulsa.id),
          // Una cotización descartada no es una columna: es una que se anuló.
          ne(cotizaciones.estado, 'descartada'),
        ),
      )
      .orderBy(asc(cotizaciones.createdAt), asc(cotizaciones.id)),
    db.select({ nombre: estudios.nombre }).from(estudios).where(eq(estudios.id, estudioId)),
    db.select().from(adjudicaciones).where(eq(adjudicaciones.compulsaId, compulsa.id)),
    leerConfig(db, estudioId),
  ]);

  const columnas: CotizacionComparativa[] = filasCotizaciones.map(({ cotizacion, proveedor }) => ({
    id: cotizacion.id,
    proveedorId: proveedor.id,
    proveedorNombre: proveedor.nombre,
    moneda: cotizacion.moneda,
    incluyeIva: cotizacion.incluyeIva,
    total: cotizacion.total,
    validezDias: cotizacion.validezDias,
    plazoDias: cotizacion.plazoDias,
    scoreFidelidad: cotizacion.scoreFidelidad,
    lineas: cotizacion.lineasJson,
    createdAt: cotizacion.createdAt,
  }));

  const ids = columnas.map((c) => c.id);
  const claves = compulsa.itemsJson.map((item) => item.claveItem);

  const [filasConciliacion, filasIndice] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({
            cotizacionId: conciliacionItems.cotizacionId,
            claveItem: conciliacionItems.claveItem,
            lineaIdx: conciliacionItems.lineaIdx,
            match: conciliacionItems.match,
            nota: conciliacionItems.nota,
          })
          .from(conciliacionItems)
          .where(inArray(conciliacionItems.cotizacionId, ids)),
    claves.length === 0
      ? Promise.resolve([])
      : db
          .select({
            claveItem: priceIndex.claveItem,
            zona: priceIndex.zona,
            mes: priceIndex.mes,
            p50: priceIndex.p50,
            p75: priceIndex.p75,
            n: priceIndex.n,
          })
          .from(priceIndex)
          .where(
            and(
              eq(priceIndex.estudioId, estudioId),
              eq(priceIndex.zona, obra.zona),
              inArray(priceIndex.claveItem, claves),
            ),
          ),
  ]);

  const comparativa = armarComparativa(
    {
      id: compulsa.id,
      rubro: compulsa.rubro,
      version: compulsa.version,
      items: compulsa.itemsJson,
    },
    columnas,
    filasConciliacion as ConciliacionComparativa[],
    filasIndice as FilaIndice[],
    { zona: obra.zona, ahora },
  );

  const entradas = entradasDeRanking(comparativa);
  const rankeadas = new Set(entradas.map((e) => e.id));

  return {
    obra,
    compulsa,
    estudioNombre: estudio?.nombre ?? '',
    comparativa,
    ranking: rankear(entradas, config.pesosRanking),
    sinRanking: comparativa.columnas.filter((c) => !rankeadas.has(c.cotizacionId)).map((c) => c.cotizacionId),
    pesos: config.pesosRanking,
    mepReferencia: config.mepReferencia,
    adjudicacion: adjudicacion ?? null,
  };
}

/** Las compulsas de una obra, de la más nueva a la más vieja (el selector). */
export async function listarCompulsasDeObra(
  db: Db,
  estudioId: string,
  obraId: string,
): Promise<Compulsa[]> {
  return db
    .select({ compulsa: compulsas })
    .from(compulsas)
    .innerJoin(obras, eq(obras.id, compulsas.obraId))
    .where(and(eq(compulsas.obraId, obraId), eq(obras.estudioId, estudioId)))
    .orderBy(asc(compulsas.rubro), asc(compulsas.version))
    .then((filas) => filas.map((f) => f.compulsa));
}

// ---------------------------------------------------------------------------
// Ahorro (RF-1104), calculado al leer
// ---------------------------------------------------------------------------

export interface DatosAhorro {
  /** Totales declarados de las cotizaciones conciliadas de la compulsa. */
  totalesComparables: number[];
  totalAdjudicado: number;
  /** Bajas conseguidas en rondas aceptadas. Vacío ⇒ no se negoció (o no bajó). */
  mejoras: number[];
  ahorro: number;
}

/**
 * Cuánto se ahorró en una compulsa. `null` mientras no esté adjudicada: sin
 * adjudicación no hay contra qué medir, y un 0 se leería como "no ahorramos".
 *
 * **Las mejoras de negociación se cuentan una sola vez.** `negociaciones` guarda
 * el total que había *antes* de cada ronda (`oferta_json.totalCotizado`), así
 * que con dos rondas aceptadas —105 → 102 → 100— sumar ronda por ronda contaría
 * 5 + 2 = 7 donde la baja real fue 5. Se toma el **máximo** de esos totales
 * previos menos el total con el que se adjudicó.
 */
export async function ahorroDeCompulsa(db: Db, compulsaId: string): Promise<DatosAhorro | null> {
  const [adjudicacion] = await db
    .select()
    .from(adjudicaciones)
    .where(eq(adjudicaciones.compulsaId, compulsaId));
  if (!adjudicacion) return null;

  const filas = await db
    .select({ id: cotizaciones.id, total: cotizaciones.total })
    .from(cotizaciones)
    .innerJoin(contactosCompulsa, eq(contactosCompulsa.id, cotizaciones.contactoId))
    .where(
      and(eq(contactosCompulsa.compulsaId, compulsaId), eq(cotizaciones.estado, 'conciliada')),
    );

  const totalesComparables = filas
    .map((f) => f.total)
    .filter((t): t is number => t !== null && Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);

  const adjudicada = filas.find((f) => f.id === adjudicacion.cotizacionId);
  const totalAdjudicado = adjudicada?.total ?? null;
  // Sin total adjudicado no hay cuenta posible. No puede pasar por el camino de
  // `adjudicarCompulsa` (lo exige antes de escribir), pero sí si alguien anula
  // el total después: preferimos no mostrar número a mostrar uno inventado.
  if (totalAdjudicado === null || totalesComparables.length === 0) return null;

  const rondas = await db
    .select({ ofertaJson: negociaciones.ofertaJson })
    .from(negociaciones)
    .where(
      and(
        eq(negociaciones.cotizacionId, adjudicacion.cotizacionId),
        eq(negociaciones.resultado, 'aceptada'),
      ),
    );

  const previos = rondas
    .map((r) => Number((r.ofertaJson as { totalCotizado?: unknown }).totalCotizado))
    .filter((t) => Number.isFinite(t) && t > 0);
  const mejor = previos.length > 0 ? Math.max(...previos) : null;
  const mejora = mejor === null ? 0 : redondear2(mejor - totalAdjudicado);
  const mejoras = mejora > 0 ? [mejora] : [];

  return {
    totalesComparables,
    totalAdjudicado,
    mejoras,
    ahorro: calcularAhorro(totalesComparables, totalAdjudicado, mejoras),
  };
}

export interface ResumenCompulsasObra {
  total: number;
  /** Lanzadas, esperando cotizaciones o decisión. */
  enCurso: number;
  adjudicadas: number;
  /** Cotizaciones recibidas en la obra (sin contar las descartadas). */
  cotizaciones: number;
  /** Ahorro acumulado en ARS de las compulsas adjudicadas de esta obra. */
  ahorro: number;
}

/** Lo que la card «Compulsas» del tablero necesita saber de una obra. */
export async function resumenCompulsasObra(
  db: Db,
  obraId: string,
): Promise<ResumenCompulsasObra> {
  const [filas, [recibidas]] = await Promise.all([
    db
      .select({ id: compulsas.id, estado: compulsas.estado })
      .from(compulsas)
      .where(eq(compulsas.obraId, obraId)),
    db
      .select({ total: count() })
      .from(cotizaciones)
      .innerJoin(contactosCompulsa, eq(contactosCompulsa.id, cotizaciones.contactoId))
      .innerJoin(compulsas, eq(compulsas.id, contactosCompulsa.compulsaId))
      .where(and(eq(compulsas.obraId, obraId), ne(cotizaciones.estado, 'descartada'))),
  ]);

  const adjudicadas = filas.filter((f) => f.estado === 'adjudicada');
  const ahorros = await Promise.all(adjudicadas.map((f) => ahorroDeCompulsa(db, f.id)));

  return {
    total: filas.length,
    enCurso: filas.filter((f) => f.estado === 'lanzada').length,
    adjudicadas: adjudicadas.length,
    cotizaciones: recibidas?.total ?? 0,
    ahorro: acumularAhorros(
      ahorros.filter((a): a is DatosAhorro => a !== null).map((a) => a.ahorro),
    ),
  };
}

// ---------------------------------------------------------------------------
// Adjudicar
// ---------------------------------------------------------------------------

export interface EntradaAdjudicacion {
  cotizacionId: string;
  /**
   * Total con el que se adjudica. Solo hace falta cuando `cotizaciones.total`
   * está en `null` (el presupuesto no lo traía, P5 §8) o cuando se corrige a
   * mano; se persiste en la cotización, porque es el número por el que se
   * compró y contra el que se va a medir el ahorro.
   */
  total?: number | null;
  /** Número de orden del estudio, si lo lleva. */
  numero?: string | null;
  notas?: string | null;
}

export interface ResultadoAdjudicacion {
  adjudicacion: Adjudicacion;
  ordenCompra: string;
  items: ItemOrdenCompra[];
  ahorro: DatosAhorro | null;
}

export interface DepsAdjudicacion {
  ahora?: () => Date;
}

export async function adjudicarCompulsa(
  db: Db,
  actor: ActorAdjudicacion,
  entrada: EntradaAdjudicacion,
  deps: DepsAdjudicacion = {},
): Promise<ResultadoAdjudicacion> {
  // El rol se chequea antes que nada: adjudicar es de titular (RF-1201), y el
  // mensaje tiene que hablar del permiso, no de un id que además no existe.
  requireAccion(actor, 'adjudicar_compulsa');

  const { cotizacion, contexto } = await requireCotizacionCore(
    db,
    actor.estudioId,
    entrada.cotizacionId,
  );
  const ahora = deps.ahora?.() ?? new Date();

  if (contexto.compulsa.estado === 'adjudicada') {
    throw new CompulsaYaAdjudicadaError(contexto.compulsa.id);
  }
  if (cotizacion.estado !== 'conciliada') {
    throw new CotizacionNoConciliadaError(cotizacion.id);
  }

  // --- 1. El total con el que se compra ------------------------------------
  const totalCargado =
    entrada.total !== undefined &&
    entrada.total !== null &&
    Number.isFinite(entrada.total) &&
    entrada.total > 0
      ? redondear2(entrada.total)
      : null;
  const totalAdjudicado = totalCargado ?? cotizacion.total;
  if (totalAdjudicado === null || !Number.isFinite(totalAdjudicado) || totalAdjudicado <= 0) {
    throw new AdjudicacionSinTotalError(cotizacion.id);
  }
  if (totalCargado !== null && totalCargado !== cotizacion.total) {
    await db
      .update(cotizaciones)
      .set({ total: totalCargado })
      .where(eq(cotizaciones.id, cotizacion.id));
  }

  // --- 2. Los ítems, del cuadro comparativo --------------------------------
  const datos = await leerComparativa(db, actor.estudioId, contexto.compulsa.id, {
    ahora,
  });
  const columna = datos.comparativa.columnas.find((c) => c.cotizacionId === cotizacion.id);
  const items: ItemOrdenCompra[] = datos.comparativa.filas
    .map((fila) => {
      const celda = fila.celdas.find((c) => c.cotizacionId === cotizacion.id);
      if (!celda?.comparable || celda.importe === null || celda.precioUnitario === null) return null;
      return {
        claveItem: fila.claveItem,
        descripcion: fila.item.descripcion,
        unidad: fila.item.unidad,
        cantidad: fila.item.cantidad,
        precioUnitario: celda.precioUnitario,
        importe: celda.importe,
      };
    })
    .filter((item): item is ItemOrdenCompra => item !== null);

  if (items.length === 0) throw new AdjudicacionSinItemsError(cotizacion.id);

  // --- 3. La orden de compra ------------------------------------------------
  //
  // El total de la orden es el del presupuesto aceptado, no la suma del
  // detalle: es lo que se va a pagar. Cuando no coinciden —flete, un ítem que
  // el proveedor cotizó aparte, una sustitución que quedó afuera— la orden lo
  // dice, en vez de dejar que alguien sume el detalle y encuentre otra cifra.
  const sumaDetalle = redondear2(items.reduce((acc, item) => acc + item.importe, 0));
  const notas: string[] = [];
  if (sumaDetalle !== totalAdjudicado) {
    notas.push(
      `El total de esta orden es el del presupuesto aceptado; el detalle de arriba suma ${sumaDetalle.toFixed(2).replace('.', ',')}. Confirmá con el proveedor a qué corresponde la diferencia antes de despachar.`,
    );
  }
  if (entrada.notas?.trim()) notas.push(entrada.notas.trim());

  const ordenCompra = generarOrdenCompra(
    { nombre: datos.estudioNombre, mepReferencia: datos.mepReferencia },
    { nombre: contexto.obra.nombre, zona: contexto.obra.zona, moneda: contexto.obra.moneda },
    {
      nombre: contexto.proveedor.nombre,
      contacto: contactoLegible(contexto.proveedor.contactosJson),
    },
    {
      moneda: cotizacion.moneda,
      incluyeIva: cotizacion.incluyeIva,
      validezDias: cotizacion.validezDias,
      plazoDias: cotizacion.plazoDias,
      formaPago: cotizacion.formaPago,
    },
    items,
    {
      rubro: contexto.compulsa.rubro,
      version: contexto.compulsa.version,
      total: totalAdjudicado,
      condiciones: contexto.compulsa.condicionesJson,
      fecha: ahora,
      numero: entrada.numero ?? null,
      notas: notas.length > 0 ? notas.join(' ') : null,
    },
  );

  // --- 4. Lo que queda escrito ---------------------------------------------
  //
  // La fila de `adjudicaciones` va primera y con el UNIQUE por compulsa: es la
  // que serializa dos adjudicaciones simultáneas. Si perdiéramos la carrera
  // después de haber marcado la compulsa, quedaría una compulsa `adjudicada`
  // sin adjudicación.
  let adjudicacion: Adjudicacion;
  try {
    [adjudicacion] = await db
      .insert(adjudicaciones)
      .values({
        compulsaId: contexto.compulsa.id,
        cotizacionId: cotizacion.id,
        ocTexto: ordenCompra,
        confirmadoAt: ahora,
      })
      .returning();
  } catch (error) {
    if (esConflictoDeUnicidad(error)) throw new CompulsaYaAdjudicadaError(contexto.compulsa.id);
    throw error;
  }

  await db
    .update(compulsas)
    .set({ estado: 'adjudicada' })
    .where(eq(compulsas.id, contexto.compulsa.id));

  await db
    .update(contactosCompulsa)
    .set({ estado: 'cerrado' })
    .where(
      and(
        eq(contactosCompulsa.compulsaId, contexto.compulsa.id),
        ne(contactosCompulsa.estado, 'sin_respuesta'),
      ),
    );

  // --- 5. Ahorro, auditoría y aviso ----------------------------------------
  const ahorro = await ahorroDeCompulsa(db, contexto.compulsa.id);
  const rubroNombre = PLANTILLAS[contexto.compulsa.rubro].nombre;

  await registrarAuditoria({
    obraId: contexto.obra.id,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'compulsa_adjudicada',
    targetRef: `compulsas:${contexto.compulsa.id}`,
    diff: {
      cotizacionId: cotizacion.id,
      contactoId: contexto.contacto.id,
      proveedor: contexto.proveedor.nombre,
      rubro: contexto.compulsa.rubro,
      version: contexto.compulsa.version,
      totalAdjudicado,
      totalCargadoAMano: totalCargado,
      itemsAdjudicados: items.length,
      sumaDetalle,
      // El ahorro se recalcula al leer; esto es cuánto dio el día que se
      // adjudicó, que es lo que hace auditable la decisión.
      ahorro: ahorro?.ahorro ?? null,
      totalesComparables: ahorro?.totalesComparables ?? [],
      mejorasNegociacion: ahorro?.mejoras ?? [],
      puntaje: datos.ranking.find((p) => p.id === cotizacion.id)?.puntaje ?? null,
      posicion: datos.ranking.find((p) => p.id === cotizacion.id)?.posicion ?? null,
      totalComparable: columna?.totalComparable ?? null,
    },
  });

  await crearNotificacion(
    db,
    { estudioId: actor.estudioId },
    {
      titulo: `Compulsa adjudicada — ${rubroNombre}`,
      cuerpo: `${contexto.obra.nombre}: se adjudicó ${rubroNombre} a ${contexto.proveedor.nombre}. La orden de compra ya está lista para mandar.`,
      link: `/obras/${contexto.obra.id}/comparativa?compulsa=${contexto.compulsa.id}`,
    },
  );

  return { adjudicacion, ordenCompra, items, ahorro };
}

/**
 * Una línea de contacto legible a partir de `proveedores.contactos_json`, que es
 * un jsonb libre (`{ contacto, telefono, email, whatsapp }`). Se toma lo que
 * haya, en ese orden de preferencia, y nunca se inventa nada.
 */
function contactoLegible(contactos: Record<string, unknown>): string | null {
  const persona = typeof contactos.contacto === 'string' ? contactos.contacto.trim() : '';
  const via = ['telefono', 'whatsapp', 'email']
    .map((clave) => (typeof contactos[clave] === 'string' ? (contactos[clave] as string).trim() : ''))
    .find((valor) => valor !== '');

  if (persona && via) return `${persona} — ${via}`;
  return persona || via || null;
}
