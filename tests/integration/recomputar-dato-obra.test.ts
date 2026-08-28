/**
 * El `targetDato` de un hallazgo tiene que **llegar a la base** y tiene que
 * **participar de la idempotencia** del recompute.
 *
 * Son dos cosas distintas y las dos se rompen calladas. Si el insert no
 * persiste la columna, el hallazgo de dato de obra llega a la bandeja sin saber
 * a qué dato apunta ni a quiénes afecta, y la tarjeta no tiene con qué
 * responder. Y si la comparación no lo mira, el recompute que corrige la lista
 * de afectados no ve diff y deja escrita la lista vieja para siempre — que es
 * la misma clase de bug que la propuesta conservada de la búsqueda dirigida,
 * pero al revés.
 *
 * El seam es `plantillasConConfig`: T1 todavía no tiene ninguna plantilla que
 * emita datos de obra (las cuatro nuevas son stubs hasta T6/T7), así que el
 * test pone una que sí y usa el constructor **real** de `taxonomia.ts`. Lo que
 * se prueba es el rail del pipeline, no la plantilla.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { EntidadPersistida } from '@/lib/computo/engine';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { TargetDato } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const CLAVE = 'dato_obra.altura_local.PB';

vi.mock('@/lib/rubros/overrides', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/rubros/overrides')>();
  const { hallazgoDatoObraFaltante } = await import('@/lib/hallazgos/taxonomia');
  const { plantillaSeco } = await import('@/lib/rubros/seco');

  return {
    ...actual,
    plantillasConConfig(config: Parameters<typeof actual.plantillasConConfig>[0]) {
      const plantillas = actual.plantillasConConfig(config);
      return {
        ...plantillas,
        seco: {
          ...plantillaSeco,
          computar(entidadesDeLaObra: readonly EntidadPersistida[]) {
            const sinAltura = entidadesDeLaObra.filter(
              (entidad) => entidad.tipo === 'tabique' && entidad.atributos.alturaM === undefined,
            );
            if (sinAltura.length === 0) return { items: [], hallazgos: [] };
            return {
              items: [],
              hallazgos: [
                hallazgoDatoObraFaltante({
                  rubro: 'seco',
                  claveDato: 'altura_local.PB',
                  unidad: 'm',
                  descripcion: 'No encontré la altura de local de planta baja.',
                  entidades: sinAltura,
                }),
              ],
            };
          },
        },
      };
    },
  };
});

let db: Db;
let obraId: string;
let idsTabiques: string[];

function hallazgoPorClave(clave: string): Promise<Hallazgo | undefined> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

function auditoriasDeHallazgos(): Promise<Array<{ accion: string; diff: unknown }>> {
  return db
    .select({ accion: auditoria.accion, diff: auditoria.diffJson })
    .from(auditoria)
    .where(eq(auditoria.obraId, obraId))
    .then((filas) => filas.filter((f) => f.accion.startsWith('hallazgo_')));
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
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa PB', zona: 'CABA', tipo: 'nueva' })
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

  // Cuatro tabiques de PB acotados en planta y sin altura: el caso que sin
  // datos de obra abría cuatro consultas idénticas.
  const filas = await db
    .insert(entidades)
    .values(
      ['T1', 'T2', 'T3', 'T4'].map((nombre, i) => ({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'tabique' as const,
        nombre,
        atributosJson: { largoM: 3 + i, nivel: 'PB', tipo: 'durlock' },
        estadoReforma: 'nueva' as const,
        fuentesJson: [{ laminaId: lamina.id, bbox: [0.1 * i, 0.5, 0.06, 0.02] as [number, number, number, number] }],
        confianza: 0.9,
      })),
    )
    .returning();
  idsTabiques = filas.map((f) => f.id);
});

describe('recompute · hallazgos que apuntan a un dato de obra', () => {
  it('escribe UNA consulta con su target_dato, no cuatro', async () => {
    await recomputarObra(obraId, { db });

    const fila = await hallazgoPorClave(CLAVE);
    expect(fila?.estado).toBe('abierto');
    expect(fila?.bloqueante).toBe(false);
    expect(fila?.targetRef).toBeNull();
    expect(fila?.laminasJson).toEqual([]);
    expect(fila?.targetDato).toEqual({
      clave: 'altura_local.PB',
      unidad: 'm',
      entidades: idsTabiques,
    });
    expect(fila?.descripcion).toBe(
      'No encontré la altura de local de planta baja. Afecta a T1, T2, T3 y T4.',
    );

    const todos = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
    expect(todos.filter((h) => h.clave.startsWith('dato_obra.'))).toHaveLength(1);
  });

  it('el mismo target_dato dos veces no es un diff: cero auditorías fantasma', async () => {
    await recomputarObra(obraId, { db });
    const antes = (await auditoriasDeHallazgos()).length;

    await recomputarObra(obraId, { db });
    await recomputarObra(obraId, { db });

    expect((await auditoriasDeHallazgos()).length).toBe(antes);
  });

  it('un target_dato desactualizado en la base se corrige, y la auditoría lo nombra', async () => {
    await recomputarObra(obraId, { db });
    const previo = await hallazgoPorClave(CLAVE);

    // Solo el target_dato queda mal: si la comparación no lo mirara, el
    // recompute no vería diff y esta lista vieja se quedaría escrita.
    const desactualizado: TargetDato = {
      clave: 'altura_local.PB',
      unidad: 'm',
      entidades: [idsTabiques[0]!],
    };
    await db
      .update(hallazgos)
      .set({ targetDato: desactualizado })
      .where(eq(hallazgos.id, previo!.id));

    await recomputarObra(obraId, { db });

    expect((await hallazgoPorClave(CLAVE))?.targetDato).toEqual({
      clave: 'altura_local.PB',
      unidad: 'm',
      entidades: idsTabiques,
    });
    const actualizaciones = (await auditoriasDeHallazgos()).filter(
      (fila) => fila.accion === 'hallazgo_actualizado',
    );
    expect(actualizaciones).toHaveLength(1);
    expect(Object.keys(actualizaciones[0]!.diff as Record<string, unknown>)).toEqual(['targetDato']);
  });
});
