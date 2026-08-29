/**
 * Pipeline de análisis, de punta a punta, contra PGlite en memoria y los PDFs
 * reales de `tests/fixtures/pdfs/`.
 *
 * No se testea el route handler sino la lógica que el handler envuelve
 * (`subirDocumento`, `procesarDocumento`, `actualizarLamina`): lo que hay que
 * proteger es qué queda escrito en la base, no cómo se serializa un multipart.
 *
 * El provider de análisis es SIEMPRE el mock (`NODE_ENV=test`), que lee los
 * fixtures `obra-demo-p1..p3.json`. `sin-escala.pdf` no tiene fixture a
 * propósito: es el caso que ejercita el bloqueo por escala (RF-201).
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
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Lamina,
} from '@/db/schema';
import type { BusquedaProvider } from '@/lib/analysis/busqueda-tipos';
import { getAnalysisProvider, rotuloNulo, type AnalysisProvider } from '@/lib/analysis/index';
import { responderHallazgo } from '@/lib/bandeja/resolver';
import { puedeAprobarRubro } from '@/lib/hallazgos/gate';
import { buscarDatosFaltantes } from '@/lib/pipeline/busqueda';
import {
  ACCION_BUSQUEDA_FALLIDA,
  ACCION_PROCESANDO,
  actualizarLamina,
  descripcionEscalaAsumida,
  descripcionEscalaRelectura,
  PREFIJO_RECOMPUTO_FALLIDO,
  procesarDocumento,
  procesarLamina,
  subirDocumento,
  TTL_PROCESANDO_MS,
} from '@/lib/pipeline/procesar';
import { parsearRefArchivo } from '@/lib/pipeline/refs';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';
import type { ObraContexto } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let usuarioId: string;

async function archivoFixture(nombre: string): Promise<File> {
  const bytes = await readFile(new URL(nombre, PDFS));
  return new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
}

async function subirYProcesar(nombre: string) {
  const documento = await subirDocumento(db, storage, obraId, usuarioId, await archivoFixture(nombre));
  await procesarDocumento(documento.id, { db, storage });
  return documento;
}

function laminasDe(documentoId: string): Promise<Lamina[]> {
  return db
    .select()
    .from(laminas)
    .where(eq(laminas.documentoId, documentoId))
    .orderBy(laminas.numeroPagina);
}

async function itemsActivos() {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.estado, 'activo')));
}

async function clavesDeHallazgos(): Promise<string[]> {
  const filas = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
  return filas.map((h) => h.clave);
}

function auditoriaDe(accion: string) {
  return db
    .select()
    .from(auditoria)
    .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, accion)));
}

/**
 * Acciones que solo aparecen si el recompute —o la búsqueda dirigida que corre
 * al final del documento— escribió un dato de la obra.
 */
const ESCRITURAS_DE_DATOS = new Set([
  'computo_item_creado',
  'computo_item_actualizado',
  'computo_item_anulado',
  'computo_item_desvinculado',
  'computo_recalculado',
  'entidad_actualizada',
  'hallazgo_abierto',
  'hallazgo_actualizado',
  'hallazgo_descartado',
  'hallazgo_reabierto',
  // C2: las dos escrituras de la búsqueda dirigida sobre un hallazgo. La
  // propuesta que ya está escrita no se reescribe, y lo que se buscó y no
  // estaba no se vuelve a marcar: las dos son idempotentes o son un diff
  // fantasma que le cuesta créditos al usuario.
  'hallazgo_valor_propuesto',
  'hallazgo_sin_resultado',
  // Las cuatro que trajo el pipeline por fases: el rótulo que persiste el
  // inventario, los hechos de obra y las deducciones que aplica el cruce, y las
  // entidades que unifica. Todas tienen que ser idempotentes por la misma razón
  // que las de arriba — una obra que no cambió no puede reescribirse sola.
  'lamina_inventariada',
  'dato_obra_escrito',
  'dato_obra_actualizado',
  'deduccion_aplicada',
  'entidades_unificadas',
]);

function todosLosItems() {
  return db
    .select()
    .from(computoItems)
    .where(eq(computoItems.obraId, obraId))
    .orderBy(computoItems.claveItem);
}

function todasLasEntidades() {
  return db.select().from(entidades).where(eq(entidades.obraId, obraId)).orderBy(entidades.id);
}

function todosLosHallazgos() {
  return db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId)).orderBy(hallazgos.clave);
}

function todaLaAuditoria() {
  return db.select().from(auditoria).where(eq(auditoria.obraId, obraId));
}

/**
 * Provider que lee la escala pero no encuentra ninguna entidad. Sirve para
 * ejercitar la desaparición de entidades sin tocar la base a mano: es lo que
 * pasa cuando el arquitecto sube una revisión con una lámina vaciada.
 */
function providerSinEntidades(): AnalysisProvider {
  return {
    async leerRotulo() {
      return { ...rotuloNulo(), escala: '1:100', escalaConfiable: true, confianza: 1 };
    },
    async extraerEntidades() {
      return [];
    },
  };
}

/**
 * El provider mock de siempre, con el `ObraContexto` que recibe cada llamada
 * anotado. Es la única manera de ver qué le llega al prompt sin salir a la red
 * (`tests/CLAUDE.md` §2), y de contar cuántas veces se llamó al modelo.
 */
/** Qué contexto vio cada llamada, con la lámina que la motivó. */
interface LlamadaEspiada {
  laminaId: string;
  ctx: ObraContexto | undefined;
}

/**
 * El espía anota **por lámina** y no por orden de llegada: la fase de
 * extracción corre en paralelo (cap 4), así que el orden en el que las láminas
 * llaman al provider no es el de las páginas.
 */
function providerEspia() {
  const real = getAnalysisProvider();
  const inventarios: LlamadaEspiada[] = [];
  const rotulos: LlamadaEspiada[] = [];
  const extracciones: LlamadaEspiada[] = [];

  const provider: AnalysisProvider = {
    async inventariar(lamina, ctx) {
      inventarios.push({ laminaId: lamina.laminaId, ctx });
      return real.leerRotulo(lamina, ctx);
    },
    async leerRotulo(lamina, ctx) {
      rotulos.push({ laminaId: lamina.laminaId, ctx });
      return real.leerRotulo(lamina, ctx);
    },
    async extraerEntidades(lamina, ctx) {
      extracciones.push({ laminaId: lamina.laminaId, ctx });
      return real.extraerEntidades(lamina, ctx);
    },
  };

  const ctxDe = (llamadas: readonly LlamadaEspiada[], laminaId: string): ObraContexto =>
    llamadas.find((llamada) => llamada.laminaId === laminaId)?.ctx as ObraContexto;

  return { provider, inventarios, rotulos, extracciones, ctxDe };
}

/** Cuántas veces arrancó el análisis de esta lámina (una por llamada al modelo). */
async function procesamientosDe(laminaId: string): Promise<number> {
  const filas = await auditoriaDe(ACCION_PROCESANDO);
  return filas.filter((fila) => fila.targetRef === `laminas:${laminaId}`).length;
}

