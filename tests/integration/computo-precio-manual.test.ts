/**
 * `editarItemAction`: la única puerta por la que entra un precio `manual`.
 *
 * Todo lo demás de la cascada del §5.6 sale de tablas que cargó una persona
 * (`precios_referencia`, `price_index`) y lo resuelve el recompute. Este action
 * es el otro extremo: el arquitecto escribiendo un número sobre la fila, y por
 * eso tiene que estar cubierto lo que puede salir mal —un precio que no es un
 * precio, un rol que no puede tocar el cómputo, un precio que se borra y tiene
 * que volver el de la lista—.
 *
 * `next/headers` va mockeado (la sesión sale de una cookie que acá no existe) y
 * `next/cache` también: `revalidatePath` no corre fuera de un request de Next.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { editarItemAction } from '@/app/obras/[obraId]/computo/actions';
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
  usuarios,
  type ComputoItem,
} from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import { recomputarObra } from '@/lib/pipeline/recomputar';

import { createTestDb } from '../helpers/test-db';

/** Cookie que ve el action en la llamada que viene. */
let cookieActual: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      cookieActual && nombre === 'compulsa_session' ? { value: cookieActual } : undefined,
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

let db: Db;
let obraId: string;
let itemId: string;
let tokenTitular: string;
let tokenLectura: string;

function itemDe(claveItem: string): Promise<ComputoItem | undefined> {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, claveItem)))
    .then((filas) => filas[0]);
}

function auditoriasDeEdicion(): Promise<{ diff: unknown }[]> {
  return db
    .select({ accion: auditoria.accion, diff: auditoria.diffJson })
    .from(auditoria)
    .where(eq(auditoria.obraId, obraId))
    .then((filas) => filas.filter((fila) => fila.accion === 'computo_item_editado'));
}

async function ponerEnLista(precio: number): Promise<void> {
  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  await db.insert(preciosReferencia).values({
    estudioId: obra!.estudioId,
    claveItem: 'seco.placas',
    descripcion: 'Placa de roca de yeso',
    unidad: 'm2',
    precio,
    moneda: 'ARS',
    fecha: '2026-08-20',
    origen: 'manual',
  });
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Norte' }).returning();
  const [titular] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'arq@estudionorte.ar',
      nombre: 'Ana Arquitecta',
      passwordHash: 'x',
      rol: 'titular',
    })
    .returning();
  const [pasante] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'pasante@estudionorte.ar',
      nombre: 'Pas Ante',
      passwordHash: 'x',
      rol: 'lectura',
    })
    .returning();
  tokenTitular = (await crearSesion(db, titular.id)).token;
  tokenLectura = (await crearSesion(db, pasante.id)).token;
  cookieActual = tokenTitular;

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
      subidoPor: titular.id,
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

  await recomputarObra(obraId, { db });
  itemId = (await itemDe('seco.placas'))!.id;
});

describe('editarItemAction · cargar un precio a mano', () => {
  it('escribe el precio con fuente manual y la fecha de hoy', async () => {
    expect(await editarItemAction({ obraId, itemId, precioUnitario: '12500,5' })).toEqual({ ok: true });

    const placas = await itemDe('seco.placas');
    expect(placas?.precioJson).toEqual({
      unitario: 12_500.5,
      moneda: 'ARS',
      fuente: 'manual',
      fechaPrecio: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    // La cantidad no se tocó, así que la fila NO queda congelada para el
    // recompute: poner un precio no es afirmar nada sobre la obra.
    expect(placas?.editadoPor).toBeNull();
    expect(placas?.cantNeta).toBe(26);
  });

  it('le gana a la lista del estudio y sobrevive a todos los recomputes', async () => {
    await ponerEnLista(9_000);
    await editarItemAction({ obraId, itemId, precioUnitario: '20000' });

    await recomputarObra(obraId, { db });
    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.precioJson).toMatchObject({
      unitario: 20_000,
      fuente: 'manual',
    });
  });

  it('deja el precio en la auditoría, con el antes y el después', async () => {
    await ponerEnLista(9_000);
    await recomputarObra(obraId, { db });

    await editarItemAction({ obraId, itemId, precioUnitario: '20000' });

    const auditadas = await auditoriasDeEdicion();
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]!.diff).toMatchObject({
      precio: {
        antes: { unitario: 9_000, fuente: 'lista' },
        despues: { unitario: 20_000, fuente: 'manual' },
      },
    });
  });

  it('el mismo precio dos veces no escribe ni audita de nuevo', async () => {
    await editarItemAction({ obraId, itemId, precioUnitario: '20000' });
    const antes = (await auditoriasDeEdicion()).length;

    expect(await editarItemAction({ obraId, itemId, precioUnitario: '20000' })).toEqual({ ok: true });

    expect((await auditoriasDeEdicion()).length).toBe(antes);
  });
});

describe('editarItemAction · borrar el precio manual', () => {
  it('vuelve el de la lista en la misma corrida, sin esperar otro recompute', async () => {
    await ponerEnLista(9_000);
    await editarItemAction({ obraId, itemId, precioUnitario: '20000' });
    expect((await itemDe('seco.placas'))?.precioJson?.fuente).toBe('manual');

    expect(await editarItemAction({ obraId, itemId, precioUnitario: '' })).toEqual({ ok: true });

    expect((await itemDe('seco.placas'))?.precioJson).toEqual({
      unitario: 9_000,
      moneda: 'ARS',
      fuente: 'lista',
      fechaPrecio: '2026-08-20',
    });
  });

  it('sin lista ni índice queda sin precio, que no es lo mismo que en cero', async () => {
    await editarItemAction({ obraId, itemId, precioUnitario: '20000' });

    await editarItemAction({ obraId, itemId, precioUnitario: '' });

    expect((await itemDe('seco.placas'))?.precioJson).toBeNull();
  });
});

describe('editarItemAction · lo que no es un precio', () => {
  const MENSAJE = 'El precio unitario tiene que ser un número mayor que cero (ej.: 12.500,50).';

  for (const [caso, valor] of [
    ['un cero', '0'],
    ['un negativo', '-5'],
    ['una palabra', 'gratis'],
    ['una unidad tipeada', '12500 pesos'],
  ] as const) {
    it(`rechaza ${caso} y no escribe nada`, async () => {
      await ponerEnLista(9_000);
      await recomputarObra(obraId, { db });

      expect(await editarItemAction({ obraId, itemId, precioUnitario: valor })).toEqual({
        ok: false,
        error: MENSAJE,
      });
      // El precio que había sigue tal cual: un rechazo no borra.
      expect((await itemDe('seco.placas'))?.precioJson?.fuente).toBe('lista');
      expect(await auditoriasDeEdicion()).toEqual([]);
    });
  }
});

describe('editarItemAction · quién puede', () => {
  it('un usuario de solo lectura no toca el precio (RF-1201)', async () => {
    cookieActual = tokenLectura;

    const resultado = await editarItemAction({ obraId, itemId, precioUnitario: '20000' });

    expect(resultado.ok).toBe(false);
    expect((await itemDe('seco.placas'))?.precioJson).toBeNull();
    expect(await auditoriasDeEdicion()).toEqual([]);
  });

  it('sin ítem de esta obra no hay precio que poner (RNF-4)', async () => {
    const resultado = await editarItemAction({
      obraId,
      itemId: '00000000-0000-4000-8000-000000000000',
      precioUnitario: '20000',
    });

    expect(resultado).toEqual({ ok: false, error: 'No encontré ese ítem en esta obra.' });
  });
});
