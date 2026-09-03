/**
 * `POST /api/obras/[obraId]/cruce` contra PGlite: el reintento del cruce.
 *
 * El cruce es la fase cara y la única que manda el expediente entero a la red,
 * así que es la que más se cae — y era **la única sin reintento**.
 * `cruzarTolerante` la atrapa y deja la obra con sus huecos, pero después de eso
 * ningún botón, acción ni ruta la volvía a llamar: reintentarla exigía volver a
 * subir el PDF, y el botón de reprocesar de una lámina solo re-extrae esa
 * lámina.
 *
 * Lo que hace el cruce ya está probado en `pipeline-fases.test.ts`. Lo que se
 * prueba acá es lo que solo puede fallar del lado del handler: que **valide por
 * su cuenta** —el `matcher` del middleware excluye `/api/*`, así que sin este
 * chequeo se reintenta el cruce de una obra ajena con una URL adivinada
 * (RNF-4)—, que respete la matriz de roles (RF-1201) y que no arranque encima
 * de un análisis que todavía corre.
 *
 * `next/headers` va mockeado: `getSession()` lee la cookie de ahí y en un test
 * no hay request de Next.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/obras/[obraId]/cruce/route';
import { setDbForTests, type Db } from '@/db/client';
import { estudios, obras, usuarios } from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import { TTL_FASE_ANALISIS_MS } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

/** Cookie que ve el handler en la llamada que viene. `undefined` ⇒ sin sesión. */
let cookieActual: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      cookieActual && nombre === 'compulsa_session' ? { value: cookieActual } : undefined,
  }),
}));

let db: Db;
let obraId: string;
let obraAjenaId: string;
let tokenTitular: string;
let tokenLectura: string;

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Norte' }).returning();
  const [ajeno] = await db.insert(estudios).values({ nombre: 'Otro estudio' }).returning();

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
  const [lectura] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'cliente@estudionorte.ar',
      nombre: 'Cliente',
      passwordHash: 'x',
      rol: 'lectura',
    })
    .returning();

  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Obra Fases', zona: 'CABA', tipo: 'nueva' })
    .returning();
  const [ajena] = await db
    .insert(obras)
    .values({ estudioId: ajeno.id, nombre: 'Ajena', zona: 'GBA', tipo: 'nueva' })
    .returning();

  obraId = obra.id;
  obraAjenaId = ajena.id;
  tokenTitular = (await crearSesion(db, titular.id)).token;
  tokenLectura = (await crearSesion(db, lectura.id)).token;
  cookieActual = tokenTitular;
});

function pedir(id = obraId): Promise<Response> {
  return POST(new Request(`http://localhost/api/obras/${id}/cruce`, { method: 'POST' }), {
    params: Promise.resolve({ obraId: id }),
  });
}

describe('POST /api/obras/[obraId]/cruce: quién puede reintentarlo', () => {
  it('sin sesión responde 401', async () => {
    cookieActual = undefined;
    expect((await pedir()).status).toBe(401);
  });

  it('la obra de otro estudio no existe (RNF-4)', async () => {
    expect((await pedir(obraAjenaId)).status).toBe(404);
  });

  it('un id que no es una obra tampoco', async () => {
    expect((await pedir('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('el rol lectura no puede: reintentar el cruce reescribe el cómputo', async () => {
    cookieActual = tokenLectura;
    const respuesta = await pedir();
    expect(respuesta.status).toBe(403);
  });
});

describe('POST /api/obras/[obraId]/cruce: qué hace', () => {
  it('deja la obra en `listo` y devuelve la fase', async () => {
    const respuesta = await pedir();
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toMatchObject({ fase: { fase: 'listo' }, relecturas: 0 });

    const [fila] = await db.select().from(obras).where(eq(obras.id, obraId));
    expect(fila.analisisJson).toMatchObject({ fase: 'listo' });
  });

  /**
   * 409 y no 500: no es un error del pedido ni nuestro, es que ya hay una
   * corrida encima. Dos cruces simultáneos corren dos recomputes que leen la
   * misma foto de `computo_items` y duplican la planilla en silencio.
   */
  it('con un análisis en curso responde 409 y no toca nada', async () => {
    const enCurso = {
      fase: 'extraccion' as const,
      total: 25,
      completadas: 12,
      desde: new Date().toISOString(),
    };
    await db.update(obras).set({ analisisJson: enCurso }).where(eq(obras.id, obraId));

    const respuesta = await pedir();
    expect(respuesta.status).toBe(409);

    const [fila] = await db.select().from(obras).where(eq(obras.id, obraId));
    expect(fila.analisisJson).toEqual(enCurso);
  });

  it('si esa corrida venció, el reintento entra igual', async () => {
    await db
      .update(obras)
      .set({
        analisisJson: {
          fase: 'extraccion',
          total: 25,
          completadas: 12,
          desde: new Date(Date.now() - TTL_FASE_ANALISIS_MS - 1000).toISOString(),
        },
      })
      .where(eq(obras.id, obraId));

    expect((await pedir()).status).toBe(200);
  });
});
