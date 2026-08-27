/**
 * Búsqueda dirigida de punta a punta, sobre `obra-busqueda.pdf`.
 *
 * La obra del fixture es el reclamo del arquitecto reducido a dos páginas: una
 * planta (A-01) con la puerta FP01 dibujada **sin acotar**, y una planilla de
 * carpinterías (DET00) que —como toda planilla— no produce entidades. El
 * cómputo abre `aberturas.medidas_vano.FP01` bloqueante y le pregunta al
 * arquitecto un ancho y un alto que están escritos en DET00.
 *
 * El fixture está armado para que la deducción `planilla_plano` **no** pueda
 * disparar (hay una sola entidad FP01, no dos con el mismo tag en láminas
 * distintas): el único camino hasta ese dato es la búsqueda dirigida.
 *
 * El provider es SIEMPRE el mock (`NODE_ENV=test`), que lee
 * `tests/fixtures/analysis/busqueda/obra-busqueda-p2.json`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Hallazgo,
  type Lamina,
} from '@/db/schema';
import type { BusquedaProvider } from '@/lib/analysis/busqueda-tipos';
import { buscarDatosFaltantes, MAX_LAMINAS_POR_BUSQUEDA } from '@/lib/pipeline/busqueda';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

/** La consulta que la búsqueda tiene que poder contestar. */
const CLAVE = 'aberturas.medidas_vano.FP01';

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let usuarioId: string;

async function subirYProcesar(nombre: string): Promise<void> {
  const bytes = await readFile(new URL(nombre, PDFS));
  const archivo = new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
  const documento = await subirDocumento(db, storage, obraId, usuarioId, archivo);
  // Sin `buscar` en `deps`: el hook automático es de T2. Acá la búsqueda se
  // dispara explícita, que es lo que este archivo testea.
  await procesarDocumento(documento.id, { db, storage });
}

function hallazgoPorClave(clave: string): Promise<Hallazgo | undefined> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

function laminasDeLaObra(): Promise<Lamina[]> {
  return db
    .select()
    .from(laminas)
    .where(eq(laminas.obraId, obraId))
    .orderBy(laminas.numeroPagina);
}

function todaLaAuditoria(): Promise<Array<{ accion: string; targetRef: string | null }>> {
  return db
    .select({ accion: auditoria.accion, targetRef: auditoria.targetRef })
    .from(auditoria)
    .where(eq(auditoria.obraId, obraId));
}

/** Provider que cuenta las llamadas sin encontrar nada: mide el cap y el corte. */
function providerQueCuenta(llamadas: string[]): BusquedaProvider {
  return {
    async buscarDatos(lamina) {
      llamadas.push(`${lamina.documentoNombre}#${lamina.numeroPagina}`);
      return [];
    },
  };
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-busqueda-'));
  storage = crearStorageLocal(raizStorage);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Sur' }).returning();
  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'arq@estudiosur.ar',
      nombre: 'Ana Arquitecta',
      passwordHash: 'x',
      rol: 'titular',
    })
    .returning();
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Búsqueda', zona: 'CABA', tipo: 'nueva' })
    .returning();

  usuarioId = usuario.id;
  obraId = obra.id;

  await subirYProcesar('obra-busqueda.pdf');
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

