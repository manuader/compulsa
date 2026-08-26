/**
 * Adjudicar una compulsa, punta a punta, sobre PGlite en memoria.
 *
 * Lo que estos tests cuidan:
 *
 *  1. **El pin del ahorro (RF-1104):** tres totales comparables [100, 110, 120],
 *     se adjudica el de 100 después de negociarlo desde 105 ⇒ el tablero dice
 *     **15** = (110 − 100) + 5. El número no está guardado en ninguna tabla: se
 *     recalcula al leer, así que el test lo pide por donde lo pide el tablero.
 *  2. **Qué queda escrito al adjudicar:** la fila de `adjudicaciones` con su
 *     orden de compra, la compulsa en `adjudicada`, los contactos en `cerrado`,
 *     la auditoría y la notificación.
 *  3. **Quién puede (RF-1201) y de qué estudio (RNF-4):** adjudicar es del
 *     titular, y una compulsa de otro estudio no existe.
 *  4. **El reporte XLSX** sale con las celdas del cuadro, hoja por cotización y
 *     hoja de condiciones, y con el mismo control de tenant.
 *  5. **El loop de negociación cierra (RF-1003):** el mismo pin del ahorro, esta
 *     vez sin ninguna fila puesta a dedo —el motor propone, `resolverNegociacion`
 *     escribe el resultado—, más `descartarCotizacion`, que saca una columna del
 *     cuadro, del ranking y de la mediana sin borrarla.
 *
 * `next/headers` va mockeado porque la route del reporte lee la cookie de ahí
 * (mismo patrón que `tests/integration/export-route.test.ts`).
 */
import ExcelJS from 'exceljs';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/obras/[obraId]/compulsas/[compulsaId]/reporte/route';
import { setDbForTests, type Db } from '@/db/client';
import {
  adjudicaciones,
  auditoria,
  compulsas,
  conciliacionItems,
  contactosCompulsa,
  cotizaciones,
  estudios,
  negociaciones,
  notificaciones,
  obras,
  priceIndex,
  proveedores,
  usuarios,
} from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import {
  AdjudicacionSinTotalError,
  CompulsaYaAdjudicadaError,
  adjudicarCompulsa,
  ahorroDeCompulsa,
  ahorroDelEstudio,
  leerComparativa,
  resumenCompulsasObra,
  type ActorAdjudicacion,
} from '@/lib/compulsa/adjudicar';
import {
  CotizacionYaDescartadaError,
  descartarCotizacion,
  NegociacionImposibleError,
  NegociacionYaResueltaError,
  proponerNegociacion,
  resolverNegociacion,
  // Homónima de la de `plataforma/roles` (que es la que usa `adjudicarCompulsa`)
  // y **no** es la misma clase: hasta que P11 unifique los dos guards, un
  // `instanceof` con la equivocada pasaría de largo.
  RolInsuficienteError as RolInsuficienteEnFlujo,
} from '@/lib/compulsa/flujo';
import {
  CompulsaNoEncontradaError,
  CotizacionNoEncontradaError,
  EstadoContactoInvalidoError,
  NegociacionNoEncontradaError,
} from '@/lib/outreach/threads';
import { RolInsuficienteError } from '@/lib/plataforma/roles';
import { CONDICIONES_RFQ_DEFAULT, MANDATO_DEFAULT, type ItemRfq } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

/** Cookie que ve la route del reporte. `undefined` ⇒ sin sesión. */
let cookieActual: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      cookieActual && nombre === 'compulsa_session' ? { value: cookieActual } : undefined,
  }),
}));

const AHORA = new Date('2026-08-26T15:00:00Z');
const ZONA = 'Vicente López';

const ITEMS: ItemRfq[] = [
  {
    claveItem: 'seco.placas',
    descripcion: 'Placa de roca de yeso 12,5 mm',
    unidad: 'm2',
    cantidad: 10,
    presentacion: '4 placas de 2,88 m²',
    specsCriticas: { tipo: 'durlock' },
  },
  {
    claveItem: 'seco.montantes',
    descripcion: 'Montante 70 mm para tabique de durlock',
    unidad: 'ml',
    cantidad: 20,
    presentacion: 'a medida',
    specsCriticas: {},
  },
];

let db: Db;
let estudioId: string;
let obraId: string;
let compulsaId: string;
let titular: ActorAdjudicacion;
let colaborador: ActorAdjudicacion;
let ajeno: ActorAdjudicacion;
let token: string;
/** cotizacionId por proveedor, en el orden en que se cargan. */
let cotA: string;
let cotB: string;
let cotC: string;
let obraAjenaId: string;
let compulsaAjenaId: string;
/** Otra obra del MISMO estudio: el control de que la compulsa sea de esta obra. */
let compulsaOtraObraId: string;

/**
 * Tres corralones cotizaron el mismo pedido: 100, 110 y 120.
 *
 * Los datos se cargan directo en la base en vez de correr el pipeline y el
 * flujo de P5 completo: lo que se prueba acá es la adjudicación, y armar la
 * compulsa con tres cotizaciones conciliadas por el camino largo tardaría
 * medio minuto por test sin proteger nada de esta tarea.
 */
