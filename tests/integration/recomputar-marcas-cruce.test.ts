/**
 * El ciclo de diffs fantasma entre el cruce y las marcas de contradicción.
 *
 * `recomputarObra` marca una deducción validada que la documentación superó
 * escribiendo dos claves meta adentro de `deducciones.valor_json`
 * (`_contradicha` y `_valorDocumentado`). Quien reescribe esa fila comparando el
 * `valor_json` **entero** contra un `{ [campo]: valor }` pelado nunca la ve
 * igual: hace un `UPDATE` que no cambia ningún dato, se lleva puestas las marcas,
 * y el recompute del mismo paso las vuelve a poner. Dos auditorías por corrida,
 * un `camposActualizados` que reporta trabajo que no pasó, y un aviso de
 * «superada por la documentación» que desaparece y reaparece adentro de la misma
 * corrida.
 *
 * Los tests de idempotencia de cada lado pasaban porque ninguno ejercitaba la
 * escritura del otro. Este los compone: se aplica un resultado de cruce, se
 * recomputa, y se repite — dos veces.
 *
 * `aplicarCompletados` vive en `cruce.ts` y no es de este módulo; acá se
 * reproduce su escritura **exactamente**, en las dos variantes, para pinnear cuál
 * de las dos cierra el ciclo. `sinMarcas()` y `conMarcasDe()` son las piezas que
 * `recomputar.ts` exporta para que el cruce las use.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  deducciones,
  documentos,
  entidades,
  estudios,
  laminas,
  obras,
  usuarios,
  type Deduccion,
} from '@/db/schema';
import { igualJson } from '@/lib/pipeline/json';
import {
  conMarcasDe,
  estaContradicha,
  recomputarObra,
  sinMarcas,
  valorQueDocumenta,
} from '@/lib/pipeline/recomputar';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let obraId: string;
let entidadId: string;
let laminaId: string;

/** El `{ [campo]: valor }` que el cruce vuelve a emitir en cada corrida. */
const VALOR_DEL_CRUCE = { alturaM: 2.6 };

function auditorias(): Promise<number> {
  return db
    .select()
    .from(auditoria)
    .where(eq(auditoria.obraId, obraId))
    .then((filas) => filas.length);
}

function laDeduccion(): Promise<Deduccion> {
  return db
    .select()
    .from(deducciones)
    .where(and(eq(deducciones.obraId, obraId), eq(deducciones.campo, 'alturaM')))
    .then((filas) => filas[0]!);
}

/**
 * Lo que hace `aplicarCompletados` con una fila que ya existe: comparar y, si
 * cambió, pisarla. `conHelpers: false` es el camino que arma el ciclo.
 */
async function aplicarComoCruce(conHelpers: boolean): Promise<void> {
  const previa = await laDeduccion();
  const valores = {
    obraId,
    entidadId,
    campo: 'alturaM',
    regla: 'cruce' as const,
    fuentesJson: [{ laminaId, bbox: [0.2, 0.3, 0.5, 0.4] as [number, number, number, number] }],
    valorJson: { ...VALOR_DEL_CRUCE },
    confianza: 0.9,
    estado: 'validada' as const,
    validadoPor: null,
  };

  const guardado = conHelpers ? sinMarcas(previa.valorJson) : previa.valorJson;
  const igual =
    previa.regla === 'cruce' &&
    previa.estado === 'validada' &&
    previa.confianza === valores.confianza &&
    igualJson(guardado, valores.valorJson) &&
    igualJson(previa.fuentesJson, valores.fuentesJson);
  if (igual) return;

  await db
    .update(deducciones)
    .set({
      ...valores,
      valorJson: conHelpers ? conMarcasDe(previa, valores.valorJson) : valores.valorJson,
    })
    .where(eq(deducciones.id, previa.id));
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
    .values({ estudioId: estudio.id, nombre: 'Casa Marcas', zona: 'CABA', tipo: 'nueva' })
    .returning();
  obraId = obra.id;
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
  const [planta] = await db
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
  laminaId = planta.id;

  // El tabique tiene la altura ESCRITA en 2,40: lo que el cruce dedujo (2,60)
  // quedó superado por la documentación, que es lo que dispara la marca.
  const [tabique] = await db
    .insert(entidades)
    .values({
      obraId: obra.id,
      laminaId: planta.id,
      tipo: 'tabique' as const,
      nombre: 'T1',
      atributosJson: { tipo: 'durlock', largoM: 5, caras: 2, alturaM: 2.4 },
      estadoReforma: 'nueva' as const,
      fuentesJson: [
        { laminaId: planta.id, bbox: [0.1, 0.5, 0.4, 0.02] as [number, number, number, number] },
      ],
      confianza: 0.9,
    })
    .returning();
  entidadId = tabique.id;

  await db.insert(deducciones).values({
    obraId: obra.id,
    entidadId: tabique.id,
    campo: 'alturaM',
    regla: 'cruce',
    fuentesJson: [
      { laminaId: planta.id, bbox: [0.2, 0.3, 0.5, 0.4] as [number, number, number, number] },
    ],
    valorJson: { ...VALOR_DEL_CRUCE },
    confianza: 0.9,
    estado: 'validada',
    validadoPor: null,
  });
});

describe('cruce + recompute compuestos', () => {
  it('el recompute marca la deducción superada por la documentación', async () => {
    await recomputarObra(obraId, { db });

    const fila = await laDeduccion();
    expect(estaContradicha(fila)).toBe(true);
    expect(valorQueDocumenta(fila)).toBe(2.4);
    // El dato de la fila no se toca: la marca convive con él.
    expect(sinMarcas(fila.valorJson)).toEqual(VALOR_DEL_CRUCE);
  });

  it('con `sinMarcas` y `conMarcasDe`, dos vueltas no escriben ni una auditoría', async () => {
    await recomputarObra(obraId, { db });
    await recomputarObra(obraId, { db });
    const base = await auditorias();

    await aplicarComoCruce(true);
    await recomputarObra(obraId, { db });
    expect(await auditorias()).toBe(base);

    await aplicarComoCruce(true);
    await recomputarObra(obraId, { db });
    expect(await auditorias()).toBe(base);

    // Y la marca sigue en pie: el aviso no parpadea.
    expect(estaContradicha(await laDeduccion())).toBe(true);
  });

  it('sin los helpers el ciclo existe, y este es su tamaño: dos auditorías por vuelta', async () => {
    await recomputarObra(obraId, { db });
    await recomputarObra(obraId, { db });
    const base = await auditorias();

    // El `UPDATE` se hace aunque no cambie ningún dato, y se lleva la marca.
    await aplicarComoCruce(false);
    expect(estaContradicha(await laDeduccion())).toBe(false);

    // El recompute la vuelve a poner: `deduccion_contradicha` más el
    // `computo_recalculado` que la acompaña, por corrida y para siempre.
    await recomputarObra(obraId, { db });
    expect(await auditorias()).toBe(base + 2);
    expect(estaContradicha(await laDeduccion())).toBe(true);

    await aplicarComoCruce(false);
    await recomputarObra(obraId, { db });
    expect(await auditorias()).toBe(base + 4);
  });
});