function hallazgoPorClave(clave: string) {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

beforeEach(async () => {
  // Todo el pipeline resuelve la base por `getDb()`: hay que inyectar la de test.
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-pipeline-'));
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

describe('procesarDocumento sobre obra-demo.pdf', () => {
  it('separa las 3 páginas, las analiza y computa la obra entera', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const lams = await laminasDe(documento.id);
    expect(lams).toHaveLength(3);
    expect(lams.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada', 'analizada']);
    expect(lams.map((l) => l.codigo)).toEqual(['A-01', 'A-02', 'A-03']);
    expect(lams.map((l) => l.titulo)).toEqual([
      'PLANTA PB',
      'CORTE A-A',
      'PLANILLA DE CARPINTERÍAS',
    ]);
    expect(lams[0].escala).toBe('1:100');
    expect(lams[0].escalaConfiable).toBe(true);
    expect(lams[0].tipo).toBe('planta');
    expect(lams[0].disciplina).toBe('arquitectura');
    expect(lams.every((l) => l.errorDetalle === null)).toBe(true);

    // Cada lámina guarda su propio PDF de una página, distinto del original.
    expect(new Set(lams.map((l) => l.archivoRef)).size).toBe(3);
    for (const lamina of lams) {
      const bytes = await storage.leer(lamina.archivoRef);
      expect(bytes.length).toBeGreaterThan(0);
      expect(lamina.archivoRef).not.toBe(documento.archivoRef);
    }

    const guardadas = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(guardadas).toHaveLength(10);
    expect(guardadas.every((e) => e.fuentesJson.length > 0)).toBe(true);

    const items = await itemsActivos();
    expect(new Set(items.map((i) => i.rubro))).toEqual(
      new Set(['aberturas', 'seco', 'pintura', 'gruesa']),
    );
    // P1: ningún ítem de agente sin provenance.
    expect(items.every((i) => i.fuentesJson.length > 0)).toBe(true);
    expect(items.every((i) => i.editadoPor === null)).toBe(true);

    const porClave = new Map(items.map((i) => [i.claveItem, i]));
    expect(porClave.get('seco.placas')?.cantCompra).toBe(31.68);
    expect(porClave.get('gruesa.ladrillos')?.cantCompra).toBe(396);

    const claves = await clavesDeHallazgos();
    // Estar: piso 20 m² vs cielorraso 19 m² = 5%, por debajo del 10% que tolera el motor.
    expect(claves.filter((c) => c.startsWith('sanity.piso_cielo.'))).toEqual([]);
    // Estar y Dormitorio declaran `vanosM2`: no hay nada que consultar.
    expect(claves.filter((c) => c.startsWith('pintura.vanos_sin_descontar.'))).toEqual([]);
    // Las tres láminas leyeron escala confiable: ningún bloqueo.
    expect(claves.filter((c) => c.startsWith('escala.'))).toEqual([]);
  });
});

describe('bloqueo por escala y desbloqueo manual', () => {
  it('deja la lámina sin escala bloqueada, con hallazgo bloqueante y sin entidades', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');

    const [lamina] = await laminasDe(documento.id);
    expect(lamina.estadoAnalisis).toBe('bloqueada_escala');
    expect(lamina.escalaConfiable).toBe(false);

    const [hallazgo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, `escala.${lamina.id}`)));
    expect(hallazgo).toBeDefined();
    expect(hallazgo.tipo).toBe('faltante');
    expect(hallazgo.bloqueante).toBe(true);
    expect(hallazgo.estado).toBe('abierto');
    expect(hallazgo.laminasJson).toEqual([
      { laminaId: lamina.id, bbox: [0, 0, 1, 1], detalle: 'Lámina completa' },
    ]);

    expect(await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id))).toHaveLength(
      0,
    );
  });

  it('el PATCH de escala manual re-dispara el análisis y deja la lámina analizada', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');
    const [previa] = await laminasDe(documento.id);

    const lamina = await actualizarLamina(
      db,
      previa.id,
      { escala: '1:50', escalaConfiable: true },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { db, storage },
    );

    expect(lamina.escala).toBe('1:50');
    expect(lamina.escalaConfiable).toBe(true);
    // Sin fixture de análisis no hay entidades: analizada y vacía es la respuesta honesta.
    expect(lamina.estadoAnalisis).toBe('analizada');
    expect(await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id))).toHaveLength(
      0,
    );

    const [hallazgo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, `escala.${lamina.id}`)));
    expect(hallazgo.estado).toBe('respondido');
  });

  it('el recompute de otra lámina no cierra el hallazgo de escala', async () => {
    // `escala.<laminaId>` lo emite el pipeline, no `computarObra()`: si el
    // recompute lo conciliara junto con los suyos, lo cerraría "porque ya no
    // sale" y la lámina quedaría bloqueada sin consulta que lo explique.
    const bloqueado = await subirYProcesar('sin-escala.pdf');
    const [bloqueada] = await laminasDe(bloqueado.id);

    await subirYProcesar('obra-demo.pdf');

    const [hallazgo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, `escala.${bloqueada.id}`)));
    expect(hallazgo.estado).toBe('abierto');
    expect(hallazgo.respuestaJson).toBeNull();
  });

  it('el PATCH de clasificación guarda disciplina y tipo sin re-analizar', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');
    const [previa] = await laminasDe(documento.id);

    const lamina = await actualizarLamina(
      db,
      previa.id,
      { disciplina: 'instalaciones', tipo: 'detalle' },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { db, storage },
    );

    expect(lamina.disciplina).toBe('instalaciones');
    expect(lamina.tipo).toBe('detalle');
    expect(lamina.estadoAnalisis).toBe('bloqueada_escala');
  });
});

