import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { registrarAuditoria } from '@/lib/audit';
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
} from '@/db/schema';
import { getStorage } from '@/lib/storage';
import type { Fuente } from '@/types/domain';
import { createTestDb } from '../helpers/test-db';

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

/**
 * Espera que `accion` falle por violación de unicidad (SQLSTATE 23505) y
 * devuelve el nombre de la constraint. Drizzle envuelve el error del driver en
 * uno con el SQL fallido; el detalle de Postgres viaja en `cause`.
 */
async function violacionUnica(accion: Promise<unknown>): Promise<string> {
  try {
    await accion;
  } catch (error) {
    const causa = (error as Error).cause as {
      code?: string;
      message?: string;
      constraint?: string;
      constraint_name?: string;
    };
    expect(causa?.code).toBe('23505');
    return (
      causa.constraint_name ??
      causa.constraint ??
      /unique constraint "([^"]+)"/.exec(causa.message ?? '')?.[1] ??
      ''
    );
  }
  throw new Error('Se esperaba una violación de unicidad y la inserción pasó.');
}

/** Crea el andamiaje mínimo (estudio + titular + obra) que casi todo test necesita. */
async function sembrarObra(nombreEstudio = 'Estudio Norte', email = 'ana@estudionorte.ar') {
  const [estudio] = await db.insert(estudios).values({ nombre: nombreEstudio }).returning();
  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email,
      nombre: 'Ana Beltrán',
      passwordHash: 'scrypt$no-usado-en-este-test',
      rol: 'titular',
    })
    .returning();
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Belgrano', zona: 'CABA', tipo: 'reforma' })
    .returning();
  return { estudio, usuario, obra };
}

