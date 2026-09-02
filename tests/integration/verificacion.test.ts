/**
 * Doble pasada del cómputo (RF-306) sobre el pipeline real.
 *
 * El truco de los fixtures: la segunda pasada busca `<clave>-b.json` y, si no
 * está, usa el mismo fixture de la primera. Así los dos casos que importan se
 * pueden escribir sin red y sin azar:
 *
 *  - `obra-demo.pdf` **tiene** `obra-demo-p1-b.json` (el tabique T1 se lee 5,60 m
 *    en vez de 5,00 y la ventana V1 no aparece) ⇒ diferencias reportadas;
 *  - el mismo PDF subido como `casa-deduccion.pdf` usa fixtures **sin** `-b` ⇒
 *    las dos pasadas leen lo mismo y no hay ni una consulta.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  computoItems,
  entidades,
  estudios,
  hallazgos,
  obras,
  usuarios,
} from '@/db/schema';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import {
  ACCION_VERIFICACION,
  verificarComputo,
  type ActorVerificacion,
} from '@/lib/pipeline/verificacion';
import { RolInsuficienteError } from '@/lib/plataforma/roles';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let usuarioId: string;
let actor: ActorVerificacion;

/** Sube `obra-demo.pdf` bajo el nombre pedido (el nombre elige el fixture). */
async function subirYProcesar(nombre: string): Promise<void> {
  const bytes = await readFile(new URL('obra-demo.pdf', PDFS));
  const archivo = new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
  const documento = await subirDocumento(db, storage, obraId, usuarioId, archivo);
  await procesarDocumento(documento.id, { db, storage });
}

async function cantidadDe(claveItem: string): Promise<number> {
  const [fila] = await db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, claveItem)));
  return fila.cantCompra;
}

function hallazgoPorClave(clave: string) {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)));
}

function todosLosHallazgos() {
  return db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId)).orderBy(hallazgos.clave);
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-verificacion-'));
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
  actor = {
    usuarioId: usuario.id,
    email: usuario.email,
    rol: 'titular',
    activo: true,
  };
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

describe('con fixture -b que cambia una cantidad', () => {
  beforeEach(async () => {
    await subirYProcesar('obra-demo.pdf');
  });

  it('abre una consulta por el desvío, con los dos valores adentro', async () => {
    // Primera pasada: T1 mide 5,00 m ⇒ 26 m² de tabique ⇒ 31,68 m² de placa.
    expect(await cantidadDe('seco.placas')).toBe(31.68);

    const resultado = await verificarComputo(db, { storage }, actor, obraId);
    const [consulta] = await hallazgoPorClave('verificacion.seco.placas');

    // Segunda pasada: T1 mide 5,60 m ⇒ 29,12 m² ⇒ 12 placas ⇒ 34,56 m² (+9,09 %).
    const placas = resultado.diferencias.find((d) => d.claveItem === 'seco.placas');
    expect(placas).toBeDefined();
    expect(placas?.motivo).toBe('desvio');
    expect(placas?.cantComputo).toBe(31.68);
    expect(placas?.cantVerificacion).toBe(34.56);
    expect(placas?.desvioPct).toBe(9.09);

    expect(consulta.tipo).toBe('inconsistencia');
    expect(consulta.bloqueante).toBe(false);
    expect(consulta.estado).toBe('abierto');
    expect(consulta.descripcion).toContain('31,68 m²');
    expect(consulta.descripcion).toContain('34,56 m²');
    expect(consulta.descripcion).toContain('9,09 %');
    // Provenance: la consulta cita la lámina del ítem.
    expect(consulta.laminasJson.length).toBeGreaterThan(0);
  });

  it('reporta el ítem que una sola de las dos pasadas encontró', async () => {
    const resultado = await verificarComputo(db, { storage }, actor, obraId);

    const ventana = resultado.diferencias.find((d) => d.claveItem === 'aberturas.V1');
    expect(ventana?.motivo).toBe('solo_computo');
    expect(ventana?.cantComputo).toBe(1);
    expect(ventana?.cantVerificacion).toBeNull();

    const [consulta] = await hallazgoPorClave('verificacion.aberturas.V1');
    expect(consulta.bloqueante).toBe(false);
    expect(consulta.descripcion).toContain('no encontró');
    expect(consulta.descripcion).toContain('Ventana V1');
  });

  it('no toca el cómputo: la segunda pasada no persiste nada', async () => {
    const antes = await db.select().from(computoItems).where(eq(computoItems.obraId, obraId));
    await verificarComputo(db, { storage }, actor, obraId);
    const despues = await db.select().from(computoItems).where(eq(computoItems.obraId, obraId));

    expect(despues.map((fila) => [fila.claveItem, fila.cantCompra])).toEqual(
      antes.map((fila) => [fila.claveItem, fila.cantCompra]),
    );
  });

  it('es idempotente: correrla dos veces no duplica consultas ni las reabre', async () => {
    const primera = await verificarComputo(db, { storage }, actor, obraId);
    const segunda = await verificarComputo(db, { storage }, actor, obraId);

    expect(segunda.diferencias).toEqual(primera.diferencias);
    expect(segunda.hallazgosAbiertos).toBe(0);
    expect(segunda.hallazgosActualizados).toBe(0);
    expect(segunda.hallazgosCerrados).toBe(0);

    const claves = (await todosLosHallazgos())
      .filter((fila) => fila.clave.startsWith('verificacion.'))
      .map((fila) => fila.clave);
    expect(new Set(claves).size).toBe(claves.length);
    expect(claves.length).toBe(primera.diferencias.length);
  });

  it('deja la corrida en auditoría a nombre del usuario', async () => {
    await verificarComputo(db, { storage }, actor, obraId);

    const filas = await db
      .select()
      .from(auditoria)
      .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, ACCION_VERIFICACION)));

    expect(filas).toHaveLength(1);
    expect(filas[0].actorTipo).toBe('usuario');
    expect(filas[0].actorNombre).toBe('arq@estudionorte.ar');
    expect(filas[0].diffJson?.laminasLeidas).toBe(3);
  });

  it('el rol lectura no puede verificar', async () => {
    await expect(
      verificarComputo(db, { storage }, { ...actor, rol: 'lectura' }, obraId),
    ).rejects.toBeInstanceOf(RolInsuficienteError);

    expect(await todosLosHallazgos()).toHaveLength(0);
  });
});

