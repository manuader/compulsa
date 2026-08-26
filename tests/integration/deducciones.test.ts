/**
 * Deducción integrada, de punta a punta: del PDF a la propuesta, de la propuesta
 * al ítem `deducido`, y de vuelta.
 *
 * El expediente de prueba es `casa-deduccion.pdf` (los bytes de `obra-demo.pdf`,
 * subidos con otro nombre: el provider mock indexa los fixtures por
 * `slug(nombreArchivo)-p<página>`, no por los bytes). Tres láminas, y cada una
 * calla algo que otra dice:
 *
 *   A-01 · planta    V2 sin medidas · tabique T1 con largo 5 m, sin altura
 *   A-02 · corte     tabique T1 con altura 2,60 m, sin largo
 *   A-05 · planilla  V2 con 1,50 × 1,10, aluminio, DVH
 *
 * De ahí salen las cinco propuestas que se pinean abajo, incluidas las dos "de
 * vuelta" que genera la simetría de `continuidad` (el corte hereda del plano lo
 * que el plano heredó del corte). No se filtran: son deducciones legítimas y la
 * bandeja las agrupa por elemento para que no parezcan un duplicado.
 *
 * Se testean los **núcleos** (`validarDeduccion`, `rechazarDeduccion`), no los
 * envoltorios `*Action`: esos solo agregan sesión, `requireObra()` y
 * `revalidatePath()`. Lo que hay que proteger es qué queda escrito.
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
  deducciones,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type ComputoItem,
  type Deduccion,
  type Entidad,
  type Hallazgo,
} from '@/db/schema';
import type { AnalysisProvider } from '@/lib/analysis/index';
import { crearProviderMock } from '@/lib/analysis/mock';
import { descartarHallazgo } from '@/lib/bandeja/resolver';
import {
  explicarDeduccion,
  NO_ENCONTRADA,
  rechazarDeduccion,
  validarDeduccion,
  valorDeDeduccion,
  type ActorDeduccion,
} from '@/lib/deduccion/persistencia';
import { puedeAprobarRubro } from '@/lib/hallazgos/gate';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';
import type { RubroId } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

/** El nombre manda: es la clave con la que el mock busca los fixtures. */
const EXPEDIENTE = 'casa-deduccion.pdf';

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let documentoId: string;
let titular: ActorDeduccion;
let soloLectura: ActorDeduccion;

// ---------------------------------------------------------------------------
// Lecturas de apoyo
// ---------------------------------------------------------------------------

/**
 * El mismo provider mock de siempre, pero con la planta acotando el tabique T1.
 *
 * Es como se ejercita "la lamina se volvio a analizar y ahora dice otra cosa":
 * el fixture de `casa-deduccion-p1` deja T1 sin altura a proposito, y esto
 * simula la revision del plano que la agrega.
 */
function plantaQueAcota(alturaM: number): AnalysisProvider {
  const base = crearProviderMock();
  return {
    leerRotulo: (lamina) => base.leerRotulo(lamina),
    async extraerEntidades(lamina, ctx) {
      const entidades = await base.extraerEntidades(lamina, ctx);
      if (lamina.numeroPagina !== 1) return entidades;
      return entidades.map((entidad) =>
        entidad.tipo === 'tabique' && entidad.nombre === 'T1'
          ? { ...entidad, atributos: { ...entidad.atributos, alturaM } }
          : entidad,
      );
    },
  };
}

function todasLasDeducciones(): Promise<Deduccion[]> {
  return db
    .select()
    .from(deducciones)
    .where(eq(deducciones.obraId, obraId))
    .orderBy(deducciones.campo);
}

/** La entidad `nombre` de la lámina con ese código de rótulo. */
async function entidadEn(codigoLamina: string, nombre: string): Promise<Entidad> {
  const [fila] = await db
    .select({ entidad: entidades })
    .from(entidades)
    .innerJoin(laminas, eq(entidades.laminaId, laminas.id))
    .where(
      and(
        eq(entidades.obraId, obraId),
        eq(entidades.nombre, nombre),
        eq(laminas.codigo, codigoLamina),
      ),
    );
  if (!fila) throw new Error(`No encontré la entidad ${nombre} en la lámina ${codigoLamina}.`);
  return fila.entidad;
}

