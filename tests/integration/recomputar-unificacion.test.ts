/**
 * La unificación por elemento, enchufada al recompute (§5.3).
 *
 * `unificarPorElemento` es puro y está pinneado aparte; lo que se prueba acá es
 * el rail, que es donde se rompe callado: que el mismo tabique dicho en la
 * planta y en el corte produzca **un** ítem, que ese ítem cite las dos láminas,
 * y que cuando las dos láminas no coinciden el sistema no elija en silencio
 * sino que abra una consulta.
 *
 * El `elemento_id` lo escribe el cruce; acá se escribe a mano, que es
 * exactamente lo mismo que hace él.
 */
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  computoItems,
  datosObra,
  deducciones,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type ComputoItem,
  type Hallazgo,
} from '@/db/schema';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import { leerResumen } from '@/lib/pipeline/resumen';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let obraId: string;
let elementoId: string;
let idPlanta: string;
let idCorte: string;
let laminaPlanta: string;
let laminaCorte: string;

function itemDe(claveItem: string): Promise<ComputoItem | undefined> {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, claveItem)))
    .then((filas) => filas[0]);
}

function hallazgosDeUnificacion(): Promise<Hallazgo[]> {
  return db
    .select()
    .from(hallazgos)
    .where(eq(hallazgos.obraId, obraId))
    .then((filas) => filas.filter((fila) => fila.clave.startsWith('unificacion.')));
}

/**
 * Las dos láminas acotan la altura, y no dicen lo mismo.
 *
 * Las dos tienen que declararla: si una la callara, el motor de deducción se la
 * pasaría de la otra (`planta_corte`) y no habría conflicto que resolver — que
 * es justamente lo que pasa en el caso feliz.
 */
async function alturasEnPugna(enPlanta: number, enCorte: number): Promise<void> {
  await db
    .update(entidades)
    .set({ atributosJson: { largoM: 5, tipo: 'durlock', alturaM: enPlanta } })
    .where(eq(entidades.id, idPlanta));
  await db
    .update(entidades)
    .set({ atributosJson: { alturaM: enCorte } })
    .where(eq(entidades.id, idCorte));
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
    .values({ estudioId: estudio.id, nombre: 'Casa Cruce', zona: 'CABA', tipo: 'nueva' })
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
  laminaPlanta = planta.id;
  laminaCorte = corte.id;

  // La MISMA pared, dicha por las dos láminas: la planta la acota de largo, el
  // corte le da la altura. Es el caso que sin unificar se computa dos veces.
  elementoId = randomUUID();
  const [enPlanta, enCorte] = await db
    .insert(entidades)
    .values([
      {
        obraId: obra.id,
        laminaId: planta.id,
        tipo: 'tabique' as const,
        nombre: 'T1',
        atributosJson: { largoM: 5, tipo: 'durlock' },
        estadoReforma: 'nueva' as const,
        fuentesJson: [{ laminaId: planta.id, bbox: [0.1, 0.5, 0.4, 0.02] as [number, number, number, number] }],
        confianza: 0.9,
        elementoId,
      },
      {
        obraId: obra.id,
        laminaId: corte.id,
        tipo: 'tabique' as const,
        nombre: 'T1',
        atributosJson: { alturaM: 2.6 },
        estadoReforma: 'nueva' as const,
        fuentesJson: [{ laminaId: corte.id, bbox: [0.2, 0.3, 0.5, 0.4] as [number, number, number, number] }],
        confianza: 0.8,
        elementoId,
      },
    ])
    .returning();
  idPlanta = enPlanta.id;
  idCorte = enCorte.id;
});

