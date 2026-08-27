/**
 * Bandeja de consultas: resolver un hallazgo y ver el efecto en el cómputo.
 *
 * Se testean los **núcleos** de `@/lib/bandeja/resolver` (`responderHallazgo`,
 * `marcarExistente`, …), no los envoltorios `*Action`: esos solo agregan
 * `requireUser()` / `requireObra()` y `revalidatePath()`, que necesitan el
 * request de Next. Lo que hay que proteger es qué queda escrito en la base.
 *
 * Sobre los fixtures: `obra-demo.pdf` trae todas las entidades completas y por
 * eso **no** genera hallazgos bloqueantes de medidas. Los escenarios de acá
 * insertan la entidad incompleta a mano y corren `recomputarObra`, que es
 * exactamente lo que hace el pipeline después de analizar una lámina. El único
 * test que pasa por el pipeline real es el de escala, que necesita el PDF.
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
import {
  confirmarLote,
  confirmarSupuesto,
  descartarHallazgo,
  descartarLote,
  ESCALA_NO_ES_SUPUESTO,
  marcarExistente,
  MEDIDA_NO_POSITIVA,
  responderHallazgo,
  type ActorBandeja,
} from '@/lib/bandeja/resolver';
import { puedeAprobarRubro } from '@/lib/hallazgos/gate';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';
import type { Fuente } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let obraId: string;
let laminaId: string;
let usuarioId: string;
let actor: ActorBandeja;

function fuente(detalle: string): Fuente[] {
  return [{ laminaId, bbox: [0.1, 0.2, 0.05, 0.08], detalle }];
}

async function insertarEntidad(entrada: {
  tipo: 'abertura' | 'tabique' | 'ambiente' | 'muro';
  nombre: string;
  atributos: Record<string, number | string | boolean | null>;
  /** Por debajo de 0,7 el motor degrada el ítem a consulta (§11.b). */
  confianza?: number;
}): Promise<string> {
  const [fila] = await db
    .insert(entidades)
    .values({
      obraId,
      laminaId,
      tipo: entrada.tipo,
      nombre: entrada.nombre,
      atributosJson: entrada.atributos,
      estadoReforma: 'na',
      fuentesJson: fuente(entrada.nombre),
      confianza: entrada.confianza ?? 0.9,
    })
    .returning();
  return fila.id;
}

function hallazgosAbiertos(): Promise<Hallazgo[]> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.estado, 'abierto')));
}

function hallazgoPorClave(clave: string): Promise<Hallazgo | undefined> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)))
    .then((filas) => filas[0]);
}

function itemPorClave(clave: string): Promise<ComputoItem | undefined> {
  return db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, clave)))
    .then((filas) => filas[0]);
}

async function gateDeAberturas() {
  const filas = await db
    .select({ rubro: hallazgos.rubro, bloqueante: hallazgos.bloqueante, estado: hallazgos.estado })
    .from(hallazgos)
    .where(eq(hallazgos.obraId, obraId));
  return puedeAprobarRubro('aberturas', filas);
}

/** Auditoría escrita por el usuario (la del pipeline sale con actor `agente`). */
function auditoriaDelUsuario() {
  return db
    .select()
    .from(auditoria)
    .where(and(eq(auditoria.obraId, obraId), eq(auditoria.actorTipo, 'usuario')));
}

