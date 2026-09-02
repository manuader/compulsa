/**
 * Responder **un** dato de obra desde la bandeja, y que los N ítems que lo
 * esperaban salgan computados en esa misma pasada (§5.2 y §5.8).
 *
 * Es la otra mitad de la deduplicación de preguntas. `recomputar-datos-obra`
 * prueba que el recompute lea `datos_obra` y lo propague; acá se prueba el
 * camino de ida: la tarjeta de la bandeja escribe la fila —una, con origen
 * declarado y con quién la cargó— y dispara **un** recompute que computa los
 * cuatro tabiques y cierra la consulta.
 *
 * El fixture es el de `recomputar-datos-obra`: cuatro tabiques de PB acotados en
 * planta y sin altura, que es exactamente la obra del reclamo ("me pregunta la
 * altura del techo muro por muro cuando la respuesta está en el corte").
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

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
  type ComputoItem,
  type DatoObra,
  type Hallazgo,
} from '@/db/schema';
import {
  confirmarLote,
  DATO_OBRA_SIN_VALOR,
  MEDIDA_NO_POSITIVA,
  responderHallazgo,
  type ActorBandeja,
} from '@/lib/bandeja/resolver';
import { CAMPO_DATO_OBRA } from '@/lib/hallazgos/taxonomia';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { Fuente } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const CLAVE = 'dato_obra.altura_local.PB';

let db: Db;
let obraId: string;
let actor: ActorBandeja;
let fuenteCorte: Fuente;

function itemDe(claveItem: string): Promise<ComputoItem | undefined> {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, claveItem)))
    .then((filas) => filas[0]);
}

function consulta(): Promise<Hallazgo | undefined> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, CLAVE)))
    .then((filas) => filas[0]);
}

function datos(): Promise<DatoObra[]> {
  return db.select().from(datosObra).where(eq(datosObra.obraId, obraId));
}

function auditoriaDe(accion: string) {
  return db
    .select()
    .from(auditoria)
    .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, accion)));
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
  actor = { usuarioId: usuario.id, email: usuario.email };

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

  await db.insert(entidades).values(
    ['T1', 'T2', 'T3', 'T4'].map((nombre, i) => ({
      obraId: obra.id,
      laminaId: planta.id,
      tipo: 'tabique' as const,
      nombre,
      atributosJson: { largoM: 3, caras: 2, tipo: 'durlock', nivel: 'PB' },
      estadoReforma: 'nueva' as const,
      fuentesJson: [
        {
          laminaId: planta.id,
          bbox: [0.1, 0.1 + i * 0.1, 0.3, 0.02] as [number, number, number, number],
        },
      ],
      confianza: 0.9,
    })),
  );

  await recomputarObra(obraId, { db });
});

describe('la consulta de dato de obra', () => {
  it('es UNA sola para los cuatro tabiques, y dice a quiénes afecta', async () => {
    const fila = await consulta();
    expect(fila?.estado).toBe('abierto');
    expect(fila?.bloqueante).toBe(false); // un hecho global que falta no frena el rubro
    expect(fila?.targetRef).toBeNull();
    expect(fila?.targetDato?.clave).toBe('altura_local.PB');
    expect(fila?.targetDato?.unidad).toBe('m');
    expect(fila?.targetDato?.entidades).toHaveLength(4);
    expect(fila?.descripcion).toContain('T1, T2, T3 y T4');
  });

  it('responderla computa los cuatro en UN recompute y cierra la consulta', async () => {
    const fila = await consulta();

    expect(
      await responderHallazgo(
        { obraId, hallazgoId: fila!.id, valores: { [CAMPO_DATO_OBRA]: '2,60' } },
        actor,
      ),
    ).toEqual({ ok: true });

    // UNA fila en `datos_obra`, con origen declarado: la cargó una persona, así
    // que va sin fuentes y con `definido_por` (P1 por origen declarado).
    const guardados = await datos();
    expect(guardados).toHaveLength(1);
    expect(guardados[0]?.clave).toBe('altura_local.PB');
    expect(guardados[0]?.valorJson).toEqual({ valor: 2.6, unidad: 'm' });
    expect(guardados[0]?.origen).toBe('explicito');
    expect(guardados[0]?.fuentesJson).toEqual([]);
    expect(guardados[0]?.confianza).toBe(1);
    expect(guardados[0]?.definidoPor).toBe(actor.usuarioId);

    // Y los cuatro tabiques ya están computados: 4 × 3 × 2,60 × 2 = 62,4 m².
    const placas = await itemDe('seco.placas');
    expect(placas?.cantNeta).toBe(62.4);
    expect(placas?.cantCompra).toBe(72);
    expect(placas?.origen).toBe('explicito');

    const cerrada = await consulta();
    expect(cerrada?.estado).toBe('respondido');
    expect(cerrada?.resueltoPor).toBe(actor.usuarioId);
    expect(cerrada?.respuestaJson).toEqual({
      tipo: 'dato_obra',
      clave: 'altura_local.PB',
      valor: 2.6,
    });

    const auditadas = await auditoriaDe('dato_obra_definido');
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]?.actorNombre).toBe(actor.email);
    expect(auditadas[0]?.diffJson).toMatchObject({
      valor: { antes: null, despues: 2.6 },
      afectadas: 4,
    });
  });

  it('lo que no es una medida no se escribe y la consulta sigue abierta', async () => {
    const fila = await consulta();

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: fila!.id, valores: { [CAMPO_DATO_OBRA]: 'no figura' } },
      actor,
    );

    expect(resultado.ok).toBe(false);
    expect(await datos()).toEqual([]);
    expect((await consulta())?.estado).toBe('abierto');
  });

  it('un cero tampoco: cerraría la consulta con los tabiques sin computar', async () => {
    const fila = await consulta();

    expect(
      await responderHallazgo(
        { obraId, hallazgoId: fila!.id, valores: { [CAMPO_DATO_OBRA]: '0' } },
        actor,
      ),
    ).toEqual({ ok: false, error: MEDIDA_NO_POSITIVA });
    expect((await consulta())?.estado).toBe('abierto');
  });

  it('una nota sola no la responde: el hecho seguiría faltando', async () => {
    const fila = await consulta();

    expect(
      await responderHallazgo(
        { obraId, hallazgoId: fila!.id, nota: 'lo pregunto en obra' },
        actor,
      ),
    ).toEqual({ ok: false, error: DATO_OBRA_SIN_VALOR });
    expect((await consulta())?.estado).toBe('abierto');
  });

  it('una clave que la consulta no pide no se escribe', async () => {
    const fila = await consulta();

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: fila!.id, valores: { alturaM: '2,60' } },
      actor,
    );

    expect(resultado.ok).toBe(false);
    expect(await datos()).toEqual([]);
  });

  it('responder de nuevo pisa el dato, sin duplicar la fila', async () => {
    const fila = await consulta();
    await responderHallazgo(
      { obraId, hallazgoId: fila!.id, valores: { [CAMPO_DATO_OBRA]: '2,60' } },
      actor,
    );

    // La consulta ya está cerrada y no se reabre: el dato se corrige desde la
    // pantalla de datos de obra. Lo que se prueba acá es el upsert por clave.
    await db
      .update(hallazgos)
      .set({ estado: 'abierto', respuestaJson: null, resueltoPor: null })
      .where(eq(hallazgos.id, fila!.id));
    await responderHallazgo(
      { obraId, hallazgoId: fila!.id, valores: { [CAMPO_DATO_OBRA]: '2,40' } },
      actor,
    );

    const guardados = await datos();
    expect(guardados).toHaveLength(1);
    expect(guardados[0]?.valorJson.valor).toBe(2.4);
    expect((await itemDe('seco.placas'))?.cantNeta).toBe(57.6);
  });

  it('confirmar la propuesta de la búsqueda escribe el dato, no un atributo', async () => {
    const fila = await consulta();
    // Lo que deja `propuestaDeDato` (`src/lib/pipeline/busqueda.ts`): una sola
    // clave, `valor`, con la lámina donde se leyó y su confianza.
    await db
      .update(hallazgos)
      .set({
        valorPropuestoJson: {
          valores: { [CAMPO_DATO_OBRA]: 2.6 },
          origen: 'busqueda_dirigida',
          confianza: 0.8,
          fuente: fuenteCorte,
        },
      })
      .where(eq(hallazgos.id, fila!.id));

    expect(await confirmarLote({ obraId, hallazgoIds: [fila!.id] }, actor)).toEqual({
      ok: true,
      confirmadas: 1,
      salteadas: 0,
    });

    const guardados = await datos();
    expect(guardados).toHaveLength(1);
    expect(guardados[0]?.valorJson).toEqual({ valor: 2.6, unidad: 'm' });
    expect(guardados[0]?.definidoPor).toBe(actor.usuarioId);
    // Confirmar no le inventa un atributo a ninguna entidad: el hecho es de la
    // obra y las cuatro lo toman por la cadena de respaldo.
    const tabiques = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(tabiques.every((t) => t.atributosJson.alturaM === undefined)).toBe(true);
    expect((await itemDe('seco.placas'))?.cantNeta).toBe(62.4);
  });
});