describe('esquema: cadena estudio → obra → documento → lámina → entidad → ítem', () => {
  it('persiste la cadena completa con provenance y la lee de vuelta', async () => {
    const { estudio, usuario, obra } = await sembrarObra();

    expect(obra.estudioId).toBe(estudio.id);
    expect(obra.moneda).toBe('ARS');
    expect(obra.estado).toBe('activa');
    expect(obra.tipo).toBe('reforma');

    const [documento] = await db
      .insert(documentos)
      .values({
        obraId: obra.id,
        nombreArchivo: 'obra-demo.pdf',
        tipo: 'plano',
        archivoRef: `obras/${obra.id}/documentos/obra-demo.pdf`,
        mime: 'application/pdf',
        hash: 'e3b0c44298fc1c14',
        subidoPor: usuario.id,
      })
      .returning();

    expect(documento.version).toBe(1);

    const [lamina] = await db
      .insert(laminas)
      .values({
        documentoId: documento.id,
        obraId: obra.id,
        numeroPagina: 3,
        codigo: 'A-01',
        titulo: 'Planta baja',
        disciplina: 'arquitectura',
        tipo: 'planta',
        escala: '1:100',
        escalaConfiable: true,
        revision: 'B',
        archivoRef: `obras/${obra.id}/laminas/${documento.id}-p3.pdf`,
      })
      .returning();

    expect(lamina.numeroPagina).toBe(3);
    expect(lamina.estadoAnalisis).toBe('pendiente');

    const fuentes: Fuente[] = [
      { laminaId: lamina.id, bbox: [0.125, 0.25, 0.5, 0.125], detalle: 'cota 5,00 m' },
    ];

    const [entidad] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'tabique',
        nombre: 'T1',
        atributosJson: { largoM: 5, alturaM: 2.6, caras: 2, tipo: 'durlock' },
        estadoReforma: 'nueva',
        fuentesJson: fuentes,
        confianza: 0.75,
      })
      .returning();

    const [item] = await db
      .insert(computoItems)
      .values({
        obraId: obra.id,
        rubro: 'seco',
        entidadId: entidad.id,
        claveItem: 'seco.placas',
        descripcion: 'Placa de yeso 12,5 mm',
        unidad: 'm2',
        cantNeta: 26,
        desperdicioPct: 12,
        cantCompra: 31.68,
        presentacion: 'placa 1,20 × 2,40 m (2,88 m²)',
        origen: 'deducido',
        fuentesJson: fuentes,
        confianza: 0.75,
      })
      .returning();

    // Lectura de vuelta: recorre la cadena entera por FKs.
    const [fila] = await db
      .select({
        obraNombre: obras.nombre,
        documentoNombre: documentos.nombreArchivo,
        laminaCodigo: laminas.codigo,
        entidadNombre: entidades.nombre,
        entidadAtributos: entidades.atributosJson,
        entidadEstadoReforma: entidades.estadoReforma,
        itemClave: computoItems.claveItem,
        itemCantNeta: computoItems.cantNeta,
        itemDesperdicio: computoItems.desperdicioPct,
        itemCantCompra: computoItems.cantCompra,
        itemUnidad: computoItems.unidad,
        itemOrigen: computoItems.origen,
        itemEstado: computoItems.estado,
        itemEditadoPor: computoItems.editadoPor,
        itemFuentes: computoItems.fuentesJson,
        itemConfianza: computoItems.confianza,
      })
      .from(computoItems)
      .innerJoin(entidades, eq(computoItems.entidadId, entidades.id))
      .innerJoin(laminas, eq(entidades.laminaId, laminas.id))
      .innerJoin(documentos, eq(laminas.documentoId, documentos.id))
      .innerJoin(obras, eq(documentos.obraId, obras.id))
      .where(eq(computoItems.id, item.id));

    expect(fila.obraNombre).toBe('Casa Belgrano');
    expect(fila.documentoNombre).toBe('obra-demo.pdf');
    expect(fila.laminaCodigo).toBe('A-01');
    expect(fila.entidadNombre).toBe('T1');
    expect(fila.entidadAtributos).toEqual({ largoM: 5, alturaM: 2.6, caras: 2, tipo: 'durlock' });
    expect(fila.entidadEstadoReforma).toBe('nueva');
    expect(fila.itemClave).toBe('seco.placas');
    expect(fila.itemCantNeta).toBe(26);
    expect(fila.itemDesperdicio).toBe(12);
    expect(fila.itemCantCompra).toBe(31.68);
    expect(fila.itemUnidad).toBe('m2');
    expect(fila.itemOrigen).toBe('deducido');
    expect(fila.itemEstado).toBe('activo');
    expect(fila.itemEditadoPor).toBeNull();
    expect(fila.itemConfianza).toBe(0.75);

    // Provenance (P1): el ítem viaja con lámina + bbox normalizado.
    expect(fila.itemFuentes).toEqual([
      { laminaId: lamina.id, bbox: [0.125, 0.25, 0.5, 0.125], detalle: 'cota 5,00 m' },
    ]);
  });

  it('aplica los defaults del PRD en entidades y láminas', async () => {
    const { usuario, obra } = await sembrarObra();
    const [documento] = await db
      .insert(documentos)
      .values({
        obraId: obra.id,
        nombreArchivo: 'sin-escala.pdf',
        tipo: 'plano',
        archivoRef: 'obras/x/sin-escala.pdf',
        mime: 'application/pdf',
        hash: 'ff00',
        subidoPor: usuario.id,
      })
      .returning();
    const [lamina] = await db
      .insert(laminas)
      .values({
        documentoId: documento.id,
        obraId: obra.id,
        numeroPagina: 1,
        archivoRef: 'obras/x/sin-escala-p1.pdf',
      })
      .returning();

    expect(lamina.escalaConfiable).toBe(false);
    expect(lamina.estadoAnalisis).toBe('pendiente');
    expect(lamina.codigo).toBeNull();
    expect(lamina.escala).toBeNull();
    expect(lamina.errorDetalle).toBeNull();

    const [entidad] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'ambiente',
        nombre: 'Estar',
        atributosJson: { superficieM2: 20, perimetroM: 18 },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0, 0, 1, 1] }],
        confianza: 0.5,
      })
      .returning();

    expect(entidad.estadoReforma).toBe('na');
  });
});