beforeEach(async () => {
  // Todo el core resuelve la base por `getDb()`: hay que inyectar la de test.
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-bandeja-'));
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
  actor = { usuarioId: usuario.id, email: usuario.email };

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
      escala: '1:100',
      escalaConfiable: true,
    })
    .returning();

  laminaId = lamina.id;
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('responderHallazgo sobre un faltante de medidas', () => {
  it('carga el alto de P1, computa la abertura y libera el gate del rubro', async () => {
    // P1 tiene el ancho pero no el alto: el motor no la puede computar (P4).
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'P1',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
    });
    await recomputarObra(obraId);

    const abierto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(abierto?.estado).toBe('abierto');
    expect(abierto?.bloqueante).toBe(true);
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['altoM'] });
    expect(await itemPorClave('aberturas.P1')).toBeUndefined();

    const antes = await gateDeAberturas();
    expect(antes.ok).toBe(false);
    expect(antes.bloqueantes).toBe(1);

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: abierto!.id, valor: '2,05' },
      actor,
    );
    expect(resultado).toEqual({ ok: true });

    // 1) La entidad quedó con el dato que aportó el arquitecto.
    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.altoM).toBe(2.05);

    // 2) El ítem existe y es explícito: el dato lo aportó una persona (RF-602).
    const item = await itemPorClave('aberturas.P1');
    expect(item?.estado).toBe('activo');
    expect(item?.origen).toBe('explicito');
    expect(item?.cantNeta).toBe(1);
    expect(item?.descripcion).toBe('Puerta P1 (0,90 × 2,05 m)');
    expect(item?.fuentesJson.length).toBe(1);

    // 3) El hallazgo quedó respondido con su respuesta y su autor.
    const resuelto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({ tipo: 'valor', campo: 'altoM', valor: 2.05 });
    expect(resuelto?.resueltoPor).toBe(usuarioId);

    // 4) El gate del rubro pasa de false a true.
    const despues = await gateDeAberturas();
    expect(despues.ok).toBe(true);
    expect(despues.bloqueantes).toBe(0);

    // 5) La auditoría registra las dos escrituras del usuario.
    const registros = await auditoriaDelUsuario();
    const entidadAuditada = registros.find((r) => r.accion === 'entidad_actualizada');
    expect(entidadAuditada?.targetRef).toBe(`entidades:${entidadId}`);
    expect(entidadAuditada?.diffJson).toEqual({ altoM: { antes: null, despues: 2.05 } });

    const hallazgoAuditado = registros.find((r) => r.accion === 'hallazgo_respondido');
    expect(hallazgoAuditado?.targetRef).toBe('hallazgos:aberturas.medidas_vano.P1');
    expect(hallazgoAuditado?.actorNombre).toBe('arq@estudionorte.ar');
    expect(hallazgoAuditado?.diffJson).toMatchObject({
      estado: { antes: 'abierto', despues: 'respondido' },
    });
  });

  it('sin valor numérico deja nota y no le inventa un dato a la entidad (P4)', async () => {
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'V2',
      atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1.2 },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.V2');

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: abierto!.id, nota: 'Está en la planilla de carpinterías, lámina A-03.' },
      actor,
    );
    expect(resultado).toEqual({ ok: true });

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.altoM).toBeUndefined();

    const resuelto = await hallazgoPorClave('aberturas.medidas_vano.V2');
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({
      tipo: 'nota',
      nota: 'Está en la planilla de carpinterías, lámina A-03.',
    });
  });

  it('rechaza un 0 y deja la consulta abierta: cerrarla no computaría nada', async () => {
    // `leerMedida()` solo toma valores positivos: con altoM = 0 el motor sigue
    // sin poder emitir el ítem, pero el hallazgo quedaría cerrado y el rubro
    // aprobable con el dato faltando — el agujero exacto que el gate tapa.
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'P1',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['altoM'] });

    for (const valor of ['0', '0,00']) {
      expect(await responderHallazgo({ obraId, hallazgoId: abierto!.id, valor }, actor)).toEqual({
        ok: false,
        error: MEDIDA_NO_POSITIVA,
      });
    }

    // La consulta sigue viva, la entidad intacta, el ítem sin emitir.
    const intacto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(intacto?.estado).toBe('abierto');
    expect(intacto?.respuestaJson).toBeNull();
    expect(intacto?.resueltoPor).toBeNull();

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.altoM).toBeUndefined();
    expect(await itemPorClave('aberturas.P1')).toBeUndefined();

    // El gate del rubro no se movió y nada se escribió en la auditoría.
    expect(await gateDeAberturas()).toEqual({ ok: false, bloqueantes: 1 });
    expect(await auditoriaDelUsuario()).toHaveLength(0);

    // Y la medida de verdad se sigue pudiendo responder.
    expect(await responderHallazgo({ obraId, hallazgoId: abierto!.id, valor: '2,05' }, actor)).toEqual({
      ok: true,
    });
    expect((await hallazgoPorClave('aberturas.medidas_vano.P1'))?.estado).toBe('respondido');
  });

  it('rechaza un negativo, una unidad tipeada y un typo: los tres dejan la consulta abierta', async () => {
    // El agujero que tapa: `parsearCantidad` devuelve `null` para todo lo que
    // no es un positivo —el negativo incluido—, así que el chequeo `<= 0` de
    // arriba solo llegaba a atrapar el cero. Los otros tres caían al camino de
    // texto y cerraban la consulta ENTERA como `{tipo:'nota'}`: sin escribir un
    // dato, sin recompute, y `recomputarObra` no reabre (regla 3). Quedaba la
    // abertura incomputable, el rubro aprobable y, como única señal, una nota
    // en «Respondidas».
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'V9',
      atributos: { tag: 'V9', tipologia: 'ventana', anchoM: 1.2 },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.V9');
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['altoM'] });

    // Negativo, medida con la unidad tipeada, y el typo de la o por el cero.
    for (const valor of ['-2', '0,90 m', '2,o5']) {
      // Por la tarjeta multi-campo…
      expect(
        await responderHallazgo({ obraId, hallazgoId: abierto!.id, valores: { altoM: valor } }, actor),
      ).toEqual({
        ok: false,
        error: `«${valor}» no es una medida: escribí solo el número, con coma decimal y sin unidad.`,
      });
      // …y por el `valor` suelto, que es el mismo endpoint con otro payload.
      expect(await responderHallazgo({ obraId, hallazgoId: abierto!.id, valor }, actor)).toEqual({
        ok: false,
        error: `«${valor}» no es una medida: escribí solo el número, con coma decimal y sin unidad.`,
      });
    }

    // La consulta sigue viva, la entidad intacta, el ítem sin emitir.
    const intacto = await hallazgoPorClave('aberturas.medidas_vano.V9');
    expect(intacto?.estado).toBe('abierto');
    expect(intacto?.respuestaJson).toBeNull();
    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.altoM).toBeUndefined();
    expect(await itemPorClave('aberturas.V9')).toBeUndefined();
    expect(await gateDeAberturas()).toEqual({ ok: false, bloqueantes: 1 });
    expect(await auditoriaDelUsuario()).toHaveLength(0);

    // Y la medida bien escrita se sigue respondiendo igual que siempre.
    expect(
      await responderHallazgo({ obraId, hallazgoId: abierto!.id, valores: { altoM: '2,05' } }, actor),
    ).toEqual({ ok: true });
    expect((await hallazgoPorClave('aberturas.medidas_vano.V9'))?.estado).toBe('respondido');
  });

  it('una consulta que pregunta por un texto se sigue respondiendo en palabras', async () => {
    // El downgrade a nota no se fue: sigue siendo lo correcto donde el campo no
    // es una medida. El `tipo` de un tabique se contesta "durlock", y eso no es
    // un atributo numérico que inventarle a la entidad (P4).
    const entidadId = await insertarEntidad({
      tipo: 'tabique',
      nombre: 'T9',
      atributos: { tipo: 'placa de yeso', largoM: 3, alturaM: 2.6, caras: 2 },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('seco.sistema_tabique.T9');
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['tipo'] });

    expect(
      await responderHallazgo(
        { obraId, hallazgoId: abierto!.id, valores: { tipo: 'durlock' } },
        actor,
      ),
    ).toEqual({ ok: true });

    const resuelto = await hallazgoPorClave('seco.sistema_tabique.T9');
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({ tipo: 'nota', nota: 'durlock' });
  });

  it('rechaza la consulta de otra obra sin escribir nada', async () => {
    const [otroEstudio] = await db.insert(estudios).values({ nombre: 'Otro' }).returning();
    const [otraObra] = await db
      .insert(obras)
      .values({ estudioId: otroEstudio.id, nombre: 'Ajena', zona: 'GBA', tipo: 'nueva' })
      .returning();
    const [ajeno] = await db
      .insert(hallazgos)
      .values({
        obraId: otraObra.id,
        clave: 'aberturas.medidas_vano.P9',
        tipo: 'faltante',
        rubro: 'aberturas',
        descripcion: 'Consulta de otra obra.',
        laminasJson: [],
        bloqueante: true,
      })
      .returning();

    const resultado = await responderHallazgo({ obraId, hallazgoId: ajeno.id, valor: '2' }, actor);
    expect(resultado.ok).toBe(false);

    const [sinTocar] = await db.select().from(hallazgos).where(eq(hallazgos.id, ajeno.id));
    expect(sinTocar.estado).toBe('abierto');
    expect((await auditoriaDelUsuario()).length).toBe(0);
  });
});

