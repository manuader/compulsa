/**
 * El pipeline por fases (§4), de punta a punta, sobre `obra-fases.pdf`.
 *
 * La obra del fixture está armada para que cada fase tenga algo que hacer y
 * para que ninguna pueda tapar a otra:
 *
 *  - **T1** está dibujado en la planta sin altura y la altura de local está
 *    acotada en el corte. Ninguna regla determinista los une —el corte no
 *    dibuja un T1 del que copiar— así que si el ítem de seco sale computado, lo
 *    completó el **cruce**;
 *  - **M1** (planta, sin largo) y **M2** (corte, sin altura) están dibujados a
 *    escala y no acotados: sus medidas solo pueden salir de **medir el
 *    dibujo**, y sus ítems tienen que salir `inferido`;
 *  - **T2** queda sin altura después del cruce, así que la consulta agrupada
 *    `dato_obra.altura_local.general` sigue abierta y la **búsqueda dirigida**
 *    tiene adónde ir: al corte, que es donde está acotada. La clave es
 *    `general` y no `PB` a propósito: los tabiques de la planta **no** declaran
 *    `nivel` —que es lo más común en una planta real, y lo que el prompt
 *    produce cuando la lámina no lo dice—, así que la cadena de respaldo
 *    pregunta por el hecho que vale para toda la obra.
 *
 * Los providers son SIEMPRE los mocks (`NODE_ENV=test`), con los fixtures de
 * `tests/fixtures/analysis/` — el del cruce es el único cuya clave es la obra
 * (`cruce/obra-fases.json`, por `slug(nombreObra)`).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  computoItems,
  datosObra,
  deducciones,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Entidad,
  type Lamina,
} from '@/db/schema';
import { getAnalysisProvider, type AnalysisProvider } from '@/lib/analysis/index';
import type { CruceProvider, RespuestaCruceCruda } from '@/lib/analysis/cruce-tipos';
import {
  ACCION_CRUCE,
  ACCION_IDENTIDAD,
  aplicarCruce,
  claveConflicto,
  descripcionConflicto,
  expedienteDelCruce,
  RESPUESTA_CRUCE_RESUELTO,
} from '@/lib/pipeline/cruce';
import {
  ACCION_CRUCE_FALLIDO,
  ACCION_CRUCE_REINTENTADO,
  ACCION_FASE,
  AnalisisEnCursoError,
  CONFIANZA_MEDICION,
  MARCA_METODO,
  marcarAnalisisFallido,
  ObraInexistenteError,
  procesarDocumento,
  reintentarCruce,
  subirDocumento,
} from '@/lib/pipeline/procesar';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';
import { TTL_FASE_ANALISIS_MS, type FaseAnalisis } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

/** La consulta agrupada por el dato de obra que les falta a los tabiques. */
const CLAVE_ALTURA = 'dato_obra.altura_local.general';

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let estudioId: string;
let usuarioId: string;
let obraId: string;

async function crearObra(nombre: string): Promise<string> {
  const [obra] = await db
    .insert(obras)
    .values({ estudioId, nombre, zona: 'CABA', tipo: 'nueva' })
    .returning();
  return obra.id;
}

async function subirYProcesar(obra: string, nombre = 'obra-fases.pdf'): Promise<string> {
  const bytes = await readFile(new URL(nombre, PDFS));
  const archivo = new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
  const documento = await subirDocumento(db, storage, obra, usuarioId, archivo);
  await procesarDocumento(documento.id, { db, storage });
  return documento.id;
}

function laminasDe(obra: string): Promise<Lamina[]> {
  return db
    .select()
    .from(laminas)
    .where(eq(laminas.obraId, obra))
    .orderBy(asc(laminas.numeroPagina));
}

function entidadesDe(obra: string): Promise<Entidad[]> {
  return db.select().from(entidades).where(eq(entidades.obraId, obra)).orderBy(asc(entidades.nombre));
}

function deduccionesDe(obra: string) {
  return db
    .select()
    .from(deducciones)
    .where(eq(deducciones.obraId, obra))
    .orderBy(asc(deducciones.campo));
}

function itemsDe(obra: string) {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obra), eq(computoItems.estado, 'activo')))
    .orderBy(asc(computoItems.claveItem));
}

function auditoriaDe(obra: string, accion: string) {
  return db
    .select()
    .from(auditoria)
    .where(and(eq(auditoria.obraId, obra), eq(auditoria.accion, accion)))
    .orderBy(asc(auditoria.at));
}

function hallazgoPorClave(obra: string, clave: string) {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obra), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

async function faseDe(obra: string): Promise<FaseAnalisis | null> {
  const [fila] = await db.select().from(obras).where(eq(obras.id, obra));
  return fila.analisisJson;
}

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-fases-'));
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

  estudioId = estudio.id;
  usuarioId = usuario.id;
  // El nombre importa: el mock del cruce resuelve su fixture con
  // `slug(nombreObra)` ⇒ `tests/fixtures/analysis/cruce/obra-fases.json`.
  obraId = await crearObra('Obra Fases');
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

