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
import { documentos, estudios, hallazgos, laminas, obras, usuarios } from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import { resolverDestacado, type MarcasDeLamina } from '@/lib/pipeline/marcas';
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
/** La planilla de carpinterías de obra-demo (página 3): la lámina "no citada". */
let laminaPlanillaId: string;
let laminaAjenaId: string;
let obraId: string;
let obraAjenaId: string;
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
  laminaPlanillaId = paginas[2].id;
  obraId = obra.id;
  obraAjenaId = obraAjena.id;

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

/**
 * `?highlight=<hallazgoId>` sobre la lámina donde el sistema leyó lo que propone.
 *
 * La búsqueda dirigida encuentra el ancho de FP01 en la planilla de
 * carpinterías, pero la consulta está citada en la planta: `laminas_json` no
 * nombra la planilla en ningún lado. Hasta acá el visor resolvía el highlight
 * solo contra esas citas, así que el recuadro del que salió el número —el que
 * hay que mirar para confirmar— no tenía vista a pantalla completa: la bandeja
 * lo mostraba en su panel y el link "abrir en página completa" caía en una
 * lámina sin nada resaltado.
 *
 * Es **aditivo**: el contrato de `src/app/CLAUDE.md` §4 no cambia, se amplía.
 */
describe('resolverDestacado: la lámina de la propuesta también se resalta', () => {
  const HUECO: [number, number, number, number] = [0.1, 0.2, 0.05, 0.1];
  const FILA_PLANILLA: [number, number, number, number] = [0.6, 0.35, 0.3, 0.04];

  /** Una consulta citada en la planta, con o sin el dato leído en la planilla. */
  async function consulta(conPropuesta: boolean, clave: string): Promise<string> {
    const [fila] = await db
      .insert(hallazgos)
      .values({
        obraId,
        clave,
        tipo: 'faltante',
        rubro: 'aberturas',
        descripcion: 'Falta el ancho de FP01.',
        laminasJson: [{ laminaId, bbox: HUECO, detalle: 'FP01' }],
        targetRef: null,
        valorPropuestoJson: conPropuesta
          ? {
              valores: { anchoM: 0.9 },
              fuente: { laminaId: laminaPlanillaId, bbox: FILA_PLANILLA },
              confianza: 0.85,
              origen: 'busqueda_dirigida',
            }
          : null,
        bloqueante: true,
      })
      .returning();
    return fila.id;
  }

  it('devuelve la fuente de la propuesta primero, y después las citadas', async () => {
    const id = await consulta(true, 'aberturas.FP01.ancho');

    const destacado = await resolverDestacado(db, obraId, id);

    expect(destacado?.nombre).toBe('Falta el ancho de FP01.');
    // Primero la planilla: es el recuadro del que salió el número y al que el
    // visor scrollea. Sin esto, la planilla no aparecía en la lista.
    expect(destacado?.fuentes.map((fuente) => fuente.laminaId)).toEqual([
      laminaPlanillaId,
      laminaId,
    ]);
    expect(destacado?.fuentes[0].bbox).toEqual(FILA_PLANILLA);
  });

  it('sin propuesta sigue resolviendo exactamente las citadas', async () => {
    const id = await consulta(false, 'aberturas.FP02.ancho');

    const destacado = await resolverDestacado(db, obraId, id);

    expect(destacado?.fuentes).toEqual([{ laminaId, bbox: HUECO, detalle: 'FP01' }]);
  });

  it('la propuesta leída en una zona ya citada no se resalta dos veces', async () => {
    const [fila] = await db
      .insert(hallazgos)
      .values({
        obraId,
        clave: 'aberturas.FP03.ancho',
        tipo: 'faltante',
        rubro: 'aberturas',
        descripcion: 'Falta el ancho de FP03.',
        laminasJson: [{ laminaId, bbox: HUECO }],
        targetRef: null,
        valorPropuestoJson: {
          valores: { anchoM: 0.9 },
          fuente: { laminaId, bbox: HUECO },
          origen: 'lectura_baja_confianza',
        },
        bloqueante: false,
      })
      .returning();

    const destacado = await resolverDestacado(db, obraId, fila.id);

    // Dos veces el mismo bbox diría "2 zonas citadas" por una sola.
    expect(destacado?.fuentes).toHaveLength(1);
  });

  it('una consulta de otra obra no existe (RNF-4), y un id mal formado tampoco', async () => {
    const id = await consulta(true, 'aberturas.FP04.ancho');

    expect(await resolverDestacado(db, obraAjenaId, id)).toBeNull();
    expect(await resolverDestacado(db, obraId, 'no-es-un-uuid')).toBeNull();
    expect(await resolverDestacado(db, obraId, UUID_INEXISTENTE)).toBeNull();
  });
});