describe('una consulta con varios campos se responde de una sola vez', () => {
  it('pide el ancho y el alto juntos, los escribe en un update y no reaparece', async () => {
    // FP01 no tiene ninguna de las dos medidas. Antes eso eran dos consultas en
    // serie: responder el ancho hacía aparecer la del alto en el recompute.
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta' },
    });
    await recomputarObra(obraId);

    const abierto = await hallazgoPorClave('aberturas.medidas_vano.FP01');
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['anchoM', 'altoM'] });
    expect(
      (await hallazgosAbiertos()).filter((h) => h.clave.startsWith('aberturas.medidas_vano.')),
    ).toHaveLength(1);

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: abierto!.id, valores: { anchoM: '0,90', altoM: '2,05' } },
      actor,
    );
    expect(resultado).toEqual({ ok: true });

    // 1) Las dos medidas quedaron escritas.
    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.anchoM).toBe(0.9);
    expect(entidad.atributosJson.altoM).toBe(2.05);

    // 2) El ítem se computa: una puerta, una unidad de compra.
    const item = await itemPorClave('aberturas.FP01');
    expect(item?.estado).toBe('activo');
    expect(item?.origen).toBe('explicito');
    expect(item?.cantCompra).toBe(1);

    // 3) La respuesta guarda los dos campos, no uno.
    const resuelto = await hallazgoPorClave('aberturas.medidas_vano.FP01');
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({
      tipo: 'valor',
      valores: { anchoM: 0.9, altoM: 2.05 },
    });

    // 4) Cero reapariciones: ni ahora ni después de recomputar.
    await recomputarObra(obraId);
    expect((await hallazgosAbiertos()).filter((h) => h.rubro === 'aberturas')).toHaveLength(0);

    // 5) UNA sola auditoría de entidad, con los dos diffs adentro.
    const deEntidad = (await auditoriaDelUsuario()).filter(
      (r) => r.accion === 'entidad_actualizada',
    );
    expect(deEntidad).toHaveLength(1);
    expect(deEntidad[0].diffJson).toEqual({
      anchoM: { antes: null, despues: 0.9 },
      altoM: { antes: null, despues: 2.05 },
    });
  });

  it('un 0 en cualquiera de los campos no escribe ninguno', async () => {
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta' },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.FP01');

    // El ancho es válido, el alto no: escribir solo el ancho cerraría la
    // consulta con la abertura igual de incomputable (RF-404).
    expect(
      await responderHallazgo(
        { obraId, hallazgoId: abierto!.id, valores: { anchoM: '0,90', altoM: '0' } },
        actor,
      ),
    ).toEqual({ ok: false, error: MEDIDA_NO_POSITIVA });

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.anchoM).toBeUndefined();
    expect(entidad.atributosJson.altoM).toBeUndefined();
    expect((await hallazgoPorClave('aberturas.medidas_vano.FP01'))?.estado).toBe('abierto');
    expect(await auditoriaDelUsuario()).toHaveLength(0);
  });

  it('rechaza una respuesta a la que le falta un campo: cerrarla lo perdería para siempre', async () => {
    // El caso peligroso no es el campo en blanco sino el que **no viene** en el
    // payload: la tarjeta lo impide con un `disabled`, pero esto es una server
    // action y el cliente manda lo que quiere. Si se escribiera solo el ancho,
    // la consulta quedaría `respondido` y `recomputarObra` no la reabre nunca
    // (regla 3): el alto no se vuelve a pedir jamás.
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta' },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.FP01');

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: abierto!.id, valores: { anchoM: '0,90' } },
      actor,
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.error).toContain('alto');

    // Ni el campo que sí vino se escribe: es todo o nada.
    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.anchoM).toBeUndefined();
    expect(entidad.atributosJson.altoM).toBeUndefined();
    expect(await auditoriaDelUsuario()).toHaveLength(0);

    // Y la consulta sigue viva, también después de recomputar.
    await recomputarObra(obraId);
    const intacto = await hallazgoPorClave('aberturas.medidas_vano.FP01');
    expect(intacto?.estado).toBe('abierto');
    expect(intacto?.respuestaJson).toBeNull();

    // La respuesta completa sí entra.
    expect(
      await responderHallazgo(
        { obraId, hallazgoId: abierto!.id, valores: { anchoM: '0,90', altoM: '2,05' } },
        actor,
      ),
    ).toEqual({ ok: true });
    expect((await itemPorClave('aberturas.FP01'))?.estado).toBe('activo');
  });

  it('un `valor` suelto no responde una consulta que pide dos medidas', async () => {
    // Con `campos: ['anchoM','altoM']` y un solo número no hay forma de saber
    // cuál es, y escribir el primero cerraría la consulta con el otro sin
    // cargar. Es el mismo agujero por la puerta del payload viejo.
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta' },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.FP01');

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: abierto!.id, valor: '0,90' },
      actor,
    );
    expect(resultado.ok).toBe(false);

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.anchoM).toBeUndefined();
    expect((await hallazgoPorClave('aberturas.medidas_vano.FP01'))?.estado).toBe('abierto');
    expect(await auditoriaDelUsuario()).toHaveLength(0);
  });

  it('rechaza un campo que la consulta no pide', async () => {
    await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta' },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.FP01');

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: abierto!.id, valores: { espesorM: '0,15' } },
      actor,
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.error).toContain('espesorM');
    expect((await hallazgoPorClave('aberturas.medidas_vano.FP01'))?.estado).toBe('abierto');
    expect(await auditoriaDelUsuario()).toHaveLength(0);
  });
});