/** La deducción sobre un campo de esa entidad, sea cual sea su estado. */
async function deduccionDe(codigoLamina: string, nombre: string, campo: string): Promise<Deduccion> {
  const entidad = await entidadEn(codigoLamina, nombre);
  const [fila] = await db
    .select()
    .from(deducciones)
    .where(
      and(
        eq(deducciones.obraId, obraId),
        eq(deducciones.entidadId, entidad.id),
        eq(deducciones.campo, campo),
      ),
    );
  if (!fila) throw new Error(`No hay deducción de ${campo} sobre ${nombre} (${codigoLamina}).`);
  return fila;
}

function itemPorClave(clave: string): Promise<ComputoItem | undefined> {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, clave)))
    .then((filas) => filas[0]);
}

function hallazgoPorClave(clave: string): Promise<Hallazgo | undefined> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

async function gateDe(rubro: RubroId) {
  const filas = await db
    .select({ rubro: hallazgos.rubro, bloqueante: hallazgos.bloqueante, estado: hallazgos.estado })
    .from(hallazgos)
    .where(eq(hallazgos.obraId, obraId));
  return puedeAprobarRubro(rubro, filas);
}

function todaLaAuditoria() {
  return db.select().from(auditoria).where(eq(auditoria.obraId, obraId));
}

function auditoriaDe(accion: string) {
  return db
    .select()
    .from(auditoria)
    .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, accion)));
}

/** Códigos de lámina de las fuentes de una fila, sin repetir y ordenados. */
async function laminasCitadas(fuentes: readonly { laminaId: string }[]): Promise<string[]> {
  const filas = await db
    .select({ id: laminas.id, codigo: laminas.codigo })
    .from(laminas)
    .where(eq(laminas.obraId, obraId));
  const codigos = new Map(filas.map((fila) => [fila.id, fila.codigo ?? fila.id]));
  return [...new Set(fuentes.map((fuente) => codigos.get(fuente.laminaId) ?? fuente.laminaId))].sort();
}