describe('las cinco fases', () => {
  it('el análisis pasa por las cinco fases, en orden, y termina en listo', async () => {
    await subirYProcesar(obraId);

    const fases = (await auditoriaDe(obraId, ACCION_FASE)).map((fila) => fila.diffJson?.fase);
    expect(fases).toEqual(['inventario', 'extraccion', 'cruce', 'relectura', 'listo']);
    expect(await faseDe(obraId)).toMatchObject({ fase: 'listo' });
  });

  it('la fase de inventario deja el índice completo antes de extraer', async () => {
    await subirYProcesar(obraId);

    const planos = await laminasDe(obraId);
    expect(planos.map((l) => l.codigo)).toEqual(['A-01', 'A-02']);
    expect(planos.map((l) => l.tipo)).toEqual(['planta', 'corte']);
    // El inventario escribe el índice; la escala la decide la extracción, que
    // es la que sabe si la lámina se computa o se bloquea (RF-201).
    expect(planos.map((l) => l.escala)).toEqual(['1:50', '1:50']);
    expect(planos.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada']);
  });

  it('la extracción corre en paralelo: las dos láminas están en vuelo a la vez', async () => {
    const real = getAnalysisProvider();
    let enVuelo = 0;
    let pico = 0;
    const provider: AnalysisProvider = {
      leerRotulo: (lamina, ctx) => real.leerRotulo(lamina, ctx),
      inventariar: (lamina, ctx) => real.leerRotulo(lamina, ctx),
      async extraerEntidades(lamina, ctx) {
        enVuelo += 1;
        pico = Math.max(pico, enVuelo);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const entidadesLeidas = await real.extraerEntidades(lamina, ctx);
        enVuelo -= 1;
        return entidadesLeidas;
      },
    };

    const bytes = await readFile(new URL('obra-fases.pdf', PDFS));
    const archivo = new File([new Uint8Array(bytes)], 'obra-fases.pdf', {
      type: 'application/pdf',
    });
    const documento = await subirDocumento(db, storage, obraId, usuarioId, archivo);
    await procesarDocumento(documento.id, { db, storage, provider });

    expect(pico).toBe(2);
  });
});

describe('el cruce del expediente', () => {
  it('completa la altura de T1 desde el corte y el ítem sale deducido', async () => {
    await subirYProcesar(obraId);

    const planos = await laminasDe(obraId);
    const corte = planos[1];
    const elementos = await entidadesDe(obraId);
    const t1 = elementos.find((e) => e.nombre === 'T1');

    const [deduccion] = (await deduccionesDe(obraId)).filter(
      (fila) => fila.entidadId === t1?.id && fila.campo === 'alturaM',
    );
    expect(deduccion.regla).toBe('cruce');
    // §5.4: una deducción de cruce con confianza ≥ 0,7 nace validada y se aplica
    // en la misma corrida. `validado_por` en null: la validó la regla, no nadie.
    expect(deduccion.estado).toBe('validada');
    expect(deduccion.validadoPor).toBeNull();
    expect(deduccion.confianza).toBeCloseTo(0.85, 5);
    expect(deduccion.valorJson).toEqual({ alturaM: 2.6 });
    // P1: la fuente es el corte, que es donde está escrita la altura.
    expect(deduccion.fuentesJson[0]?.laminaId).toBe(corte.id);

    // El tabique se computa con esa altura y el ítem lo dice: `deducido`.
    const placas = (await itemsDe(obraId)).find((item) => item.claveItem === 'seco.placas');
    expect(placas?.origen).toBe('deducido');
    // T1: 4 m × 2,60 m × 2 caras = 20,80 m² netos (T2 sigue sin altura).
    expect(placas?.cantNeta).toBe(20.8);
  });

  it('T2 se queda sin altura: la consulta agrupada sigue abierta', async () => {
    await subirYProcesar(obraId);

    const consulta = await hallazgoPorClave(obraId, CLAVE_ALTURA);
    expect(consulta?.estado).toBe('abierto');
    expect(consulta?.bloqueante).toBe(false);
    expect(consulta?.targetDato?.clave).toBe('altura_local.general');
    expect(consulta?.descripcion).toContain('T2');
    expect(consulta?.descripcion).not.toContain('T1');
  });

  it('escribe el dato de obra que supera el umbral y omite el que no', async () => {
    await subirYProcesar(obraId);

    const planos = await laminasDe(obraId);
    const datos = await db.select().from(datosObra).where(eq(datosObra.obraId, obraId));
    expect(datos.map((dato) => dato.clave)).toEqual(['nivel.PB']);

    const [nivel] = datos;
    expect(nivel.valorJson).toEqual({ valor: 0, unidad: 'm' });
    expect(nivel.origen).toBe('deducido');
    expect(nivel.confianza).toBeCloseTo(0.9, 5);
    expect(nivel.definidoPor).toBeNull();
    expect(nivel.fuentesJson[0]?.laminaId).toBe(planos[1].id);

    // El de 0,50 de confianza no se escribió, y queda contado: un dato de obra
    // no tiene entidad a la que apuntar, así que no hay dónde proponerlo.
    const [corrida] = await auditoriaDe(obraId, ACCION_CRUCE);
    expect(corrida.diffJson).toMatchObject({
      datosEscritos: 1,
      datosOmitidos: 1,
      camposCompletados: 1,
      relecturas: 1,
    });
  });

  it('sin fixture de cruce la obra termina igual, sin nada del cruce', async () => {
    const otra = await crearObra('Obra Sin Cruce');
    await subirYProcesar(otra);

    expect(await faseDe(otra)).toMatchObject({ fase: 'listo' });
    expect((await deduccionesDe(otra)).map((fila) => fila.regla)).toEqual([
      'medicion_grafica',
      'medicion_grafica',
    ]);
    expect(await db.select().from(datosObra).where(eq(datosObra.obraId, otra))).toEqual([]);

    // Sin la altura del cruce, ningún tabique se computa y la consulta agrupada
    // los nombra a los dos: es el estado honesto de una obra sin cruzar.
    const consulta = await hallazgoPorClave(otra, CLAVE_ALTURA);
    expect(consulta?.descripcion).toContain('T1');
    expect(consulta?.descripcion).toContain('T2');
  });
});

describe('la medición gráfica', () => {
  it('mide el largo en la planta y la altura en el corte, con origen inferido', async () => {
    await subirYProcesar(obraId);

    const elementos = await entidadesDe(obraId);
    const m1 = elementos.find((e) => e.nombre === 'M1');
    const m2 = elementos.find((e) => e.nombre === 'M2');
    const medidas = (await deduccionesDe(obraId)).filter(
      (fila) => fila.regla === 'medicion_grafica',
    );

    const largo = medidas.find((fila) => fila.entidadId === m1?.id);
    // bbox 0,50 de ancho × 841,89 pts / 72 × 0,0254 × 50 = 7,43 m
    expect(largo?.campo).toBe('largoM');
    expect(largo?.valorJson[MARCA_METODO]).toBe('medición gráfica sobre el dibujo a escala 1:50');
    expect(largo?.valorJson.largoM).toBe(7.43);
    expect(largo?.confianza).toBe(CONFIANZA_MEDICION);
    expect(largo?.estado).toBe('validada');
    expect(largo?.validadoPor).toBeNull();

    const alto = medidas.find((fila) => fila.entidadId === m2?.id);
    expect(alto?.campo).toBe('alturaM');
    expect(alto?.valorJson.alturaM).toBe(2.6);

    // §5.5: lo medido sobre el dibujo deja el ítem en `inferido`, un escalón por
    // debajo de lo deducido de otra lámina.
    const ladrillos = (await itemsDe(obraId)).find((item) => item.claveItem.startsWith('gruesa.'));
    expect(ladrillos?.origen).toBe('inferido');
  });

  it('no le inventa una altura a lo que está dibujado en planta', async () => {
    await subirYProcesar(obraId);

    const elementos = await entidadesDe(obraId);
    const enPlanta = new Set(
      elementos.filter((e) => ['T1', 'T2', 'M1'].includes(e.nombre)).map((e) => e.id),
    );
    const alturasMedidas = (await deduccionesDe(obraId)).filter(
      (fila) =>
        fila.regla === 'medicion_grafica' && fila.campo === 'alturaM' && enPlanta.has(fila.entidadId),
    );

    // En planta, el alto del rectángulo de un tabique es su ESPESOR: leerlo como
    // altura sería un número plausible y equivocado, y encima taparía al corte y
    // al cruce, que son los que saben.
    expect(alturasMedidas).toEqual([]);
  });
});

describe('la relectura dirigida', () => {
  it('propone la altura de obra sobre la consulta agrupada, leída en el corte', async () => {
    await subirYProcesar(obraId);

    const planos = await laminasDe(obraId);
    const consulta = await hallazgoPorClave(obraId, CLAVE_ALTURA);

    // El contrato que confirma la bandeja: un solo campo, `valor`, ya numérico
    // porque el dato tiene unidad, con la lámina donde se leyó.
    expect(consulta?.valorPropuestoJson).toMatchObject({
      valores: { valor: 2.6 },
      origen: 'busqueda_dirigida',
    });
    expect(consulta?.valorPropuestoJson?.fuente?.laminaId).toBe(planos[1].id);
    // Y **no** se escribió el dato: P4 sigue en pie, la propuesta espera el
    // click del arquitecto.
    expect(
      await db.select().from(datosObra).where(eq(datosObra.clave, 'altura_local.general')),
    ).toEqual([]);
  });
});

/**
 * Acciones que solo aparecen si la corrida escribió un dato de la obra. Es el
 * mismo set de `pipeline.test.ts` más las cinco que trajeron las fases nuevas.
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
  'hallazgo_valor_propuesto',
  'hallazgo_sin_resultado',
  // Las de las fases nuevas.
  'lamina_inventariada',
  'dato_obra_escrito',
  'dato_obra_actualizado',
  'deduccion_aplicada',
  'entidades_unificadas',
]);

describe('una fase que se cae', () => {
  /**
   * El cruce es la fase más cara y la única que manda el expediente entero a la
   * red. Un timeout suyo no puede convertir dos láminas analizadas en una
   * subida perdida: lo persistido queda, la pantalla dice `error` con el
   * detalle, y la corrida siguiente vuelve a intentarlo.
   */
  it('deja el análisis en error con el detalle y no tira lo ya persistido', async () => {
    const revienta: CruceProvider = {
      nombre: 'cruce-que-revienta',
      async cruzar() {
        throw new Error('el modelo no contestó a tiempo');
      },
    };

    const bytes = await readFile(new URL('obra-fases.pdf', PDFS));
    const archivo = new File([new Uint8Array(bytes)], 'obra-fases.pdf', {
      type: 'application/pdf',
    });
    const documento = await subirDocumento(db, storage, obraId, usuarioId, archivo);
    await procesarDocumento(documento.id, { db, storage, cruce: revienta });

    // La fase queda contada, y el detalle está escrito para el arquitecto: qué
    // quedó sin hacer y qué puede hacer él. Ni el nombre interno de la fase ni
    // el `error.message` del provider.
    const fase = await faseDe(obraId);
    expect(fase?.fase).toBe('error');
    expect(fase?.detalle).toBe(
      'el expediente no se cruzó: las láminas están analizadas y computadas, pero lo que una ' +
        'lámina dice y a otra le falta quedó sin resolver. Reintentá el cruce del expediente',
    );
    expect(fase?.detalle).not.toContain('el modelo no contestó a tiempo');

    // Y el fallo tiene su propia fila de auditoría, que es donde SÍ va el
    // detalle técnico: sacarlo de la pantalla no es perderlo.
    const [fallo] = await auditoriaDe(obraId, ACCION_CRUCE_FALLIDO);
    expect(fallo.diffJson).toMatchObject({ errorDetalle: 'el modelo no contestó a tiempo' });

    // Lo que se analizó, se computó y se midió sigue ahí: las fases anteriores
    // no se tiran porque la tercera se haya caído.
    const planos = await laminasDe(obraId);
    expect(planos.map((l) => l.estadoAnalisis)).toEqual(['analizada', 'analizada']);
    expect((await entidadesDe(obraId)).map((e) => e.nombre)).toEqual(['M1', 'M2', 'T1', 'T2']);
    expect((await deduccionesDe(obraId)).map((d) => d.regla)).toEqual([
      'medicion_grafica',
      'medicion_grafica',
    ]);
    expect((await itemsDe(obraId)).length).toBeGreaterThan(0);

    // Sin cruce no hay nada del cruce, y las fases siguientes corrieron igual.
    expect(await db.select().from(datosObra).where(eq(datosObra.obraId, obraId))).toEqual([]);
    const fases = (await auditoriaDe(obraId, ACCION_FASE)).map((fila) => fila.diffJson?.fase);
    expect(fases).toEqual(['inventario', 'extraccion', 'cruce', 'relectura', 'error']);
  });
});

