/**
 * Gestión de obras y documentos: archivar, editar, eliminar.
 *
 * Se testean los **núcleos** de `@/lib/obras/gestion` (no los envoltorios
 * `*Action`, que solo agregan `requireUser()` / `requireObra()` y
 * `revalidatePath()`): lo que hay que proteger es qué queda —y qué deja de
 * quedar— escrito en la base y en el storage.
 *
 * Estas son las únicas operaciones del producto que **borran filas**. El resto
 * del dominio es soft-delete (`src/db/CLAUDE.md` §7), así que los tests de acá
 * cuidan las dos cosas que el borrado físico puede romper: que se lleve todo lo
 * de la obra (sin dejar huérfanos ni archivos colgados) y que no toque nada de
 * otra obra ni de otro estudio (RNF-4).
 *
 * El flujo de datos es el real (`subirDocumento` + `procesarDocumento` con los
 * PDFs de `tests/fixtures/pdfs/`), como en `pipeline.test.ts`: un `delete`
 * armado a mano no ejercitaría las FKs que la obra tiene de verdad.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  computoItems,
  computoRubros,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Documento,
} from '@/db/schema';
import { ObraNoEncontradaError } from '@/lib/auth/guards';
import {
  archivarObra,
  desarchivarObra,
  DocumentoNoEncontradoError,
  editarObra,
  eliminarDocumento,
  eliminarObra,
  listarObras,
  ObraNoArchivadaError,
  RESPUESTA_DOCUMENTO_ELIMINADO,
  type ActorObra,
} from '@/lib/obras/gestion';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let estudioId: string;
let otroEstudioId: string;
let obraId: string;
let obraAjenaId: string;
let usuarioId: string;
let actor: ActorObra;

async function subirYProcesar(nombre: string, destino = obraId): Promise<Documento> {
  const bytes = await readFile(new URL(nombre, PDFS));
  const archivo = new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
  const documento = await subirDocumento(db, storage, destino, usuarioId, archivo);
  await procesarDocumento(documento.id, { db, storage });
  return documento;
}

/** Cuántas filas tiene cada tabla de la obra. Lo que el borrado tiene que dejar en cero. */
async function conteosDe(id: string) {
  const filas = async <T,>(promesa: Promise<T[]>) => (await promesa).length;
  return {
    documentos: await filas(db.select().from(documentos).where(eq(documentos.obraId, id))),
    laminas: await filas(db.select().from(laminas).where(eq(laminas.obraId, id))),
    entidades: await filas(db.select().from(entidades).where(eq(entidades.obraId, id))),
    computoItems: await filas(db.select().from(computoItems).where(eq(computoItems.obraId, id))),
    computoRubros: await filas(db.select().from(computoRubros).where(eq(computoRubros.obraId, id))),
    hallazgos: await filas(db.select().from(hallazgos).where(eq(hallazgos.obraId, id))),
    auditoria: await filas(db.select().from(auditoria).where(eq(auditoria.obraId, id))),
  };
}

function auditoriaDe(accion: string, id = obraId) {
  return db
    .select()
    .from(auditoria)
    .where(and(eq(auditoria.obraId, id), eq(auditoria.accion, accion)));
}

function itemPorClave(clave: string) {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, clave)))
    .then((filas) => filas[0]);
}