async function sembrar(): Promise<void> {
  const [norte, sur] = await db
    .insert(estudios)
    .values([{ nombre: 'Estudio Norte' }, { nombre: 'Estudio Sur' }])
    .returning();
  estudioId = norte.id;

  const [ana, beto, ajena] = await db
    .insert(usuarios)
    .values([
      { estudioId: norte.id, email: 'ana@norte.ar', nombre: 'Ana', passwordHash: 'x', rol: 'titular' },
      { estudioId: norte.id, email: 'beto@norte.ar', nombre: 'Beto', passwordHash: 'x', rol: 'colaborador' },
      { estudioId: sur.id, email: 'sur@sur.ar', nombre: 'Sur', passwordHash: 'x', rol: 'titular' },
    ])
    .returning();

  titular = { usuarioId: ana.id, email: ana.email, rol: 'titular', activo: true, estudioId: norte.id };
  colaborador = {
    usuarioId: beto.id,
    email: beto.email,
    rol: 'colaborador',
    activo: true,
    estudioId: norte.id,
  };
  ajeno = { usuarioId: ajena.id, email: ajena.email, rol: 'titular', activo: true, estudioId: sur.id };
  token = (await crearSesion(db, ana.id)).token;

  const [obra, otraObra, obraAjena] = await db
    .insert(obras)
    .values([
      { estudioId: norte.id, nombre: 'Casa Demo', zona: ZONA, tipo: 'nueva' },
      { estudioId: norte.id, nombre: 'Otra del estudio', zona: ZONA, tipo: 'reforma' },
      { estudioId: sur.id, nombre: 'Ajena', zona: 'CABA', tipo: 'nueva' },
    ])
    .returning();
  obraId = obra.id;
  obraAjenaId = obraAjena.id;

  const [corralon, ferreteria, maderera, ajenoProv] = await db
    .insert(proveedores)
    .values([
      { estudioId: norte.id, nombre: 'Corralón San Martín', rubros: ['seco'], zona: ZONA, origen: 'manual' },
      { estudioId: norte.id, nombre: 'Ferretería del Centro', rubros: ['seco'], zona: ZONA, origen: 'manual' },
      { estudioId: norte.id, nombre: 'Maderera Norte', rubros: ['seco'], zona: ZONA, origen: 'manual' },
      { estudioId: sur.id, nombre: 'Corralón del Sur', rubros: ['seco'], zona: 'CABA', origen: 'manual' },
    ])
    .returning();

  const [compulsa, compulsaOtraObra, compulsaAjena] = await db
    .insert(compulsas)
    .values([
      {
        obraId: obra.id,
        rubro: 'seco',
        estado: 'lanzada',
        snapshotHash: 'hash-demo',
        itemsJson: ITEMS,
        condicionesJson: CONDICIONES_RFQ_DEFAULT,
        mandatoJson: MANDATO_DEFAULT,
        version: 1,
      },
      {
        obraId: otraObra.id,
        rubro: 'pintura',
        estado: 'lanzada',
        snapshotHash: 'hash-otra',
        itemsJson: ITEMS,
        condicionesJson: CONDICIONES_RFQ_DEFAULT,
        version: 1,
      },
      {
        obraId: obraAjena.id,
        rubro: 'seco',
        estado: 'lanzada',
        snapshotHash: 'hash-ajeno',
        itemsJson: ITEMS,
        condicionesJson: CONDICIONES_RFQ_DEFAULT,
        version: 1,
      },
    ])
    .returning();
  compulsaId = compulsa.id;
  compulsaOtraObraId = compulsaOtraObra.id;
  compulsaAjenaId = compulsaAjena.id;

  const contactosValues = [corralon, ferreteria, maderera].map((proveedor) => ({
    compulsaId: compulsa.id,
    proveedorId: proveedor.id,
    canal: 'manual' as const,
    estado: 'cotizo' as const,
  }));
  const contactos = await db.insert(contactosCompulsa).values(contactosValues).returning();
  await db.insert(contactosCompulsa).values({
    compulsaId: compulsaAjena.id,
    proveedorId: ajenoProv.id,
    canal: 'manual',
    estado: 'cotizo',
  });

  // Unitarios 5 y 2,5 ⇒ 5×10 + 2,5×20 = 100. Idem para 110 y 120.
  const precios: ReadonlyArray<readonly [number, number, number]> = [
    [5, 2.5, 100],
    [5.5, 2.75, 110],
    [6, 3, 120],
  ];

  const ids: string[] = [];
  for (const [i, contacto] of contactos.entries()) {
    const [placa, montante, total] = precios[i];
    const [cotizacion] = await db
      .insert(cotizaciones)
      .values({
        contactoId: contacto.id,
        moneda: 'ARS',
        incluyeIva: false,
        validezDias: 15,
        plazoDias: 10 + i * 5,
        formaPago: '50% con la orden, 50% contra entrega',
        total,
        lineasJson: [
          {
            descripcion: 'Placa de roca de yeso 12,5 mm',
            unidad: 'm2',
            cantidad: 10,
            precioUnitario: placa,
            precioTotal: null,
            claveItemSugerida: null,
            notas: null,
          },
          {
            descripcion: 'Montante 70 mm para tabique de durlock',
            unidad: 'ml',
            cantidad: 20,
            precioUnitario: montante,
            precioTotal: null,
            claveItemSugerida: null,
            notas: null,
          },
        ],
        scoreFidelidad: 1,
        estado: 'conciliada',
        // Una hora de diferencia entre cotizaciones: el orden de las columnas
        // es el de llegada, y con el mismo `created_at` desempataría el uuid.
        createdAt: new Date(Date.UTC(2026, 7, 24, 12 + i)),
      })
      .returning();
    ids.push(cotizacion.id);

    await db.insert(conciliacionItems).values([
      {
        cotizacionId: cotizacion.id,
        claveItem: 'seco.placas',
        lineaIdx: 0,
        match: 'exacto',
        nota: 'La línea cotizada coincide con el ítem pedido.',
      },
      {
        cotizacionId: cotizacion.id,
        claveItem: 'seco.montantes',
        lineaIdx: 1,
        match: 'exacto',
        nota: 'La línea cotizada coincide con el ítem pedido.',
      },
    ]);
  }
  [cotA, cotB, cotC] = ids;

  // El corralón bajó de 105 a 100 en la ronda 1 y la aceptó: son 5 de mejora.
  await db.insert(negociaciones).values({
    cotizacionId: cotA,
    ronda: 1,
    ofertaJson: { totalCotizado: 105, objetivoTotal: 100, moneda: 'ARS' },
    resultado: 'aceptada',
  });

  // Índice del estudio: 4 muestras del mes corriente para las placas.
  await db.insert(priceIndex).values({
    estudioId: norte.id,
    claveItem: 'seco.placas',
    zona: ZONA,
    mes: '2026-08',
    p25: 4.5,
    p50: 5.5,
    p75: 5.8,
    n: 4,
    muestrasJson: [4.5, 5.5, 5.8, 6.5],
  });
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  cookieActual = undefined;
  await sembrar();
});