describe('confirmar una lectura de baja confianza', () => {
  it('sube la confianza de la entidad a 1 y el ítem que no se emitía aparece', async () => {
    // Las medidas están leídas, pero con 0,6 de confianza el motor no computa
    // (§11.b): el dato existe y hasta ahora se tiraba.
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta', anchoM: 0.9, altoM: 2.05 },
      confianza: 0.6,
    });
    await recomputarObra(obraId);

    expect(await itemPorClave('aberturas.FP01')).toBeUndefined();

    const abierto = await hallazgoPorClave('aberturas.baja_confianza.FP01');
    expect(abierto?.estado).toBe('abierto');
    // Los campos salen de recorrer `atributos_json`, y jsonb no conserva el
    // orden en que se escribieron: ordena las claves por largo y después
    // alfabéticamente. De ahí "altoM" antes que "anchoM" — es el orden en el
    // que la tarjeta va a mostrar los inputs de una propuesta de lectura.
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['altoM', 'anchoM'] });
    expect(abierto?.valorPropuestoJson).toMatchObject({
      valores: { anchoM: 0.9, altoM: 2.05 },
      confianza: 0.6,
      origen: 'lectura_baja_confianza',
    });

    expect(
      await responderHallazgo(
        { obraId, hallazgoId: abierto!.id, valores: { anchoM: '0,90', altoM: '2,05' } },
        actor,
      ),
    ).toEqual({ ok: true });

    // Sin esto la confirmación no serviría de nada: el gate mira la confianza
    // de la ENTIDAD, así que el ítem se seguiría degradando (decisión 4).
    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.confianza).toBe(1);

    const item = await itemPorClave('aberturas.FP01');
    expect(item?.estado).toBe('activo');
    expect(item?.cantCompra).toBe(1);

    const deEntidad = (await auditoriaDelUsuario()).filter(
      (r) => r.accion === 'entidad_actualizada',
    );
    expect(deEntidad).toHaveLength(1);
    expect(deEntidad[0].diffJson).toMatchObject({ confianza: { antes: 0.6, despues: 1 } });

    // Y no vuelve a preguntar por lo mismo en el próximo recompute.
    await recomputarObra(obraId);
    expect((await hallazgosAbiertos()).filter((h) => h.rubro === 'aberturas')).toHaveLength(0);
  });
});

