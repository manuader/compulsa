/**
 * Diff de revisiones (RF-308): qué le hizo a la planilla procesar un documento.
 *
 * `procesarDocumento` saca una foto de los ítems activos antes de tocar nada y
 * otra al terminar; lo que cambió queda en `recomputos.diff_json` con el mismo
 * diff campo a campo que el recompute deja en `auditoria`. La pantalla "Qué
 * cambió" del expediente lee la última fila.
 *
 * El fixture `obra-demo-p1-b.json` (el de la segunda pasada) se usa acá como
 * "revisión que cambió el plano": el tabique T1 pasa de 5,00 a 5,60 m y la
 * ventana V1 desaparece.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import { estudios, obras, recomputos, usuarios, type Documento } from '@/db/schema';
import { crearProviderMock, SUFIJO_SEGUNDA_PASADA } from '@/lib/analysis/mock';
import { archivarObra, eliminarObra } from '@/lib/obras/gestion';
import { procesarDocumento, subirDocumento, type DiffDeRevision } from '@/lib/pipeline/procesar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let usuarioId: string;
let estudioId: string;

/** El provider que lee la revisión: los fixtures `-b`. */
const providerRevisado = () => crearProviderMock(undefined, { sufijoClave: SUFIJO_SEGUNDA_PASADA });

async function subir(nombre: string): Promise<Documento> {
  const bytes = await readFile(new URL('obra-demo.pdf', PDFS));
  const archivo = new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
  return subirDocumento(db, storage, obraId, usuarioId, archivo);
}

function filasDeRecomputos() {
  return db
    .select()
    .from(recomputos)
    .where(eq(recomputos.obraId, obraId))
    .orderBy(desc(recomputos.at));
}

async function ultimoRecomputo() {
  const [fila] = await filasDeRecomputos();
  if (!fila) throw new Error('No se registró ningún recomputo.');
  return { motivo: fila.motivo, diff: fila.diffJson as unknown as DiffDeRevision };
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-revisiones-'));
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
  estudioId = estudio.id;
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

describe('primera subida', () => {
  it('registra los ítems que aparecieron', async () => {
    const documento = await subir('obra-demo.pdf');
    await procesarDocumento(documento.id, { db, storage });

    const { motivo, diff } = await ultimoRecomputo();

    expect(motivo).toBe('reproceso');
    expect(diff.documentoNombre).toBe('obra-demo.pdf');
    expect(diff.version).toBe(1);
    expect(diff.cambios.length).toBeGreaterThan(0);
    expect(diff.cambios.every((cambio) => cambio.estado === 'agregado')).toBe(true);
    expect(diff.cambios.every((cambio) => cambio.cantCompraAntes === null)).toBe(true);
    // Ordenado por clave: la pantalla lo muestra tal cual.
    expect(diff.cambios.map((cambio) => cambio.claveItem)).toEqual(
      [...diff.cambios.map((cambio) => cambio.claveItem)].sort((a, b) => a.localeCompare(b, 'es-AR')),
    );
  });
});

describe('reproceso con el plano cambiado', () => {
  it('deja el antes y el después de cada ítem que se movió', async () => {
    const documento = await subir('obra-demo.pdf');
    await procesarDocumento(documento.id, { db, storage });
    await procesarDocumento(documento.id, { db, storage, provider: providerRevisado() });

    const { motivo, diff } = await ultimoRecomputo();
    expect(motivo).toBe('reproceso');
    expect(await filasDeRecomputos()).toHaveLength(2);

    // T1 pasa de 5,00 a 5,60 m: la placa de yeso pasa de 31,68 a 34,56 m².
    const placas = diff.cambios.find((cambio) => cambio.claveItem === 'seco.placas');
    expect(placas?.estado).toBe('modificado');
    expect(placas?.cantCompraAntes).toBe(31.68);
    expect(placas?.cantCompraDespues).toBe(34.56);
    expect(placas?.campos.cantCompra).toEqual({ antes: 31.68, despues: 34.56 });

    // La ventana V1 ya no está en el plano: su ítem se anula.
    const ventana = diff.cambios.find((cambio) => cambio.claveItem === 'aberturas.V1');
    expect(ventana?.estado).toBe('anulado');
    expect(ventana?.cantCompraAntes).toBe(1);
    expect(ventana?.cantCompraDespues).toBeNull();
  });

  it('un reproceso que no mueve nada no escribe una fila', async () => {
    const documento = await subir('obra-demo.pdf');
    await procesarDocumento(documento.id, { db, storage });
    expect(await filasDeRecomputos()).toHaveLength(1);

    await procesarDocumento(documento.id, { db, storage });

    expect(await filasDeRecomputos()).toHaveLength(1);
  });
});

describe('la purga de la obra se lleva los recomputos', () => {
  it('eliminar una obra archivada no se traba con las filas de recomputos', async () => {
    const documento = await subir('obra-demo.pdf');
    await procesarDocumento(documento.id, { db, storage });
    expect(await filasDeRecomputos()).toHaveLength(1);

    // `recomputos.obra_id` es una FK NOT NULL: si la purga no las borra, el
    // `delete from obras` falla y la obra queda a medio eliminar.
    const actor = { usuarioId, email: 'arq@estudionorte.ar', rol: 'titular' as const, activo: true };
    await archivarObra(db, estudioId, obraId, actor);
    await eliminarObra(db, storage, estudioId, obraId, actor);

    expect(await filasDeRecomputos()).toHaveLength(0);
    expect(await db.select().from(obras).where(eq(obras.id, obraId))).toHaveLength(0);
  });
});

describe('versión nueva del mismo archivo', () => {
  it('queda registrada como revisión nueva', async () => {
    const primero = await subir('obra-demo.pdf');
    await procesarDocumento(primero.id, { db, storage });

    // Mismo nombre ⇒ versión 2, documento aparte (los originales son inmutables).
    const segundo = await subir('obra-demo.pdf');
    expect(segundo.version).toBe(2);
    await procesarDocumento(segundo.id, { db, storage, provider: providerRevisado() });

    const { motivo, diff } = await ultimoRecomputo();

    expect(motivo).toBe('revision_nueva');
    expect(diff.documentoId).toBe(segundo.id);
    expect(diff.version).toBe(2);
    expect(diff.cambios.length).toBeGreaterThan(0);
  });
});
