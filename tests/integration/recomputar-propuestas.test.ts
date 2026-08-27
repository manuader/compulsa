/**
 * Regla de merge del recompute sobre `hallazgos.valor_propuesto_json`.
 *
 * Hay dos clases de propuesta y el recompute las trata distinto:
 *
 *  - las que **produce el motor** (`lectura_baja_confianza`, `rotulo`) las
 *    gobierna el motor: si deja de emitirlas, se van;
 *  - las de `busqueda_dirigida` las escribe otro proceso, por fuera del motor
 *    (`src/lib/pipeline/busqueda.ts`). El motor no las conoce y no las puede
 *    borrar por omisión: sin esta regla, el primer recompute después de una
 *    búsqueda tiraba todo lo que la búsqueda encontró y el usuario pagaba los
 *    créditos otra vez.
 *
 * Es la decisión 8 del plan "proponer en vez de bloquear", y es la que sostiene
 * a T3: se testea acá, en la base, porque es lo que queda escrito lo que importa.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Hallazgo,
} from '@/db/schema';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { ValorPropuesto } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const CLAVE = 'aberturas.medidas_vano.FP01';

/** Lo que escribiría la búsqueda dirigida al encontrar las medidas en DET00. */
const DE_LA_BUSQUEDA: ValorPropuesto = {
  valores: { anchoM: 0.9, altoM: 2.05 },
  fuente: { laminaId: 'no-importa', bbox: [0.1, 0.3, 0.3, 0.04] },
  confianza: 0.85,
  origen: 'busqueda_dirigida',
};

let db: Db;
let obraId: string;

function hallazgoPorClave(clave: string): Promise<Hallazgo | undefined> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

function auditoriasDeHallazgos(): Promise<Array<{ accion: string }>> {
  return db
    .select({ accion: auditoria.accion })
    .from(auditoria)
    .where(eq(auditoria.obraId, obraId))
    .then((filas) => filas.filter((f) => f.accion.startsWith('hallazgo_')));
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

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
    .values({ estudioId: estudio.id, nombre: 'Casa FP01', zona: 'CABA', tipo: 'nueva' })
    .returning();
  const [documento] = await db
    .insert(documentos)
    .values({
      obraId: obra.id,
      nombreArchivo: 'planta.pdf',
      tipo: 'plano',
      archivoRef: 'demo/planta.pdf',
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
      archivoRef: 'demo/planta-p1.pdf',
      estadoAnalisis: 'analizada',
      tipo: 'planta',
      escala: '1:100',
      escalaConfiable: true,
    })
    .returning();

  obraId = obra.id;

  // La puerta FP01 dibujada sin acotar: el motor emite `medidas_vano.FP01`
  // bloqueante, con target a las dos medidas y sin propuesta propia.
  await db.insert(entidades).values({
    obraId: obra.id,
    laminaId: lamina.id,
    tipo: 'abertura',
    nombre: 'FP01',
    atributosJson: { tag: 'FP01', tipologia: 'puerta' },
    estadoReforma: 'na',
    fuentesJson: [{ laminaId: lamina.id, bbox: [0.24, 0.5, 0.06, 0.02], detalle: 'FP01' }],
    confianza: 0.9,
  });

  await recomputarObra(obraId, { db });
});

describe('recompute · merge de propuestas (decisión 8)', () => {
  it('el hallazgo nace sin propuesta y con el target en plural', async () => {
    const fila = await hallazgoPorClave(CLAVE);

    expect(fila?.estado).toBe('abierto');
    expect(fila?.valorPropuestoJson).toBeNull();
    expect(fila?.targetRef?.campos).toEqual(['anchoM', 'altoM']);
  });

  it('la propuesta de la búsqueda dirigida sobrevive al recompute', async () => {
    const previo = await hallazgoPorClave(CLAVE);
    await db
      .update(hallazgos)
      .set({ valorPropuestoJson: DE_LA_BUSQUEDA })
      .where(eq(hallazgos.id, previo!.id));

    await recomputarObra(obraId, { db });

    const despues = await hallazgoPorClave(CLAVE);
    expect(despues?.valorPropuestoJson).toEqual(DE_LA_BUSQUEDA);
  });

  it('conservarla no cuenta como diff: cero auditorías fantasma por corrida', async () => {
    const previo = await hallazgoPorClave(CLAVE);
    await db
      .update(hallazgos)
      .set({ valorPropuestoJson: DE_LA_BUSQUEDA })
      .where(eq(hallazgos.id, previo!.id));

    const antes = (await auditoriasDeHallazgos()).length;
    await recomputarObra(obraId, { db });
    await recomputarObra(obraId, { db });

    expect((await auditoriasDeHallazgos()).length).toBe(antes);
  });

  it('una propuesta del motor sí la gobierna el motor: se borra si deja de emitirla', async () => {
    const previo = await hallazgoPorClave(CLAVE);
    await db
      .update(hallazgos)
      .set({
        valorPropuestoJson: {
          valores: { anchoM: 0.9 },
          confianza: 0.6,
          origen: 'lectura_baja_confianza',
        },
      })
      .where(eq(hallazgos.id, previo!.id));

    await recomputarObra(obraId, { db });

    expect((await hallazgoPorClave(CLAVE))?.valorPropuestoJson).toBeNull();
  });
});