describe('idempotencia', () => {
  it('re-procesar el documento da los mismos conteos y no duplica nada', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const entidadesAntes = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    const itemsAntes = await itemsActivos();
    const clavesAntes = (await clavesDeHallazgos()).sort();

    await procesarDocumento(documento.id, { db, storage });

    const lams = await laminasDe(documento.id);
    expect(lams).toHaveLength(3);
    expect(lams.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada', 'analizada']);

    const entidadesDespues = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(entidadesDespues).toHaveLength(10);
    // Las entidades conservan su id: el recompute matchea por lámina + tipo + nombre,
    // así los `entidad_id` de los ítems y los `target_ref` de los hallazgos no se pudren.
    expect(new Set(entidadesDespues.map((e) => e.id))).toEqual(
      new Set(entidadesAntes.map((e) => e.id)),
    );

    const itemsDespues = await itemsActivos();
    expect(itemsDespues).toHaveLength(itemsAntes.length);
    expect(new Set(itemsDespues.map((i) => i.claveItem))).toEqual(
      new Set(itemsAntes.map((i) => i.claveItem)),
    );
    expect(new Set(itemsDespues.map((i) => i.id))).toEqual(new Set(itemsAntes.map((i) => i.id)));
    expect(itemsDespues.find((i) => i.claveItem === 'seco.placas')?.cantCompra).toBe(31.68);
    expect(itemsDespues.find((i) => i.claveItem === 'gruesa.ladrillos')?.cantCompra).toBe(396);

    expect((await clavesDeHallazgos()).sort()).toEqual(clavesAntes);
  });

  /**
   * Regresión: Postgres devuelve las claves de un `jsonb` ordenadas, y el
   * pipeline arma sus `Fuente` como `{laminaId, bbox, detalle}`. Con un
   * `JSON.stringify` sensible al orden, `fuentes_json` "difería" siempre y una
   * segunda corrida idéntica reescribía todos los ítems y todas las entidades,
   * inundando `auditoria` de diffs fantasma con `antes == despues`.
   *
   * El invariante que este test pinnea: la segunda corrida no escribe **nada**.
   */
  it('un segundo procesado idéntico no reescribe ni audita: cero diffs fantasma', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const itemsAntes = await todosLosItems();
    const entidadesAntes = await todasLasEntidades();
    const hallazgosAntes = await todosLosHallazgos();
    const auditoriaAntes = await todaLaAuditoria();

    await procesarDocumento(documento.id, { db, storage });

    // 1) Ni un solo registro de auditoría de escritura sobre cómputo, entidades
    //    o hallazgos. (El pipeline sí audita el arranque de cada lámina y su
    //    análisis: eso es la corrida, no una escritura de datos.)
    const previas = new Set(auditoriaAntes.map((r) => r.id));
    const nuevas = (await todaLaAuditoria()).filter((r) => !previas.has(r.id));
    expect(auditoriaAntes.length).toBeGreaterThan(0);
    expect(
      nuevas
        .filter((r) => ESCRITURAS_DE_DATOS.has(r.accion))
        .map((r) => `${r.accion} ${r.targetRef}`),
    ).toEqual([]);

    // 2) Las filas quedan idénticas, `updated_at` incluido: sin churn no hay
    //    "modificado" falso en la planilla ni en el expediente.
    expect(await todosLosItems()).toEqual(itemsAntes);
    expect(await todasLasEntidades()).toEqual(entidadesAntes);
    expect(await todosLosHallazgos()).toEqual(hallazgosAntes);

    // 3) El resumen que audita cada lámina lo dice con números: nada cambió.
    for (const registro of nuevas.filter((r) => r.accion === 'lamina_analizada')) {
      expect(registro.diffJson).toMatchObject({ creadas: 0, actualizadas: 0, eliminadas: 0 });
    }
  });

  it('un ítem editado a mano sobrevive al recompute', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const [placas] = await db
      .select()
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.placas')));

    await db
      .update(computoItems)
      .set({ cantNeta: 40, cantCompra: 46.08, editadoPor: usuarioId })
      .where(eq(computoItems.id, placas.id));

    await procesarDocumento(documento.id, { db, storage });

    const filas = await db
      .select()
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.placas')));

    // Ni pisado ni duplicado: la clave editada a mano es del humano.
    expect(filas).toHaveLength(1);
    expect(filas[0].id).toBe(placas.id);
    expect(filas[0].cantCompra).toBe(46.08);
    expect(filas[0].editadoPor).toBe(usuarioId);
    expect(filas[0].estado).toBe('activo');
  });
});

describe('refs del storage', () => {
  it('las refs que genera el pipeline nombran al estudio y a la obra', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const [estudio] = await db.select().from(estudios);
    const [lamina] = await laminasDe(documento.id);

    // `/api/archivos/[...ref]` decide la pertenencia leyendo la propia ref: si
    // esta forma cambia, ese control de acceso se queda sin de dónde agarrarse.
    expect(documento.archivoRef).toBe(
      `estudios/${estudio.id}/obras/${obraId}/documentos/${documento.id}/original.pdf`,
    );
    expect(lamina.archivoRef).toBe(
      `estudios/${estudio.id}/obras/${obraId}/documentos/${documento.id}/laminas/p001.pdf`,
    );

    expect(parsearRefArchivo(documento.archivoRef)).toEqual({
      estudioId: estudio.id,
      obraId,
      documentoId: documento.id,
    });
    expect(parsearRefArchivo(lamina.archivoRef)?.obraId).toBe(obraId);
  });

  it('rechaza cualquier ref que no tenga la forma canónica', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const valida = `estudios/${uuid}/obras/${uuid}/documentos/${uuid}/original.pdf`;
    expect(parsearRefArchivo(valida)).not.toBeNull();

    for (const ref of [
      '',
      'original.pdf',
      '../../../etc/passwd',
      `estudios/${uuid}/obras/${uuid}/documentos/${uuid}/../../../../original.pdf`,
      `estudios/${uuid}/obras/${uuid}/documentos/${uuid}/original.pdf/../secreto.pdf`,
      `estudios/${uuid}/obras/${uuid}/documentos/${uuid}/laminas/p1.pdf`,
      `estudios/${uuid}/obras/${uuid}/documentos/${uuid}/secreto.env`,
      `estudios/no-es-uuid/obras/${uuid}/documentos/${uuid}/original.pdf`,
      `/estudios/${uuid}/obras/${uuid}/documentos/${uuid}/original.pdf`,
    ]) {
      expect(parsearRefArchivo(ref), ref).toBeNull();
    }
  });
});

describe('errores', () => {
  it('una lámina cuyo archivo no está queda en error, con detalle y sin excepción', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const [lamina] = await laminasDe(documento.id);

    await db
      .update(laminas)
      .set({ archivoRef: `${lamina.archivoRef}.no-existe` })
      .where(eq(laminas.id, lamina.id));

    await expect(procesarLamina(lamina.id, { db, storage })).resolves.toBeUndefined();

    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.estadoAnalisis).toBe('error');
    expect(despues.errorDetalle).toBeTruthy();
  });

  it('rechaza un archivo que no es PDF sin escribir nada', async () => {
    const archivo = new File([new Uint8Array([1, 2, 3])], 'planta.dwg', {
      type: 'application/acad',
    });

    await expect(subirDocumento(db, storage, obraId, usuarioId, archivo)).rejects.toThrow(
      /PDF/i,
    );
  });

  it('deja la lámina analizada y audita el fallo si el recompute se cae', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const [lamina] = await laminasDe(documento.id);
    const itemsAntes = await itemsActivos();

    await procesarLamina(lamina.id, {
      db,
      storage,
      recomputar: async () => {
        throw new Error('la conexión se cortó en el medio');
      },
    });

    // El análisis de la lámina salió bien: marcarla `error` sería mentir sobre
    // qué se rompió, y el próximo reproceso tiraría el trabajo bueno.
    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.estadoAnalisis).toBe('analizada');
    expect(despues.errorDetalle).toBe(
      `${PREFIJO_RECOMPUTO_FALLIDO}la conexión se cortó en el medio`,
    );

    const fallos = await auditoriaDe('recomputo_fallido');
    expect(fallos).toHaveLength(1);
    expect(fallos[0].actorTipo).toBe('agente');
    expect(fallos[0].targetRef).toBe(`obras:${obraId}`);
    expect(fallos[0].diffJson).toMatchObject({
      laminaId: lamina.id,
      errorDetalle: 'la conexión se cortó en el medio',
    });

    // El cómputo anterior sigue en pie: no se recalculó, no se perdió.
    expect(await itemsActivos()).toHaveLength(itemsAntes.length);

    // Y el recompute se repara solo la próxima vez que corre.
    await procesarLamina(lamina.id, { db, storage });
    const [reparada] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(reparada.errorDetalle).toBeNull();
  });
});