describe('confirmarLote', () => {
  it('confirma las que traen propuesta y saltea la que no tiene nada que confirmar', async () => {
    const fp01 = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta', anchoM: 0.9, altoM: 2.05 },
      confianza: 0.6,
    });
    const fp02 = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP02',
      atributos: { tag: 'FP02', tipologia: 'ventana', anchoM: 1.2, altoM: 1.5 },
      confianza: 0.6,
    });
    // V2 no tiene el alto en ningún lado: su consulta es una pregunta, no una
    // propuesta, y el lote no la puede confirmar.
    await insertarEntidad({
      tipo: 'abertura',
      nombre: 'V2',
      atributos: { tag: 'V2', tipologia: 'ventana', anchoM: 1 },
    });
    await recomputarObra(obraId);

    const uno = await hallazgoPorClave('aberturas.baja_confianza.FP01');
    const dos = await hallazgoPorClave('aberturas.baja_confianza.FP02');
    const sinPropuesta = await hallazgoPorClave('aberturas.medidas_vano.V2');
    expect(uno?.valorPropuestoJson).not.toBeNull();
    expect(dos?.valorPropuestoJson).not.toBeNull();
    expect(sinPropuesta?.valorPropuestoJson).toBeNull();

    const resultado = await confirmarLote(
      { obraId, hallazgoIds: [uno!.id, dos!.id, sinPropuesta!.id] },
      actor,
    );
    expect(resultado).toEqual({ ok: true, confirmadas: 2, salteadas: 1 });

    // Las dos confirmadas quedaron con la confianza en 1 y sus ítems activos.
    for (const id of [fp01, fp02]) {
      const [entidad] = await db.select().from(entidades).where(eq(entidades.id, id));
      expect(entidad.confianza).toBe(1);
    }
    expect((await itemPorClave('aberturas.FP01'))?.estado).toBe('activo');
    expect((await itemPorClave('aberturas.FP02'))?.estado).toBe('activo');

    // La que no tenía propuesta sigue esperando una respuesta a mano.
    expect((await hallazgoPorClave('aberturas.medidas_vano.V2'))?.estado).toBe('abierto');

    const registros = await auditoriaDelUsuario();
    expect(registros.filter((r) => r.accion === 'hallazgo_respondido')).toHaveLength(2);
    expect(registros.filter((r) => r.accion === 'entidad_actualizada')).toHaveLength(2);
  });

  it('saltea la propuesta a la que le falta una medida en vez de cerrar la consulta', async () => {
    // El escenario real: la búsqueda dirigida encuentra el ancho en la planilla
    // y el alto no. Confirmar eso escribiría el ancho y cerraría la consulta
    // para siempre, con la abertura igual de incomputable y sin nada que diga
    // que el alto quedó sin cargar.
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta' },
    });
    await recomputarObra(obraId);

    const abierto = await hallazgoPorClave('aberturas.medidas_vano.FP01');
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['anchoM', 'altoM'] });
    await db
      .update(hallazgos)
      .set({
        valorPropuestoJson: {
          valores: { anchoM: 0.9 },
          origen: 'busqueda_dirigida',
          confianza: 0.85,
        },
      })
      .where(eq(hallazgos.id, abierto!.id));

    const resultado = await confirmarLote({ obraId, hallazgoIds: [abierto!.id] }, actor);
    expect(resultado).toEqual({ ok: true, confirmadas: 0, salteadas: 1 });

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson.anchoM).toBeUndefined();

    const intacto = await hallazgoPorClave('aberturas.medidas_vano.FP01');
    expect(intacto?.estado).toBe('abierto');
    expect(intacto?.respuestaJson).toBeNull();
    // La propuesta parcial sigue ahí: la tarjeta la muestra y una persona la completa.
    expect(intacto?.valorPropuestoJson).toMatchObject({ valores: { anchoM: 0.9 } });
    expect(await auditoriaDelUsuario()).toHaveLength(0);
  });

  it('no toca nada si alguna de las seleccionadas es de otra obra', async () => {
    await insertarEntidad({
      tipo: 'abertura',
      nombre: 'FP01',
      atributos: { tag: 'FP01', tipologia: 'puerta', anchoM: 0.9, altoM: 2.05 },
      confianza: 0.6,
    });
    await recomputarObra(obraId);
    const propio = await hallazgoPorClave('aberturas.baja_confianza.FP01');

    const [otroEstudio] = await db.insert(estudios).values({ nombre: 'Otro' }).returning();
    const [otraObra] = await db
      .insert(obras)
      .values({ estudioId: otroEstudio.id, nombre: 'Ajena', zona: 'GBA', tipo: 'nueva' })
      .returning();
    const [ajeno] = await db
      .insert(hallazgos)
      .values({
        obraId: otraObra.id,
        clave: 'aberturas.baja_confianza.P9',
        tipo: 'faltante',
        rubro: 'aberturas',
        descripcion: 'Consulta de otra obra.',
        laminasJson: [],
        bloqueante: true,
      })
      .returning();

    const resultado = await confirmarLote(
      { obraId, hallazgoIds: [propio!.id, ajeno.id] },
      actor,
    );
    expect(resultado.ok).toBe(false);
    expect((await hallazgoPorClave('aberturas.baja_confianza.FP01'))?.estado).toBe('abierto');
    expect(await auditoriaDelUsuario()).toHaveLength(0);
  });
});

