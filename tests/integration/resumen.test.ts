/**
 * Resumen ejecutivo de la obra (RF-205) sobre el pipeline real.
 *
 * Los números están pinneados contra `obra-demo.pdf` y sus fixtures: el resumen
 * es determinístico y sin LLM, así que un cambio en el motor de cómputo o en las
 * plantillas de rubro tiene que aparecer acá como un diff explícito, no como un
 * párrafo que dice algo distinto cada vez.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import { auditoria, estudios, laminas, obras, usuarios } from '@/db/schema';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { leerResumen, persistirResumen, type ResumenObra } from '@/lib/pipeline/resumen';
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

async function resumenGuardado(): Promise<ResumenObra> {
  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  const resumen = leerResumen(obra);
  if (resumen === null) throw new Error('La obra quedó sin resumen.');
  return resumen;
}

function auditoriasDeResumen() {
  return db
    .select()
    .from(auditoria)
    .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, 'resumen_generado')));
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-resumen-'));
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

describe('resumen de obra-demo.pdf', () => {
  it('queda persistido en obras.resumen_json con los números de la obra', async () => {
    await subirYProcesar('obra-demo.pdf');
    const resumen = await resumenGuardado();

    expect(resumen.titular).toBe(
      'Obra nueva con 3 láminas; 4 rubros computados (aberturas, construcción en seco, ' +
        'pintura, obra gruesa); sin consultas abiertas.',
    );
    expect(resumen.obra).toEqual({ nombre: 'Casa Demo', tipo: 'nueva', zona: 'CABA' });

    expect(resumen.laminas.total).toBe(3);
    expect(resumen.laminas.analizadas).toBe(3);
    expect(resumen.laminas.bloqueadas).toBe(0);
    expect(resumen.laminas.pendientes).toBe(0);
    expect(resumen.laminas.conError).toBe(0);
    expect(resumen.laminas.porDisciplina).toEqual([{ disciplina: 'arquitectura', cantidad: 3 }]);
    expect(resumen.laminas.porTipo).toEqual([
      { tipo: 'planta', cantidad: 1 },
      { tipo: 'corte', cantidad: 1 },
      { tipo: 'planilla', cantidad: 1 },
    ]);
  });

  it('el alcance lista los rubros con ítems, en el orden del dominio', async () => {
    await subirYProcesar('obra-demo.pdf');
    const { alcance } = await resumenGuardado();

    expect(alcance.map((entrada) => entrada.rubro)).toEqual([
      'aberturas',
      'seco',
      'pintura',
      'gruesa',
    ]);
    expect(alcance.map((entrada) => entrada.items)).toEqual([3, 6, 2, 4]);
    expect(alcance[0].ejemplos).toEqual([
      'Puerta P1 (0,80 × 2,05 m)',
      'Puerta P2 (0,80 × 2,05 m)',
      'Ventana V1 (1,50 × 1,10 m)',
    ]);
  });

  it('nombra lo que el legajo no tiene: disciplinas y tipos ausentes', async () => {
    await subirYProcesar('obra-demo.pdf');
    const { documentacion } = await resumenGuardado();

    expect(documentacion.disciplinasPresentes).toEqual(['arquitectura']);
    expect(documentacion.disciplinasAusentes).toEqual(['estructura', 'instalaciones', 'otra']);
    expect(documentacion.tiposAusentes).toEqual(['vista', 'detalle', 'otra']);
    expect(documentacion.trabadas).toEqual([]);
  });

  it('es determinístico: correrlo de nuevo no reescribe ni audita', async () => {
    await subirYProcesar('obra-demo.pdf');
    const primero = await resumenGuardado();
    expect(await auditoriasDeResumen()).toHaveLength(1);

    const segundo = await persistirResumen(db, obraId);

    expect(segundo).toEqual(primero);
    expect(await auditoriasDeResumen()).toHaveLength(1);
  });
});

describe('resumen de una obra con una lámina trabada', () => {
  it('cuenta la lámina bloqueada, explica por qué y destaca la consulta bloqueante', async () => {
    await subirYProcesar('sin-escala.pdf');
    const resumen = await resumenGuardado();
    const [lamina] = await db.select().from(laminas).where(eq(laminas.obraId, obraId));

    expect(resumen.laminas.total).toBe(1);
    expect(resumen.laminas.analizadas).toBe(0);
    expect(resumen.laminas.bloqueadas).toBe(1);
    expect(resumen.alcance).toEqual([]);

    expect(resumen.documentacion.trabadas).toEqual([
      {
        laminaId: lamina.id,
        codigo: null,
        titulo: null,
        estado: 'bloqueada_escala',
        motivo:
          'Sin escala confiable: no se computa hasta que cargues la escala o una medida de referencia.',
      },
    ]);

    expect(resumen.consultas.abiertas).toBe(1);
    expect(resumen.consultas.bloqueantes).toBe(1);
    expect(resumen.consultas.destacadas).toEqual([
      {
        clave: `escala.${lamina.id}`,
        descripcion:
          'La lámina no tiene escala confiable; indicá la escala o una medida de referencia.',
        bloqueante: true,
      },
    ]);
    expect(resumen.titular).toBe(
      'Obra nueva con 1 lámina; sin cómputo todavía; 1 lámina trabada; 1 consulta abierta.',
    );
  });
});
