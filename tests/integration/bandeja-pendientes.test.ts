/**
 * Qué número muestra el badge de «Bandeja», y sobre todo qué **no** muestra.
 *
 * El contador ya se equivocó una vez: cuando la pantalla de deducciones se mudó
 * a la solapa «Para revisar» (§5.8), el badge —que contaba deducciones
 * `propuesta`— pasó a contar consultas abiertas, y una deducción bajo umbral
 * esperando un visto bueno se quedó sin ninguna señal en la navegación de la
 * obra: invisible hasta que alguien entrara a mirar.
 *
 * Las dos mitades que cuentan son las que **bajan a cero** al decidirse. Lo ya
 * aplicado —auto-validadas e inferidos— no entra: un badge que no baja a cero
 * deja de leerse a la semana.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  deducciones,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
} from '@/db/schema';
import { contarPendientes, detallePendientes } from '@/lib/bandeja/pendientes';
import type { EstadoDeduccion, EstadoHallazgo } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let obraId: string;
let otraObraId: string;
let usuarioId: string;
let laminaId: string;
let entidadId: string;

async function abrirConsulta(clave: string, estado: EstadoHallazgo): Promise<void> {
  await db.insert(hallazgos).values({
    obraId,
    tipo: 'faltante',
    rubro: 'seco',
    descripcion: `Falta ${clave}`,
    clave,
    estado,
    bloqueante: true,
    laminasJson: [],
  });
}

async function deducir(campo: string, estado: EstadoDeduccion, validadoPor: string | null): Promise<void> {
  await db.insert(deducciones).values({
    obraId,
    entidadId,
    campo,
    regla: 'planta_corte',
    valorJson: { [campo]: 2.6 },
    fuentesJson: [{ laminaId, bbox: [0.1, 0.1, 0.2, 0.05] }],
    confianza: 0.81,
    estado,
    validadoPor,
  });
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

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
  usuarioId = usuario.id;

  const [obra, otra] = await db
    .insert(obras)
    .values([
      { estudioId: estudio.id, nombre: 'Casa PB', zona: 'CABA', tipo: 'nueva' },
      { estudioId: estudio.id, nombre: 'Casa Vecina', zona: 'CABA', tipo: 'nueva' },
    ])
    .returning();
  obraId = obra.id;
  otraObraId = otra.id;

  const [documento] = await db
    .insert(documentos)
    .values({
      obraId: obra.id,
      nombreArchivo: 'obra.pdf',
      tipo: 'plano',
      archivoRef: 'demo/obra.pdf',
      mime: 'application/pdf',
      hash: 'sha256-demo',
      subidoPor: usuario.id,
    })
    .returning();
  const [lamina] = await db
    .insert(laminas)
    .values({
      documentoId: documento.id,
      obraId: obra.id,
      numeroPagina: 1,
      codigo: 'A-01',
      archivoRef: 'demo/obra-p1.pdf',
      estadoAnalisis: 'analizada' as const,
      tipo: 'planta' as const,
      escala: '1:100',
      escalaConfiable: true,
    })
    .returning();
  laminaId = lamina.id;

  const [entidad] = await db
    .insert(entidades)
    .values({
      obraId: obra.id,
      laminaId: lamina.id,
      tipo: 'tabique' as const,
      nombre: 'T1',
      atributosJson: { largoM: 3 },
      estadoReforma: 'nueva' as const,
      fuentesJson: [{ laminaId: lamina.id, bbox: [0.1, 0.1, 0.3, 0.02] }],
      confianza: 0.9,
    })
    .returning();
  entidadId = entidad.id;
});

describe('contarPendientes', () => {
  it('sin nada pendiente el badge no se muestra', async () => {
    expect(await contarPendientes(db, obraId)).toEqual({
      consultas: 0,
      revisiones: 0,
      total: 0,
    });
  });

  it('cuenta las consultas abiertas y no las resueltas', async () => {
    await abrirConsulta('seco.largo.T1', 'abierto');
    await abrirConsulta('seco.largo.T2', 'abierto');
    await abrirConsulta('seco.largo.T3', 'respondido');
    await abrirConsulta('seco.largo.T4', 'descartado');

    expect(await contarPendientes(db, obraId)).toEqual({
      consultas: 2,
      revisiones: 0,
      total: 2,
    });
  });

  it('cuenta las deducciones propuesta: son la cola de «Para revisar»', async () => {
    await deducir('alturaM', 'propuesta', null);

    expect(await contarPendientes(db, obraId)).toEqual({
      consultas: 0,
      revisiones: 1,
      total: 1,
    });
  });

  it('lo ya aplicado NO entra: un badge que no baja a cero deja de leerse', async () => {
    await deducir('alturaM', 'validada', null); // la aplicó el sistema (§5.4)
    await deducir('caras', 'validada', usuarioId); // la validó una persona
    await deducir('largoM', 'rechazada', usuarioId); // es historia

    expect(await contarPendientes(db, obraId)).toEqual({
      consultas: 0,
      revisiones: 0,
      total: 0,
    });
  });

  it('el total suma las dos mitades', async () => {
    await abrirConsulta('seco.largo.T1', 'abierto');
    await abrirConsulta('seco.largo.T2', 'abierto');
    await abrirConsulta('seco.largo.T3', 'abierto');
    await deducir('alturaM', 'propuesta', null);
    await deducir('caras', 'propuesta', null);

    expect(await contarPendientes(db, obraId)).toEqual({
      consultas: 3,
      revisiones: 2,
      total: 5,
    });
  });

  it('la obra de al lado no suma (RNF-4)', async () => {
    await abrirConsulta('seco.largo.T1', 'abierto');

    expect((await contarPendientes(db, otraObraId)).total).toBe(0);
  });
});

describe('detallePendientes', () => {
  it('desglosa las dos mitades: un número solo deja buscando la otra', () => {
    expect(detallePendientes({ consultas: 3, revisiones: 2, total: 5 })).toBe(
      '3 consultas abiertas en «Preguntas» · 2 deducciones esperando tu visto bueno en «Para revisar»',
    );
  });

  it('la mitad en cero no se nombra', () => {
    expect(detallePendientes({ consultas: 3, revisiones: 0, total: 3 })).toBe(
      '3 consultas abiertas en «Preguntas»',
    );
    expect(detallePendientes({ consultas: 0, revisiones: 1, total: 1 })).toBe(
      '1 deducción esperando tu visto bueno en «Para revisar»',
    );
  });

  it('singular y plural en es-AR', () => {
    expect(detallePendientes({ consultas: 1, revisiones: 0, total: 1 })).toBe(
      '1 consulta abierta en «Preguntas»',
    );
  });

  it('sin nada pendiente lo dice, no devuelve vacío', () => {
    expect(detallePendientes({ consultas: 0, revisiones: 0, total: 0 })).toBe(
      'No hay nada esperando una decisión',
    );
  });
});