describe('una lámina se analiza de a una', () => {
  it('no vuelve a analizar una lámina que ya está en procesando', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const [lamina] = await laminasDe(documento.id);
    const entidadesAntes = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    const itemsAntes = await itemsActivos();

    // Otra corrida la tiene tomada (o el proceso que la tenía murió recién).
    await db
      .update(laminas)
      .set({ estadoAnalisis: 'procesando' })
      .where(eq(laminas.id, lamina.id));

    await procesarLamina(lamina.id, { db, storage });

    // La corrida en curso manda: la segunda no le pisa el estado…
    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.estadoAnalisis).toBe('procesando');

    // …ni duplica entidades ni cantidades.
    const entidadesDespues = await db.select().from(entidades).where(eq(entidades.obraId, obraId));
    expect(entidadesDespues).toHaveLength(entidadesAntes.length);
    expect(new Set(entidadesDespues.map((e) => e.id))).toEqual(
      new Set(entidadesAntes.map((e) => e.id)),
    );
    const itemsDespues = await itemsActivos();
    expect(itemsDespues).toHaveLength(itemsAntes.length);
    expect(itemsDespues.find((i) => i.claveItem === 'gruesa.ladrillos')?.cantCompra).toBe(396);

    const omitidos = await auditoriaDe('lamina_procesamiento_omitido');
    expect(omitidos).toHaveLength(1);
    expect(omitidos[0].targetRef).toBe(`laminas:${lamina.id}`);
  });

  it('dos llamadas simultáneas sobre la misma lámina la analizan una sola vez', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const [lamina] = await laminasDe(documento.id);
    const antes = await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id));
    expect(antes.length).toBeGreaterThan(0);

    await Promise.all([
      procesarLamina(lamina.id, { db, storage }),
      procesarLamina(lamina.id, { db, storage }),
    ]);

    const despues = await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id));
    expect(despues).toHaveLength(antes.length);
    expect(new Set(despues.map((e) => e.id))).toEqual(new Set(antes.map((e) => e.id)));

    // Un solo análisis nuevo: el de la subida, más el de esta corrida. Si las
    // dos llamadas hubieran corrido, habría tres.
    const analizadas = (await auditoriaDe('lamina_analizada')).filter(
      (fila) => fila.targetRef === `laminas:${lamina.id}`,
    );
    expect(analizadas).toHaveLength(2);

    // Dentro del proceso la segunda llamada no se va con las manos vacías: se
    // cuelga de la primera y espera su resultado, así que nunca llega a pedirle
    // permiso a la base (si lo hiciera, habría un `omitido` acá).
    expect(await auditoriaDe('lamina_procesamiento_omitido')).toHaveLength(0);

    const [final] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(final.estadoAnalisis).toBe('analizada');
  });

  it('retoma una lámina colgada en procesando por un proceso que murió', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');
    const [lamina] = await laminasDe(documento.id);

    // Quedó tomada y el arranque está fechado hace más del TTL: no hay nadie
    // del otro lado. Si el guard no soltara nunca, "Reprocesar" no haría nada y
    // el arquitecto se quedaría sin manera de destrabarla.
    await db
      .update(laminas)
      .set({ estadoAnalisis: 'procesando' })
      .where(eq(laminas.id, lamina.id));
    await db
      .update(auditoria)
      .set({ at: new Date(Date.now() - TTL_PROCESANDO_MS - 60_000) })
      .where(
        and(
          eq(auditoria.accion, ACCION_PROCESANDO),
          eq(auditoria.targetRef, `laminas:${lamina.id}`),
        ),
      );

    await procesarLamina(lamina.id, { db, storage });

    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.estadoAnalisis).toBe('analizada');
    expect(await auditoriaDe('lamina_procesamiento_omitido')).toHaveLength(0);

    const retomas = (await auditoriaDe(ACCION_PROCESANDO)).filter(
      (fila) =>
        fila.targetRef === `laminas:${lamina.id}` &&
        (fila.diffJson as { retomada?: boolean }).retomada === true,
    );
    expect(retomas).toHaveLength(1);
  });
});

describe('el contexto de obra llega al prompt', () => {
  /**
   * La deuda que esto cierra: `analizarLamina` mandaba `{obraId, tipoObra}` y
   * nada más, y encima pedía el rótulo **sin** ctx. Como el provider real
   * cachea por lámina y sirve la promesa de la primera llamada, el prompt que
   * efectivamente se mandaba era siempre el que no tenía contexto: el resumen,
   * el índice de láminas y las instrucciones del estudio no llegaban nunca.
   */
  it('arma el ctx completo y lo pasa a las DOS llamadas, rótulo incluido', async () => {
    const [estudio] = await db.select().from(estudios);
    await db
      .update(estudios)
      .set({
        configJson: {
          instruccionesExtraccion: {
            general: 'Las cotas de nuestros planos están en centímetros.',
            porRubro: { aberturas: 'Las medidas de las carpinterías están en la planilla DET00.' },
          },
        },
      })
      .where(eq(estudios.id, estudio.id));

    const espia = providerEspia();
    const documento = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-demo.pdf'),
    );
    await procesarDocumento(documento.id, { db, storage, provider: espia.provider });
    const paginas = await laminasDe(documento.id);

    // Una pasada de inventario y una de extracción por lámina: el inventario no
    // reemplaza al rótulo de la extracción, lo adelanta.
    expect(espia.inventarios).toHaveLength(3);
    expect(espia.rotulos).toHaveLength(3);
    expect(espia.extracciones).toHaveLength(3);
    // RNF-7: el inventario también sabe de qué obra es, o su costo no se ve.
    expect(espia.inventarios.every(({ ctx }) => ctx?.obraId === obraId)).toBe(true);
    // El rótulo se pide CON contexto, y es el mismo objeto que ve la extracción.
    expect(espia.rotulos.every(({ ctx }) => ctx !== undefined)).toBe(true);
    expect(espia.ctxDe(espia.rotulos, paginas[2].id)).toEqual(
      espia.ctxDe(espia.extracciones, paginas[2].id),
    );

    // La tercera lámina: las otras dos ya están leídas, así que el índice tiene
    // sus códigos y títulos de verdad.
    const ctx = espia.ctxDe(espia.extracciones, paginas[2].id);
    expect(ctx.obraId).toBe(obraId);
    expect(ctx.tipoObra).toBe('nueva');
    // Las **otras** láminas del expediente: la que se está leyendo no entra a su
    // propio índice.
    expect(ctx.indiceLaminas).toEqual([
      { codigo: 'A-01', titulo: 'PLANTA PB', tipo: 'planta' },
      { codigo: 'A-02', titulo: 'CORTE A-A', tipo: 'corte' },
    ]);
    expect(ctx.instruccionesEstudio).toBe(
      'Las cotas de nuestros planos están en centímetros.\n' +
        'Aberturas: Las medidas de las carpinterías están en la planilla DET00.',
    );
  });

  /**
   * Para esto existe la fase de inventario: hasta acá, la **primera** lámina de
   * la primera subida se analizaba sin saber que existía ninguna otra —el
   * índice se llenaba a medida que se analizaba— y el prompt no podía decirle
   * al modelo "no copies acá un dato que está escrito en otra lámina". Ahora
   * los rótulos se leen todos antes de extraer nada.
   */
  it('la primera lámina ya ve el índice completo del expediente', async () => {
    const espia = providerEspia();
    const documento = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-demo.pdf'),
    );
    await procesarDocumento(documento.id, { db, storage, provider: espia.provider });
    const paginas = await laminasDe(documento.id);

    expect(espia.ctxDe(espia.extracciones, paginas[0].id).indiceLaminas).toEqual([
      { codigo: 'A-02', titulo: 'CORTE A-A', tipo: 'corte' },
      { codigo: 'A-03', titulo: 'PLANILLA DE CARPINTERÍAS', tipo: 'planilla' },
    ]);
  });

  it('sin instrucciones ni resumen, el ctx queda como el de siempre', async () => {
    const espia = providerEspia();
    const documento = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-demo.pdf'),
    );
    await procesarDocumento(documento.id, { db, storage, provider: espia.provider });

    // Un estudio que no escribió instrucciones no le agrega una sección vacía
    // al prompt, y la primera lámina de la primera subida se analiza cuando
    // todavía no hay resumen ejecutivo: eso no es un error, es el orden.
    expect(espia.extracciones[0].ctx?.instruccionesEstudio).toBeUndefined();
    expect(espia.extracciones[0].ctx?.resumen).toBeUndefined();
  });

  it('el titular del resumen ejecutivo entra al ctx en cuanto existe', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
    const titular = (obra.resumenJson as { titular?: string } | null)?.titular;
    expect(titular).toBeTruthy();

    const espia = providerEspia();
    await procesarDocumento(documento.id, { db, storage, provider: espia.provider });

    expect(espia.extracciones[0].ctx?.resumen).toBe(titular);
  });
});

