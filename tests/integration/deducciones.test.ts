/**
 * Deducción integrada, de punta a punta: del PDF a la deducción, de la deducción
 * al ítem `deducido`, y de vuelta.
 *
 * Desde §5.4 el paso del medio no lo da una persona: una deducción documental
 * con confianza ≥ 0,7 **nace validada** (`validado_por = null`) y se aplica en
 * la misma corrida del recompute. Validar a mano sigue existiendo para lo que no
 * llega al umbral, y esos casos se arman con `volverAPropuesta()`.
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
import { randomUUID } from 'node:crypto';
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

/**
 * Deja una deducción en `propuesta`, que es el estado en el que llega a la
 * bandeja lo que **no** se auto-valida.
 *
 * Desde §5.4 una deducción documental con confianza suficiente nace `validada`
 * y se aplica sola: el camino de validarla a mano queda para lo que no llega al
 * umbral —hoy, el cruce por debajo de 0,7— y para la revisión de T11. Estos
 * casos ejercitan ese camino, y este helper es el fixture que lo arma sin
 * inventar una deducción que el motor no produce.
 *
 * No recomputa a propósito: `validarDeduccion` y `rechazarDeduccion` recomputan
 * ellos mismos, y lo que estos casos miran es qué queda escrito.
 */
/**
 * Le escribe el mismo `elemento_id` al T1 de la planta y al del corte: es
 * **exactamente** lo que hace el cruce (§5.3) cuando reconoce que las dos
 * láminas hablan de la misma pared. El fixture no lo trae porque el cruce corre
 * en otra rama; el rail que se prueba acá es el del recompute.
 */
async function unificarT1(): Promise<void> {
  const elementoId = randomUUID();
  for (const codigo of ['A-01', 'A-02']) {
    const entidad = await entidadEn(codigo, 'T1');
    await db.update(entidades).set({ elementoId }).where(eq(entidades.id, entidad.id));
  }
  await recomputarObra(obraId);
}