const deps = { ahora: () => AHORA };

function adjudicar(actor: ActorAdjudicacion = titular, cotizacionId: string = cotA) {
  return adjudicarCompulsa(db, actor, { cotizacionId }, deps);
}

// ---------------------------------------------------------------------------
// El cuadro leído de la base
// ---------------------------------------------------------------------------

describe('leerComparativa', () => {
  it('arma el cuadro con las tres columnas y el ranking', async () => {
    const datos = await leerComparativa(db, estudioId, compulsaId, { ahora: AHORA });

    expect(datos.comparativa.columnas.map((c) => c.proveedorNombre)).toEqual([
      'Corralón San Martín',
      'Ferretería del Centro',
      'Maderera Norte',
    ]);
    expect(datos.comparativa.columnas.map((c) => c.totalComparable)).toEqual([100, 110, 120]);
    // Mismo score y precio más bajo con el plazo más corto: gana el corralón.
    expect(datos.ranking[0].id).toBe(cotA);
    expect(datos.ranking[0].puntaje).toBe(1);
  });

  it('trae el benchmark del índice del estudio', async () => {
    const datos = await leerComparativa(db, estudioId, compulsaId, { ahora: AHORA });
    const placas = datos.comparativa.filas[0];

    // p50 = 5,5 y p75 = 5,8: el corralón cotiza 5 (verde) y la maderera 6 (rojo).
    expect(placas.celdas[0].benchmark).toBe('verde');
    expect(placas.celdas[1].benchmark).toBe('verde');
    expect(placas.celdas[2].benchmark).toBe('rojo');
    expect(placas.celdas[0].indice).toEqual({ p50: 5.5, p75: 5.8, n: 4, mes: '2026-08' });
  });

  it('una compulsa de otro estudio no existe (RNF-4)', async () => {
    await expect(leerComparativa(db, estudioId, compulsaAjenaId)).rejects.toBeInstanceOf(
      CompulsaNoEncontradaError,
    );
  });
});

// ---------------------------------------------------------------------------
// Adjudicar
// ---------------------------------------------------------------------------

describe('adjudicarCompulsa: lo que queda escrito', () => {
  it('crea la adjudicación con su orden de compra', async () => {
    const resultado = await adjudicar();

    const [fila] = await db
      .select()
      .from(adjudicaciones)
      .where(eq(adjudicaciones.compulsaId, compulsaId));

    expect(fila.cotizacionId).toBe(cotA);
    expect(fila.confirmadoAt).not.toBeNull();
    expect(fila.ocTexto).toContain('ORDEN DE COMPRA');
    expect(fila.ocTexto).toContain('Corralón San Martín');
    expect(fila.ocTexto).toContain('Casa Demo');
    expect(fila.ocTexto).toContain('TOTAL: $ 100');
    expect(resultado.ordenCompra).toBe(fila.ocTexto);
  });

  it('la orden de compra lleva los ítems con las cantidades del pedido', async () => {
    const { ordenCompra } = await adjudicar();

    expect(ordenCompra).toContain('1. 10 m² — Placa de roca de yeso 12,5 mm');
    expect(ordenCompra).toContain('Precio unitario: $ 5 — Importe: $ 50');
    expect(ordenCompra).toContain('2. 20 ml — Montante 70 mm para tabique de durlock');
  });

  it('deja la compulsa adjudicada y cierra los contactos', async () => {
    await adjudicar();

    const [compulsa] = await db.select().from(compulsas).where(eq(compulsas.id, compulsaId));
    expect(compulsa.estado).toBe('adjudicada');

    const contactos = await db
      .select()
      .from(contactosCompulsa)
      .where(eq(contactosCompulsa.compulsaId, compulsaId));
    expect(contactos.every((c) => c.estado === 'cerrado')).toBe(true);
  });

  it('audita la adjudicación con el ahorro que dio en ese momento', async () => {
    await adjudicar();

    const [fila] = await db
      .select()
      .from(auditoria)
      .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, 'compulsa_adjudicada')));

    expect(fila.actorNombre).toBe('ana@norte.ar');
    expect(fila.diffJson).toMatchObject({
      cotizacionId: cotA,
      proveedor: 'Corralón San Martín',
      totalAdjudicado: 100,
      ahorro: 15,
    });
  });

  it('avisa al estudio con una notificación que linkea a la comparativa', async () => {
    await adjudicar();

    const avisos = await db.select().from(notificaciones);

    expect(avisos).toHaveLength(2); // titular y colaborador; el ajeno no.
    expect(avisos[0].titulo).toContain('adjudicada');
    expect(avisos[0].cuerpo).toContain('Corralón San Martín');
    expect(avisos[0].link).toBe(`/obras/${obraId}/comparativa?compulsa=${compulsaId}`);
  });

  it('devuelve el resumen del ahorro que acaba de calcular', async () => {
    const resultado = await adjudicar();

    expect(resultado.ahorro).toEqual({
      totalesComparables: [100, 110, 120],
      totalAdjudicado: 100,
      mejoras: [5],
      ahorro: 15,
    });
  });
});