describe('idempotencia', () => {
  it('re-procesar el mismo documento no reescribe ni audita: cero diffs fantasma', async () => {
    const documentoId = await subirYProcesar(obraId);

    const items = await itemsDe(obraId);
    const elementos = await entidadesDe(obraId);
    const relaciones = await deduccionesDe(obraId);
    const datos = await db.select().from(datosObra).where(eq(datosObra.obraId, obraId));
    const huecos = await db
      .select()
      .from(hallazgos)
      .where(eq(hallazgos.obraId, obraId))
      .orderBy(asc(hallazgos.clave));
    const previas = new Set((await db.select().from(auditoria)).map((fila) => fila.id));

    await procesarDocumento(documentoId, { db, storage });

    const nuevas = (await db.select().from(auditoria)).filter((fila) => !previas.has(fila.id));
    expect(previas.size).toBeGreaterThan(0);
    expect(
      nuevas
        .filter((fila) => ESCRITURAS_DE_DATOS.has(fila.accion))
        .map((fila) => `${fila.accion} ${fila.targetRef}`),
    ).toEqual([]);

    expect(await itemsDe(obraId)).toEqual(items);
    expect(await entidadesDe(obraId)).toEqual(elementos);
    expect(await deduccionesDe(obraId)).toEqual(relaciones);
    expect(await db.select().from(datosObra).where(eq(datosObra.obraId, obraId))).toEqual(datos);
    expect(
      await db
        .select()
        .from(hallazgos)
        .where(eq(hallazgos.obraId, obraId))
        .orderBy(asc(hallazgos.clave)),
    ).toEqual(huecos);
  });
});