describe('marcarExistente', () => {
  it('sobre un ambiente ya construido, sus ítems salen del cómputo', async () => {
    // Sin altura no hay m² de pared, pero el cielorraso sí se computa: es el
    // caso donde la entidad tiene ítems Y una consulta abierta que la apunta.
    const entidadId = await insertarEntidad({
      tipo: 'ambiente',
      nombre: 'Estar',
      atributos: { superficieM2: 20, perimetroM: 18 },
    });
    await recomputarObra(obraId);

    const abierto = await hallazgoPorClave('pintura.altura_ambiente.Estar');
    expect(abierto?.targetRef).toEqual({ entidadId, campos: ['alturaM'] });
    expect((await itemPorClave('pintura.latex_cielorrasos'))?.cantNeta).toBe(4);

    const resultado = await marcarExistente({ obraId, hallazgoId: abierto!.id }, actor);
    expect(resultado).toEqual({ ok: true });

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.estadoReforma).toBe('existente');

    expect((await itemPorClave('pintura.latex_cielorrasos'))?.estado).toBe('anulado');

    const resuelto = await hallazgoPorClave('pintura.altura_ambiente.Estar');
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({ tipo: 'existente' });
    expect(resuelto?.resueltoPor).toBe(usuarioId);

    const registros = await auditoriaDelUsuario();
    expect(registros.find((r) => r.accion === 'entidad_actualizada')?.diffJson).toEqual({
      estadoReforma: { antes: 'na', despues: 'existente' },
    });
    expect(registros.filter((r) => r.accion === 'hallazgo_respondido')).toHaveLength(1);
  });

  it('sobre un tabique lo deja fuera del rubro seco y no reabre la consulta', async () => {
    await insertarEntidad({
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { largoM: 3, alturaM: 2.6, tipo: 'durlock' },
    });
    const t2 = await insertarEntidad({
      tipo: 'tabique',
      nombre: 'T2',
      atributos: { largoM: 2, tipo: 'durlock' },
    });
    await recomputarObra(obraId);

    // Solo T1 computa: 3 × 2,60 × 2 caras = 15,6 m².
    expect((await itemPorClave('seco.placas'))?.cantNeta).toBe(15.6);
    const abierto = await hallazgoPorClave('seco.altura_tabiques.T2');
    expect(abierto?.targetRef).toEqual({ entidadId: t2, campos: ['alturaM'] });

    expect(await marcarExistente({ obraId, hallazgoId: abierto!.id }, actor)).toEqual({ ok: true });

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, t2));
    expect(entidad.estadoReforma).toBe('existente');
    expect((await itemPorClave('seco.placas'))?.cantNeta).toBe(15.6);

    // Un recompute posterior no vuelve a abrir la consulta de T2.
    await recomputarObra(obraId);
    expect((await hallazgoPorClave('seco.altura_tabiques.T2'))?.estado).toBe('respondido');
  });
});