describe('escala declarada pero no verificada (decisión 1)', () => {
  /**
   * El reclamo, textual: el rótulo declara "1:20", la IA lo lee, y la app igual
   * bloqueaba la lámina y le hacía tipear "1:20" a mano. "Podía confirmarlo sin
   * mí, para algo estoy pagando los créditos."
   */
  it('la lámina se analiza y se computa con la escala del rótulo', async () => {
    const documento = await subirYProcesar('escala-declarada.pdf');
    const [lamina] = await laminasDe(documento.id);

    expect(lamina.estadoAnalisis).toBe('analizada');
    expect(lamina.escala).toBe('1:20');
    // Sigue sin verificar: lo que cambió es que eso ya no frena nada.
    expect(lamina.escalaConfiable).toBe(false);

    const guardadas = await db.select().from(entidades).where(eq(entidades.laminaId, lamina.id));
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0].nombre).toBe('T5');

    // T5 de 4 × 2,60 m × 2 caras = 20,80 m² netos; 12 % de desperdicio ⇒
    // 23,296 m²; placa de 2,88 m² ⇒ 9 placas ⇒ 25,92 m². Si la lámina se
    // bloqueara no habría ítem ninguno: este número es el testigo.
    const items = await itemsActivos();
    expect(items.find((i) => i.claveItem === 'seco.placas')?.cantCompra).toBe(25.92);
  });

  it('la consulta pasa a ser un supuesto no bloqueante con la escala propuesta', async () => {
    const documento = await subirYProcesar('escala-declarada.pdf');
    const [lamina] = await laminasDe(documento.id);

    const consulta = await hallazgoPorClave(`escala.${lamina.id}`);
    expect(consulta.estado).toBe('abierto');
    expect(consulta.tipo).toBe('supuesto');
    expect(consulta.bloqueante).toBe(false);
    // La escala no es un campo de ninguna entidad: se confirma con su botón.
    expect(consulta.targetRef).toBeNull();
    expect(consulta.valorPropuestoJson).toEqual({
      valores: { escala: '1:20' },
      origen: 'rotulo',
      confianza: 0.9,
    });
    expect(consulta.descripcion).toBe(descripcionEscalaAsumida('1:20'));
  });

  it('el supuesto abierto no frena la aprobación del rubro (RF-404)', async () => {
    await subirYProcesar('escala-declarada.pdf');

    const filas = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
    expect(filas.some((f) => f.clave.startsWith('escala.') && f.estado === 'abierto')).toBe(true);
    expect(puedeAprobarRubro('seco', filas)).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('sin ninguna escala declarada sigue bloqueando, igual que siempre', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');
    const [lamina] = await laminasDe(documento.id);

    expect(lamina.estadoAnalisis).toBe('bloqueada_escala');
    const consulta = await hallazgoPorClave(`escala.${lamina.id}`);
    expect(consulta.tipo).toBe('faltante');
    expect(consulta.bloqueante).toBe(true);
    expect(consulta.valorPropuestoJson).toBeNull();
    expect(puedeAprobarRubro('seco', [consulta])).toEqual({ ok: false, bloqueantes: 1 });
  });
});

describe('una planilla sin escala declarada se lee igual', () => {
  /**
   * La trampa que la revisión final encontró, y que es exactamente la regla 6
   * de `tests/CLAUDE.md` cometida en la misma ola que escribió la regla.
   *
   * Una planilla de carpinterías no imprime escala en el rótulo —no tiene por
   * qué: es una tabla—, y el prompt real (`claude.ts`, regla 4) manda
   * `escalaConfiable: true` SOLO tras verificar contra ≥ 2 cotas. O sea que el
   * provider real devuelve `escala: null, escalaConfiable: false` para toda
   * planilla, y con eso `modoEscala` daba `bloqueada`: sin filas extraídas, sin
   * deducción planilla↔plano y excluida de la búsqueda dirigida, que exige
   * `analizada`. Los cuatro fixtures de planilla del repo declaraban
   * `escalaConfiable: true` —una salida que el provider real **no puede
   * emitir**— y la suite entera validaba un rótulo imposible.
   *
   * `obra-reforma.pdf` p2 es esa planilla, ahora con el rótulo que el provider
   * real sí produce. Este test es el que faltaba.
   */
  it('queda analizada, con sus filas extraídas y sin consulta de escala', async () => {
    const documento = await subirYProcesar('obra-reforma.pdf');
    const lams = await laminasDe(documento.id);
    const planilla = lams.find((l) => l.tipo === 'planilla');
    if (!planilla) throw new Error('el fixture de reforma tiene que traer una planilla');

    // El rótulo que el provider real puede emitir: sin escala y sin verificar.
    expect(planilla.escala).toBeNull();
    expect(planilla.escalaConfiable).toBe(false);
    // Y aun así se leyó: en una tabla no se mide, se transcribe.
    expect(planilla.estadoAnalisis).toBe('analizada');

    const filas = await db.select().from(entidades).where(eq(entidades.laminaId, planilla.id));
    expect(filas.map((e) => e.nombre).sort()).toEqual(['P3', 'V5']);
    expect(filas.find((e) => e.nombre === 'P3')?.atributosJson).toMatchObject({
      anchoM: 0.8,
      altoM: 2.05,
    });

    // Sin hallazgo de escala: preguntar por la escala de una planilla es pedir
    // un dato que no cambia nada de lo que se extrajo.
    expect(await hallazgoPorClave(`escala.${planilla.id}`)).toBeUndefined();

    // `analizada` + `planilla` es exactamente lo que `laminasCandidatas` pide
    // para releerla en la búsqueda dirigida: con la planilla bloqueada, la
    // lámina donde están escritas las medidas no entraba nunca.
  });

  it('la planilla no bloquea el rubro y una lámina común sin escala sí', async () => {
    await subirYProcesar('obra-reforma.pdf');
    await subirYProcesar('sin-escala.pdf');

    const abiertos = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.estado, 'abierto')));
    const deEscala = abiertos.filter((f) => f.clave.startsWith('escala.'));

    // Una sola consulta de escala en toda la obra, y es la del plano sin escala.
    expect(deEscala).toHaveLength(1);
    expect(deEscala[0].bloqueante).toBe(true);
  });
});