describe('esquema: unicidad e integridad', () => {
  it('rechaza dos hallazgos con la misma clave en la misma obra', async () => {
    const { obra } = await sembrarObra();

    const base = {
      obraId: obra.id,
      clave: 'seco.altura_tabiques.T1',
      tipo: 'faltante' as const,
      rubro: 'seco' as const,
      descripcion: 'No pude leer la altura del tabique T1.',
      laminasJson: [],
      bloqueante: true,
    };

    const [primero] = await db.insert(hallazgos).values(base).returning();
    expect(primero.estado).toBe('abierto');
    expect(primero.respuestaJson).toBeNull();
    expect(primero.resueltoPor).toBeNull();

    expect(await violacionUnica(db.insert(hallazgos).values(base))).toBe(
      'hallazgos_obra_clave_uq',
    );

    const filas = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obra.id));
    expect(filas).toHaveLength(1);
  });

  it('permite la misma clave de hallazgo en obras distintas', async () => {
    const { estudio, obra } = await sembrarObra();
    const [otraObra] = await db
      .insert(obras)
      .values({ estudioId: estudio.id, nombre: 'Casa Núñez', zona: 'CABA', tipo: 'nueva' })
      .returning();

    for (const obraId of [obra.id, otraObra.id]) {
      await db.insert(hallazgos).values({
        obraId,
        clave: 'escala.lamina-1',
        tipo: 'faltante',
        rubro: null,
        descripcion: 'La lámina no tiene escala confiable.',
        laminasJson: [],
        bloqueante: true,
      });
    }

    expect(await db.select().from(hallazgos)).toHaveLength(2);
  });

  it('rechaza dos filas de computo_rubros para el mismo (obra, rubro)', async () => {
    const { obra } = await sembrarObra();

    const [rubro] = await db
      .insert(computoRubros)
      .values({ obraId: obra.id, rubro: 'seco' })
      .returning();
    expect(rubro.estado).toBe('borrador');
    expect(rubro.aprobadoPor).toBeNull();
    expect(rubro.aprobadoAt).toBeNull();

    expect(
      await violacionUnica(db.insert(computoRubros).values({ obraId: obra.id, rubro: 'seco' })),
    ).toBe('computo_rubros_obra_rubro_uq');

    await db.insert(computoRubros).values({ obraId: obra.id, rubro: 'pintura' });
    expect(await db.select().from(computoRubros)).toHaveLength(2);
  });

  it('rechaza un mail de usuario repetido', async () => {
    const { estudio } = await sembrarObra();
    expect(
      await violacionUnica(
        db.insert(usuarios).values({
          estudioId: estudio.id,
          email: 'ana@estudionorte.ar',
          nombre: 'Ana bis',
          passwordHash: 'x',
          rol: 'colaborador',
        }),
      ),
    ).toBe('usuarios_email_unique');
  });

  it('aísla obras entre estudios: la query filtrada por estudio no ve la ajena', async () => {
    const { obra } = await sembrarObra();
    const { estudio: otroEstudio } = await sembrarObra('Estudio Sur', 'beto@estudiosur.ar');

    const visibles = await db
      .select()
      .from(obras)
      .where(and(eq(obras.estudioId, otroEstudio.id), eq(obras.id, obra.id)));

    expect(visibles).toHaveLength(0);
  });
});

describe('auditoría', () => {
  it('registra una escritura de agente con actor, acción y diff', async () => {
    const { obra } = await sembrarObra();

    await registrarAuditoria({
      obraId: obra.id,
      actorTipo: 'agente',
      actorNombre: 'pipeline',
      accion: 'computo_recalculado',
      targetRef: `computo_items:seco.placas`,
      diff: { antes: { cantCompra: 28.8 }, despues: { cantCompra: 31.68 } },
    });

    const filas = await db.select().from(auditoria).where(eq(auditoria.obraId, obra.id));
    expect(filas).toHaveLength(1);
    expect(filas[0].actorTipo).toBe('agente');
    expect(filas[0].actorNombre).toBe('pipeline');
    expect(filas[0].accion).toBe('computo_recalculado');
    expect(filas[0].targetRef).toBe('computo_items:seco.placas');
    expect(filas[0].diffJson).toEqual({
      antes: { cantCompra: 28.8 },
      despues: { cantCompra: 31.68 },
    });
    expect(filas[0].at).toBeInstanceOf(Date);
  });

  it('acepta una entrada sin obra (acciones de plataforma)', async () => {
    await registrarAuditoria({
      actorTipo: 'usuario',
      actorNombre: 'ana@estudionorte.ar',
      accion: 'estudio_registrado',
    });

    const filas = await db.select().from(auditoria);
    expect(filas).toHaveLength(1);
    expect(filas[0].obraId).toBeNull();
    expect(filas[0].targetRef).toBeNull();
    expect(filas[0].diffJson).toBeNull();
  });
});

describe('storage local', () => {
  const rutasCreadas: string[] = [];

  afterAll(async () => {
    await rm(path.join(process.cwd(), 'data', 'uploads', 'tests'), {
      recursive: true,
      force: true,
    });
    rutasCreadas.length = 0;
  });

  it('guarda y lee los mismos bytes', async () => {
    const storage = getStorage();
    const ruta = `tests/${randomUUID()}/documento.pdf`;
    rutasCreadas.push(ruta);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

    const ref = await storage.guardar(ruta, bytes, 'application/pdf');
    expect(ref).toBe(ruta);

    const leido = await storage.leer(ref);
    expect(leido).toBeInstanceOf(Uint8Array);
    expect(leido.byteLength).toBe(8);
    expect(Array.from(leido)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  });

  it('rechaza rutas que se escapan de la raíz de uploads', async () => {
    const storage = getStorage();
    await expect(storage.leer('../../package.json')).rejects.toThrow(/ruta/i);
    await expect(storage.guardar('../fuga.txt', new Uint8Array([1]), 'text/plain')).rejects.toThrow(
      /ruta/i,
    );
  });

  it('falla al leer una referencia inexistente', async () => {
    const storage = getStorage();
    await expect(storage.leer(`tests/${randomUUID()}/no-existe.pdf`)).rejects.toThrow();
  });
});
