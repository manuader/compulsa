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
 *
 * `next/headers` va mockeado porque la route del reporte lee la cookie de ahí
 * (mismo patrón que `tests/integration/export-route.test.ts`).
 */
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
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
import { CompulsaNoEncontradaError } from '@/lib/outreach/threads';
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