describe('el punto de partida: la consulta que el arquitecto no debería tener que contestar', () => {
  it('FP01 queda sin medidas y con la consulta abierta, sin propuesta', async () => {
    const lams = await laminasDeLaObra();
    expect(lams.map((l) => l.codigo)).toEqual(['A-01', 'DET00']);
    expect(lams.map((l) => l.tipo)).toEqual(['planta', 'planilla']);
    expect(lams.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada']);

    const [fp01] = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(fp01.nombre).toBe('FP01');
    expect(fp01.atributosJson.anchoM).toBeUndefined();
    expect(fp01.atributosJson.altoM).toBeUndefined();

    const consulta = await hallazgoPorClave(CLAVE);
    expect(consulta?.estado).toBe('abierto');
    expect(consulta?.bloqueante).toBe(true);
    expect(consulta?.valorPropuestoJson).toBeNull();
    expect(consulta?.targetRef?.campos).toEqual(['anchoM', 'altoM']);
  });
});

describe('buscarDatosFaltantes', () => {
  it('encuentra las medidas en la planilla con UNA sola llamada', async () => {
    const resultado = await buscarDatosFaltantes(obraId, { db, storage });

    expect(resultado).toEqual({
      objetivos: 1,
      laminasConsultadas: 1,
      propuestos: 1,
      sinResultado: 0,
    });
  });

  it('deja el ancho y el alto propuestos, con lámina y bbox, sin cerrar la consulta', async () => {
    await buscarDatosFaltantes(obraId, { db, storage });

    const [, det00] = await laminasDeLaObra();
    const consulta = await hallazgoPorClave(CLAVE);

    expect(consulta?.estado).toBe('abierto');
    expect(consulta?.valorPropuestoJson).toEqual({
      valores: { anchoM: 0.9, altoM: 2.05 },
      fuente: { laminaId: det00.id, bbox: [0.1, 0.3, 0.3, 0.04] },
      confianza: 0.85,
      origen: 'busqueda_dirigida',
    });
  });

  it('NO escribe el dato en la entidad (P4): entra recién cuando el arquitecto confirma', async () => {
    await buscarDatosFaltantes(obraId, { db, storage });

    const [fp01] = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(fp01.atributosJson).toEqual({ tag: 'FP01', tipologia: 'puerta' });
    expect(fp01.confianza).toBe(0.9);
  });

  it('audita la propuesta y la corrida', async () => {
    await buscarDatosFaltantes(obraId, { db, storage });

    const filas = await todaLaAuditoria();
    expect(filas.filter((f) => f.accion === 'hallazgo_valor_propuesto')).toEqual([
      { accion: 'hallazgo_valor_propuesto', targetRef: `hallazgos:${CLAVE}` },
    ]);
    expect(filas.filter((f) => f.accion === 'busqueda_dirigida')).toEqual([
      { accion: 'busqueda_dirigida', targetRef: `obras:${obraId}` },
    ]);
  });

  it('la segunda corrida no busca nada ni escribe una línea de auditoría', async () => {
    await buscarDatosFaltantes(obraId, { db, storage });
    const antes = (await todaLaAuditoria()).length;

    const resultado = await buscarDatosFaltantes(obraId, { db, storage });

    expect(resultado).toEqual({
      objetivos: 0,
      laminasConsultadas: 0,
      propuestos: 0,
      sinResultado: 0,
    });
    expect((await todaLaAuditoria()).length).toBe(antes);
  });

  it('un recompute posterior no borra la propuesta (decisión 8)', async () => {
    await buscarDatosFaltantes(obraId, { db, storage });
    const propuesta = (await hallazgoPorClave(CLAVE))?.valorPropuestoJson;

    await recomputarObra(obraId, { db });
    await recomputarObra(obraId, { db });

    const despues = await hallazgoPorClave(CLAVE);
    expect(despues?.estado).toBe('abierto');
    expect(despues?.valorPropuestoJson).toEqual(propuesta);
  });

  it('no toca una consulta que el arquitecto ya respondió', async () => {
    const consulta = await hallazgoPorClave(CLAVE);
    await db
      .update(hallazgos)
      .set({ estado: 'respondido', respuestaJson: { anchoM: 1.2 }, resueltoPor: usuarioId })
      .where(eq(hallazgos.id, consulta!.id));

    const resultado = await buscarDatosFaltantes(obraId, { db, storage });

    expect(resultado.objetivos).toBe(0);
    const despues = await hallazgoPorClave(CLAVE);
    expect(despues?.estado).toBe('respondido');
    expect(despues?.valorPropuestoJson).toBeNull();
  });

  it('tampoco una descartada', async () => {
    const consulta = await hallazgoPorClave(CLAVE);
    await db
      .update(hallazgos)
      .set({ estado: 'descartado' })
      .where(eq(hallazgos.id, consulta!.id));

    expect((await buscarDatosFaltantes(obraId, { db, storage })).objetivos).toBe(0);
    expect((await hallazgoPorClave(CLAVE))?.valorPropuestoJson).toBeNull();
  });

  it('no busca el campo que la entidad ya tiene', async () => {
    const [fp01] = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    await db
      .update(entidades)
      .set({ atributosJson: { ...fp01.atributosJson, anchoM: 1.1 } })
      .where(eq(entidades.id, fp01.id));

    const llamadas: string[] = [];
    await buscarDatosFaltantes(obraId, {
      db,
      storage,
      provider: {
        async buscarDatos(lamina, objetivos) {
          llamadas.push(objetivos.flatMap((o) => o.campos).join(','));
          return [];
        },
      },
    });

    expect(llamadas).toEqual(['altoM', 'altoM']);
  });

  it('lee las planillas primero y frena cuando no queda nada pendiente', async () => {
    // Sin resultados no hay corte: las dos candidatas se leen, planilla primero.
    const llamadas: string[] = [];
    const resultado = await buscarDatosFaltantes(obraId, {
      db,
      storage,
      provider: providerQueCuenta(llamadas),
    });

    expect(llamadas).toEqual(['obra-busqueda.pdf#2', 'obra-busqueda.pdf#1']);
    expect(resultado).toEqual({
      objetivos: 1,
      laminasConsultadas: 2,
      propuestos: 0,
      sinResultado: 1,
    });
    expect((await hallazgoPorClave(CLAVE))?.valorPropuestoJson).toBeNull();
  });

  it('nunca lee más de MAX_LAMINAS_POR_BUSQUEDA láminas', async () => {
    expect(MAX_LAMINAS_POR_BUSQUEDA).toBe(8);

    const llamadas: string[] = [];
    await buscarDatosFaltantes(obraId, {
      db,
      storage,
      provider: providerQueCuenta(llamadas),
    });

    expect(llamadas.length).toBeLessThanOrEqual(MAX_LAMINAS_POR_BUSQUEDA);
  });

  it('una obra sin consultas con target no gasta una llamada ni una auditoría', async () => {
    await db.update(hallazgos).set({ estado: 'descartado' }).where(eq(hallazgos.obraId, obraId));
    const antes = (await todaLaAuditoria()).length;

    const llamadas: string[] = [];
    const resultado = await buscarDatosFaltantes(obraId, {
      db,
      storage,
      provider: providerQueCuenta(llamadas),
    });

    expect(llamadas).toEqual([]);
    expect(resultado.objetivos).toBe(0);
    expect((await todaLaAuditoria()).length).toBe(antes);
  });

  it('una obra que no existe explota con ObraInexistenteError', async () => {
    const [otra] = await db.select().from(obras).where(eq(obras.id, obraId));
    expect(otra).toBeDefined();
    await expect(
      buscarDatosFaltantes('00000000-0000-0000-0000-000000000000', { db, storage }),
    ).rejects.toThrow(/No existe la obra/);
  });
});