// ---------------------------------------------------------------------------
// `aplicarCruce` con lo que el fixture de la obra no ejercita: identidades,
// conflictos y las líneas que el cruce no cruza.
// ---------------------------------------------------------------------------

/** Un provider de cruce que devuelve lo que le digan, sin fixture. */
function cruceQueDice(respuesta: Partial<RespuestaCruceCruda>): CruceProvider {
  return {
    nombre: 'cruce-test',
    async cruzar() {
      return {
        datosObra: [],
        completados: [],
        identidades: [],
        conflictos: [],
        relecturas: [],
        ...respuesta,
      };
    },
  };
}

describe('la fase con reloj y el reintento del cruce', () => {
  /**
   * `procesarDocumento` corre ADENTRO del POST del upload, con
   * `maxDuration = 300`: un expediente grande sobre el provider real se pasa de
   * ahí y el proceso muere en el medio de una fase. Sin `desde`, la columna
   * queda diciendo «Analizando las láminas · 12 de 25» para siempre y la
   * pantalla pide un refresh cada cuatro segundos, también para siempre.
   */
  it('cada marca de fase deja su hora, también la final', async () => {
    const antes = Date.now();
    await subirYProcesar(obraId);

    const fase = await faseDe(obraId);
    expect(fase?.fase).toBe('listo');
    expect(Date.parse(fase?.desde ?? '')).toBeGreaterThanOrEqual(antes - 1000);

    // Y la línea de tiempo de la corrida también, que es donde se ve cuánto
    // tardó cada parte.
    const marcas = await auditoriaDe(obraId, ACCION_FASE);
    expect(marcas.length).toBeGreaterThan(0);
    for (const marca of marcas) {
      expect(typeof (marca.diffJson as { desde?: unknown }).desde).toBe('string');
    }
  });

  it('marcarAnalisisFallido deja el error escrito, que es lo que el upload no hacía', async () => {
    await marcarAnalisisFallido(obraId, 'el documento se guardó pero no se pudo analizar', { db });

    const fase = await faseDe(obraId);
    expect(fase?.fase).toBe('error');
    expect(fase?.detalle).toBe('el documento se guardó pero no se pudo analizar');
    expect(typeof fase?.desde).toBe('string');
  });

  /**
   * El cruce es la fase cara y la única que sale a la red con el expediente
   * entero, así que es la más probable de caerse — y era la única sin reintento:
   * el único llamador de `cruzarObra` era `procesarDocumento`, o sea que
   * reintentar exigía volver a subir el PDF.
   */
  it('reintenta el cruce de una obra que quedó en error, sin volver a subir nada', async () => {
    const revienta: CruceProvider = {
      nombre: 'cruce-que-revienta',
      async cruzar() {
        throw new Error('el modelo no contestó a tiempo');
      },
    };

    const bytes = await readFile(new URL('obra-fases.pdf', PDFS));
    const archivo = new File([new Uint8Array(bytes)], 'obra-fases.pdf', {
      type: 'application/pdf',
    });
    const documento = await subirDocumento(db, storage, obraId, usuarioId, archivo);
    await procesarDocumento(documento.id, { db, storage, cruce: revienta });

    expect((await faseDe(obraId))?.fase).toBe('error');
    expect(await db.select().from(datosObra).where(eq(datosObra.obraId, obraId))).toEqual([]);

    const { fase, relecturas } = await reintentarCruce(obraId, { db, storage });

    expect(fase.fase).toBe('listo');
    expect(relecturas).toBe(1);
    expect((await faseDe(obraId))?.fase).toBe('listo');
    // El cruce corrió de verdad: escribió el dato de obra del fixture y
    // completó la altura de T1.
    const datos = await db.select().from(datosObra).where(eq(datosObra.obraId, obraId));
    expect(datos.map((dato) => dato.clave)).toEqual(['nivel.PB']);
    const delCruce = (await deduccionesDe(obraId)).filter((fila) => fila.regla === 'cruce');
    expect(delCruce.map((fila) => fila.campo)).toEqual(['alturaM']);

    const [reintento] = await auditoriaDe(obraId, ACCION_CRUCE_REINTENTADO);
    expect(reintento.diffJson).toMatchObject({ resultado: 'listo', relecturas: 1 });
  });

  it('reintentar sobre una obra quieta no escribe ni audita nada', async () => {
    await subirYProcesar(obraId);
    const previas = new Set((await db.select().from(auditoria)).map((fila) => fila.id));

    await reintentarCruce(obraId, { db, storage });

    const nuevas = (await db.select().from(auditoria)).filter((fila) => !previas.has(fila.id));
    expect(previas.size).toBeGreaterThan(0);
    expect(
      nuevas
        .filter((fila) => ESCRITURAS_DE_DATOS.has(fila.accion))
        .map((fila) => `${fila.accion} ${fila.targetRef}`),
    ).toEqual([]);
  });

  /**
   * Dos cruces encimados sobre la misma obra corren dos recomputes que leen la
   * misma foto de `computo_items`: los dos insertan la clave que no vieron y la
   * planilla termina con ítems duplicados en silencio. Es el mismo motivo por
   * el que la extracción en paralelo difiere su recompute.
   */
  it('no arranca encima de un análisis que todavía está corriendo', async () => {
    await subirYProcesar(obraId);
    await db
      .update(obras)
      .set({ analisisJson: { fase: 'extraccion', total: 25, completadas: 12, desde: new Date().toISOString() } })
      .where(eq(obras.id, obraId));

    await expect(reintentarCruce(obraId, { db, storage })).rejects.toBeInstanceOf(
      AnalisisEnCursoError,
    );
  });

  /**
   * La otra mitad del reloj: una fase que dice que trabaja y hace rato que no
   * se mueve no bloquea nada. Sin esto, un proceso muerto dejaba la obra sin
   * reintento posible para siempre.
   */
  it('una fase vencida no bloquea el reintento', async () => {
    await subirYProcesar(obraId);
    const rancia = new Date(Date.now() - TTL_FASE_ANALISIS_MS - 1000).toISOString();
    await db
      .update(obras)
      .set({ analisisJson: { fase: 'extraccion', total: 25, completadas: 12, desde: rancia } })
      .where(eq(obras.id, obraId));

    const { fase } = await reintentarCruce(obraId, { db, storage });
    expect(fase.fase).toBe('listo');
  });

  it('una obra que no existe no es un 500', async () => {
    await expect(
      reintentarCruce('00000000-0000-4000-8000-000000000000', { db, storage }),
    ).rejects.toBeInstanceOf(ObraInexistenteError);
  });
});