describe('adjudicarCompulsa: lo que no deja pasar', () => {
  it('un colaborador no adjudica (RF-1201)', async () => {
    await expect(adjudicar(colaborador)).rejects.toBeInstanceOf(RolInsuficienteError);

    const filas = await db.select().from(adjudicaciones);
    expect(filas).toHaveLength(0);
  });

  it('un usuario de otro estudio no ve la cotización (RNF-4)', async () => {
    await expect(adjudicar(ajeno)).rejects.toThrow(/no encontré/i);
  });

  it('un usuario desactivado no adjudica aunque sea titular', async () => {
    await expect(adjudicar({ ...titular, activo: false })).rejects.toThrow(/desactivado/i);
  });

  it('una compulsa ya adjudicada no se vuelve a adjudicar', async () => {
    await adjudicar();

    await expect(adjudicar(titular, cotB)).rejects.toBeInstanceOf(CompulsaYaAdjudicadaError);

    const filas = await db.select().from(adjudicaciones);
    expect(filas).toHaveLength(1);
    expect(filas[0].cotizacionId).toBe(cotA);
  });

  it('sin total declarado pide que lo carguen, no adjudica a ciegas', async () => {
    await db.update(cotizaciones).set({ total: null }).where(eq(cotizaciones.id, cotA));

    await expect(adjudicar()).rejects.toBeInstanceOf(AdjudicacionSinTotalError);
  });

  it('con el total cargado a mano adjudica y lo deja escrito en la cotización', async () => {
    await db.update(cotizaciones).set({ total: null }).where(eq(cotizaciones.id, cotA));

    await adjudicarCompulsa(db, titular, { cotizacionId: cotA, total: 100 }, deps);

    const [fila] = await db.select().from(cotizaciones).where(eq(cotizaciones.id, cotA));
    expect(fila.total).toBe(100);
  });

  it('una cotización sin conciliar no se puede adjudicar: no hay qué comprar', async () => {
    await db.update(cotizaciones).set({ estado: 'recibida' }).where(eq(cotizaciones.id, cotA));

    await expect(adjudicar()).rejects.toThrow(/concili/i);
  });
});

// ---------------------------------------------------------------------------
// Ahorro (RF-1104) — el pin
// ---------------------------------------------------------------------------

