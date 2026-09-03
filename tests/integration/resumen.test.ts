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
import {
  auditoria,
  computoItems,
  datosObra,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
} from '@/db/schema';
import { crearProviderMock } from '@/lib/analysis/mock';
import { responderHallazgo } from '@/lib/bandeja/resolver';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { recomputarObra } from '@/lib/pipeline/recomputar';
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

describe('el resumen se refresca en cada recompute', () => {
  it('responder la consulta de escala deja el resumen contando la obra nueva', async () => {
    await subirYProcesar('sin-escala.pdf');

    const antes = await resumenGuardado();
    expect(antes.laminas.bloqueadas).toBe(1);
    expect(antes.consultas.abiertas).toBe(1);
    expect(antes.titular).toContain('1 lámina trabada');

    const [lamina] = await db.select().from(laminas).where(eq(laminas.obraId, obraId));
    const [hallazgo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, `escala.${lamina.id}`)));

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: hallazgo.id, valor: '1:20', nota: 'Verificado contra el tabique.' },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { storage, provider: crearProviderMock() },
    );
    expect(resultado.ok).toBe(true);

    // El recompute que dispara la respuesta rehace el resumen: sin esto, la
    // pantalla del expediente seguiría diciendo "1 lámina trabada".
    const despues = await resumenGuardado();
    expect(despues.laminas.bloqueadas).toBe(0);
    expect(despues.consultas.abiertas).toBe(0);
    expect(despues.titular).not.toContain('trabada');
    expect((await auditoriasDeResumen()).length).toBeGreaterThan(antes.consultas.abiertas);
  });

  it('procesar un documento publica UN solo resumen, no uno por lámina', async () => {
    await subirYProcesar('obra-demo.pdf'); // tres láminas, tres recomputes

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

// ---------------------------------------------------------------------------

describe('el alcance del resumen es el mismo que el de la planilla', () => {
  /**
   * Cuatro tabiques de PB sin altura acotada, más la altura de local declarada
   * una sola vez en `datos_obra` (§5.2). Es el caso que rompía en silencio: el
   * resumen vuelve a computar la obra en vez de leer `computo_items`, así que si
   * no recibe los datos de obra, el rubro entero desaparece del resumen mientras
   * la planilla lo muestra bien.
   */
  async function obraConAlturaEnDatosDeObra(): Promise<string> {
    const [documento] = await db
      .insert(documentos)
      .values({
        obraId,
        nombreArchivo: 'planta.pdf',
        tipo: 'plano',
        archivoRef: 'demo/planta.pdf',
        mime: 'application/pdf',
        hash: 'sha256-demo',
        subidoPor: usuarioId,
      })
      .returning();
    const [lamina] = await db
      .insert(laminas)
      .values({
        documentoId: documento.id,
        obraId,
        numeroPagina: 1,
        codigo: 'A-01',
        archivoRef: 'demo/planta-p1.pdf',
        estadoAnalisis: 'analizada',
        tipo: 'planta',
        escala: '1:100',
        escalaConfiable: true,
      })
      .returning();

    await db.insert(entidades).values(
      ['T1', 'T2', 'T3', 'T4'].map((nombre, i) => ({
        obraId,
        laminaId: lamina.id,
        tipo: 'tabique' as const,
        nombre,
        atributosJson: { largoM: 3, caras: 2, tipo: 'durlock', nivel: 'PB' },
        estadoReforma: 'nueva' as const,
        fuentesJson: [
          { laminaId: lamina.id, bbox: [0.1, 0.1 + i * 0.1, 0.3, 0.02] as [number, number, number, number] },
        ],
        confianza: 0.9,
      })),
    );
    return lamina.id;
  }

  it('incluye el rubro que solo computa gracias a un dato de obra', async () => {
    const laminaId = await obraConAlturaEnDatosDeObra();
    await db.insert(datosObra).values({
      obraId,
      clave: 'altura_local.PB',
      valorJson: { valor: 2.6, unidad: 'm' },
      origen: 'deducido',
      fuentesJson: [{ laminaId, bbox: [0.2, 0.3, 0.5, 0.4] }],
      confianza: 0.9,
    });

    await recomputarObra(obraId, { db });

    const resumen = await resumenGuardado();
    const seco = resumen.alcance.find((rubro) => rubro.rubro === 'seco');
    expect(seco?.items).toBe(6);
    // Y cuenta lo mismo que la planilla, que es el invariante entero.
    const items = await db
      .select({ clave: computoItems.claveItem })
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.estado, 'activo')));
    expect(items).toHaveLength(6);
  });

  it('sin el dato de obra el rubro no está en ninguno de los dos lados', async () => {
    await obraConAlturaEnDatosDeObra();

    await recomputarObra(obraId, { db });

    const resumen = await resumenGuardado();
    expect(resumen.alcance.find((rubro) => rubro.rubro === 'seco')).toBeUndefined();
    const items = await db
      .select({ clave: computoItems.claveItem })
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.estado, 'activo')));
    expect(items).toEqual([]);
  });
});