describe('confirmar la escala asumida', () => {
  it('confirmar la misma escala no vuelve a llamar al modelo', async () => {
    const documento = await subirYProcesar('escala-declarada.pdf');
    const [lamina] = await laminasDe(documento.id);
    expect(await procesamientosDe(lamina.id)).toBe(1);

    const espia = providerEspia();
    const despues = await actualizarLamina(
      db,
      lamina.id,
      { escala: '1:20', escalaConfiable: true },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { db, storage, provider: espia.provider },
    );

    // Lo que el arquitecto confirma es exactamente lo que ya se computó:
    // re-extraer sería cobrarle una llamada para llegar al mismo número.
    expect(espia.rotulos).toEqual([]);
    expect(espia.extracciones).toEqual([]);
    expect(await procesamientosDe(lamina.id)).toBe(1);

    expect(despues.escalaConfiable).toBe(true);
    expect(despues.escala).toBe('1:20');
    expect(despues.estadoAnalisis).toBe('analizada');
    expect((await hallazgoPorClave(`escala.${lamina.id}`)).estado).toBe('respondido');

    // El cómputo no se movió y quedó registrado quién confirmó.
    expect((await itemsActivos()).find((i) => i.claveItem === 'seco.placas')?.cantCompra).toBe(
      25.92,
    );
    const confirmaciones = await auditoriaDe('lamina_escala_confirmada');
    expect(confirmaciones).toHaveLength(1);
    expect(confirmaciones[0].actorTipo).toBe('usuario');
  });

  it('corregirla a otro valor sí re-analiza la lámina', async () => {
    const documento = await subirYProcesar('escala-declarada.pdf');
    const [lamina] = await laminasDe(documento.id);

    const despues = await actualizarLamina(
      db,
      lamina.id,
      { escala: '1:25', escalaConfiable: true },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { db, storage },
    );

    // Todo lo que se midió se midió con la escala anterior: hay que rehacerlo.
    expect(await procesamientosDe(lamina.id)).toBe(2);
    // Y el rótulo no le pisa la corrección al volver a leer la lámina.
    expect(despues.escala).toBe('1:25');
    expect(despues.escalaConfiable).toBe(true);
    expect(despues.estadoAnalisis).toBe('analizada');
    expect((await hallazgoPorClave(`escala.${lamina.id}`)).estado).toBe('respondido');
  });

  it('confirmar la escala de una lámina que no llegó a analizarse sí la manda a analizar', async () => {
    const documento = await subirYProcesar('sin-escala.pdf');
    const [lamina] = await laminasDe(documento.id);

    // La corrida anterior se cayó y la lámina quedó en `error`: no tiene
    // entidades. Cerrarle la consulta sin reprocesar la dejaría fuera del
    // cómputo y sin nada que lo explique.
    await db
      .update(laminas)
      .set({ estadoAnalisis: 'error', errorDetalle: 'la conexión se cortó' })
      .where(eq(laminas.id, lamina.id));

    const despues = await actualizarLamina(
      db,
      lamina.id,
      { escala: '1:50', escalaConfiable: true },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { db, storage },
    );

    expect(await procesamientosDe(lamina.id)).toBe(2);
    expect(despues.estadoAnalisis).toBe('analizada');
    expect(despues.errorDetalle).toBeNull();
  });

  it('desde la bandeja, confirmar el supuesto tampoco re-analiza', async () => {
    const documento = await subirYProcesar('escala-declarada.pdf');
    const [lamina] = await laminasDe(documento.id);
    const consulta = await hallazgoPorClave(`escala.${lamina.id}`);

    const espia = providerEspia();
    const resultado = await responderHallazgo(
      // La tarjeta manda la propuesta tal cual la leyó el rótulo: un click.
      { obraId, hallazgoId: consulta.id, valores: { escala: '1:20' } },
      { usuarioId, email: 'arq@estudionorte.ar' },
      { storage, provider: espia.provider },
    );

    expect(resultado).toEqual({ ok: true });
    expect(espia.rotulos).toEqual([]);
    expect(await procesamientosDe(lamina.id)).toBe(1);

    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.escalaConfiable).toBe(true);
    expect(despues.escala).toBe('1:20');
    // La bandeja cierra la consulta antes de reprocesar, así que queda como
    // respondida por él y no descartada por el pipeline.
    expect((await hallazgoPorClave(`escala.${lamina.id}`)).estado).toBe('respondido');
  });
});

/**
 * La red que le faltaba a `fusionarRotulo`.
 *
 * Que la escala confirmada no se pise está bien y ya estaba testeado: protege
 * la corrección del arquitecto de un rótulo mal impreso. Lo que no estaba
 * fijado por ningún test es **qué pasa con el valor que se descarta**. Hasta
 * acá se iba en silencio: "Reprocesar" sobre una lámina ya confiable podía leer
 * otra escala, tirarla, y dejar la lámina computada con la vieja sin que nada
 * en ninguna pantalla lo dijera. Si esa relectura es la verificada contra
 * cotas, el cómputo entero puede estar corrido por el factor entre las dos.
 *
 * La decisión, escrita: el valor no se pisa (eso no cambia) **y** deja de irse
 * en silencio — sale un aviso no bloqueante con la escala releída como
 * propuesta. Solo cuando la relectura viene verificada: una lectura sin
 * verificar que difiere es el caso del rótulo mal impreso, y volver a
 * preguntar por eso en cada reproceso es el ruido que el plan vino a sacar.
 */
