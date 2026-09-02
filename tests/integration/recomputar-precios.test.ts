/**
 * La cascada de precios, enchufada al recompute (§5.6).
 *
 * `resolverPrecio` es puro y ya está pinneado (`tests/unit/precios.test.ts`); lo
 * que este test protege es la otra mitad, que es la que se rompe callada: que el
 * recompute lea la lista del estudio y el índice de **la zona de la obra**, que
 * escriba `computo_items.precio_json`, que un precio cargado a mano sobreviva a
 * todas las corridas siguientes y que dos recomputes idénticos no escriban ni
 * una fila (`igualJson`, no `JSON.stringify`).
 *
 * La IA no participa: `precio_json.fuente` solo puede ser `manual`, `lista` o
 * `indice`, y las tres salen de tablas que cargó una persona.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  computoItems,
  documentos,
  entidades,
  estudios,
  laminas,
  obras,
  preciosReferencia,
  priceIndex,
  usuarios,
  type ComputoItem,
} from '@/db/schema';
import { recomputarObra } from '@/lib/pipeline/recomputar';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let obraId: string;
let estudioId: string;

function itemDe(claveItem: string): Promise<ComputoItem | undefined> {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, claveItem)))
    .then((filas) => filas[0]);
}

function auditoriasDePrecio(): Promise<{ id: string }[]> {
  return db
    .select({ id: auditoria.id, accion: auditoria.accion })
    .from(auditoria)
    .where(eq(auditoria.obraId, obraId))
    .then((filas) => filas.filter((fila) => fila.accion === 'computo_item_precio'));
}

async function listaConPlacas(precio: number, fecha = '2026-08-20'): Promise<void> {
  await db.insert(preciosReferencia).values({
    estudioId,
    claveItem: 'seco.placas',
    descripcion: 'Placa de roca de yeso',
    unidad: 'm2',
    precio,
    moneda: 'ARS',
    fecha,
    origen: 'manual',
  });
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Norte' }).returning();
  estudioId = estudio.id;
  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'arq@estudionorte.ar',
      nombre: 'Ana Arquitecta',
      passwordHash: 'x',
      rol: 'titular',
    })
    .returning();
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa PB', zona: 'CABA', tipo: 'nueva' })
    .returning();
  obraId = obra.id;
  const [documento] = await db
    .insert(documentos)
    .values({
      obraId: obra.id,
      nombreArchivo: 'planta.pdf',
      tipo: 'plano',
      archivoRef: 'demo/planta.pdf',
      mime: 'application/pdf',
      hash: 'sha256-demo',
      subidoPor: usuario.id,
    })
    .returning();
  const [lamina] = await db
    .insert(laminas)
    .values({
      documentoId: documento.id,
      obraId: obra.id,
      numeroPagina: 1,
      archivoRef: 'demo/planta-p1.pdf',
      estadoAnalisis: 'analizada',
      tipo: 'planta',
      escala: '1:100',
      escalaConfiable: true,
    })
    .returning();

  // Un tabique de durlock de 5 × 2,60 m a dos caras: 26 m² netos, 31,68 de compra.
  await db.insert(entidades).values({
    obraId: obra.id,
    laminaId: lamina.id,
    tipo: 'tabique',
    nombre: 'T1',
    atributosJson: { largoM: 5, alturaM: 2.6, caras: 2, tipo: 'durlock' },
    estadoReforma: 'nueva',
    fuentesJson: [{ laminaId: lamina.id, bbox: [0.1, 0.5, 0.4, 0.02] }],
    confianza: 0.9,
  });
});

describe('recompute · precio de la lista del estudio', () => {
  it('le pone el precio de la lista al ítem, con su fecha y su fuente', async () => {
    await listaConPlacas(12_500);

    await recomputarObra(obraId, { db });

    const placas = await itemDe('seco.placas');
    expect(placas?.cantCompra).toBe(31.68);
    expect(placas?.precioJson).toEqual({
      unitario: 12_500,
      moneda: 'ARS',
      fuente: 'lista',
      fechaPrecio: '2026-08-20',
    });
    // El subtotal de la planilla: unitario × cantidad de compra.
    expect(12_500 * (placas?.cantCompra ?? 0)).toBe(396_000);
  });

  it('sin lista y sin índice el precio queda en null: un cero sería mentira', async () => {
    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.precioJson).toBeNull();
  });

  it('una fila que salió de la lista (`activo = false`) no cotiza', async () => {
    await listaConPlacas(12_500);
    await db
      .update(preciosReferencia)
      .set({ activo: false })
      .where(eq(preciosReferencia.claveItem, 'seco.placas'));

    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.precioJson).toBeNull();
  });
});

describe('recompute · precio del índice del estudio', () => {
  it('toma el p50 del mes más reciente con muestras, de la zona de la obra', async () => {
    await db.insert(priceIndex).values([
      { estudioId, claveItem: 'seco.placas', zona: 'CABA', mes: '2026-07', p25: 400, p50: 500, p75: 600, n: 5, muestrasJson: [400, 500, 600] },
      { estudioId, claveItem: 'seco.placas', zona: 'CABA', mes: '2026-08', p25: 700, p50: 800, p75: 900, n: 3, muestrasJson: [700, 800, 900] },
      // Más nuevo pero sin muestras: no es un precio, es una fila vacía.
      { estudioId, claveItem: 'seco.placas', zona: 'CABA', mes: '2026-09', p25: 0, p50: 999, p75: 0, n: 0, muestrasJson: [] },
      // Otra zona: el precio de Rosario no es el precio de esta obra.
      { estudioId, claveItem: 'seco.placas', zona: 'Rosario', mes: '2026-08', p25: 10, p50: 11, p75: 12, n: 9, muestrasJson: [11] },
    ]);

    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.precioJson).toEqual({
      unitario: 800,
      moneda: 'ARS',
      // El índice es mensual: la fecha del precio es el mes, sin día inventado.
      fuente: 'indice',
      fechaPrecio: '2026-08',
    });
  });

  it('la lista le gana al índice', async () => {
    await listaConPlacas(12_500);
    await db.insert(priceIndex).values({
      estudioId,
      claveItem: 'seco.placas',
      zona: 'CABA',
      mes: '2026-08',
      p25: 700,
      p50: 800,
      p75: 900,
      n: 3,
      muestrasJson: [700, 800, 900],
    });

    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.precioJson?.fuente).toBe('lista');
  });
});

describe('recompute · el precio que cargó una persona', () => {
  it('sobrevive al recompute aunque la lista diga otra cosa', async () => {
    await recomputarObra(obraId, { db });
    const placas = await itemDe('seco.placas');
    await db
      .update(computoItems)
      .set({
        precioJson: { unitario: 20_000, moneda: 'ARS', fuente: 'manual', fechaPrecio: '2026-08-28' },
      })
      .where(eq(computoItems.id, placas!.id));

    await listaConPlacas(12_500);
    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.precioJson).toEqual({
      unitario: 20_000,
      moneda: 'ARS',
      fuente: 'manual',
      fechaPrecio: '2026-08-28',
    });
  });
});

describe('recompute · idempotencia del precio', () => {
  it('el mismo precio resuelto dos veces no escribe ni audita nada', async () => {
    await listaConPlacas(12_500);
    await recomputarObra(obraId, { db });
    const antes = (await auditoriasDePrecio()).length;
    expect(antes).toBe(1);

    const resumen = await recomputarObra(obraId, { db });
    await recomputarObra(obraId, { db });

    expect(resumen.preciosActualizados).toBe(0);
    expect((await auditoriasDePrecio()).length).toBe(antes);
  });

  it('un precio que cambia en la lista sí se escribe, y queda auditado', async () => {
    await listaConPlacas(12_500);
    await recomputarObra(obraId, { db });

    await db
      .update(preciosReferencia)
      .set({ precio: 13_000 })
      .where(eq(preciosReferencia.claveItem, 'seco.placas'));
    const resumen = await recomputarObra(obraId, { db });

    expect(resumen.preciosActualizados).toBe(1);
    expect((await itemDe('seco.placas'))?.precioJson?.unitario).toBe(13_000);
    expect((await auditoriasDePrecio()).length).toBe(2);
  });
});