describe('sin fixture -b', () => {
  it('las dos pasadas leen lo mismo y no hay ni una consulta', async () => {
    // `casa-deduccion-p1..p3` existen y no tienen `-b`: la segunda pasada cae al
    // mismo fixture, que es el contrato pinneado.
    await subirYProcesar('casa-deduccion.pdf');
    const previos = (await todosLosHallazgos()).length;

    const resultado = await verificarComputo(db, { storage }, actor, obraId);

    expect(resultado.laminasLeidas).toBe(3);
    expect(resultado.itemsComparados).toBeGreaterThan(0);
    expect(resultado.diferencias).toEqual([]);
    expect(resultado.hallazgosAbiertos).toBe(0);
    expect((await todosLosHallazgos()).length).toBe(previos);
  });
});

describe('el recompute no se lleva puestas las consultas de verificación', () => {
  it('sobreviven a un reproceso de las láminas', async () => {
    await subirYProcesar('obra-demo.pdf');
    await verificarComputo(db, { storage }, actor, obraId);

    const antes = (await todosLosHallazgos()).filter((fila) =>
      fila.clave.startsWith('verificacion.'),
    );
    expect(antes.length).toBeGreaterThan(0);

    const { recomputarObra } = await import('@/lib/pipeline/recomputar');
    await recomputarObra(obraId, { db });

    const despues = (await todosLosHallazgos()).filter((fila) =>
      fila.clave.startsWith('verificacion.'),
    );
    expect(despues.map((fila) => fila.estado)).toEqual(antes.map(() => 'abierto'));
  });
});

describe('la segunda pasada unifica igual que el cómputo', () => {
  /**
   * El T1 de la planta y el T1 del corte son UN tabique (§5.3), y el cruce se lo
   * escribe. La primera pasada lo cuenta una vez porque `recomputarObra`
   * unifica; la segunda lo contaba dos, porque `verificarComputo` computaba sin
   * unificar — y encima sus entidades sintéticas ni siquiera llevaban el
   * `elemento_id`. Resultado: «el cómputo dice 26 m² y la segunda lectura dice
   * 52», una consulta falsa por cada elemento que el cruce agrupó, pegada en la
   * bandeja hasta la verificación siguiente (`verificacion.*` es prefijo
   * protegido).
   */
  async function unificarLosT1(): Promise<string> {
    const elementoId = randomUUID();
    const filas = await db
      .select()
      .from(entidades)
      .where(and(eq(entidades.obraId, obraId), eq(entidades.nombre, 'T1')));
    expect(filas).toHaveLength(2);
    for (const fila of filas) {
      await db.update(entidades).set({ elementoId }).where(eq(entidades.id, fila.id));
    }
    const { recomputarObra } = await import('@/lib/pipeline/recomputar');
    await recomputarObra(obraId, { db });
    return elementoId;
  }

  it('no inventa un desvío del 100 % por cada elemento unificado', async () => {
    await subirYProcesar('casa-deduccion.pdf');
    await unificarLosT1();

    // 5,00 × 2,60 × 2 caras = 26 m² netos ⇒ 31,68 m² de compra. UNA vez.
    expect(await cantidadDe('seco.placas')).toBe(31.68);

    const resultado = await verificarComputo(db, { storage }, actor, obraId);

    expect(resultado.diferencias).toEqual([]);
    const abiertas = (await todosLosHallazgos()).filter((fila) =>
      fila.clave.startsWith('verificacion.'),
    );
    expect(abiertas).toEqual([]);
  });
});