async function volverAPropuesta(fila: Deduccion): Promise<Deduccion> {
  await db
    .update(deducciones)
    .set({ estado: 'propuesta', validadoPor: null })
    .where(eq(deducciones.id, fila.id));
  return { ...fila, estado: 'propuesta', validadoPor: null };
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

describe('el pipeline deduce y lo aplica en la misma corrida', () => {
  it('cruza las tres láminas, aplica los cinco datos y no toca ninguna entidad', async () => {
    const filas = await todasLasDeducciones();
    expect(filas).toHaveLength(5);
    // §5.4: lo deducido con fuentes y confianza suficiente entra al cómputo
    // marcado y reversible, en vez de esperar a que alguien apriete un botón.
    // `validado_por` en null es lo que dice quién lo validó: el sistema.
    expect(filas.every((fila) => fila.estado === 'validada')).toBe(true);
    expect(filas.every((fila) => fila.validadoPor === null)).toBe(true);

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

    // La mitad de P4 que NO cambió: auto-validar no es escribir en la entidad.
    // El dato entra al cómputo por la capa de `aplicarDeduccionesValidadas`, y
    // `atributos_json` sigue diciendo lo que dice la documentación y nada más.
    const v2 = await entidadEn('A-01', 'V2');
    expect(v2.atributosJson.anchoM).toBeUndefined();
    expect(v2.atributosJson.altoM).toBeUndefined();

    // Y sin embargo la ventana ya está computada, con su medida y su marca: la
    // consulta por el dato faltante se cerró sola y el rubro quedó liberado.
    const item = await itemPorClave('aberturas.V2');
    expect(item?.origen).toBe('deducido');
    expect(item?.descripcion).toBe('Ventana V2 (1,50 × 1,10 m)');
    expect((await hallazgoPorClave('aberturas.medidas_vano.V2'))?.estado).toBe('descartado');
    expect(await gateDe('aberturas')).toEqual({ ok: true, bloqueantes: 0 });

    // Todo lo escribió el agente, y quedó auditado una vez por deducción.
    const auditadas = await auditoriaDe('deduccion_autovalidada');
    expect(auditadas).toHaveLength(5);
    expect(auditadas.every((fila) => fila.actorTipo === 'agente')).toBe(true);
    expect(await auditoriaDe('deduccion_propuesta')).toHaveLength(0);
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
    // Una fila `propuesta` sobre un campo que el motor no deduce: es lo que
    // queda cuando cambia la lámina o el arquitecto carga el dato a mano. Sigue
    // siendo una sugerencia viva, y una sugerencia sin sustento se retira.
    const v2 = await entidadEn('A-01', 'V2');
    await db.insert(deducciones).values({
      obraId,
      entidadId: v2.id,
      campo: 'vanosM2',
      regla: 'continuidad',
      fuentesJson: v2.fuentesJson,
      valorJson: { vanosM2: 1.65 },
      confianza: 0.8,
    });

    const resumen = await recomputarObra(obraId);
    expect(resumen.deduccionesRetiradas).toBe(1);

    const filas = await todasLasDeducciones();
    expect(filas).toHaveLength(5);
    expect(filas.some((fila) => fila.campo === 'vanosM2')).toBe(false);
    expect(await auditoriaDe('deduccion_retirada')).toHaveLength(1);
  });

  it('lo ya aplicado no se retira aunque la documentación lo diga después', async () => {
    // El arquitecto carga las medidas a mano: la planilla ya no deduce nada,
    // pero esas deducciones no son propuestas vivas — son decisiones tomadas
    // (por el sistema, y por eso `validado_por` es null). Se conservan, y la
    // contradicción se avisa por su propio camino si los números no coinciden.
    const v2 = await entidadEn('A-01', 'V2');
    await db
      .update(entidades)
      .set({ atributosJson: { ...v2.atributosJson, anchoM: 1.5, altoM: 1.1 } })
      .where(eq(entidades.id, v2.id));

    const resumen = await recomputarObra(obraId);

    expect(resumen.deduccionesRetiradas).toBe(0);
    expect(await todasLasDeducciones()).toHaveLength(5);
  });

  it('reprocesar el documento no duplica ni una deducción', async () => {
    await procesarDocumento(documentoId, { db, storage });
    expect(await todasLasDeducciones()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------

describe('la deducción aplicada', () => {
  it('deja el ítem en origen deducido, con las dos láminas, y libera el gate', async () => {
    // El ítem sale deducido y citando las dos láminas. Sigue siendo UNA sola
    // ventana: la de la planta, especificada por la planilla.
    const item = await itemPorClave('aberturas.V2');
    expect(item?.estado).toBe('activo');
    expect(item?.origen).toBe('deducido');
    expect(item?.cantNeta).toBe(1);
    expect(item?.descripcion).toBe('Ventana V2 (1,50 × 1,10 m)');
    expect(await laminasCitadas(item!.fuentesJson)).toEqual(['A-01', 'A-05']);

    // La consulta por el dato faltante se cerró sola y el rubro se libera. La
    // de «cantidad supuesta por la planilla» ni llegó a abrirse: la deducción
    // entró en la misma corrida en la que se leyó la planilla, así que la V2 de
    // la planta ya estaba computable cuando el rubro se computó.
    expect((await hallazgoPorClave('aberturas.medidas_vano.V2'))?.estado).toBe('descartado');
    expect(await hallazgoPorClave('aberturas.cantidad_planilla.V2')).toBeUndefined();
    expect(await gateDe('aberturas')).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('la altura del corte deja seco.placas en origen deducido', async () => {
    // Sin cruce corrido, el T1 de la planta y el T1 del corte son dos tabiques
    // para el sistema: 2 × (5 m × 2,60 m × 2 caras) = 52 m². Nadie le dijo
    // todavía que son la misma pared.
    const placas = await itemPorClave('seco.placas');
    expect(placas?.origen).toBe('deducido');
    expect(placas?.cantNeta).toBe(52);
    expect((await hallazgoPorClave('dato_obra.altura_local.general'))?.estado).toBe('descartado');
  });

  it('con el elemento unificado se computa UNA vez, citando las dos láminas', async () => {
    await unificarT1();

    // La misma pared: 5 m × 2,60 m × 2 caras = 26 m²; +12 % ⇒ 11 placas de
    // 2,88 m² = 31,68 m². El largo lo dice la planta y la altura el corte, así
    // que el ítem tiene que citar las dos (P1).
    const placas = await itemPorClave('seco.placas');
    expect(placas?.cantNeta).toBe(26);
    expect(placas?.cantCompra).toBe(31.68);
    expect(placas?.origen).toBe('deducido');
    expect(await laminasCitadas(placas!.fuentesJson)).toEqual(['A-01', 'A-02']);

    // Y no queda ninguna consulta de unificación: las dos láminas dicen lo mismo.
    const todos = await db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId));
    expect(todos.filter((fila) => fila.clave.startsWith('unificacion.'))).toEqual([]);
  });

  it('el dato deducido sobrevive a un reanálisis de la lámina', async () => {
    // Reprocesar reescribe `atributos_json` con lo que vuelve a leer el provider:
    // la planta sigue sin acotar la ventana. La deducción validada la sostiene.
    await procesarDocumento(documentoId, { db, storage });

    const validadas = (await todasLasDeducciones()).filter((fila) => fila.estado === 'validada');
    expect(validadas).toHaveLength(5);

    const item = await itemPorClave('aberturas.V2');
    expect(item?.estado).toBe('activo');
    expect(item?.origen).toBe('deducido');
    // Una sola ventana: la de la planta. La fila de la planilla es la misma V2,
    // dicha de nuevo (antes salía 2, que era el doble conteo plano↔planilla).
    expect(item?.cantNeta).toBe(1);
    expect(await gateDe('aberturas')).toEqual({ ok: true, bloqueantes: 0 });
  });

  it('si el reanálisis trae OTRO valor, gana la documentación y el conflicto se avisa', async () => {
    expect((await itemPorClave('seco.placas'))?.origen).toBe('deducido');

    // La planta se vuelve a analizar y ahora SÍ acota el tabique: 2,40 m.
    await procesarDocumento(documentoId, { db, storage, provider: plantaQueAcota(2.4) });

    // 1) Manda lo escrito: el T1 de la planta pasa a 5 × 2,40 × 2 = 24 m². El
    //    del corte sigue en 26 —sin cruce corrido son dos tabiques distintos— y
    //    es el que deja el ítem en `deducido`: su largo lo puso la continuidad.
    const placas = await itemPorClave('seco.placas');
    expect(placas?.cantNeta).toBe(50);
    expect(placas?.origen).toBe('deducido');

    // 2) Pero no en silencio: queda una consulta no bloqueante con los dos valores.
    const consulta = await hallazgoPorClave('deduccion.contradicha.T1.alturaM');
    expect(consulta?.estado).toBe('abierto');
    expect(consulta?.tipo).toBe('inconsistencia');
    expect(consulta?.bloqueante).toBe(false);
    expect(consulta?.descripcion).toContain('se validó en 2,60 m');
    expect(consulta?.descripcion).toContain('ahora dice 2,40 m');
    expect(await laminasCitadas(consulta!.laminasJson)).toEqual(['A-01', 'A-02']);
    // No frena nada: el cómputo usa el dato bueno.
    expect((await gateDe('seco')).bloqueantes).toBe(0);

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
    // La planta ahora acota 2,60 m, que es exactamente lo que se había deducido.
    await procesarDocumento(documentoId, { db, storage, provider: plantaQueAcota(2.6) });

    expect(await hallazgoPorClave('deduccion.contradicha.T1.alturaM')).toBeUndefined();
    expect(await auditoriaDe('deduccion_contradicha')).toHaveLength(0);

    const sinMarca = await deduccionDe('A-01', 'T1', 'alturaM');
    expect(sinMarca.estado).toBe('validada');
    expect(sinMarca.valorJson).toEqual({ alturaM: 2.6 });
    expect((await itemPorClave('seco.placas'))?.cantNeta).toBe(52);
  });

  it('cuando la documentación vuelve a coincidir, la marca se levanta sola', async () => {
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
    await volverAPropuesta(await deduccionDe('A-01', 'V2', 'anchoM'));
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
    const ancho = await volverAPropuesta(await deduccionDe('A-01', 'V2', 'anchoM'));
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
    const ancho = await volverAPropuesta(await deduccionDe('A-01', 'V2', 'anchoM'));
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
  it('no escribe el dato y el ítem deja de apoyarse en él', async () => {
    const ancho = await volverAPropuesta(await deduccionDe('A-01', 'V2', 'anchoM'));
    expect(await rechazarDeduccion({ obraId, deduccionId: ancho.id }, titular)).toEqual({ ok: true });

    const rechazada = await deduccionDe('A-01', 'V2', 'anchoM');
    expect(rechazada.estado).toBe('rechazada');
    expect(rechazada.validadoPor).toBe(titular.usuarioId);

    // La entidad quedó intacta y el ancho ya no entra al cómputo: la ventana
    // vuelve a computarse solo con lo que dice la planilla.
    expect((await entidadEn('A-01', 'V2')).atributosJson.anchoM).toBeUndefined();
    expect((await itemPorClave('aberturas.V2'))?.origen).toBe('supuesto');

    expect(await auditoriaDe('deduccion_rechazada')).toHaveLength(1);
  });

  it('el motor no vuelve a proponer lo rechazado, ni tras reprocesar', async () => {
    const altura = await volverAPropuesta(await deduccionDe('A-01', 'T1', 'alturaM'));
    await rechazarDeduccion({ obraId, deduccionId: altura.id }, titular);

    await recomputarObra(obraId);
    expect((await deduccionDe('A-01', 'T1', 'alturaM')).estado).toBe('rechazada');

    await procesarDocumento(documentoId, { db, storage });
    const filas = (await todasLasDeducciones()).filter((fila) => fila.campo === 'alturaM');
    expect(filas).toHaveLength(1);
    expect(filas[0]?.estado).toBe('rechazada');

    // Y el tabique de la planta deja de computarse: su altura falta de verdad.
    // Quedan los 26 m² del T1 del corte, que tiene la suya acotada.
    expect((await itemPorClave('seco.placas'))?.cantNeta).toBe(26);
  });

  it('un usuario de solo lectura tampoco rechaza', async () => {
    const ancho = await volverAPropuesta(await deduccionDe('A-01', 'V2', 'anchoM'));
    const resultado = await rechazarDeduccion({ obraId, deduccionId: ancho.id }, soloLectura);
    expect(resultado.ok).toBe(false);
    expect((await deduccionDe('A-01', 'V2', 'anchoM')).estado).toBe('propuesta');
  });

  it('rechazar una AUTO-validada todavía no procede — lo habilita T11', async () => {
    // Estado intermedio y declarado de la ola: la deducción entra sola al
    // cómputo (§5.4) pero el camino de vuelta —revertir el dato y reabrir el
    // faltante— es de la bandeja «Para revisar» (T11). Hasta entonces
    // `rechazarDeduccion` la trata como cualquier fila ya resuelta.
    const ancho = await deduccionDe('A-01', 'V2', 'anchoM');
    expect(ancho.estado).toBe('validada');
    expect(ancho.validadoPor).toBeNull();

    const resultado = await rechazarDeduccion({ obraId, deduccionId: ancho.id }, titular);
    expect(resultado.ok).toBe(false);
    expect((await deduccionDe('A-01', 'V2', 'anchoM')).estado).toBe('validada');
  });
});
