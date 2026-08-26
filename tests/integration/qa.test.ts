/**
 * Q&A del expediente (RF-106), de punta a punta: el pipeline analiza el PDF real
 * de `tests/fixtures/pdfs/obra-demo.pdf`, deja el texto en
 * `laminas.texto_extraido` y el provider mock contesta sobre ese texto.
 *
 * Lo que estos tests protegen:
 *
 *  1. el pipeline **persiste** el texto de cada lámina (sin eso el Q&A no tiene
 *     de dónde leer, y la columna es nueva de P1);
 *  2. un fixture `qa/<slug-pregunta>.json` contesta con su texto y sus citas
 *     resueltas a láminas de ESTA obra;
 *  3. una pregunta que el expediente no contesta —y un fixture que cita una
 *     lámina que no existe— caen en "No encontré eso en el expediente" **sin
 *     citas** (P4).
 *
 * El provider es siempre el mock (`NODE_ENV=test`): nada de red.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import { estudios, laminas, obras, usuarios } from '@/db/schema';
import { crearProviderQaMock } from '@/lib/analysis/qa-mock';
import {
  getQaProvider,
  SIN_RESPUESTA,
  slugPregunta,
  type ContextoQa,
  type LaminaQa,
} from '@/lib/analysis/qa-tipos';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let usuarioId: string;

async function subirYProcesar(nombre: string): Promise<void> {
  const bytes = await readFile(new URL(nombre, PDFS));
  const archivo = new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
  const documento = await subirDocumento(db, storage, obraId, usuarioId, archivo);
  await procesarDocumento(documento.id, { db, storage });
}

/** El expediente tal como se lo pasa la pantalla al provider. */
async function contexto(): Promise<ContextoQa> {
  const filas = await db
    .select()
    .from(laminas)
    .where(eq(laminas.obraId, obraId))
    .orderBy(asc(laminas.numeroPagina));

  const vistas: LaminaQa[] = filas.map((lamina) => ({
    id: lamina.id,
    codigo: lamina.codigo,
    titulo: lamina.titulo,
    tipo: lamina.tipo,
    disciplina: lamina.disciplina,
    textoExtraido: lamina.textoExtraido,
  }));

  return { obraId, obraNombre: 'Casa Demo', laminas: vistas };
}

async function laminaPorCodigo(codigo: string) {
  const filas = await db.select().from(laminas).where(eq(laminas.obraId, obraId));
  const encontrada = filas.find((fila) => fila.codigo === codigo);
  if (!encontrada) throw new Error(`No hay lámina ${codigo} en la obra de prueba.`);
  return encontrada;
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-qa-'));
  storage = crearStorageLocal(raizStorage);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Norte' }).returning();
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
    .values({ estudioId: estudio.id, nombre: 'Casa Demo', zona: 'CABA', tipo: 'nueva' })
    .returning();

  usuarioId = usuario.id;
  obraId = obra.id;

  await subirYProcesar('obra-demo.pdf');
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

describe('el pipeline persiste el texto de la lámina', () => {
  it('deja `texto_extraido` con lo que dice el PDF de cada página', async () => {
    const { laminas: vistas } = await contexto();

    expect(vistas).toHaveLength(3);
    expect(vistas.every((lamina) => lamina.textoExtraido !== null)).toBe(true);
    expect(vistas[0].textoExtraido).toContain('PLANTA PB');
    expect(vistas[0].textoExtraido).toContain('A-01');
    expect(vistas[2].textoExtraido).toContain('PLANILLA DE CARPINTER');
  });
});

describe('respuesta por fixture', () => {
  it('contesta con el texto del fixture y cita la lámina por su código', async () => {
    const pregunta = '¿Qué vidrio llevan las ventanas?';
    expect(slugPregunta(pregunta)).toBe('que-vidrio-llevan-las-ventanas');

    const respuesta = await getQaProvider().responder(pregunta, await contexto());
    const planilla = await laminaPorCodigo('A-03');

    expect(respuesta.respuesta).toContain('DVH 4/9/4');
    expect(respuesta.citas).toEqual([{ laminaId: planilla.id, codigo: 'A-03' }]);
  });

  it('degrada a P4 si el fixture cita una lámina que no está en el expediente', async () => {
    // El fixture cita E-01 (estructura) y esta obra no la tiene: una respuesta
    // sin fuente verificable no se muestra, se convierte en "no lo sé".
    const respuesta = await getQaProvider().responder(
      '¿Quién firma el cálculo de estructura?',
      await contexto(),
    );

    expect(respuesta.respuesta).toBe(SIN_RESPUESTA);
    expect(respuesta.citas).toEqual([]);
  });
});

describe('respuesta por búsqueda sobre el texto extraído', () => {
  it('cita la lámina con más palabras de la pregunta y transcribe su línea', async () => {
    const respuesta = await getQaProvider().responder(
      '¿Cuál es la escala de la planta?',
      await contexto(),
    );
    const planta = await laminaPorCodigo('A-01');

    // A-01 es la única que tiene "escala" y "planta": las otras dos solo dicen
    // "Escala", así que el puntaje las deja afuera.
    expect(respuesta.citas).toEqual([{ laminaId: planta.id, codigo: 'A-01' }]);
    expect(respuesta.respuesta).toContain('Según A-01');
    expect(respuesta.respuesta).toContain('1:100');
  });

  it('sin match contesta que no lo encontró y no cita nada (P4)', async () => {
    const respuesta = await getQaProvider().responder(
      '¿Cuánto sale el metro cuadrado de durlock colocado?',
      await contexto(),
    );

    expect(respuesta.respuesta).toBe(SIN_RESPUESTA);
    expect(respuesta.citas).toEqual([]);
  });

  it('una pregunta vacía no dispara ninguna búsqueda', async () => {
    const respuesta = await getQaProvider().responder('   ', await contexto());

    expect(respuesta.respuesta).toBe(SIN_RESPUESTA);
    expect(respuesta.citas).toEqual([]);
  });

  it('es determinístico: la misma pregunta dos veces da exactamente lo mismo', async () => {
    const ctx = await contexto();
    const provider = crearProviderQaMock();

    const primera = await provider.responder('¿Qué dice el corte?', ctx);
    const segunda = await provider.responder('¿Qué dice el corte?', ctx);

    expect(segunda).toEqual(primera);
  });
});