describe('confirmarSupuesto y descarte', () => {
  it('confirmarSupuesto deja el supuesto respondido sin tocar el cómputo', async () => {
    await insertarEntidad({
      tipo: 'ambiente',
      nombre: 'Estar',
      atributos: { superficieM2: 20, perimetroM: 18, alturaM: 2.6 },
    });
    await recomputarObra(obraId);

    const supuesto = await hallazgoPorClave('pintura.vanos_sin_descontar.Estar');
    expect(supuesto?.tipo).toBe('supuesto');
    expect(supuesto?.bloqueante).toBe(false);
    const litrosAntes = (await itemPorClave('pintura.latex_paredes'))?.cantNeta;

    expect(await confirmarSupuesto({ obraId, hallazgoId: supuesto!.id }, actor)).toEqual({
      ok: true,
    });

    const resuelto = await hallazgoPorClave('pintura.vanos_sin_descontar.Estar');
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({ tipo: 'supuesto_confirmado' });
    expect((await itemPorClave('pintura.latex_paredes'))?.cantNeta).toBe(litrosAntes);
  });

  it('confirmarSupuesto rechaza el supuesto de escala: ese tiene su propio botón', async () => {
    // La escala asumida es un supuesto, pero darlo por bueno acá cerraría la
    // consulta sin marcar `escala_confiable` ni reprocesar la lámina: la obra
    // quedaría computada sobre una escala que nadie verificó y sin ninguna
    // consulta que lo diga (decisión 7).
    const [supuesto] = await db
      .insert(hallazgos)
      .values({
        obraId,
        clave: `escala.${laminaId}`,
        tipo: 'supuesto',
        rubro: null,
        descripcion: 'Computé la lámina con la escala 1:20 que declara el rótulo.',
        laminasJson: [],
        bloqueante: false,
        valorPropuestoJson: { valores: { escala: '1:20' }, origen: 'rotulo' },
      })
      .returning();

    expect(await confirmarSupuesto({ obraId, hallazgoId: supuesto.id }, actor)).toEqual({
      ok: false,
      error: ESCALA_NO_ES_SUPUESTO,
    });

    const intacto = await hallazgoPorClave(`escala.${laminaId}`);
    expect(intacto?.estado).toBe('abierto');
    expect(intacto?.respuestaJson).toBeNull();
    expect(await auditoriaDelUsuario()).toHaveLength(0);
  });

  it('descartarHallazgo cierra una consulta y es idempotente', async () => {
    await insertarEntidad({
      tipo: 'abertura',
      nombre: 'P1',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.P1');

    expect(
      await descartarHallazgo({ obraId, hallazgoId: abierto!.id, nota: 'No va en esta etapa.' }, actor),
    ).toEqual({ ok: true });

    const resuelto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(resuelto?.estado).toBe('descartado');
    expect(resuelto?.respuestaJson).toEqual({ tipo: 'descartado', nota: 'No va en esta etapa.' });
    expect((await gateDeAberturas()).ok).toBe(true);

    // Repetir el descarte no vuelve a escribir ni a auditar.
    expect(await descartarHallazgo({ obraId, hallazgoId: abierto!.id }, actor)).toEqual({ ok: true });
    expect((await auditoriaDelUsuario()).filter((r) => r.accion === 'hallazgo_descartado')).toHaveLength(1);
  });

  it('descartarLote cierra las seleccionadas y audita una por una', async () => {
    await insertarEntidad({
      tipo: 'abertura',
      nombre: 'P1',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
    });
    await insertarEntidad({
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { largoM: 3, tipo: 'durlock' },
    });
    await recomputarObra(obraId);

    const uno = await hallazgoPorClave('aberturas.medidas_vano.P1');
    const dos = await hallazgoPorClave('seco.altura_tabiques.T1');

    const resultado = await descartarLote(
      { obraId, hallazgoIds: [uno!.id, dos!.id] },
      actor,
    );
    expect(resultado).toEqual({ ok: true, descartados: 2, respondidas: 0 });

    expect((await hallazgoPorClave('aberturas.medidas_vano.P1'))?.estado).toBe('descartado');
    expect((await hallazgoPorClave('seco.altura_tabiques.T1'))?.estado).toBe('descartado');
    expect(
      (await auditoriaDelUsuario()).filter((r) => r.accion === 'hallazgo_descartado'),
    ).toHaveLength(2);
  });

  it('descartarHallazgo NO pisa la respuesta de una consulta ya respondida', async () => {
    await insertarEntidad({
      tipo: 'abertura',
      nombre: 'P1',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    await responderHallazgo({ obraId, hallazgoId: abierto!.id, valor: '2,05' }, actor);

    const resultado = await descartarHallazgo({ obraId, hallazgoId: abierto!.id }, actor);
    expect(resultado.ok).toBe(false);

    const intacto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(intacto?.estado).toBe('respondido');
    expect(intacto?.respuestaJson).toEqual({ tipo: 'valor', campo: 'altoM', valor: 2.05 });
    expect(intacto?.resueltoPor).toBe(usuarioId);
    expect(
      (await auditoriaDelUsuario()).filter((r) => r.accion === 'hallazgo_descartado'),
    ).toHaveLength(0);
  });

  it('descartarLote saltea las respondidas del lote y las informa aparte', async () => {
    await insertarEntidad({
      tipo: 'abertura',
      nombre: 'P1',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
    });
    await insertarEntidad({
      tipo: 'tabique',
      nombre: 'T1',
      atributos: { largoM: 3, tipo: 'durlock' },
    });
    await recomputarObra(obraId);

    // La de la abertura ya está respondida; la del tabique sigue abierta.
    const respondida = await hallazgoPorClave('aberturas.medidas_vano.P1');
    await responderHallazgo({ obraId, hallazgoId: respondida!.id, valor: '2,05' }, actor);
    const abierta = await hallazgoPorClave('seco.altura_tabiques.T1');

    const resultado = await descartarLote(
      { obraId, hallazgoIds: [respondida!.id, abierta!.id] },
      actor,
    );
    expect(resultado).toEqual({ ok: true, descartados: 1, respondidas: 1 });

    const intacta = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(intacta?.estado).toBe('respondido');
    expect(intacta?.respuestaJson).toEqual({ tipo: 'valor', campo: 'altoM', valor: 2.05 });
    expect(intacta?.resueltoPor).toBe(usuarioId);

    expect((await hallazgoPorClave('seco.altura_tabiques.T1'))?.estado).toBe('descartado');
    expect(
      (await auditoriaDelUsuario()).filter((r) => r.accion === 'hallazgo_descartado'),
    ).toHaveLength(1);
  });
});

describe('un hallazgo respondido no se reabre', () => {
  it('sobrevive a un recompute que vuelve a encontrar el dato faltante', async () => {
    const entidadId = await insertarEntidad({
      tipo: 'abertura',
      nombre: 'P1',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 },
    });
    await recomputarObra(obraId);
    const abierto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    await responderHallazgo({ obraId, hallazgoId: abierto!.id, valor: '2,05' }, actor);

    // Re-procesar la lámina reescribe `atributos_json` con lo que leyó el
    // provider: el alto que cargó el arquitecto desaparece de la entidad.
    await db
      .update(entidades)
      .set({ atributosJson: { tag: 'P1', tipologia: 'puerta', anchoM: 0.9 } })
      .where(eq(entidades.id, entidadId));
    await recomputarObra(obraId);

    const resuelto = await hallazgoPorClave('aberturas.medidas_vano.P1');
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({ tipo: 'valor', campo: 'altoM', valor: 2.05 });
    expect(resuelto?.resueltoPor).toBe(usuarioId);
    // El ítem sí se anula: sin el dato, el motor no lo puede sostener.
    expect((await itemPorClave('aberturas.P1'))?.estado).toBe('anulado');
  });

  it('responde el bloqueo por escala, reprocesa la lámina y no la vuelve a bloquear', async () => {
    const bytes = await readFile(new URL('sin-escala.pdf', PDFS));
    const archivo = new File([new Uint8Array(bytes)], 'sin-escala.pdf', {
      type: 'application/pdf',
    });
    const documento = await subirDocumento(db, storage, obraId, usuarioId, archivo);
    await procesarDocumento(documento.id, { db, storage });

    const [pagina] = await db
      .select()
      .from(laminas)
      .where(eq(laminas.documentoId, documento.id));
    expect(pagina.estadoAnalisis).toBe('bloqueada_escala');

    const abierto = await hallazgoPorClave(`escala.${pagina.id}`);
    expect(abierto?.estado).toBe('abierto');
    expect(abierto?.bloqueante).toBe(true);
    expect(abierto?.targetRef).toBeNull();

    // RF-402/404: la lámina no se midió, así que ningún rubro se puede aprobar
    // — el hallazgo de escala no tiene rubro porque los afecta a todos.
    expect(abierto?.rubro).toBeNull();
    expect(await gateDeAberturas()).toEqual({ ok: false, bloqueantes: 1 });

    const resultado = await responderHallazgo(
      { obraId, hallazgoId: abierto!.id, valor: '1:50' },
      actor,
      { storage },
    );
    expect(resultado).toEqual({ ok: true });

    const [desbloqueada] = await db.select().from(laminas).where(eq(laminas.id, pagina.id));
    expect(desbloqueada.escala).toBe('1:50');
    expect(desbloqueada.escalaConfiable).toBe(true);
    expect(desbloqueada.estadoAnalisis).toBe('analizada');

    const resuelto = await hallazgoPorClave(`escala.${pagina.id}`);
    expect(resuelto?.estado).toBe('respondido');
    expect(resuelto?.respuestaJson).toEqual({ tipo: 'escala', valor: '1:50' });

    // Con la escala confirmada el gate se libera solo.
    expect(await gateDeAberturas()).toEqual({ ok: true, bloqueantes: 0 });

    // Volver a procesar el documento no reabre la consulta ni re-bloquea.
    await procesarDocumento(documento.id, { db, storage });
    const [reprocesada] = await db.select().from(laminas).where(eq(laminas.id, pagina.id));
    expect(reprocesada.estadoAnalisis).toBe('analizada');
    expect((await hallazgoPorClave(`escala.${pagina.id}`))?.estado).toBe('respondido');
  });
});