describe('ahorro: (mediana − adjudicado) + mejoras aceptadas', () => {
  it('con [100, 110, 120], adjudicado 100 tras negociar de 105, da 15', async () => {
    await adjudicar();

    expect(await ahorroDeCompulsa(db, compulsaId)).toEqual({
      totalesComparables: [100, 110, 120],
      totalAdjudicado: 100,
      mejoras: [5],
      ahorro: 15,
    });
  });

  it('sin adjudicar todavía no hay ahorro que contar', async () => {
    expect(await ahorroDeCompulsa(db, compulsaId)).toBeNull();
  });

  it('una negociación no aceptada no suma mejora', async () => {
    await db.update(negociaciones).set({ resultado: 'pendiente' });
    await adjudicar();

    const ahorro = await ahorroDeCompulsa(db, compulsaId);
    expect(ahorro?.mejoras).toEqual([]);
    expect(ahorro?.ahorro).toBe(10);
  });

  it('el tablero de la obra acumula el ahorro de las compulsas adjudicadas', async () => {
    await adjudicar();

    const resumen = await resumenCompulsasObra(db, obraId);

    expect(resumen).toEqual({
      total: 1,
      enCurso: 0,
      adjudicadas: 1,
      cotizaciones: 3,
      ahorro: 15,
    });
  });

  it('sin adjudicar, el tablero muestra la compulsa en curso y ahorro cero', async () => {
    const resumen = await resumenCompulsasObra(db, obraId);

    expect(resumen.enCurso).toBe(1);
    expect(resumen.adjudicadas).toBe(0);
    expect(resumen.cotizaciones).toBe(3);
    expect(resumen.ahorro).toBe(0);
  });

  it('no cuenta las compulsas ni las cotizaciones de otra obra', async () => {
    const resumen = await resumenCompulsasObra(db, obraAjenaId);

    expect(resumen.total).toBe(1);
    expect(resumen.cotizaciones).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cerrar la ronda de negociación (RF-1003) — el pin del ahorro, sin atajos
// ---------------------------------------------------------------------------

/**
 * Deja la compulsa como estaba **antes** de negociar: el corralón todavía pide
 * 105 y no hay ninguna ronda escrita. El `sembrar()` mete la fila de
 * `negociaciones` ya `aceptada` a mano, que es exactamente lo que este bloque
 * no quiere: acá la mejora tiene que salir del camino real.
 */
async function antesDeNegociar(): Promise<void> {
  await db.delete(negociaciones);
  await db.update(cotizaciones).set({ total: 105 }).where(eq(cotizaciones.id, cotA));
}

/** La ronda 1 propuesta por el motor, sin insertar la fila a mano. */
async function proponerRonda1(): Promise<string> {
  const propuesta = await proponerNegociacion(db, colaborador, cotA);
  if (!propuesta.procede) {
    throw new Error(`El motor escaló la ronda del test: ${propuesta.motivo}`);
  }
  return propuesta.negociacion.id;
}

describe('resolverNegociacion: la ronda deja de nacer y morir en «pendiente»', () => {
  beforeEach(antesDeNegociar);

  it('el ahorro sale del camino real: 105 → 100 negociado da los mismos 15', async () => {
    // El pin de RF-1104, esta vez sin ninguna fila puesta a dedo: el motor
    // propone, una persona dice que el proveedor aceptó y carga el número
    // nuevo, y recién ahí el término «mejoras aceptadas» tiene de dónde salir.
    const negociacionId = await proponerRonda1();

    const cierre = await resolverNegociacion(db, colaborador, negociacionId, {
      resultado: 'aceptada',
      nuevoTotal: 100,
      nota: 'Cerró en 100 si adjudicamos esta semana.',
    });

    expect(cierre.totalAnterior).toBe(105);
    expect(cierre.totalNuevo).toBe(100);
    expect(cierre.mejora).toBe(5);
    expect(cierre.negociacion.resultado).toBe('aceptada');
    expect(cierre.cotizacion.total).toBe(100);

    await adjudicar();

    expect(await ahorroDeCompulsa(db, compulsaId)).toEqual({
      totalesComparables: [100, 110, 120],
      totalAdjudicado: 100,
      mejoras: [5],
      ahorro: 15,
    });
  });

  it('el contacto vuelve a «cotizó»: no queda clavado en «negociando»', async () => {
    const negociacionId = await proponerRonda1();

    const [enNegociacion] = await db
      .select()
      .from(contactosCompulsa)
      .innerJoin(cotizaciones, eq(cotizaciones.contactoId, contactosCompulsa.id))
      .where(eq(cotizaciones.id, cotA));
    expect(enNegociacion.contactos_compulsa.estado).toBe('negociando');

    await resolverNegociacion(db, colaborador, negociacionId, {
      resultado: 'rechazada',
    });

    const [despues] = await db
      .select()
      .from(contactosCompulsa)
      .innerJoin(cotizaciones, eq(cotizaciones.contactoId, contactosCompulsa.id))
      .where(eq(cotizaciones.id, cotA));
    expect(despues.contactos_compulsa.estado).toBe('cotizo');
  });

  it('rechazada no toca el total y no suma mejora', async () => {
    const negociacionId = await proponerRonda1();

    const cierre = await resolverNegociacion(db, colaborador, negociacionId, {
      resultado: 'rechazada',
      nota: 'No baja de 105.',
    });

    expect(cierre.totalAnterior).toBe(105);
    expect(cierre.totalNuevo).toBe(105);
    expect(cierre.mejora).toBe(0);
    expect(cierre.cotizacion.total).toBe(105);

    await adjudicar();
    const ahorro = await ahorroDeCompulsa(db, compulsaId);
    // Adjudicado 105 con mediana 110 y sin mejora: 5, no 15.
    expect(ahorro?.mejoras).toEqual([]);
    expect(ahorro?.ahorro).toBe(5);
  });

  it('deja el rastro con el antes, el después y la mejora', async () => {
    const negociacionId = await proponerRonda1();
    await resolverNegociacion(db, colaborador, negociacionId, {
      resultado: 'aceptada',
      nuevoTotal: 100,
    });

    const [fila] = await db
      .select()
      .from(auditoria)
      .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, 'negociacion_resuelta')));

    expect(fila.actorNombre).toBe('beto@norte.ar');
    expect(fila.targetRef).toBe(`negociaciones:${negociacionId}`);
    expect(fila.diffJson).toMatchObject({
      cotizacionId: cotA,
      proveedor: 'Corralón San Martín',
      ronda: 1,
      resultado: 'aceptada',
      total: { antes: 105, despues: 100 },
      mejora: 5,
    });

    const [ronda] = await db.select().from(negociaciones).where(eq(negociaciones.id, negociacionId));
    expect(ronda.logJson).toMatchObject({ cerradaPor: 'beto@norte.ar', totalNuevo: 100 });
    // El log de la propuesta no se pisa: el comparable con el que se decidió
    // sigue ahí (es lo que hace auditable la contraoferta).
    expect(ronda.logJson).toMatchObject({ mejorTotalComparable: 105 });
  });

  it('aceptada sin total nuevo no se puede: una mejora sin número no es una mejora', async () => {
    const negociacionId = await proponerRonda1();

    await expect(
      resolverNegociacion(db, colaborador, negociacionId, { resultado: 'aceptada' }),
    ).rejects.toBeInstanceOf(NegociacionImposibleError);

    // Y un importe imposible tampoco entra: no se clampea, se rechaza.
    await expect(
      resolverNegociacion(db, colaborador, negociacionId, { resultado: 'aceptada', nuevoTotal: 0 }),
    ).rejects.toBeInstanceOf(RangeError);

    const [ronda] = await db.select().from(negociaciones).where(eq(negociaciones.id, negociacionId));
    expect(ronda.resultado).toBe('pendiente');
  });

  it('una ronda se resuelve una sola vez', async () => {
    const negociacionId = await proponerRonda1();
    await resolverNegociacion(db, colaborador, negociacionId, {
      resultado: 'aceptada',
      nuevoTotal: 100,
    });

    await expect(
      resolverNegociacion(db, colaborador, negociacionId, {
        resultado: 'aceptada',
        nuevoTotal: 90,
      }),
    ).rejects.toBeInstanceOf(NegociacionYaResueltaError);

    const [cotizacion] = await db.select().from(cotizaciones).where(eq(cotizaciones.id, cotA));
    expect(cotizacion.total).toBe(100);
  });

  it('con rol de lectura no se cierra nada (RF-1201) y una ronda ajena no existe (RNF-4)', async () => {
    const negociacionId = await proponerRonda1();
    const lector = { ...colaborador, rol: 'lectura' as const };

    await expect(
      resolverNegociacion(db, lector, negociacionId, { resultado: 'rechazada' }),
    ).rejects.toBeInstanceOf(RolInsuficienteEnFlujo);

    await expect(
      resolverNegociacion(db, ajeno, negociacionId, { resultado: 'rechazada' }),
    ).rejects.toBeInstanceOf(NegociacionNoEncontradaError);

    const [ronda] = await db.select().from(negociaciones).where(eq(negociaciones.id, negociacionId));
    expect(ronda.resultado).toBe('pendiente');
  });
});

// ---------------------------------------------------------------------------
// Después de adjudicar no se toca nada: el ahorro se recalcula al leer
// ---------------------------------------------------------------------------

/**
 * El ahorro (RF-1104) no está guardado en ninguna tabla: `ahorroDeCompulsa` lo
 * recalcula desde `cotizaciones.total` en vivo y las rondas `aceptada`. Eso
 * está bien mientras la compulsa esté en juego y es una trampa apenas se
 * adjudica, porque cualquier escritura posterior mueve un número que ya se
 * firmó, se auditó y se le mostró al comitente.
 *
 * Ninguno de los dos casos necesita una carrera ni un payload malicioso:
 * alcanza con adjudicar con una ronda abierta y que alguien después apriete el
 * botón que la pantalla seguía mostrando.
 */
describe('una compulsa adjudicada no se toca más', () => {
  beforeEach(antesDeNegociar);

  it('resolver una ronda que quedó pendiente al adjudicar se rechaza y no mueve el ahorro', async () => {
    // El titular adjudica con la ronda 1 todavía sin respuesta. Eso está
    // permitido a propósito (ver `exigirCompulsaEnJuego`): el ahorro sale corto,
    // que es el lado seguro. Lo que no se permite es arreglarlo después.
    const negociacionId = await proponerRonda1();
    await adjudicar();

    const ahorroFirmado = await ahorroDeCompulsa(db, compulsaId);
    // Mediana de [105, 110, 120] = 110, adjudicado 105, ronda sin resolver ⇒ 5.
    expect(ahorroFirmado).toMatchObject({ totalAdjudicado: 105, mejoras: [], ahorro: 5 });

    await expect(
      resolverNegociacion(db, colaborador, negociacionId, {
        resultado: 'aceptada',
        nuevoTotal: 100,
      }),
    ).rejects.toBeInstanceOf(EstadoContactoInvalidoError);

    // Nada se movió: ni el total de la ganadora, ni la ronda, ni el ahorro.
    const [cotizacion] = await db.select().from(cotizaciones).where(eq(cotizaciones.id, cotA));
    expect(cotizacion.total).toBe(105);
    const [ronda] = await db.select().from(negociaciones).where(eq(negociaciones.id, negociacionId));
    expect(ronda.resultado).toBe('pendiente');
    expect(await ahorroDeCompulsa(db, compulsaId)).toEqual(ahorroFirmado);
  });

  it('descartar la cotización adjudicada se rechaza: dejaría la compulsa sin ganadora', async () => {
    await adjudicar();

    const antes = await ahorroDeCompulsa(db, compulsaId);
    const columnasAntes = (await leerComparativa(db, estudioId, compulsaId, { ahora: AHORA }))
      .comparativa.columnas.length;

    await expect(
      descartarCotizacion(db, colaborador, cotA, 'Me arrepentí.'),
    ).rejects.toBeInstanceOf(EstadoContactoInvalidoError);

    const [cotizacion] = await db.select().from(cotizaciones).where(eq(cotizaciones.id, cotA));
    expect(cotizacion.estado).toBe('conciliada');
    expect(await ahorroDeCompulsa(db, compulsaId)).toEqual(antes);
    expect(
      (await leerComparativa(db, estudioId, compulsaId, { ahora: AHORA })).comparativa.columnas,
    ).toHaveLength(columnasAntes);
  });

  it('tampoco se toca una cotización perdedora: la comparativa adjudicada es el documento', async () => {
    await adjudicar();

    await expect(
      descartarCotizacion(db, colaborador, cotC, 'Estaba carísima.'),
    ).rejects.toBeInstanceOf(EstadoContactoInvalidoError);
  });

  it('el camino normal —resolver ANTES de adjudicar— sigue dando 15', async () => {
    // El pin de siempre, para que el guard no haya cerrado la puerta buena.
    const negociacionId = await proponerRonda1();
    await resolverNegociacion(db, colaborador, negociacionId, {
      resultado: 'aceptada',
      nuevoTotal: 100,
    });
    await adjudicar();

    expect(await ahorroDeCompulsa(db, compulsaId)).toEqual({
      totalesComparables: [100, 110, 120],
      totalAdjudicado: 100,
      mejoras: [5],
      ahorro: 15,
    });
  });

  it('con el contacto cerrado a mano tampoco, aunque la compulsa siga abierta', async () => {
    // `adjudicarCompulsa` cierra los contactos, pero también se cierran desde la
    // conversación. El guard mira las dos cosas.
    const negociacionId = await proponerRonda1();
    await db
      .update(contactosCompulsa)
      .set({ estado: 'cerrado' })
      .where(
        inArray(
          contactosCompulsa.id,
          db.select({ id: cotizaciones.contactoId }).from(cotizaciones).where(eq(cotizaciones.id, cotA)),
        ),
      );

    await expect(
      resolverNegociacion(db, colaborador, negociacionId, { resultado: 'rechazada' }),
    ).rejects.toBeInstanceOf(EstadoContactoInvalidoError);
    await expect(
      descartarCotizacion(db, colaborador, cotA, 'Recotizó.'),
    ).rejects.toBeInstanceOf(EstadoContactoInvalidoError);

    const [compulsa] = await db.select().from(compulsas).where(eq(compulsas.id, compulsaId));
    expect(compulsa.estado).toBe('lanzada'); // no hizo falta adjudicar para bloquear
  });
});

// ---------------------------------------------------------------------------
// Descartar una cotización (`estado = 'descartada'`, el estado inalcanzable)
// ---------------------------------------------------------------------------

describe('descartarCotizacion: sacar una columna sin borrarla', () => {
  it('la saca de la comparativa, del ranking y de la mediana del ahorro', async () => {
    await descartarCotizacion(db, colaborador, cotC, 'Mandó un presupuesto corregido.');

    const datos = await leerComparativa(db, estudioId, compulsaId, { ahora: AHORA });
    expect(datos.comparativa.columnas.map((c) => c.proveedorNombre)).toEqual([
      'Corralón San Martín',
      'Ferretería del Centro',
    ]);
    expect(datos.ranking.map((p) => p.id)).toEqual([cotA, cotB]);

    // Y el ahorro se mide contra dos ofertas, no tres: mediana de [100, 110]
    // nearest-rank = 100 ⇒ 100 − 100 + 5 de la mejora.
    await adjudicar();
    expect(await ahorroDeCompulsa(db, compulsaId)).toEqual({
      totalesComparables: [100, 110],
      totalAdjudicado: 100,
      mejoras: [5],
      ahorro: 5,
    });
  });

  it('la fila sigue existiendo y el motivo queda en la auditoría', async () => {
    await descartarCotizacion(db, colaborador, cotC, '  Recotizó más barato.  ');

    const [fila] = await db.select().from(cotizaciones).where(eq(cotizaciones.id, cotC));
    expect(fila.estado).toBe('descartada');
    expect(fila.total).toBe(120); // no se toca nada más

    const [rastro] = await db
      .select()
      .from(auditoria)
      .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, 'cotizacion_descartada')));
    expect(rastro.targetRef).toBe(`cotizaciones:${cotC}`);
    expect(rastro.diffJson).toMatchObject({
      proveedor: 'Maderera Norte',
      estado: { antes: 'conciliada', despues: 'descartada' },
      motivo: 'Recotizó más barato.',
    });
  });

  it('el tablero deja de contarla como cotización recibida', async () => {
    expect((await resumenCompulsasObra(db, obraId)).cotizaciones).toBe(3);

    await descartarCotizacion(db, colaborador, cotC, 'Duplicada.');

    expect((await resumenCompulsasObra(db, obraId)).cotizaciones).toBe(2);
  });

  it('sin motivo no se descarta: una columna que desaparece tiene que poder explicarse', async () => {
    await expect(descartarCotizacion(db, colaborador, cotC, '   ')).rejects.toBeInstanceOf(
      RangeError,
    );

    const [fila] = await db.select().from(cotizaciones).where(eq(cotizaciones.id, cotC));
    expect(fila.estado).toBe('conciliada');
  });

  it('no se descarta dos veces', async () => {
    await descartarCotizacion(db, colaborador, cotC, 'Duplicada.');

    await expect(
      descartarCotizacion(db, colaborador, cotC, 'Otra vez.'),
    ).rejects.toBeInstanceOf(CotizacionYaDescartadaError);
  });

  it('con rol de lectura no se descarta (RF-1201) y una ajena no existe (RNF-4)', async () => {
    const lector = { ...colaborador, rol: 'lectura' as const };

    await expect(descartarCotizacion(db, lector, cotC, 'Duplicada.')).rejects.toBeInstanceOf(
      RolInsuficienteEnFlujo,
    );
    await expect(descartarCotizacion(db, ajeno, cotC, 'Duplicada.')).rejects.toBeInstanceOf(
      CotizacionNoEncontradaError,
    );

    const [fila] = await db.select().from(cotizaciones).where(eq(cotizaciones.id, cotC));
    expect(fila.estado).toBe('conciliada');
  });
});