// ---------------------------------------------------------------------------

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-deducciones-'));
  storage = crearStorageLocal(raizStorage);

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
  const [pasante] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'pasante@estudiosur.ar',
      nombre: 'Pas Ante',
      passwordHash: 'x',
      rol: 'lectura',
    })
    .returning();
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Deducción', zona: 'CABA', tipo: 'nueva' })
    .returning();

  obraId = obra.id;
  titular = { usuarioId: usuario.id, email: usuario.email, rol: 'titular' };
  soloLectura = { usuarioId: pasante.id, email: pasante.email, rol: 'lectura' };

  const bytes = await readFile(new URL('obra-demo.pdf', PDFS));
  const archivo = new File([new Uint8Array(bytes)], EXPEDIENTE, { type: 'application/pdf' });
  const documento = await subirDocumento(db, storage, obraId, usuario.id, archivo);
  documentoId = documento.id;
  await procesarDocumento(documento.id, { db, storage });
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('el pipeline propone deducciones', () => {
  it('cruza las tres láminas y propone cinco datos, sin tocar ninguna entidad', async () => {
    const filas = await todasLasDeducciones();
    expect(filas).toHaveLength(5);
    expect(filas.every((fila) => fila.estado === 'propuesta')).toBe(true);

    // Planilla ↔ plano: la ventana sin acotar toma las medidas de la planilla.
    // confianza = 0,95 (factor) × 0,80 (la peor de las dos lecturas) = 0,76.
    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    expect(ancho.regla).toBe('planilla_plano');
    expect(valorDeDeduccion(ancho)).toBe(1.5);
    expect(ancho.confianza).toBeCloseTo(0.76, 5);
    expect(await laminasCitadas(ancho.fuentesJson)).toEqual(['A-01', 'A-05']);

    const alto = await deduccionDe('A-01', 'V2', 'altoM');
    expect(valorDeDeduccion(alto)).toBe(1.1);

    // Planta ↔ corte: la altura del tabique sale del corte. 0,9 × 0,9 = 0,81.
    const altura = await deduccionDe('A-01', 'T1', 'alturaM');
    expect(altura.regla).toBe('planta_corte');
    expect(valorDeDeduccion(altura)).toBe(2.6);
    expect(altura.confianza).toBeCloseTo(0.81, 5);

    // Continuidad, "de vuelta": el T1 del corte hereda del plano lo que le falta.
    // 0,85 × 0,9 = 0,765 ⇒ 0,77.
    const largo = await deduccionDe('A-02', 'T1', 'largoM');
    expect(largo.regla).toBe('continuidad');
    expect(valorDeDeduccion(largo)).toBe(5);
    expect(largo.confianza).toBeCloseTo(0.77, 5);
    expect(valorDeDeduccion(await deduccionDe('A-02', 'T1', 'caras'))).toBe(2);

    // P4: proponer no es escribir. La ventana sigue sin medidas.
    const v2 = await entidadEn('A-01', 'V2');
    expect(v2.atributosJson.anchoM).toBeUndefined();
    expect(v2.atributosJson.altoM).toBeUndefined();

    // Y la consulta por el dato faltante sigue abierta y bloqueando el rubro.
    expect((await hallazgoPorClave('aberturas.medidas_vano.V2'))?.estado).toBe('abierto');
    expect((await gateDe('aberturas')).ok).toBe(false);

    // Todo lo escribió el agente, y quedó auditado una vez por deducción.
    const auditadas = await auditoriaDe('deduccion_propuesta');
    expect(auditadas).toHaveLength(5);
    expect(auditadas.every((fila) => fila.actorTipo === 'agente')).toBe(true);
  });

  it('un segundo recompute idéntico no escribe ni audita nada', async () => {
    const antes = await todasLasDeducciones();
    const auditoriaAntes = new Set((await todaLaAuditoria()).map((fila) => fila.id));

    const resumen = await recomputarObra(obraId);

    expect(resumen.deduccionesPropuestas).toBe(0);
    expect(resumen.deduccionesActualizadas).toBe(0);
    expect(resumen.deduccionesRetiradas).toBe(0);
    expect(await todasLasDeducciones()).toEqual(antes);
    expect((await todaLaAuditoria()).filter((fila) => !auditoriaAntes.has(fila.id))).toEqual([]);
  });

  it('una propuesta que el motor deja de sostener se borra: no es historia', async () => {
    // El arquitecto carga las medidas a mano: la planilla ya no deduce nada.
    const v2 = await entidadEn('A-01', 'V2');
    await db
      .update(entidades)
      .set({ atributosJson: { ...v2.atributosJson, anchoM: 1.5, altoM: 1.1 } })
      .where(eq(entidades.id, v2.id));

    const resumen = await recomputarObra(obraId);
    expect(resumen.deduccionesRetiradas).toBe(2);

    const filas = await todasLasDeducciones();
    expect(filas).toHaveLength(3);
    expect(filas.some((fila) => fila.entidadId === v2.id)).toBe(false);
    expect(await auditoriaDe('deduccion_retirada')).toHaveLength(2);
  });

  it('reprocesar el documento no duplica ni una deducción', async () => {
    await procesarDocumento(documentoId, { db, storage });
    expect(await todasLasDeducciones()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------

describe('validar una deducción', () => {
  it('escribe el dato, deja el ítem en origen deducido y libera el gate', async () => {
    // Antes: solo la ventana de la planilla se computa, y con origen explícito.
    const previo = await itemPorClave('aberturas.V2');
    expect(previo?.origen).toBe('explicito');
    expect(previo?.cantNeta).toBe(1);
    expect(await laminasCitadas(previo!.fuentesJson)).toEqual(['A-05']);

    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    const alto = await deduccionDe('A-01', 'V2', 'altoM');
    expect(await validarDeduccion({ obraId, deduccionId: ancho.id }, titular)).toEqual({ ok: true });
    expect(await validarDeduccion({ obraId, deduccionId: alto.id }, titular)).toEqual({ ok: true });

    // 1) El dato bajó a la entidad, con la provenance de las dos láminas (P1).
    const v2 = await entidadEn('A-01', 'V2');
    expect(v2.atributosJson.anchoM).toBe(1.5);
    expect(v2.atributosJson.altoM).toBe(1.1);
    expect(await laminasCitadas(v2.fuentesJson)).toEqual(['A-01', 'A-05']);

    // 2) El ítem sale deducido y citando las dos láminas.
    const item = await itemPorClave('aberturas.V2');
    expect(item?.estado).toBe('activo');
    expect(item?.origen).toBe('deducido');
    expect(item?.descripcion).toBe('Ventana V2 (1,50 × 1,10 m)');
    expect(await laminasCitadas(item!.fuentesJson)).toEqual(['A-01', 'A-05']);

    // 3) La consulta por el dato faltante se cerró sola y el rubro se libera.
    expect((await hallazgoPorClave('aberturas.medidas_vano.V2'))?.estado).toBe('descartado');
    expect(await gateDe('aberturas')).toEqual({ ok: true, bloqueantes: 0 });

    // 4) Las dos deducciones quedaron firmadas.
    const validadas = (await todasLasDeducciones()).filter((fila) => fila.estado === 'validada');
    expect(validadas).toHaveLength(2);
    expect(validadas.every((fila) => fila.validadoPor === titular.usuarioId)).toBe(true);

    // 5) Auditoría: la escritura de la entidad y la firma de la deducción.
    const escrituras = (await auditoriaDe('entidad_actualizada')).filter(
      (fila) => fila.actorTipo === 'usuario',
    );
    expect(escrituras).toHaveLength(2);
    expect(escrituras[0]?.diffJson).toMatchObject({
      via: 'deduccion',
      regla: 'planilla_plano',
    });
    const firmas = await auditoriaDe('deduccion_validada');
    expect(firmas).toHaveLength(2);
    expect(firmas[0]?.actorNombre).toBe('arq@estudiosur.ar');
  });

  it('la altura validada de un tabique deja seco.placas en origen deducido', async () => {
    expect(await itemPorClave('seco.placas')).toBeUndefined();

    const altura = await deduccionDe('A-01', 'T1', 'alturaM');
    expect(await validarDeduccion({ obraId, deduccionId: altura.id }, titular)).toEqual({ ok: true });

    // 5 m × 2,60 m × 2 caras = 26 m²; con 12% de desperdicio, 11 placas = 31,68 m².
    const placas = await itemPorClave('seco.placas');
    expect(placas?.origen).toBe('deducido');
    expect(placas?.cantNeta).toBe(26);
    expect(placas?.cantCompra).toBe(31.68);
    expect((await hallazgoPorClave('seco.altura_tabiques.T1'))?.estado).toBe('descartado');
  });

  it('el dato validado sobrevive a un reanálisis de la lámina', async () => {
    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    const alto = await deduccionDe('A-01', 'V2', 'altoM');
    await validarDeduccion({ obraId, deduccionId: ancho.id }, titular);
    await validarDeduccion({ obraId, deduccionId: alto.id }, titular);

    // Reprocesar reescribe `atributos_json` con lo que vuelve a leer el provider:
    // la planta sigue sin acotar la ventana. La deducción validada la sostiene.
    await procesarDocumento(documentoId, { db, storage });

    const validadas = (await todasLasDeducciones()).filter((fila) => fila.estado === 'validada');
    expect(validadas).toHaveLength(2);

    const item = await itemPorClave('aberturas.V2');
    expect(item?.estado).toBe('activo');
    expect(item?.origen).toBe('deducido');
    expect(item?.cantNeta).toBe(2);
    expect(await gateDe('aberturas')).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('si el reanálisis trae OTRO valor, gana la documentación y el conflicto se avisa', async () => {
    const altura = await deduccionDe('A-01', 'T1', 'alturaM');
    await validarDeduccion({ obraId, deduccionId: altura.id }, titular);
    expect((await itemPorClave('seco.placas'))?.origen).toBe('deducido');

    // La planta se vuelve a analizar y ahora SÍ acota el tabique: 2,40 m.
    await procesarDocumento(documentoId, { db, storage, provider: plantaQueAcota(2.4) });

    // 1) Manda lo escrito: 5 × 2,40 × 2 = 24 m², y el ítem vuelve a ser explícito.
    const placas = await itemPorClave('seco.placas');
    expect(placas?.origen).toBe('explicito');
    expect(placas?.cantNeta).toBe(24);

    // 2) Pero no en silencio: queda una consulta no bloqueante con los dos valores.
    const consulta = await hallazgoPorClave('deduccion.contradicha.T1.alturaM');
    expect(consulta?.estado).toBe('abierto');
    expect(consulta?.tipo).toBe('inconsistencia');
    expect(consulta?.bloqueante).toBe(false);
    expect(consulta?.descripcion).toContain('se validó en 2,60 m');
    expect(consulta?.descripcion).toContain('ahora dice 2,40 m');
    expect(await laminasCitadas(consulta!.laminasJson)).toEqual(['A-01', 'A-02']);
    // No frena nada: el cómputo usa el dato bueno.
    expect((await gateDe('seco')).bloqueantes).toBe(1); // el largo del T1 del corte, de antes

    // 3) La deducción queda marcada como superada, sin dejar de estar validada.
    const superada = await deduccionDe('A-01', 'T1', 'alturaM');
    expect(superada.estado).toBe('validada');
    expect(superada.valorJson).toEqual({
      alturaM: 2.6,
      _contradicha: true,
      _valorDocumentado: 2.4,
    });

    // 4) Y la memoria la muestra como superada.
    expect(explicarDeduccion(superada)).toContain(
      'Superada por la documentación, que ahora dice 2,40 m',
    );

    // 5) Con su registro en la auditoría, con los dos números.
    const auditadas = await auditoriaDe('deduccion_contradicha');
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]?.diffJson).toMatchObject({ valorDeducido: 2.6, valorDocumentado: 2.4 });
  });

  it('la contradicción es idempotente y no se reabre si el arquitecto la descarta', async () => {
    const altura = await deduccionDe('A-01', 'T1', 'alturaM');
    await validarDeduccion({ obraId, deduccionId: altura.id }, titular);
    await procesarDocumento(documentoId, { db, storage, provider: plantaQueAcota(2.4) });

    // Idempotencia: un segundo recompute no vuelve a marcar ni a auditar.
    const auditoriaAntes = new Set((await todaLaAuditoria()).map((fila) => fila.id));
    const resumen = await recomputarObra(obraId);
    expect(resumen.deduccionesContradichas).toBe(0);
    expect((await todaLaAuditoria()).filter((fila) => !auditoriaAntes.has(fila.id))).toEqual([]);

    // Descartada, no vuelve: es una consulta como cualquier otra.
    const consulta = await hallazgoPorClave('deduccion.contradicha.T1.alturaM');
    expect(await descartarHallazgo({ obraId, hallazgoId: consulta!.id }, titular)).toEqual({
      ok: true,
    });
    await recomputarObra(obraId);
    expect((await hallazgoPorClave('deduccion.contradicha.T1.alturaM'))?.estado).toBe('descartado');
  });

  it('si el reanálisis trae el MISMO valor no hay contradicción ni marca', async () => {
    const altura = await deduccionDe('A-01', 'T1', 'alturaM');
    await validarDeduccion({ obraId, deduccionId: altura.id }, titular);

    // La planta ahora acota 2,60 m, que es exactamente lo que se había deducido.
    await procesarDocumento(documentoId, { db, storage, provider: plantaQueAcota(2.6) });

    expect(await hallazgoPorClave('deduccion.contradicha.T1.alturaM')).toBeUndefined();
    expect(await auditoriaDe('deduccion_contradicha')).toHaveLength(0);

    const sinMarca = await deduccionDe('A-01', 'T1', 'alturaM');
    expect(sinMarca.estado).toBe('validada');
    expect(sinMarca.valorJson).toEqual({ alturaM: 2.6 });
    expect((await itemPorClave('seco.placas'))?.cantNeta).toBe(26);
  });

  it('cuando la documentación vuelve a coincidir, la marca se levanta sola', async () => {
    const altura = await deduccionDe('A-01', 'T1', 'alturaM');
    await validarDeduccion({ obraId, deduccionId: altura.id }, titular);
    await procesarDocumento(documentoId, { db, storage, provider: plantaQueAcota(2.4) });
    expect((await deduccionDe('A-01', 'T1', 'alturaM')).valorJson._contradicha).toBe(true);

    // La lámina se corrige y vuelve a decir 2,60 m.
    await procesarDocumento(documentoId, { db, storage, provider: plantaQueAcota(2.6) });

    const limpia = await deduccionDe('A-01', 'T1', 'alturaM');
    expect(limpia.valorJson).toEqual({ alturaM: 2.6 });
    expect((await hallazgoPorClave('deduccion.contradicha.T1.alturaM'))?.estado).toBe('descartado');
    expect(await auditoriaDe('deduccion_contradiccion_resuelta')).toHaveLength(1);
  });

  it('no pisa un dato que ya cargó una persona con otro valor', async () => {
    const v2 = await entidadEn('A-01', 'V2');
    await db
      .update(entidades)
      .set({ atributosJson: { ...v2.atributosJson, anchoM: 1.2 } })
      .where(eq(entidades.id, v2.id));

    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    const resultado = await validarDeduccion({ obraId, deduccionId: ancho.id }, titular);
    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.error).toContain('ya está cargado con 1.2');

    // Ni la entidad ni la deducción se movieron.
    expect((await entidadEn('A-01', 'V2')).atributosJson.anchoM).toBe(1.2);
    expect((await deduccionDe('A-01', 'V2', 'anchoM')).estado).toBe('propuesta');
  });

  it('un usuario de solo lectura no valida nada (RF-1201)', async () => {
    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    const resultado = await validarDeduccion({ obraId, deduccionId: ancho.id }, soloLectura);
    expect(resultado).toEqual({
      ok: false,
      error: 'Tu usuario es de solo lectura: no podés validar ni rechazar deducciones.',
    });
    expect((await deduccionDe('A-01', 'V2', 'anchoM')).estado).toBe('propuesta');
    expect((await entidadEn('A-01', 'V2')).atributosJson.anchoM).toBeUndefined();
  });

  it('una deducción de otra obra da el mismo error que una inventada (RNF-4)', async () => {
    const [otroEstudio] = await db.insert(estudios).values({ nombre: 'Otro' }).returning();
    const [otraObra] = await db
      .insert(obras)
      .values({ estudioId: otroEstudio.id, nombre: 'Ajena', zona: 'GBA', tipo: 'nueva' })
      .returning();
    const propia = await deduccionDe('A-01', 'V2', 'anchoM');
    const [ajena] = await db
      .insert(deducciones)
      .values({
        obraId: otraObra.id,
        entidadId: propia.entidadId,
        campo: 'anchoM',
        regla: 'planilla_plano',
        fuentesJson: [],
        valorJson: { anchoM: 9 },
        confianza: 0.9,
      })
      .returning();

    const ajenaResultado = await validarDeduccion({ obraId, deduccionId: ajena.id }, titular);
    const inventada = await validarDeduccion(
      { obraId, deduccionId: '00000000-0000-4000-8000-000000000000' },
      titular,
    );
    expect(ajenaResultado).toEqual({ ok: false, error: NO_ENCONTRADA });
    expect(inventada).toEqual({ ok: false, error: NO_ENCONTRADA });

    const [sinTocar] = await db.select().from(deducciones).where(eq(deducciones.id, ajena.id));
    expect(sinTocar.estado).toBe('propuesta');
  });

  it('validar dos veces la misma deducción no escribe dos veces', async () => {
    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    expect(await validarDeduccion({ obraId, deduccionId: ancho.id }, titular)).toEqual({ ok: true });

    const repetida = await validarDeduccion({ obraId, deduccionId: ancho.id }, titular);
    expect(repetida.ok).toBe(false);
    expect(await auditoriaDe('deduccion_validada')).toHaveLength(1);
  });

  it('una deducción sobre una entidad que ya no está no se puede validar', async () => {
    // Carrera real: la pantalla se pintó, la lámina se reprocesó y la entidad
    // desapareció. Se arma con una entidad `otro`, que no genera ítems ni
    // consultas y por eso se puede borrar sin arrastrar nada.
    const planta = await entidadEn('A-01', 'V2');
    const [suelta] = await db
      .insert(entidades)
      .values({
        obraId,
        laminaId: planta.laminaId,
        tipo: 'otro',
        nombre: 'Zócalo Z1',
        atributosJson: {},
        estadoReforma: 'na',
        fuentesJson: [{ laminaId: planta.laminaId, bbox: [0.5, 0.5, 0.1, 0.1], detalle: 'Zócalo Z1' }],
        confianza: 0.9,
      })
      .returning();
    const [colgada] = await db
      .insert(deducciones)
      .values({
        obraId,
        entidadId: suelta.id,
        campo: 'largoM',
        regla: 'continuidad',
        fuentesJson: suelta.fuentesJson,
        valorJson: { largoM: 3 },
        confianza: 0.8,
      })
      .returning();

    await db.delete(deducciones).where(eq(deducciones.id, colgada.id));
    await db.delete(entidades).where(eq(entidades.id, suelta.id));
    await db.insert(deducciones).values({ ...colgada, entidadId: suelta.id }).catch(() => undefined);

    const resultado = await validarDeduccion({ obraId, deduccionId: colgada.id }, titular);
    expect(resultado).toEqual({ ok: false, error: NO_ENCONTRADA });
  });
});

// ---------------------------------------------------------------------------

describe('rechazar una deducción', () => {
  it('no escribe el dato y deja la consulta faltante abierta', async () => {
    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    expect(await rechazarDeduccion({ obraId, deduccionId: ancho.id }, titular)).toEqual({ ok: true });

    const rechazada = await deduccionDe('A-01', 'V2', 'anchoM');
    expect(rechazada.estado).toBe('rechazada');
    expect(rechazada.validadoPor).toBe(titular.usuarioId);

    // La entidad quedó intacta y el hueco sigue siendo un faltante bloqueante.
    expect((await entidadEn('A-01', 'V2')).atributosJson.anchoM).toBeUndefined();
    const consulta = await hallazgoPorClave('aberturas.medidas_vano.V2');
    expect(consulta?.estado).toBe('abierto');
    expect(consulta?.bloqueante).toBe(true);
    expect(await gateDe('aberturas')).toEqual({ ok: false, bloqueantes: 1 });

    expect(await auditoriaDe('deduccion_rechazada')).toHaveLength(1);
  });

  it('el motor no vuelve a proponer lo rechazado, ni tras reprocesar', async () => {
    const altura = await deduccionDe('A-01', 'T1', 'alturaM');
    await rechazarDeduccion({ obraId, deduccionId: altura.id }, titular);

    await recomputarObra(obraId);
    expect((await deduccionDe('A-01', 'T1', 'alturaM')).estado).toBe('rechazada');

    await procesarDocumento(documentoId, { db, storage });
    const filas = (await todasLasDeducciones()).filter((fila) => fila.campo === 'alturaM');
    expect(filas).toHaveLength(1);
    expect(filas[0]?.estado).toBe('rechazada');

    // Y el tabique sigue sin computarse: el dato falta de verdad.
    expect(await itemPorClave('seco.placas')).toBeUndefined();
    expect((await hallazgoPorClave('seco.altura_tabiques.T1'))?.estado).toBe('abierto');
  });

  it('un usuario de solo lectura tampoco rechaza', async () => {
    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    const resultado = await rechazarDeduccion({ obraId, deduccionId: ancho.id }, soloLectura);
    expect(resultado.ok).toBe(false);
    expect((await deduccionDe('A-01', 'V2', 'anchoM')).estado).toBe('propuesta');
  });
});
