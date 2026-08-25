/**
 * Pipeline de análisis, de punta a punta, contra PGlite en memoria y los PDFs
 * reales de `tests/fixtures/pdfs/`.
 *
 * No se testea el route handler sino la lógica que el handler envuelve
 * (`subirDocumento`, `procesarDocumento`, `actualizarLamina`): lo que hay que
 * proteger es qué queda escrito en la base, no cómo se serializa un multipart.
 *
 * El provider de análisis es SIEMPRE el mock (`NODE_ENV=test`), que lee los
 * fixtures `obra-demo-p1..p3.json`. `sin-escala.pdf` no tiene fixture a
 * propósito: es el caso que ejercita el bloqueo por escala (RF-201).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  computoItems,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Lamina,
} from '@/db/schema';
import {
  actualizarLamina,
  procesarDocumento,
  procesarLamina,
  subirDocumento,
} from '@/lib/pipeline/procesar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let usuarioId: string;

async function archivoFixture(nombre: string): Promise<File> {
  const bytes = await readFile(new URL(nombre, PDFS));
  return new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
}

async function subirYProcesar(nombre: string) {
  const documento = await subirDocumento(db, storage, obraId, usuarioId, await archivoFixture(nombre));
  await procesarDocumento(documento.id, { db, storage });
  return documento;
}

function laminasDe(documentoId: string): Promise<Lamina[]> {
  return db
    .select()
    .from(laminas)
    .where(eq(laminas.documentoId, documentoId))
    .orderBy(laminas.numeroPagina);
}

async function itemsActivos() {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.estado, 'activo')));
}

async function clavesDeHallazgos(): Promise<string[]> {
  const filas = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
  return filas.map((h) => h.clave);
}

beforeEach(async () => {
  // Todo el pipeline resuelve la base por `getDb()`: hay que inyectar la de test.
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-pipeline-'));
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
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

describe('procesarDocumento sobre obra-demo.pdf', () => {
  it('separa las 3 páginas, las analiza y computa la obra entera', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const lams = await laminasDe(documento.id);
    expect(lams).toHaveLength(3);
    expect(lams.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada', 'analizada']);
    expect(lams.map((l) => l.codigo)).toEqual(['A-01', 'A-02', 'A-03']);
    expect(lams.map((l) => l.titulo)).toEqual([
      'PLANTA PB',
      'CORTE A-A',
      'PLANILLA DE CARPINTERÍAS',
    ]);
    expect(lams[0].escala).toBe('1:100');
    expect(lams[0].escalaConfiable).toBe(true);
    expect(lams[0].tipo).toBe('planta');
    expect(lams[0].disciplina).toBe('arquitectura');
    expect(lams.every((l) => l.errorDetalle === null)).toBe(true);

    // Cada lámina guarda su propio PDF de una página, distinto del original.
    expect(new Set(lams.map((l) => l.archivoRef)).size).toBe(3);
    for (const lamina of lams) {
      const bytes = await storage.leer(lamina.archivoRef);
      expect(bytes.length).toBeGreaterThan(0);
      expect(lamina.archivoRef).not.toBe(documento.archivoRef);
    }

    const guardadas = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(guardadas).toHaveLength(10);
    expect(guardadas.every((e) => e.fuentesJson.length > 0)).toBe(true);

    const items = await itemsActivos();
    expect(new Set(items.map((i) => i.rubro))).toEqual(
      new Set(['aberturas', 'seco', 'pintura', 'gruesa']),
    );
    // P1: ningún ítem de agente sin provenance.
    expect(items.every((i) => i.fuentesJson.length > 0)).toBe(true);
    expect(items.every((i) => i.editadoPor === null)).toBe(true);

    const porClave = new Map(items.map((i) => [i.claveItem, i]));
    expect(porClave.get('seco.placas')?.cantCompra).toBe(31.68);
    expect(porClave.get('gruesa.ladrillos')?.cantCompra).toBe(396);

    const claves = await clavesDeHallazgos();
    // Estar: piso 20 m² vs cielorraso 19 m² = 5%, por debajo del 10% que tolera el motor.
    expect(claves.filter((c) => c.startsWith('sanity.piso_cielo.'))).toEqual([]);
    // Estar y Dormitorio declaran `vanosM2`: no hay nada que consultar.
    expect(claves.filter((c) => c.startsWith('pintura.vanos_sin_descontar.'))).toEqual([]);
    // Las tres láminas leyeron escala confiable: ningún bloqueo.
    expect(claves.filter((c) => c.startsWith('escala.'))).toEqual([]);
  });
});

describe('bloqueo por escala y desbloqueo manual', () => {
  it('deja la lámina sin escala bloqueada, con hallazgo bloqueante y sin entidades', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');

    const [lamina] = await laminasDe(documento.id);
    expect(lamina.estadoAnalisis).toBe('bloqueada_escala');
    expect(lamina.escalaConfiable).toBe(false);

    const [hallazgo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, `escala.${lamina.id}`)));
    expect(hallazgo).toBeDefined();
    expect(hallazgo.tipo).toBe('faltante');
    expect(hallazgo.bloqueante).toBe(true);
    expect(hallazgo.estado).toBe('abierto');
    expect(hallazgo.laminasJson).toEqual([
      { laminaId: lamina.id, bbox: [0, 0, 1, 1], detalle: 'Lámina completa' },
    ]);

    expect(await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id))).toHaveLength(
      0,
    );
  });

  it('el PATCH de escala manual re-dispara el análisis y deja la lámina analizada', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');
    const [previa] = await laminasDe(documento.id);

    const lamina = await actualizarLamina(
      db,
      previa.id,
      { escala: '1:50', escalaConfiable: true },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { db, storage },
    );

    expect(lamina.escala).toBe('1:50');
    expect(lamina.escalaConfiable).toBe(true);
    // Sin fixture de análisis no hay entidades: analizada y vacía es la respuesta honesta.
    expect(lamina.estadoAnalisis).toBe('analizada');
    expect(await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id))).toHaveLength(
      0,
    );

    const [hallazgo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, `escala.${lamina.id}`)));
    expect(hallazgo.estado).toBe('descartado');
  });

  it('el recompute de otra lámina no cierra el hallazgo de escala', async () => {
    // `escala.<laminaId>` lo emite el pipeline, no `computarObra()`: si el
    // recompute lo conciliara junto con los suyos, lo cerraría "porque ya no
    // sale" y la lámina quedaría bloqueada sin consulta que lo explique.
    const bloqueado = await subirYProcesar('sin-escala.pdf');
    const [bloqueada] = await laminasDe(bloqueado.id);

    await subirYProcesar('obra-demo.pdf');

    const [hallazgo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, `escala.${bloqueada.id}`)));
    expect(hallazgo.estado).toBe('abierto');
    expect(hallazgo.respuestaJson).toBeNull();
  });

  it('el PATCH de clasificación guarda disciplina y tipo sin re-analizar', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');
    const [previa] = await laminasDe(documento.id);

    const lamina = await actualizarLamina(
      db,
      previa.id,
      { disciplina: 'instalaciones', tipo: 'detalle' },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { db, storage },
    );

    expect(lamina.disciplina).toBe('instalaciones');
    expect(lamina.tipo).toBe('detalle');
    expect(lamina.estadoAnalisis).toBe('bloqueada_escala');
  });
});

describe('idempotencia', () => {
  it('re-procesar el documento da los mismos conteos y no duplica nada', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const entidadesAntes = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    const itemsAntes = await itemsActivos();
    const clavesAntes = (await clavesDeHallazgos()).sort();

    await procesarDocumento(documento.id, { db, storage });

    const lams = await laminasDe(documento.id);
    expect(lams).toHaveLength(3);
    expect(lams.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada', 'analizada']);

    const entidadesDespues = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(entidadesDespues).toHaveLength(10);
    // Las entidades conservan su id: el recompute matchea por lámina + tipo + nombre,
    // así los `entidad_id` de los ítems y los `target_ref` de los hallazgos no se pudren.
    expect(new Set(entidadesDespues.map((e) => e.id))).toEqual(
      new Set(entidadesAntes.map((e) => e.id)),
    );

    const itemsDespues = await itemsActivos();
    expect(itemsDespues).toHaveLength(itemsAntes.length);
    expect(new Set(itemsDespues.map((i) => i.claveItem))).toEqual(
      new Set(itemsAntes.map((i) => i.claveItem)),
    );
    expect(new Set(itemsDespues.map((i) => i.id))).toEqual(new Set(itemsAntes.map((i) => i.id)));
    expect(itemsDespues.find((i) => i.claveItem === 'seco.placas')?.cantCompra).toBe(31.68);
    expect(itemsDespues.find((i) => i.claveItem === 'gruesa.ladrillos')?.cantCompra).toBe(396);

    expect((await clavesDeHallazgos()).sort()).toEqual(clavesAntes);
  });

  it('un ítem editado a mano sobrevive al recompute', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const [placas] = await db
      .select()
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.placas')));

    await db
      .update(computoItems)
      .set({ cantNeta: 40, cantCompra: 46.08, editadoPor: usuarioId })
      .where(eq(computoItems.id, placas.id));

    await procesarDocumento(documento.id, { db, storage });

    const filas = await db
      .select()
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.placas')));

    // Ni pisado ni duplicado: la clave editada a mano es del humano.
    expect(filas).toHaveLength(1);
    expect(filas[0].id).toBe(placas.id);
    expect(filas[0].cantCompra).toBe(46.08);
    expect(filas[0].editadoPor).toBe(usuarioId);
    expect(filas[0].estado).toBe('activo');
  });
});

describe('errores', () => {
  it('una lámina cuyo archivo no está queda en error, con detalle y sin excepción', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const [lamina] = await laminasDe(documento.id);

    await db
      .update(laminas)
      .set({ archivoRef: `${lamina.archivoRef}.no-existe` })
      .where(eq(laminas.id, lamina.id));

    await expect(procesarLamina(lamina.id, { db, storage })).resolves.toBeUndefined();

    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.estadoAnalisis).toBe('error');
    expect(despues.errorDetalle).toBeTruthy();
  });

  it('rechaza un archivo que no es PDF sin escribir nada', async () => {
    const archivo = new File([new Uint8Array([1, 2, 3])], 'planta.dwg', {
      type: 'application/acad',
    });

    await expect(subirDocumento(db, storage, obraId, usuarioId, archivo)).rejects.toThrow(
      /PDF/i,
    );
  });
});