describe('el texto que lee el arquitecto', () => {
  beforeEach(async () => {
    await subirYProcesar(obraId);
  });

  /**
   * Una lámina sin código de rótulo se nombra por su página, como en toda la app
   * (`etiquetaDeLamina`, bandeja). Antes caía al uuid, y el uuid terminaba
   * impreso adentro de la consulta: "…8f3a1c2e-… dice «2,60 m»…".
   */
  it('una lámina sin código se cita por su página, nunca por su uuid', async () => {
    const planos = await laminasDe(obraId);
    const corte = planos[1] as Lamina;
    await db.update(laminas).set({ codigo: null }).where(eq(laminas.id, corte.id));

    const { ctx, refs } = await expedienteDelCruce(db, obraId);
    expect(refs.get(corte.id)).toBe('Página 2');
    // Y no entra al índice por código: el modelo no podría citarla, así que
    // resolver algo contra ella sería adivinar.
    expect([...ctx.laminasPorCodigo.values()]).not.toContain(corte.id);
  });

  /**
   * `descripcion` y `causaPosible` los escribe el modelo y se empalman en el
   * medio de una frase nuestra. Sin normalizar se leían "la altura no coincide
   * A-01 dice «2,60 m»" y "Puede ser Revisión vieja contra nueva..".
   */
  it('empalma lo que escribió el modelo sin puntos dobles ni minúsculas colgadas', () => {
    const refs = new Map([
      ['lam-a', 'A-01'],
      ['lam-b', 'Página 2'],
    ]);

    expect(
      descripcionConflicto(
        {
          descripcion: 'la altura de local no coincide entre láminas',
          datoA: '2,60 m',
          laminaIdA: 'lam-a',
          datoB: '2,80 m',
          laminaIdB: 'lam-b',
          causaPosible: 'Revisión vieja contra nueva.',
        },
        refs,
      ),
    ).toBe(
      'La altura de local no coincide entre láminas. A-01 dice «2,60 m» y Página 2 dice «2,80 m». ' +
        'Puede ser revisión vieja contra nueva.',
    );
  });

  it('no le baja la mayúscula a una sigla ni al código de una lámina', () => {
    const refs = new Map([['lam-a', 'A-01'], ['lam-b', 'DET00']]);
    const base = {
      descripcion: 'El vidrio de FP01 no coincide.',
      datoA: 'DVH 4/9/4',
      laminaIdA: 'lam-a',
      datoB: 'simple 4 mm',
      laminaIdB: 'lam-b',
    };

    expect(descripcionConflicto({ ...base, causaPosible: 'DVH contra vidrio simple' }, refs)).toContain(
      'Puede ser DVH contra vidrio simple.',
    );
    expect(descripcionConflicto({ ...base, causaPosible: 'PL01 quedó desactualizada' }, refs)).toContain(
      'Puede ser PL01 quedó desactualizada.',
    );
  });

  it('una causa vacía no deja la frase colgada de un «Puede ser»', () => {
    const refs = new Map([['lam-a', 'A-01'], ['lam-b', 'A-02']]);
    expect(
      descripcionConflicto(
        {
          descripcion: 'La altura no coincide.',
          datoA: '2,60 m',
          laminaIdA: 'lam-a',
          datoB: '2,80 m',
          laminaIdB: 'lam-b',
          causaPosible: '   ',
        },
        refs,
      ),
    ).toBe('La altura no coincide. A-01 dice «2,60 m» y A-02 dice «2,80 m».');
  });
});