// ---------------------------------------------------------------------------
// Ahorro acumulado del estudio (la card de /estudio)
// ---------------------------------------------------------------------------

describe('ahorro acumulado por estudio', () => {
  it('sin nada adjudicado no hay cifra: la pantalla muestra un guion', async () => {
    expect(await ahorroDelEstudio(db, estudioId)).toEqual({
      adjudicadas: 0,
      obras: 0,
      porMoneda: [],
    });
  });

  it('acumula el ahorro de todas las obras del estudio', async () => {
    await adjudicar();

    expect(await ahorroDelEstudio(db, estudioId)).toEqual({
      adjudicadas: 1,
      obras: 1,
      porMoneda: [{ moneda: 'ARS', ahorro: 15, adjudicadas: 1 }],
    });
  });

  it('el estudio de al lado no ve nada de este (RNF-4)', async () => {
    await adjudicar();

    const [sur] = await db.select().from(estudios).where(eq(estudios.nombre, 'Estudio Sur'));
    expect((await ahorroDelEstudio(db, sur.id)).porMoneda).toEqual([]);
  });

  it('pesos y dólares se muestran aparte: no hay tipo de cambio que inventar', async () => {
    await adjudicar();
    // La misma compulsa, mirada desde una obra en dólares: el acumulado tiene
    // que abrir en dos cifras y no sumar 15 + 15.
    await db.update(obras).set({ moneda: 'USD' }).where(eq(obras.id, obraId));

    expect((await ahorroDelEstudio(db, estudioId)).porMoneda).toEqual([
      { moneda: 'USD', ahorro: 15, adjudicadas: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// El reporte XLSX
// ---------------------------------------------------------------------------

function pedirReporte(obra = obraId, compulsa = compulsaId): Promise<Response> {
  return GET(new Request(`http://localhost/api/obras/${obra}/compulsas/${compulsa}/reporte`), {
    params: Promise.resolve({ obraId: obra, compulsaId: compulsa }),
  });
}

async function libroDe(res: Response): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
  return wb;
}

describe('GET .../compulsas/[compulsaId]/reporte', () => {
  it('sin sesión responde 401', async () => {
    expect((await pedirReporte()).status).toBe(401);
  });

  it('con una compulsa de otro estudio responde 404 (RNF-4)', async () => {
    cookieActual = token;

    expect((await pedirReporte(obraAjenaId, compulsaAjenaId)).status).toBe(404);
  });

  it('con una compulsa del estudio pero de OTRA obra responde 404', async () => {
    cookieActual = token;

    expect((await pedirReporte(obraId, compulsaOtraObraId)).status).toBe(404);
  });

  it('baja como xlsx con el nombre compulsa-<obra>-<rubro>-v<version>-<fecha>', async () => {
    cookieActual = token;

    const res = await pedirReporte();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="compulsa-casa-demo-seco-v1-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('trae la hoja Comparativa, una por cotización y la de condiciones', async () => {
    cookieActual = token;

    const wb = await libroDe(await pedirReporte());

    expect(wb.worksheets.map((h) => h.name)).toEqual([
      'Comparativa',
      'Corralón San Martín',
      'Ferretería del Centro',
      'Maderera Norte',
      'Condiciones',
    ]);
  });

  it('la hoja Comparativa tiene el cuadro con los números como números', async () => {
    cookieActual = token;

    const hoja = (await libroDe(await pedirReporte())).getWorksheet('Comparativa')!;

    expect(hoja.getCell('A1').value).toBe('Clave');
    expect(hoja.getCell('E1').value).toBe('Corralón San Martín');
    expect(hoja.getCell('A2').value).toBe('seco.placas');
    expect(hoja.getCell('D2').value).toBe(10);
    expect(hoja.getCell('E2').value).toBe(50);
    expect(hoja.getCell('F2').value).toBe(55);
    expect(hoja.getCell('G2').value).toBe(60);
    // Segunda fila del cuadro: los montantes.
    expect(hoja.getCell('E3').value).toBe(50);
  });

  it('la hoja Comparativa cierra con los totales y el puntaje del ranking', async () => {
    cookieActual = token;

    const hoja = (await libroDe(await pedirReporte())).getWorksheet('Comparativa')!;
    const filas: Record<string, unknown[]> = {};
    hoja.eachRow((row) => {
      const etiqueta = row.getCell(1).value;
      if (typeof etiqueta === 'string') filas[etiqueta] = [row.getCell(5).value, row.getCell(6).value];
    });

    expect(filas['Total comparable']).toEqual([100, 110]);
    expect(filas['Total declarado']).toEqual([100, 110]);
    // B: 0,5×(100/110) + 0,3×1 + 0,2×(10/15) = 0,8879.
    expect(filas['Puntaje']).toEqual([1, 0.8879]);
  });

  it('un ítem no cotizado sale "—" y no rompe la columna', async () => {
    cookieActual = token;
    await db
      .delete(conciliacionItems)
      .where(
        and(eq(conciliacionItems.cotizacionId, cotC), eq(conciliacionItems.claveItem, 'seco.placas')),
      );

    const hoja = (await libroDe(await pedirReporte())).getWorksheet('Comparativa')!;

    expect(hoja.getCell('G2').value).toBe('—');
  });

  it('una sustitución sale con su texto y en rojo, distinta de un no cotizado (PRD §12)', async () => {
    cookieActual = token;
    // Maderera Norte cambió la placa: mismo lugar del cuadro que un
    // `no_cotizado`, pero no es lo mismo y el XLSX tiene que decirlo.
    await db
      .update(conciliacionItems)
      .set({ match: 'sustituto', nota: 'Cotizó placa de yeso común donde el pedido pide durlock.' })
      .where(
        and(eq(conciliacionItems.cotizacionId, cotC), eq(conciliacionItems.claveItem, 'seco.placas')),
      );
    // Y Ferretería del Centro directamente no cotizó ese ítem: las dos celdas
    // están en la misma fila, así que el contraste se ve en el mismo test.
    await db
      .delete(conciliacionItems)
      .where(
        and(eq(conciliacionItems.cotizacionId, cotB), eq(conciliacionItems.claveItem, 'seco.placas')),
      );

    const hoja = (await libroDe(await pedirReporte())).getWorksheet('Comparativa')!;

    expect(hoja.getCell('F2').value).toBe('—'); // el que no cotizó
    expect(hoja.getCell('G2').value).toBe('SUSTITUCIÓN'); // el que cambió la spec
    expect(hoja.getCell('G2').font?.color?.argb).toBe('FFB91C1C');
    expect(hoja.getCell('G2').font?.bold).toBe(true);
    // El "—" queda con la fuente por defecto: si los dos fueran rojos, el
    // color dejaría de significar algo.
    expect(hoja.getCell('F2').font?.color?.argb).toBeUndefined();
    // Y el motivo sigue en la nota, como en todas las celdas.
    expect(String(hoja.getCell('G2').note)).toContain('placa de yeso común');

    const filas: Record<string, unknown[]> = {};
    hoja.eachRow((row) => {
      const etiqueta = row.getCell(1).value;
      if (typeof etiqueta === 'string') {
        filas[etiqueta] = [row.getCell(5).value, row.getCell(6).value, row.getCell(7).value];
      }
    });
    expect(filas['Sustituciones de especificación']).toEqual([0, 0, 1]);

    // La hoja del proveedor la repite en su lista de lo que no entró al total.
    const suya = (await libroDe(await pedirReporte())).getWorksheet('Maderera Norte')!;
    const textos: string[] = [];
    suya.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === 'string') textos.push(cell.value);
      });
    });
    expect(textos).toContain('SUSTITUCIÓN');
  });

  it('cada hoja de cotización trae sus líneas con el match contra el pedido', async () => {
    cookieActual = token;

    const hoja = (await libroDe(await pedirReporte())).getWorksheet('Corralón San Martín')!;

    expect(hoja.getCell('B2').value).toBe('Placa de roca de yeso 12,5 mm');
    expect(hoja.getCell('E2').value).toBe(5);
    expect(hoja.getCell('G2').value).toBe('seco.placas');
    expect(hoja.getCell('H2').value).toBe('Exacto');
  });

  it('con ?documento=cualquiera responde 400 en vez de bajar otra cosa', async () => {
    cookieActual = token;

    const res = await GET(
      new Request(
        `http://localhost/api/obras/${obraId}/compulsas/${compulsaId}/reporte?documento=recibo`,
      ),
      { params: Promise.resolve({ obraId, compulsaId }) },
    );

    expect(res.status).toBe(400);
  });

  it('la orden de compra en PDF sale recién cuando hay adjudicación', async () => {
    cookieActual = token;
    const url = `http://localhost/api/obras/${obraId}/compulsas/${compulsaId}/reporte?documento=orden-compra`;
    const pedir = () =>
      GET(new Request(url), { params: Promise.resolve({ obraId, compulsaId }) });

    expect((await pedir()).status).toBe(404);

    await adjudicar();
    const res = await pedir();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="orden-compra-casa-demo-seco-v1-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('la hoja de condiciones lleva el disclaimer y los datos de la compulsa', async () => {
    cookieActual = token;

    const hoja = (await libroDe(await pedirReporte())).getWorksheet('Condiciones')!;
    const textos: string[] = [];
    hoja.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === 'string') textos.push(cell.value);
      });
    });
    const todo = textos.join(' | ');

    expect(todo).toContain('sujeto a validación del profesional responsable');
    expect(todo).toContain('Casa Demo');
    expect(todo).toContain('Construcción en seco');
    expect(todo).toContain('IVA discriminado');
  });
});
