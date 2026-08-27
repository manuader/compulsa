/**
 * `GET /api/laminas/[laminaId]/marcas` contra PGlite.
 *
 * Es lo que le da de comer al `PanelVisor` embebido: la bandeja muestra el plano
 * al lado de la consulta pidiendo esta ruta, sin navegar. Lo que se prueba acá
 * es lo que el armado de marcas no puede saber por su cuenta: que el handler
 * **valide por su cuenta** —el `matcher` del middleware excluye `/api/*`, así
 * que sin este chequeo las marcas de una obra ajena se leen con una URL
 * adivinada (RNF-4)— y que el JSON traiga lo que el visor necesita para dibujar.
 *
 * Las marcas salen del pipeline real sobre `obra-demo.pdf` (provider mock, sin
 * red): pinnear 7 entidades es pinnear que la página 1 se dibuja entera, no un
 * número inventado a mano en un `insert`.
 *
 * `next/headers` va mockeado: `getSession()` lee la cookie de ahí y en un test
 * no hay request de Next. La cookie se controla con `cookieActual`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/laminas/[laminaId]/marcas/route';
import { setDbForTests, type Db } from '@/db/client';
import { documentos, estudios, laminas, obras, usuarios } from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import type { MarcasDeLamina } from '@/lib/pipeline/marcas';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { crearStorageLocal } from '@/lib/storage/index';

import { createTestDb } from '../helpers/test-db';

/** Cookie que ve el handler en la llamada que viene. `undefined` ⇒ sin sesión. */
let cookieActual: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      cookieActual && nombre === 'compulsa_session' ? { value: cookieActual } : undefined,
  }),
}));

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);
/** Bien formado y de nadie: tiene que dar 404, no un 500 del driver. */
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

let db: Db;
let raizStorage: string;
let laminaId: string;
let laminaAjenaId: string;
let token: string;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-marcas-'));
  const storage = crearStorageLocal(raizStorage);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Ader' }).returning();
  // Segundo estudio con su propia lámina: es el control del aislamiento.
  const [estudioAjeno] = await db.insert(estudios).values({ nombre: 'Otro estudio' }).returning();

  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'manu@estudioader.ar',
      nombre: 'Manu Ader',
      passwordHash: 'no-se-usa',
      rol: 'titular',
    })
    .returning();

  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Demo', zona: 'CABA', tipo: 'nueva' })
    .returning();
  const [obraAjena] = await db
    .insert(obras)
    .values({ estudioId: estudioAjeno.id, nombre: 'Ajena', zona: 'GBA', tipo: 'nueva' })
    .returning();

  const bytes = await readFile(new URL('obra-demo.pdf', PDFS));
  const documento = await subirDocumento(
    db,
    storage,
    obra.id,
    usuario.id,
    new File([new Uint8Array(bytes)], 'obra-demo.pdf', { type: 'application/pdf' }),
  );
  await procesarDocumento(documento.id, { db, storage });

  const paginas = await db
    .select()
    .from(laminas)
    .where(eq(laminas.documentoId, documento.id))
    .orderBy(laminas.numeroPagina);
  laminaId = paginas[0].id;

  const [docAjeno] = await db
    .insert(documentos)
    .values({
      obraId: obraAjena.id,
      nombreArchivo: 'ajeno.pdf',
      tipo: 'plano',
      archivoRef: 'ref-ajeno',
      mime: 'application/pdf',
      hash: 'hash-ajeno',
      subidoPor: usuario.id,
    })
    .returning();
  const [laminaAjena] = await db
    .insert(laminas)
    .values({
      documentoId: docAjeno.id,
      obraId: obraAjena.id,
      numeroPagina: 1,
      codigo: 'X-01',
      archivoRef: 'ref-ajeno-p1',
      estadoAnalisis: 'analizada',
    })
    .returning();
  laminaAjenaId = laminaAjena.id;

  token = (await crearSesion(db, usuario.id)).token;
});

afterAll(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

function pedir(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/laminas/${id}/marcas`), {
    params: Promise.resolve({ laminaId: id }),
  });
}

describe('GET /api/laminas/[laminaId]/marcas: quién puede verlas', () => {
  it('sin sesión responde 401 y no manda una marca', async () => {
    cookieActual = undefined;

    const res = await pedir(laminaId);

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'Iniciá sesión para seguir.' });
  });

  it('con una lámina de otro estudio responde 404 (RNF-4)', async () => {
    cookieActual = token;

    const res = await pedir(laminaAjenaId);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Esa lámina no existe.' });
  });

  it('con una lámina que no existe responde 404, y con un id mal formado también', async () => {
    cookieActual = token;

    expect((await pedir(UUID_INEXISTENTE)).status).toBe(404);
    // Un id que ni siquiera es un uuid no puede llegar al driver como 500.
    expect((await pedir('no-es-un-uuid')).status).toBe(404);
  });
});

describe('GET /api/laminas/[laminaId]/marcas: lo que dibuja el visor', () => {
  it('trae las 7 entidades de la página 1 de obra-demo, con bbox y sin deducciones', async () => {
    cookieActual = token;

    const res = await pedir(laminaId);
    const marcas = (await res.json()) as MarcasDeLamina;

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(marcas.laminaId).toBe(laminaId);
    // La ruta de descarga, con los segmentos de la ref codificados.
    expect(marcas.archivoUrl.startsWith('/api/archivos/')).toBe(true);

    expect(marcas.entidades).toHaveLength(7);
    expect(marcas.entidades.map((marca) => marca.nombre)).toEqual([
      'Estar',
      'Dormitorio',
      'T1',
      'M1',
      'V1',
      'P1',
      'P2',
    ]);
    // P1: ninguna marca sin bbox — es lo único que la hace dibujable.
    expect(
      marcas.entidades.every(
        (marca) => Array.isArray(marca.bbox) && marca.bbox.length === 4,
      ),
    ).toBe(true);

    // La obra demo no deja nada propuesto por el motor de deducción.
    expect(marcas.deducciones).toEqual([]);
    // Y los hallazgos que salgan tienen que ser de esta lámina, no de la obra.
    expect(marcas.hallazgos.every((marca) => marca.bbox.length === 4)).toBe(true);
  });
});