describe('recompute · el mismo elemento en dos láminas se computa una vez', () => {
  it('computa 26 m², no 52, y cita las dos láminas', async () => {
    await recomputarObra(obraId, { db });

    const placas = await itemDe('seco.placas');
    // 5 m × 2,60 m × 2 caras = 26 m². El largo lo dice la planta y la altura el
    // corte: sin unificar, cada una computaba su propio tabique.
    expect(placas?.cantNeta).toBe(26);
    expect(placas?.cantCompra).toBe(31.68);
    expect(placas?.fuentesJson.map((fuente) => fuente.laminaId).sort()).toEqual(
      [laminaCorte, laminaPlanta].sort(),
    );
    // La confianza es la peor de las dos lecturas fusionadas, no la mejor.
    expect(placas?.confianza).toBe(0.8);
  });

  it('sin `elemento_id` son dos tabiques: uno se computa a medias y el otro pregunta', async () => {
    await db.update(entidades).set({ elementoId: null }).where(eq(entidades.obraId, obraId));

    await recomputarObra(obraId, { db });

    // El de la planta computa (la altura se la pasó el motor de deducción) pero
    // cita una sola lámina, y el del corte se queda sin largo y abre su
    // consulta: para el sistema son dos paredes distintas.
    const placas = await itemDe('seco.placas');
    expect(placas?.fuentesJson.map((fuente) => fuente.laminaId)).toEqual([laminaPlanta]);

    const abiertas = await db
      .select({ clave: hallazgos.clave })
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.estado, 'abierto')));
    expect(abiertas.map((fila) => fila.clave)).toContain('seco.largo_tabiques.T1');
  });

  it('el resumen ejecutivo cuenta lo mismo que la planilla', async () => {
    await recomputarObra(obraId, { db });

    const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
    const alcance = leerResumen(obra!)?.alcance ?? [];
    expect(alcance.find((rubro) => rubro.rubro === 'seco')?.items).toBe(6);
  });

  it('es idempotente: un segundo recompute no escribe ni audita', async () => {
    await recomputarObra(obraId, { db });
    const antes = (await db.select().from(auditoria).where(eq(auditoria.obraId, obraId))).length;

    const resumen = await recomputarObra(obraId, { db });

    expect(resumen.itemsActualizados).toBe(0);
    expect(resumen.hallazgosActualizados).toBe(0);
    expect((await db.select().from(auditoria).where(eq(auditoria.obraId, obraId))).length).toBe(antes);
  });
});

describe('recompute · cuando las dos láminas no coinciden', () => {
  it('computa con la lectura más confiable y abre UNA consulta no bloqueante', async () => {
    await alturasEnPugna(2.6, 2.4);

    await recomputarObra(obraId, { db });

    // Gana la planta (0,9 contra 0,8): 5 × 2,60 × 2 = 26 m².
    expect((await itemDe('seco.placas'))?.cantNeta).toBe(26);

    const consultas = await hallazgosDeUnificacion();
    expect(consultas).toHaveLength(1);
    const consulta = consultas[0]!;
    expect(consulta.clave).toBe(`unificacion.${elementoId}.alturaM`);
    expect(consulta.tipo).toBe('inconsistencia');
    expect(consulta.bloqueante).toBe(false);
    expect(consulta.rubro).toBeNull();
    expect(consulta.descripcion).toContain('2,60 m');
    expect(consulta.descripcion).toContain('2,40 m');
    // Dice QUÉ ganó y con qué evidencia, no «la lectura más confiable»: las dos
    // están escritas, y lo que desempata es de qué lámina salió.
    expect(consulta.descripcion).toContain('lámina A-01');
    expect(consulta.descripcion).toContain('lámina A-02');
    expect(consulta.descripcion).toContain('escrito en la lámina');
    expect(consulta.descripcion).not.toContain('la lectura más confiable');
    expect(consulta.laminasJson.map((fuente) => fuente.laminaId).sort()).toEqual(
      [laminaCorte, laminaPlanta].sort(),
    );
  });

  it('la consulta se cierra sola cuando las láminas vuelven a coincidir', async () => {
    await alturasEnPugna(2.6, 2.4);
    await recomputarObra(obraId, { db });
    expect((await hallazgosDeUnificacion())[0]?.estado).toBe('abierto');

    // La lámina se corrige y las dos dicen 2,60.
    await alturasEnPugna(2.6, 2.6);
    await recomputarObra(obraId, { db });

    expect((await hallazgosDeUnificacion())[0]?.estado).toBe('descartado');
  });

  it('una diferencia de menos del 1 % no abre nada: son dos lápices', async () => {
    await alturasEnPugna(2.6, 2.62);

    await recomputarObra(obraId, { db });

    expect(await hallazgosDeUnificacion()).toEqual([]);
    expect((await itemDe('seco.placas'))?.cantNeta).toBe(26);
  });
});