describe('aplicarCruce', () => {
  beforeEach(async () => {
    await subirYProcesar(obraId);
  });

  it('un conflicto abre una consulta no bloqueante que el recompute no cierra', async () => {
    const conflicto = {
      descripcion: 'La altura de local no coincide entre láminas.',
      datoA: '2,60 m',
      laminaCodigoA: 'A-02',
      datoB: '2,80 m',
      laminaCodigoB: 'A-01',
      causaPosible: 'una revisión vieja de la planta',
    };
    const expediente = await expedienteDelCruce(db, obraId);
    const crudo = await cruceQueDice({ conflictos: [conflicto] }).cruzar('', {
      obraId,
      tipoObra: 'nueva',
    });

    const { resultado } = await aplicarCruce(db, obraId, crudo, expediente);
    const clave = claveConflicto(resultado.conflictos[0]);

    expect(clave).toMatch(/^cruce\.conflicto\.[0-9a-f]{8}$/);
    const consulta = await hallazgoPorClave(obraId, clave);
    expect(consulta?.tipo).toBe('inconsistencia');
    expect(consulta?.bloqueante).toBe(false);
    expect(consulta?.descripcion).toBe(
      'La altura de local no coincide entre láminas. A-02 dice «2,60 m» y A-01 dice «2,80 m». ' +
        'Puede ser una revisión vieja de la planta.',
    );
    expect(consulta?.laminasJson).toHaveLength(2);

    // El conciliador del recompute no la toca: la clave está en un namespace
    // protegido. Sin eso, el aviso moría en el recompute siguiente —que corre
    // en la misma corrida— sin que nadie lo viera.
    await recomputarObra(obraId, { db, resumen: false });
    expect((await hallazgoPorClave(obraId, clave))?.estado).toBe('abierto');
  });

  /**
   * El otro lado del namespace protegido: si el recompute no concilia las
   * claves `cruce.*`, el cruce tiene que conciliarlas él. Una contradicción que
   * el arquitecto arregló subiendo la revisión buena no puede quedarse abierta
   * para siempre.
   */
  it('un conflicto que el cruce ya no encuentra se cierra solo; el que sigue, sigue abierto', async () => {
    const queSigue = {
      descripcion: 'La altura de local no coincide entre láminas.',
      datoA: '2,60 m',
      laminaCodigoA: 'A-02',
      datoB: '2,80 m',
      laminaCodigoB: 'A-01',
      causaPosible: null,
    };
    const queSeResuelve = {
      descripcion: 'El espesor del tabique no coincide entre láminas.',
      datoA: '0,10 m',
      laminaCodigoA: 'A-01',
      datoB: '0,15 m',
      laminaCodigoB: 'A-02',
      causaPosible: null,
    };
    const expediente = await expedienteDelCruce(db, obraId);
    const ctx = { obraId, tipoObra: 'nueva' as const };

    const primero = await cruceQueDice({ conflictos: [queSigue, queSeResuelve] }).cruzar('', ctx);
    const { resultado } = await aplicarCruce(db, obraId, primero, expediente);
    const claves = resultado.conflictos.map(claveConflicto);
    expect(claves).toHaveLength(2);

    // La revisión nueva arregla uno de los dos: el cruce siguiente solo ve al otro.
    const segundo = await cruceQueDice({ conflictos: [queSigue] }).cruzar('', ctx);
    const { resumen } = await aplicarCruce(db, obraId, segundo, expediente);

    expect(resumen.conflictosCerrados).toBe(1);
    expect((await hallazgoPorClave(obraId, claves[0]))?.estado).toBe('abierto');
    const cerrado = await hallazgoPorClave(obraId, claves[1]);
    expect(cerrado?.estado).toBe('descartado');
    expect(cerrado?.respuestaJson).toEqual({ ...RESPUESTA_CRUCE_RESUELTO });
  });

  it('la clave de un conflicto no depende de cómo lo redactó el modelo', async () => {
    const base = {
      datoA: '2,60 m',
      laminaIdA: 'aaaa',
      datoB: '2,80 m',
      laminaIdB: 'bbbb',
    };

    // Misma contradicción, otra redacción (y otra causa arriesgada): misma
    // clave. Es el punto — si la clave dependiera del texto, cada corrida
    // abriría una consulta nueva sobre lo mismo y la anterior quedaría abierta.
    expect(claveConflicto({ ...base, descripcion: 'No coinciden.' })).toBe(
      claveConflicto({
        ...base,
        descripcion: 'Hay una diferencia de 20 cm.',
        causaPosible: 'una revisión vieja',
      }),
    );

    // Las láminas entran ordenadas: cuál se cita primero no abre otra consulta.
    expect(
      claveConflicto({ ...base, descripcion: 'x', laminaIdA: 'bbbb', laminaIdB: 'aaaa' }),
    ).toBe(claveConflicto({ ...base, descripcion: 'x' }));

    // Otro dato es otra contradicción.
    expect(claveConflicto({ ...base, descripcion: 'x', datoB: '3,00 m' })).not.toBe(
      claveConflicto({ ...base, descripcion: 'x' }),
    );
  });

  it('una identidad comparte elemento_id y no lo regenera en la corrida siguiente', async () => {
    const identidad = [
      { laminaCodigo: 'A-01', entidadNombre: 'M1' },
      { laminaCodigo: 'A-02', entidadNombre: 'M2' },
    ];
    const expediente = await expedienteDelCruce(db, obraId);
    const crudo = await cruceQueDice({ identidades: [identidad] }).cruzar('', {
      obraId,
      tipoObra: 'nueva',
    });

    await aplicarCruce(db, obraId, crudo, expediente);
    const primera = await entidadesDe(obraId);
    const compartido = primera.find((e) => e.nombre === 'M1')?.elementoId;
    expect(compartido).toBeTruthy();
    expect(primera.find((e) => e.nombre === 'M2')?.elementoId).toBe(compartido);
    expect(primera.find((e) => e.nombre === 'T1')?.elementoId).toBeNull();

    // Idempotente: el mismo cruce dos veces no genera un uuid nuevo ni audita.
    await aplicarCruce(db, obraId, crudo, expediente);
    expect(await entidadesDe(obraId)).toEqual(primera);
    expect(await auditoriaDe(obraId, ACCION_IDENTIDAD)).toHaveLength(1);
  });

  it('no pisa lo que decidió una persona ni escribe por debajo del umbral', async () => {
    const elementos = await entidadesDe(obraId);
    const t2 = elementos.find((e) => e.nombre === 'T2');
    // El arquitecto rechazó una deducción sobre ese mismo campo.
    await db.insert(deducciones).values({
      obraId,
      entidadId: t2!.id,
      campo: 'alturaM',
      regla: 'planta_corte',
      fuentesJson: [{ laminaId: elementos[0].laminaId, bbox: [0, 0, 1, 1] }],
      valorJson: { alturaM: 3 },
      confianza: 0.9,
      estado: 'rechazada',
      validadoPor: usuarioId,
    });
    // Y cargó a mano un dato de obra.
    await db.insert(datosObra).values({
      obraId,
      clave: 'altura_local.PB',
      valorJson: { valor: 2.4, unidad: 'm' },
      origen: 'explicito',
      fuentesJson: [],
      confianza: 1,
      definidoPor: usuarioId,
    });

    const expediente = await expedienteDelCruce(db, obraId);
    const crudo = await cruceQueDice({
      completados: [
        {
          laminaCodigo: 'A-01',
          entidadNombre: 'T2',
          campo: 'alturaM',
          valor: '2,60',
          fuenteLaminaCodigo: 'A-02',
          bbox: null,
          confianza: 0.9,
        },
        {
          laminaCodigo: 'A-01',
          entidadNombre: 'T1',
          campo: 'largoM',
          valor: '9',
          fuenteLaminaCodigo: 'A-02',
          bbox: null,
          confianza: 0.4,
        },
      ],
      datosObra: [
        {
          clave: 'altura_local.PB',
          valor: '2,90',
          unidad: 'm',
          laminaCodigo: 'A-02',
          bbox: null,
          confianza: 0.95,
        },
      ],
    }).cruzar('', { obraId, tipoObra: 'nueva' });

    const { resumen } = await aplicarCruce(db, obraId, crudo, expediente);

    expect(resumen).toMatchObject({ camposCompletados: 0, camposOmitidos: 2, datosOmitidos: 1 });
    const [dato] = await db
      .select()
      .from(datosObra)
      .where(and(eq(datosObra.obraId, obraId), eq(datosObra.clave, 'altura_local.PB')));
    expect(dato.valorJson).toEqual({ valor: 2.4, unidad: 'm' });
    const rechazada = (await deduccionesDe(obraId)).find(
      (fila) => fila.entidadId === t2!.id && fila.campo === 'alturaM',
    );
    expect(rechazada?.estado).toBe('rechazada');
    expect(rechazada?.valorJson).toEqual({ alturaM: 3 });
  });
});