describe('la relectura del rótulo contra la escala confirmada', () => {
  const ARQUITECTA = { usuarioId: '', email: 'arq@estudionorte.ar' };

  /** Un rótulo con esta escala y ninguna entidad: lo que interesa es la escala. */
  function providerConRotulo(escala: string, escalaConfiable: boolean): AnalysisProvider {
    return {
      async leerRotulo() {
        return { ...rotuloNulo(), escala, escalaConfiable, confianza: 0.95 };
      },
      async extraerEntidades() {
        return [];
      },
    };
  }

  /** La lámina de `escala-declarada.pdf` con la escala corregida a mano y confirmada. */
  async function conEscalaConfirmada(escala: string): Promise<Lamina> {
    const documento = await subirYProcesar('escala-declarada.pdf');
    const [lamina] = await laminasDe(documento.id);
    await actualizarLamina(db, lamina.id, { escala, escalaConfiable: true }, ARQUITECTA, {
      db,
      storage,
    });
    const [confirmada] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    return confirmada;
  }

  function reprocesarCon(laminaId: string, escala: string, confiable: boolean): Promise<void> {
    return procesarLamina(laminaId, { db, storage, provider: providerConRotulo(escala, confiable) });
  }

  it('la escala confirmada no se pisa, y la relectura verificada queda avisada', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');

    await reprocesarCon(lamina.id, '1:50', true);

    // Lo de siempre: la corrección del arquitecto manda.
    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.escala).toBe('1:25');
    expect(despues.escalaConfiable).toBe(true);

    // Lo nuevo: el valor descartado tiene dónde verse.
    const aviso = await hallazgoPorClave(`escala.${lamina.id}.rotulo`);
    expect(aviso.estado).toBe('abierto');
    expect(aviso.tipo).toBe('inconsistencia');
    expect(aviso.bloqueante).toBe(false);
    expect(aviso.descripcion).toBe(descripcionEscalaRelectura('1:25', '1:50'));
    expect(aviso.valorPropuestoJson).toEqual({
      valores: { escala: '1:50' },
      origen: 'rotulo',
      confianza: 0.95,
    });
  });

  it('avisa sin frenar: el rubro se sigue pudiendo aprobar (RF-404)', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');
    await reprocesarCon(lamina.id, '1:50', true);

    const filas = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
    expect(filas.some((f) => f.clave.endsWith('.rotulo') && f.estado === 'abierto')).toBe(true);
    expect(puedeAprobarRubro('seco', filas)).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('una relectura SIN verificar que difiere no dice nada: es el rótulo que él ya corrigió', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');

    // El rótulo sigue diciendo 1:20 y el modelo sigue sin poder verificarlo:
    // insistir con eso en cada reproceso es pedirle que descarte lo mismo para
    // siempre.
    await reprocesarCon(lamina.id, '1:20', false);

    expect(await hallazgoPorClave(`escala.${lamina.id}.rotulo`)).toBeUndefined();
  });

  it('la misma escala escrita distinto no es una contradicción', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');

    await reprocesarCon(lamina.id, ' 1: 25 ', true);

    expect(await hallazgoPorClave(`escala.${lamina.id}.rotulo`)).toBeUndefined();
  });

  it('reprocesar dos veces no duplica el aviso ni deja un diff fantasma', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');
    await reprocesarCon(lamina.id, '1:50', true);

    const antes = (await todaLaAuditoria()).length;
    await reprocesarCon(lamina.id, '1:50', true);

    const avisos = (await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId))).filter(
      (fila) => fila.clave === `escala.${lamina.id}.rotulo`,
    );
    expect(avisos).toHaveLength(1);
    const escrituras = (await todaLaAuditoria())
      .slice(antes)
      .filter((fila) => ESCRITURAS_DE_DATOS.has(fila.accion));
    expect(escrituras).toEqual([]);
  });

  it('cuando la relectura vuelve a coincidir, el aviso se cierra solo', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');
    await reprocesarCon(lamina.id, '1:50', true);

    await reprocesarCon(lamina.id, '1:25', true);

    expect((await hallazgoPorClave(`escala.${lamina.id}.rotulo`)).estado).toBe('descartado');
  });

  it('lo que él descartó no se reabre en el próximo reproceso', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');
    await reprocesarCon(lamina.id, '1:50', true);

    const aviso = await hallazgoPorClave(`escala.${lamina.id}.rotulo`);
    await db.update(hallazgos).set({ estado: 'descartado' }).where(eq(hallazgos.id, aviso.id));

    await reprocesarCon(lamina.id, '1:50', true);

    expect((await hallazgoPorClave(`escala.${lamina.id}.rotulo`)).estado).toBe('descartado');
  });

  it('confirmarlo desde la bandeja adopta la escala del rótulo y vuelve a medir', async () => {
    ARQUITECTA.usuarioId = usuarioId;
    const lamina = await conEscalaConfirmada('1:25');
    await reprocesarCon(lamina.id, '1:50', true);
    const procesamientosPrevios = await procesamientosDe(lamina.id);

    const aviso = await hallazgoPorClave(`escala.${lamina.id}.rotulo`);
    // La tarjeta lo trata como lo que es —una consulta de escala— y manda la
    // propuesta tal cual: un click.
    const resultado = await responderHallazgo(
      { obraId, hallazgoId: aviso.id, valores: { escala: '1:50' } },
      ARQUITECTA,
      { storage, provider: providerConRotulo('1:50', true) },
    );

    expect(resultado).toEqual({ ok: true });
    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.escala).toBe('1:50');
    expect(despues.escalaConfiable).toBe(true);
    // La escala cambió: todo lo que se midió con la anterior hay que rehacerlo.
    expect(await procesamientosDe(lamina.id)).toBe(procesamientosPrevios + 1);
    expect((await hallazgoPorClave(`escala.${lamina.id}.rotulo`)).estado).toBe('respondido');
  });
});