describe('recompute · la marca de origen sobrevive a la unificación', () => {
  it('un dato de obra que aporta la hermana deja el ítem marcado', async () => {
    // La planta no tiene altura y el corte tampoco: la pone el dato de obra, y
    // el ítem tiene que salir `deducido` aunque el campo lo haya aportado la
    // entidad que desapareció en la unificación.
    await db.update(entidades).set({ atributosJson: {} }).where(eq(entidades.id, idCorte));
    await db.insert(datosObra).values({
      obraId,
      clave: 'altura_local.general',
      valorJson: { valor: 2.6, unidad: 'm' },
      origen: 'deducido',
      fuentesJson: [{ laminaId: laminaCorte, bbox: [0.2, 0.3, 0.5, 0.4] }],
      confianza: 0.9,
    });

    await recomputarObra(obraId, { db });

    const placas = await itemDe('seco.placas');
    expect(placas?.cantNeta).toBe(26);
    expect(placas?.origen).toBe('deducido');
    expect(idPlanta).not.toBe(idCorte);
  });
});

describe('recompute · lo escrito le gana a lo medido, aunque lo medido esté en la base', () => {
  /**
   * El caso que invertía la cadena del §5.2.
   *
   * La planta es la base (0,9 contra 0,8) y su `largoM` **no está escrito**: se
   * lo puso la medición gráfica, la evidencia más débil que el sistema produce
   * (confianza 0,5 fija). El corte lo tiene acotado. Antes ganaba la planta por
   * ser la base, el ítem salía `inferido` y la consulta le decía al arquitecto
   * que 6,12 era «la lectura más confiable».
   */
  async function largoMedidoContraLargoEscrito(): Promise<void> {
    await db
      .update(entidades)
      .set({ atributosJson: { tipo: 'durlock', alturaM: 2.6 } })
      .where(eq(entidades.id, idPlanta));
    await db
      .update(entidades)
      .set({ atributosJson: { largoM: 6, alturaM: 2.6 } })
      .where(eq(entidades.id, idCorte));
    await db.insert(deducciones).values({
      obraId,
      entidadId: idPlanta,
      campo: 'largoM',
      regla: 'medicion_grafica',
      fuentesJson: [{ laminaId: laminaPlanta, bbox: [0.1, 0.5, 0.4, 0.02] }],
      valorJson: { largoM: 6.12 },
      confianza: 0.5,
      estado: 'validada',
      validadoPor: null,
    });
  }

  it('computa con los 6,00 m acotados y no con los 6,12 m medidos', async () => {
    await largoMedidoContraLargoEscrito();

    await recomputarObra(obraId, { db });

    // 6,00 × 2,60 × 2 caras = 31,20 m². Con el largo medido darían 31,82.
    const placas = await itemDe('seco.placas');
    expect(placas?.cantNeta).toBe(31.2);
  });

  it('el ítem sale `explicito`: el número con el que computa está escrito', async () => {
    await largoMedidoContraLargoEscrito();

    await recomputarObra(obraId, { db });

    expect((await itemDe('seco.placas'))?.origen).toBe('explicito');
  });

  it('no abre consulta: no es una contradicción, es la cadena de evidencia', async () => {
    await largoMedidoContraLargoEscrito();

    await recomputarObra(obraId, { db });

    expect(await hallazgosDeUnificacion()).toEqual([]);
  });

  it('sigue siendo idempotente', async () => {
    await largoMedidoContraLargoEscrito();
    await recomputarObra(obraId, { db });
    const antes = (await db.select().from(auditoria).where(eq(auditoria.obraId, obraId))).length;

    await recomputarObra(obraId, { db });

    expect((await db.select().from(auditoria).where(eq(auditoria.obraId, obraId))).length).toBe(
      antes,
    );
  });
});