function hallazgoPorClave(clave: string) {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

/** `true` si el archivo ya no está en el storage. */
async function borrado(ref: string): Promise<boolean> {
  try {
    await storage.leer(ref);
    return false;
  } catch {
    return true;
  }
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-gestion-'));
  storage = crearStorageLocal(raizStorage);

  const [estudio, otro] = await db
    .insert(estudios)
    .values([{ nombre: 'Estudio Norte' }, { nombre: 'Estudio Sur' }])
    .returning();
  estudioId = estudio.id;
  otroEstudioId = otro.id;

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
  usuarioId = usuario.id;
  actor = { usuarioId: usuario.id, email: usuario.email };

  const [obra, ajena] = await db
    .insert(obras)
    .values([
      { estudioId: estudio.id, nombre: 'Casa Demo', zona: 'CABA', tipo: 'nueva' },
      { estudioId: otro.id, nombre: 'Ajena', zona: 'GBA', tipo: 'reforma' },
    ])
    .returning();
  obraId = obra.id;
  obraAjenaId = ajena.id;
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('archivar y desarchivar', () => {
  it('archivar la saca del listado default y desarchivar la devuelve', async () => {
    const inicial = await listarObras(db, estudioId);
    expect(inicial.obras.map((o) => o.id)).toEqual([obraId]);
    expect(inicial.activas).toBe(1);
    expect(inicial.archivadas).toBe(0);

    const archivada = await archivarObra(db, estudioId, obraId, actor);
    expect(archivada.estado).toBe('archivada');

    const soloActivas = await listarObras(db, estudioId);
    expect(soloActivas.obras).toEqual([]);
    expect(soloActivas.activas).toBe(0);
    expect(soloActivas.archivadas).toBe(1);

    const conArchivadas = await listarObras(db, estudioId, { archivadas: true });
    expect(conArchivadas.obras.map((o) => o.id)).toEqual([obraId]);
    expect(conArchivadas.archivadas).toBe(1);

    const auditadas = await auditoriaDe('obra_archivada');
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0].actorTipo).toBe('usuario');
    expect(auditadas[0].actorNombre).toBe('arq@estudionorte.ar');
    expect(auditadas[0].targetRef).toBe(`obras:${obraId}`);
    expect(auditadas[0].diffJson).toEqual({
      estado: { antes: 'activa', despues: 'archivada' },
    });

    const devuelta = await desarchivarObra(db, estudioId, obraId, actor);
    expect(devuelta.estado).toBe('activa');
    expect((await listarObras(db, estudioId)).obras.map((o) => o.id)).toEqual([obraId]);
    expect(await auditoriaDe('obra_desarchivada')).toHaveLength(1);
  });

  it('archivar una obra ya archivada es un no-op y no duplica la auditoría', async () => {
    await archivarObra(db, estudioId, obraId, actor);
    const repetida = await archivarObra(db, estudioId, obraId, actor);

    expect(repetida.estado).toBe('archivada');
    expect(await auditoriaDe('obra_archivada')).toHaveLength(1);

    await desarchivarObra(db, estudioId, obraId, actor);
    await desarchivarObra(db, estudioId, obraId, actor);
    expect(await auditoriaDe('obra_desarchivada')).toHaveLength(1);
  });

  it('no archiva una obra de otro estudio (RNF-4)', async () => {
    await expect(archivarObra(db, estudioId, obraAjenaId, actor)).rejects.toBeInstanceOf(
      ObraNoEncontradaError,
    );

    const [intacta] = await db.select().from(obras).where(eq(obras.id, obraAjenaId));
    expect(intacta.estado).toBe('activa');
    expect(await auditoriaDe('obra_archivada', obraAjenaId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('editarObra', () => {
  it('persiste el cambio y lo audita con el antes y el después', async () => {
    const resultado = await editarObra(
      db,
      estudioId,
      obraId,
      { nombre: '  Casa Belgrano  ', moneda: 'USD' },
      actor,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.obra.nombre).toBe('Casa Belgrano');
    expect(resultado.obra.moneda).toBe('USD');
    // Lo que no vino en el payload no se toca.
    expect(resultado.obra.zona).toBe('CABA');
    expect(resultado.obra.tipo).toBe('nueva');

    const [guardada] = await db.select().from(obras).where(eq(obras.id, obraId));
    expect(guardada.nombre).toBe('Casa Belgrano');
    expect(guardada.moneda).toBe('USD');

    const auditadas = await auditoriaDe('obra_editada');
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0].actorTipo).toBe('usuario');
    expect(auditadas[0].targetRef).toBe(`obras:${obraId}`);
    // Solo los campos que cambiaron.
    expect(auditadas[0].diffJson).toEqual({
      nombre: { antes: 'Casa Demo', despues: 'Casa Belgrano' },
      moneda: { antes: 'ARS', despues: 'USD' },
    });
  });

  it('rechaza un tipo de obra que no existe y no escribe nada', async () => {
    const resultado = await editarObra(db, estudioId, obraId, { tipo: 'demolicion' }, actor);

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.errores).toEqual({ tipo: 'Elegí si es obra nueva, reforma o ampliación.' });

    const [intacta] = await db.select().from(obras).where(eq(obras.id, obraId));
    expect(intacta.tipo).toBe('nueva');
    expect(await auditoriaDe('obra_editada')).toHaveLength(0);
  });

  it('sin cambios reales no escribe auditoría', async () => {
    const resultado = await editarObra(
      db,
      estudioId,
      obraId,
      { nombre: 'Casa Demo', zona: 'CABA' },
      actor,
    );

    expect(resultado.ok).toBe(true);
    expect(await auditoriaDe('obra_editada')).toHaveLength(0);
  });

  it('no edita una obra de otro estudio (RNF-4)', async () => {
    await expect(
      editarObra(db, estudioId, obraAjenaId, { nombre: 'Robada' }, actor),
    ).rejects.toBeInstanceOf(ObraNoEncontradaError);

    const [intacta] = await db.select().from(obras).where(eq(obras.id, obraAjenaId));
    expect(intacta.nombre).toBe('Ajena');
  });
});

// ---------------------------------------------------------------------------

describe('eliminarObra', () => {
  it('sobre una obra activa se niega y no borra nada', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    await expect(
      eliminarObra(db, storage, estudioId, obraId, actor),
    ).rejects.toBeInstanceOf(ObraNoArchivadaError);

    const conteos = await conteosDe(obraId);
    expect(conteos.documentos).toBe(1);
    expect(conteos.laminas).toBe(3);
    expect(await borrado(documento.archivoRef)).toBe(false);
  });

  it('sobre una archivada borra la obra entera, sus archivos y deja el rastro', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    await db.insert(computoRubros).values({ obraId, rubro: 'seco', estado: 'aprobado' });

    const refsLaminas = (
      await db.select({ ref: laminas.archivoRef }).from(laminas).where(eq(laminas.obraId, obraId))
    ).map((f) => f.ref);
    expect(refsLaminas).toHaveLength(3);

    const antes = await conteosDe(obraId);
    expect(antes.documentos).toBe(1);
    expect(antes.laminas).toBe(3);
    expect(antes.entidades).toBe(10);
    expect(antes.computoItems).toBeGreaterThan(0);
    expect(antes.computoRubros).toBe(1);
    expect(antes.auditoria).toBeGreaterThan(0);

    await archivarObra(db, estudioId, obraId, actor);
    const conteos = await eliminarObra(db, storage, estudioId, obraId, actor);

    expect(conteos.documentos).toBe(1);
    expect(conteos.laminas).toBe(3);
    expect(conteos.entidades).toBe(10);
    expect(conteos.computoItems).toBe(antes.computoItems);
    expect(conteos.computoRubros).toBe(1);
    expect(conteos.hallazgos).toBe(antes.hallazgos);
    expect(conteos.archivos).toBe(4); // el original + una lámina por página

    // Nada de la obra sobrevive, ni siquiera su auditoría (excepción documentada
    // a `src/db/CLAUDE.md` §7: una obra eliminada no deja registros huérfanos).
    expect(await conteosDe(obraId)).toEqual({
      documentos: 0,
      laminas: 0,
      entidades: 0,
      computoItems: 0,
      computoRubros: 0,
      hallazgos: 0,
      auditoria: 0,
    });
    expect(await db.select().from(obras).where(eq(obras.id, obraId))).toHaveLength(0);

    // Los archivos tampoco quedan colgados en el storage.
    expect(await borrado(documento.archivoRef)).toBe(true);
    for (const ref of refsLaminas) expect(await borrado(ref)).toBe(true);

    // La única fila que queda: el rastro de que la obra existió, sin `obra_id`.
    const rastro = await db
      .select()
      .from(auditoria)
      .where(and(isNull(auditoria.obraId), eq(auditoria.accion, 'obra_eliminada')));
    expect(rastro).toHaveLength(1);
    expect(rastro[0].actorTipo).toBe('usuario');
    expect(rastro[0].actorNombre).toBe('arq@estudionorte.ar');
    expect(rastro[0].targetRef).toBe('obras:Casa Demo');
    expect(rastro[0].diffJson).toMatchObject({
      obraId,
      nombre: 'Casa Demo',
      documentos: 1,
      laminas: 3,
      entidades: 10,
      computoRubros: 1,
      archivos: 4,
    });
  });

  it('no elimina la obra de otro estudio ni distingue si existe (RNF-4)', async () => {
    await db.update(obras).set({ estado: 'archivada' }).where(eq(obras.id, obraAjenaId));

    const ajena = eliminarObra(db, storage, estudioId, obraAjenaId, actor);
    await expect(ajena).rejects.toBeInstanceOf(ObraNoEncontradaError);

    // Un id que no existe da exactamente el mismo error: no se filtra existencia.
    const inexistente = eliminarObra(
      db,
      storage,
      estudioId,
      '11111111-1111-1111-1111-111111111111',
      actor,
    );
    await expect(inexistente).rejects.toBeInstanceOf(ObraNoEncontradaError);

    expect(await db.select().from(obras).where(eq(obras.id, obraAjenaId))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('eliminarDocumento', () => {
  it('se lleva sus láminas y entidades, y anula los ítems que dependían', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const refsLaminas = (
      await db
        .select({ ref: laminas.archivoRef })
        .from(laminas)
        .where(eq(laminas.documentoId, documento.id))
    ).map((f) => f.ref);

    expect((await itemPorClave('seco.placas'))?.estado).toBe('activo');

    const conteos = await eliminarDocumento(db, storage, estudioId, obraId, documento.id, actor);

    expect(conteos.laminas).toBe(3);
    expect(conteos.entidades).toBe(10);
    expect(conteos.archivos).toBe(4);

    expect(await db.select().from(documentos).where(eq(documentos.id, documento.id))).toHaveLength(0);
    expect(await db.select().from(laminas).where(eq(laminas.obraId, obraId))).toHaveLength(0);
    expect(await db.select().from(entidades).where(eq(entidades.obraId, obraId))).toHaveLength(0);

    // Los ítems NO se borran: quedan anulados (`src/db/CLAUDE.md` §7) y sin
    // entidad, porque la entidad que los respaldaba desapareció.
    const placas = await itemPorClave('seco.placas');
    expect(placas?.estado).toBe('anulado');
    expect(placas?.entidadId).toBeNull();
    const ladrillos = await itemPorClave('gruesa.ladrillos');
    expect(ladrillos?.estado).toBe('anulado');

    expect(await borrado(documento.archivoRef)).toBe(true);
    for (const ref of refsLaminas) expect(await borrado(ref)).toBe(true);

    const auditadas = await auditoriaDe('documento_eliminado');
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0].actorTipo).toBe('usuario');
    expect(auditadas[0].targetRef).toBe(`documentos:${documento.id}`);
    expect(auditadas[0].diffJson).toMatchObject({
      nombreArchivo: 'obra-demo.pdf',
      version: 1,
      laminas: 3,
      entidades: 10,
      archivos: 4,
    });
  });

  it('descarta el hallazgo de escala de sus láminas: el recompute no lo cierra', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');
    const [lamina] = await db
      .select()
      .from(laminas)
      .where(eq(laminas.documentoId, documento.id));
    expect((await hallazgoPorClave(`escala.${lamina.id}`))?.estado).toBe('abierto');

    const conteos = await eliminarDocumento(db, storage, estudioId, obraId, documento.id, actor);
    expect(conteos.hallazgosEscala).toBe(1);

    const cerrado = await hallazgoPorClave(`escala.${lamina.id}`);
    expect(cerrado?.estado).toBe('descartado');
    expect(cerrado?.respuestaJson).toEqual({ ...RESPUESTA_DOCUMENTO_ELIMINADO });
  });

  it('no toca los otros documentos de la obra ni las otras obras', async () => {
    const aBorrar = await subirYProcesar('sin-escala.pdf');
    const queda = await subirYProcesar('obra-demo.pdf');
    const ajeno = await subirYProcesar('obra-demo.pdf', obraAjenaId);

    await eliminarDocumento(db, storage, estudioId, obraId, aBorrar.id, actor);

    expect(await db.select().from(documentos).where(eq(documentos.id, queda.id))).toHaveLength(1);
    expect(
      await db.select().from(laminas).where(eq(laminas.documentoId, queda.id)),
    ).toHaveLength(3);
    // Los ítems del documento que queda siguen activos.
    expect((await itemPorClave('seco.placas'))?.estado).toBe('activo');
    expect(await borrado(queda.archivoRef)).toBe(false);

    expect(await db.select().from(documentos).where(eq(documentos.id, ajeno.id))).toHaveLength(1);
    expect(await borrado(ajeno.archivoRef)).toBe(false);
  });

  it('no borra un documento de otro estudio ni de otra obra', async () => {
    const ajeno = await subirYProcesar('obra-demo.pdf', obraAjenaId);

    // El documento existe, pero la obra no es del estudio de la sesión.
    await expect(
      eliminarDocumento(db, storage, estudioId, obraAjenaId, ajeno.id, actor),
    ).rejects.toBeInstanceOf(ObraNoEncontradaError);

    // Y con la obra correcta, el documento no es de esa obra.
    await expect(
      eliminarDocumento(db, storage, estudioId, obraId, ajeno.id, actor),
    ).rejects.toBeInstanceOf(DocumentoNoEncontradoError);

    expect(await db.select().from(documentos).where(eq(documentos.id, ajeno.id))).toHaveLength(1);
    expect(await borrado(ajeno.archivoRef)).toBe(false);
  });
});