describe('búsqueda dirigida al final del documento (C2)', () => {
  it('corre una sola vez, después del resumen, con toda la obra analizada', async () => {
    const corridas: string[] = [];
    const documento = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-demo.pdf'),
    );

    await procesarDocumento(documento.id, {
      db,
      storage,
      async buscar(id) {
        corridas.push(id);
        // El orden importa: antes del recompute no existe la lista de lo que
        // falta, y antes del resumen la obra todavía no está contada.
        const lams = await laminasDe(documento.id);
        expect(lams.every((l) => l.estadoAnalisis === 'analizada')).toBe(true);
        const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
        expect(obra.resumenJson).not.toBeNull();
        return undefined;
      },
    });

    expect(corridas).toEqual([obraId]);
  });

  it('con el default sobre obra-demo no hay nada que buscar: cero llamadas, cero escrituras', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    // La corrida sin objetivos no audita ni una línea (es la del 90 % de los
    // casos y tiene que ser gratis), y no deja ni una propuesta ni una marca.
    expect(await auditoriaDe('busqueda_dirigida')).toEqual([]);
    expect(await auditoriaDe('hallazgo_valor_propuesto')).toEqual([]);
    expect(await auditoriaDe('hallazgo_sin_resultado')).toEqual([]);

    // Es la obra que sale entera: ninguna consulta con target, así que no hay
    // ningún dato que salir a buscar y no se gasta una llamada.
    const filas = await todosLosHallazgos();
    expect(filas.filter((f) => f.targetRef !== null)).toEqual([]);
    expect(filas.every((f) => f.valorPropuestoJson === null && f.busquedaJson === null)).toBe(true);
    expect((await laminasDe(documento.id)).every((l) => l.estadoAnalisis === 'analizada')).toBe(
      true,
    );
  });

  it('si la búsqueda se cae, el documento queda igual de bien y el fallo queda auditado', async () => {
    const documento = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-demo.pdf'),
    );

    await expect(
      procesarDocumento(documento.id, {
        db,
        storage,
        buscar: async () => {
          throw new Error('el modelo no contestó');
        },
      }),
    ).resolves.toBeUndefined();

    // El análisis y el cómputo ya estaban guardados: lo único que se pierde es
    // una propuesta, y la consulta sigue en la bandeja como pregunta.
    const lams = await laminasDe(documento.id);
    expect(lams.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada', 'analizada']);
    expect(lams.every((l) => l.errorDetalle === null)).toBe(true);
    expect((await itemsActivos()).length).toBeGreaterThan(0);

    const fallos = await auditoriaDe(ACCION_BUSQUEDA_FALLIDA);
    expect(fallos).toHaveLength(1);
    expect(fallos[0].actorTipo).toBe('agente');
    expect(fallos[0].targetRef).toBe(`obras:${obraId}`);
    expect(fallos[0].diffJson).toMatchObject({ errorDetalle: 'el modelo no contestó' });
  });
});

describe('lo que se buscó y no está no se vuelve a pagar', () => {
  /** La búsqueda que no encuentra nada, contando qué se le pidió. */
  function busquedaVacia(pedidos: string[][]) {
    const provider: BusquedaProvider = {
      nombre: 'busqueda-test',

      async buscarDatos(_lamina, objetivos) {
        pedidos.push(objetivos.map((objetivo) => objetivo.clave));
        return [];
      },
    };
    return (id: string, deps: { db: Db; storage: StorageAdapter }) =>
      buscarDatosFaltantes(id, { ...deps, provider });
  }

  const CLAVE = 'aberturas.medidas_vano.FP01';

  it('la marca evita que la corrida siguiente vuelva a pagar la misma consulta', async () => {
    const pedidos: string[][] = [];
    const buscar = busquedaVacia(pedidos);

    const documento = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-busqueda.pdf'),
    );
    await procesarDocumento(documento.id, { db, storage, buscar });

    // Se buscó de verdad: dos láminas candidatas, las dos por la misma consulta.
    expect(pedidos).toEqual([[CLAVE], [CLAVE]]);
    const consulta = await hallazgoPorClave(CLAVE);
    expect(consulta.estado).toBe('abierto');
    expect(consulta.valorPropuestoJson).toBeNull();
    expect(consulta.busquedaJson).toMatchObject({ campos: ['anchoM', 'altoM'] });
    expect(consulta.busquedaJson?.huella).toMatch(/^[0-9a-f]{64}$/);

    const marcas = await auditoriaDe('hallazgo_sin_resultado');
    expect(marcas).toHaveLength(1);
    expect(marcas[0].targetRef).toBe(`hallazgos:${CLAVE}`);

    // Segunda corrida sobre la misma documentación: ni una llamada más.
    pedidos.length = 0;
    await procesarDocumento(documento.id, { db, storage, buscar });

    expect(pedidos).toEqual([]);
    expect(await auditoriaDe('hallazgo_sin_resultado')).toHaveLength(1);
    expect((await hallazgoPorClave(CLAVE)).busquedaJson).toEqual(consulta.busquedaJson);
  });

  it('documentación nueva caduca la marca y el dato se vuelve a buscar', async () => {
    const pedidos: string[][] = [];
    const buscar = busquedaVacia(pedidos);

    const primero = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-busqueda.pdf'),
    );
    await procesarDocumento(primero.id, { db, storage, buscar });
    expect((await hallazgoPorClave(CLAVE)).busquedaJson).not.toBeNull();

    // El arquitecto sube el legajo que faltaba: la marca tiene que caducar, si
    // no el dato que recién llegó no se buscaría nunca.
    pedidos.length = 0;
    const segundo = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-demo.pdf'),
    );
    await procesarDocumento(segundo.id, { db, storage, buscar });

    expect(pedidos.length).toBeGreaterThan(0);
    expect(pedidos.some((claves) => claves.includes(CLAVE))).toBe(true);
  });

  it('la marca no se escribe si el arquitecto contestó mientras se buscaba', async () => {
    const documento = await subirDocumento(
      db,
      storage,
      obraId,
      usuarioId,
      await archivoFixture('obra-busqueda.pdf'),
    );
    await procesarDocumento(documento.id, {
      db,
      storage,
      buscar: (id, deps) =>
        buscarDatosFaltantes(id, {
          ...deps,
          provider: {
            nombre: 'busqueda-test',

            async buscarDatos() {
              await db
                .update(hallazgos)
                .set({ estado: 'respondido', respuestaJson: { anchoM: 1.2, altoM: 2.4 } })
                .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, CLAVE)));
              return [];
            },
          },
        }),
    });

    const consulta = await hallazgoPorClave(CLAVE);
    expect(consulta.estado).toBe('respondido');
    expect(consulta.busquedaJson).toBeNull();
    expect(await auditoriaDe('hallazgo_sin_resultado')).toEqual([]);
  });
});

describe('desvinculación de ítems', () => {
  it('audita cuando un ítem editado a mano pierde la entidad que lo respaldaba', async () => {
    const documento = await subirYProcesar('obra-demo.pdf');

    const [item] = await db
      .select()
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'gruesa.ladrillos')));
    expect(item.entidadId).not.toBeNull();

    // El arquitecto se apropia del ítem: desde acá, la fila es de él.
    await db
      .update(computoItems)
      .set({ editadoPor: usuarioId })
      .where(eq(computoItems.id, item.id));

    const [entidad] = await db
      .select()
      .from(entidades)
      .where(eq(entidades.id, item.entidadId as string));

    // Se re-analiza la lámina y el agente ya no encuentra esa entidad.
    await procesarLamina(entidad.laminaId, {
      db,
      storage,
      provider: providerSinEntidades(),
    });

    const [despues] = await db
      .select()
      .from(computoItems)
      .where(eq(computoItems.id, item.id));
    // La fila del humano no se borra: pierde el link, no la fila.
    expect(despues.entidadId).toBeNull();
    expect(despues.editadoPor).toBe(usuarioId);
    expect(despues.cantCompra).toBe(item.cantCompra);

    const desvinculados = await auditoriaDe('computo_item_desvinculado');
    const propia = desvinculados.find(
      (fila) => fila.targetRef === `computo_items:${item.claveItem}`,
    );
    expect(propia).toBeDefined();
    expect(propia?.actorTipo).toBe('agente');
    expect(propia?.diffJson).toMatchObject({
      entidadId: { antes: item.entidadId, despues: null },
      editadoPor: usuarioId,
    });
  });
});
