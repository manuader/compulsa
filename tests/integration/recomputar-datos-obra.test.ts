/**
 * Los datos de obra, del `datos_obra` de la base al `computo_items` de la
 * planilla (§5.2).
 *
 * La cadena de respaldo está probada en la plantilla y en el motor; acá se
 * prueba el rail: que el recompute **lea la tabla**, se la pase a las plantillas
 * y que el origen que declara el dato termine escrito en el ítem. Sin este
 * eslabón, responder «2,60» una vez seguiría dejando los cuatro tabiques sin
 * computar y la consulta abierta para siempre.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  computoItems,
  datosObra,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type ComputoItem,
} from '@/db/schema';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { Fuente, Origen } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let obraId: string;
let usuarioId: string;
let fuenteCorte: Fuente;

function itemDe(claveItem: string): Promise<ComputoItem | undefined> {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, claveItem)))
    .then((filas) => filas[0]);
}

async function declararAltura(origen: Origen, definidoPor: string | null = null): Promise<void> {
  await db.insert(datosObra).values({
    obraId,
    clave: 'altura_local.PB',
    valorJson: { valor: 2.6, unidad: 'm' },
    origen,
    fuentesJson: definidoPor === null ? [fuenteCorte] : [],
    confianza: origen === 'explicito' ? 1 : 0.9,
    ...(definidoPor === null ? {} : { definidoPor }),
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
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa PB', zona: 'CABA', tipo: 'nueva' })
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
  const [planta, corte] = await db
    .insert(laminas)
    .values([
      {
        documentoId: documento.id,
        obraId: obra.id,
        numeroPagina: 1,
        codigo: 'A-01',
        archivoRef: 'demo/obra-p1.pdf',
        estadoAnalisis: 'analizada' as const,
        tipo: 'planta' as const,
        escala: '1:100',
        escalaConfiable: true,
      },
      {
        documentoId: documento.id,
        obraId: obra.id,
        numeroPagina: 2,
        codigo: 'A-02',
        archivoRef: 'demo/obra-p2.pdf',
        estadoAnalisis: 'analizada' as const,
        tipo: 'corte' as const,
        escala: '1:50',
        escalaConfiable: true,
      },
    ])
    .returning();
  fuenteCorte = { laminaId: corte.id, bbox: [0.2, 0.3, 0.5, 0.4], detalle: 'Corte A-A' };

  // Cuatro tabiques de 3 m de PB, acotados en planta y sin altura.
  await db.insert(entidades).values(
    ['T1', 'T2', 'T3', 'T4'].map((nombre, i) => ({
      obraId: obra.id,
      laminaId: planta.id,
      tipo: 'tabique' as const,
      nombre,
      atributosJson: { largoM: 3, caras: 2, tipo: 'durlock', nivel: 'PB' },
      estadoReforma: 'nueva' as const,
      fuentesJson: [
        { laminaId: planta.id, bbox: [0.1, 0.1 + i * 0.1, 0.3, 0.02] as [number, number, number, number] },
      ],
      confianza: 0.9,
    })),
  );
});

describe('recompute · el dato de obra llega al cómputo', () => {
  it('sin el dato no hay ítems de seco y queda UNA consulta abierta', async () => {
    await recomputarObra(obraId, { db });

    expect(await itemDe('seco.placas')).toBeUndefined();
    const abiertos = await db
      .select({ clave: hallazgos.clave })
      .from(hallazgos)
      .where(eq(hallazgos.obraId, obraId));
    expect(abiertos.filter((h) => h.clave.startsWith('dato_obra.'))).toEqual([
      { clave: 'dato_obra.altura_local.PB' },
    ]);
  });

  it('con el dato deducido computa los cuatro y marca el ítem `deducido`', async () => {
    await declararAltura('deducido');

    await recomputarObra(obraId, { db });

    const placas = await itemDe('seco.placas');
    // 4 × 3 m × 2,60 m × 2 caras = 62,4 m²; +12 % ⇒ 25 placas de 2,88 m² = 72 m².
    expect(placas?.cantNeta).toBe(62.4);
    expect(placas?.cantCompra).toBe(72);
    expect(placas?.origen).toBe('deducido');
    // P1: el corte que declara la altura queda citado en el ítem.
    expect(placas?.fuentesJson.at(-1)).toEqual(fuenteCorte);
  });

  it('el dato que cargó una persona computa igual, y el ítem sale explícito', async () => {
    await declararAltura('explicito', usuarioId);

    await recomputarObra(obraId, { db });

    const placas = await itemDe('seco.placas');
    expect(placas?.cantNeta).toBe(62.4);
    expect(placas?.origen).toBe('explicito');
  });

  it('un dato inferido deja el ítem `inferido`: es la advertencia más fuerte', async () => {
    await declararAltura('inferido');
    await db
      .update(datosObra)
      .set({ metodo: 'Medición gráfica sobre el dibujo a escala 1:50', confianza: 0.5 })
      .where(eq(datosObra.obraId, obraId));

    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.origen).toBe('inferido');
  });

  it('responder el dato cierra la consulta que lo pedía', async () => {
    await recomputarObra(obraId, { db });
    await declararAltura('explicito', usuarioId);

    await recomputarObra(obraId, { db });

    const [consulta] = await db
      .select({ estado: hallazgos.estado })
      .from(hallazgos)
      .where(
        and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, 'dato_obra.altura_local.PB')),
      );
    expect(consulta?.estado).toBe('descartado');
  });
});
