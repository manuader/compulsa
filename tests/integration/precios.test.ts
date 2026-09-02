/**
 * La lista de precios de referencia del estudio (§5.6).
 *
 * Se testea el **núcleo** de `@/lib/precios/gestion` (no los `*Action`, que solo
 * agregan `requireUser()` y `revalidatePath()`): lo que hay que proteger es qué
 * queda escrito, para qué estudio y con qué rastro.
 *
 * Las cuatro cosas que estos tests cuidan:
 *
 *  1. **Upsert por `(estudio, clave_item)`:** cargar dos veces la misma clave
 *     no deja dos filas, y cargarla dos veces **igual** no escribe ni audita.
 *  2. **Aislamiento (RNF-4):** la lista es del estudio. La misma clave en dos
 *     estudios son dos precios distintos, y ninguno ve al otro.
 *  3. **Todo lo que muta, audita** (CLAUDE.md §4), y el rol se chequea en el
 *     core y no solo en la UI (RF-1201).
 *  4. **El import no pierde filas:** `nuevos + actualizados + sinCambios +
 *     errores` es siempre el total de las filas que entraron.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import { auditoria, estudios, preciosReferencia, usuarios } from '@/db/schema';
import { importarCsvPrecios } from '@/lib/precios/import-csv';
import {
  eliminarPrecio,
  guardarPrecio,
  listaDelEstudio,
  listarPrecios,
  persistirImportPrecios,
  PrecioNoEncontradoError,
  type ActorPrecios,
} from '@/lib/precios/gestion';
import { resolverPrecio } from '@/lib/precios/resolver';
import { RolInsuficienteError } from '@/lib/plataforma/roles';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let estudioId: string;
let otroEstudioId: string;
let actor: ActorPrecios;
let actorAjeno: ActorPrecios;
let lector: ActorPrecios;

/** El default que la pantalla le pasa al core cuando el CSV no trae fecha. */
const HOY = '2026-08-28';

const VENTANA = {
  claveItem: 'aberturas.ventana.dvh',
  descripcion: 'Ventana corrediza DVH de aluminio',
  unidad: 'm2' as const,
  precio: 145000,
  fecha: '2026-08-10',
};

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio, otro] = await db
    .insert(estudios)
    .values([{ nombre: 'Estudio Norte' }, { nombre: 'Estudio Sur' }])
    .returning();
  estudioId = estudio.id;
  otroEstudioId = otro.id;

  const [titular, ajeno, lectura] = await db
    .insert(usuarios)
    .values([
      {
        estudioId: estudio.id,
        email: 'arq@estudionorte.ar',
        nombre: 'Ana Arquitecta',
        passwordHash: 'x',
        rol: 'titular',
      },
      {
        estudioId: otro.id,
        email: 'otro@estudiosur.ar',
        nombre: 'Bruno Sur',
        passwordHash: 'x',
        rol: 'colaborador',
      },
      {
        estudioId: estudio.id,
        email: 'pasante@estudionorte.ar',
        nombre: 'Caro Pasante',
        passwordHash: 'x',
        rol: 'lectura',
      },
    ])
    .returning();

  actor = {
    usuarioId: titular.id,
    email: titular.email,
    estudioId,
    rol: 'titular',
    activo: true,
  };
  actorAjeno = {
    usuarioId: ajeno.id,
    email: ajeno.email,
    estudioId: otroEstudioId,
    rol: 'colaborador',
    activo: true,
  };
  lector = {
    usuarioId: lectura.id,
    email: lectura.email,
    estudioId,
    rol: 'lectura',
    activo: true,
  };
});

/** Las auditorías del estudio, en orden. */
async function acciones(): Promise<string[]> {
  const filas = await db.select().from(auditoria);
  return filas.map((fila) => fila.accion);
}

async function filasDe(estudio: string) {
  return db.select().from(preciosReferencia).where(eq(preciosReferencia.estudioId, estudio));
}

// ---------------------------------------------------------------------------

describe('guardarPrecio: upsert por (estudio, clave_item)', () => {
  it('la primera vez inserta y deja el rastro', async () => {
    const resultado = await guardarPrecio(db, actor, VENTANA, 'manual');

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.creado).toBe(true);
    expect(resultado.precio.precio).toBe(145000);
    expect(resultado.precio.moneda).toBe('ARS');
    expect(resultado.precio.origen).toBe('manual');

    expect(await acciones()).toEqual(['precio_referencia_creado']);
  });

  it('la segunda vez con los mismos datos no escribe ni audita', async () => {
    await guardarPrecio(db, actor, VENTANA, 'manual');
    const repetido = await guardarPrecio(db, actor, VENTANA, 'manual');

    expect(repetido.ok).toBe(true);
    if (!repetido.ok) return;
    expect(repetido.creado).toBe(false);
    expect(repetido.cambios).toEqual({});

    expect(await filasDe(estudioId)).toHaveLength(1);
    // Una sola auditoría: la del alta. Un no-cambio no deja rastro.
    expect(await acciones()).toEqual(['precio_referencia_creado']);
  });

  it('con otro precio actualiza la misma fila y audita el antes y el después', async () => {
    const alta = await guardarPrecio(db, actor, VENTANA, 'manual');
    const nuevo = await guardarPrecio(db, actor, { ...VENTANA, precio: 158000 }, 'manual');

    expect(nuevo.ok).toBe(true);
    if (!alta.ok || !nuevo.ok) return;
    expect(nuevo.precio.id).toBe(alta.precio.id);
    expect(nuevo.precio.precio).toBe(158000);
    expect(nuevo.cambios.precio).toEqual({ antes: 145000, despues: 158000 });

    expect(await filasDe(estudioId)).toHaveLength(1);
    expect(await acciones()).toEqual(['precio_referencia_creado', 'precio_referencia_editado']);
  });

  it('la misma clave en dos estudios son dos precios distintos (RNF-4)', async () => {
    await guardarPrecio(db, actor, VENTANA, 'manual');
    await guardarPrecio(db, actorAjeno, { ...VENTANA, precio: 99000 }, 'manual');

    expect(await filasDe(estudioId)).toHaveLength(1);
    expect(await filasDe(otroEstudioId)).toHaveLength(1);

    const [mio] = await filasDe(estudioId);
    expect(mio.precio).toBe(145000);
  });

  it('el precio se guarda con dos decimales, así el upsert es idempotente', async () => {
    // La columna es `numeric(14,2)`: sin redondear en el core, 12,555 se
    // escribiría como 12,56 y la siguiente corrida vería un cambio que no hubo.
    const primera = await guardarPrecio(db, actor, { ...VENTANA, precio: 12.555 }, 'csv');
    const segunda = await guardarPrecio(db, actor, { ...VENTANA, precio: 12.555 }, 'csv');

    expect(primera.ok && primera.precio.precio).toBe(12.56);
    expect(segunda.ok && segunda.creado).toBe(false);
    expect(await acciones()).toEqual(['precio_referencia_creado']);
  });

  it('dos escrituras simultáneas sobre la misma clave no chocan contra el UNIQUE', async () => {
    // Leer-y-después-decidir es un check-then-act: los dos escritores podían
    // leer «no existe» y el segundo INSERT se estrellaba contra el
    // `UNIQUE (estudio_id, clave_item)` con un 500 crudo. El write es una sola
    // sentencia `ON CONFLICT DO UPDATE`, así que gane quien gane la carrera
    // queda una fila sola y nadie explota.
    const resultados = await Promise.all([
      guardarPrecio(db, actor, { ...VENTANA, precio: 145000 }, 'manual'),
      guardarPrecio(db, actor, { ...VENTANA, precio: 158000 }, 'csv'),
    ]);

    expect(resultados.every((r) => r.ok)).toBe(true);
    expect(await filasDe(estudioId)).toHaveLength(1);

    const [fila] = await filasDe(estudioId);
    expect([145000, 158000]).toContain(fila.precio);
  });

  it('la moneda se guarda en mayúsculas: «usd» y «USD» son la misma', async () => {
    const alta = await guardarPrecio(db, actor, { ...VENTANA, moneda: 'usd' }, 'manual');
    expect(alta.ok && alta.precio.moneda).toBe('USD');

    // Y por eso volver a guardarla escrita distinto no es un cambio.
    const otra = await guardarPrecio(db, actor, { ...VENTANA, moneda: 'Usd' }, 'manual');
    expect(otra.ok && otra.cambios).toEqual({});
    expect(await acciones()).toEqual(['precio_referencia_creado']);
  });

  it('un precio que no es positivo no entra, y lo dice por campo', async () => {
    const resultado = await guardarPrecio(db, actor, { ...VENTANA, precio: 0 }, 'manual');

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.errores.precio).toBeTruthy();
    expect(await filasDe(estudioId)).toHaveLength(0);
  });

  it('con rol de solo lectura no se escribe nada (RF-1201)', async () => {
    await expect(guardarPrecio(db, lector, VENTANA, 'manual')).rejects.toBeInstanceOf(
      RolInsuficienteError,
    );

    expect(await filasDe(estudioId)).toHaveLength(0);
    expect(await acciones()).toEqual([]);
  });
});

describe('eliminarPrecio', () => {
  it('la saca de la lista sin borrar la fila: la auditoría tiene a qué apuntar', async () => {
    const alta = await guardarPrecio(db, actor, VENTANA, 'manual');
    if (!alta.ok) throw new Error('el alta tenía que andar');

    await eliminarPrecio(db, actor, alta.precio.id);

    // Para todas las lecturas, no existe.
    expect(await listarPrecios(db, estudioId)).toHaveLength(0);
    expect((await listaDelEstudio(db, estudioId)).size).toBe(0);

    // Pero la fila sigue, inactiva: el `precio_referencia_eliminado` referencia
    // su id y un rastro colgado de un registro borrado no se puede leer (§7).
    const todas = await filasDe(estudioId);
    expect(todas).toHaveLength(1);
    expect(todas[0].activo).toBe(false);
    expect(todas[0].id).toBe(alta.precio.id);

    expect(await acciones()).toEqual(['precio_referencia_creado', 'precio_referencia_eliminado']);
  });

  it('borrar dos veces no escribe ni audita de nuevo', async () => {
    const alta = await guardarPrecio(db, actor, VENTANA, 'manual');
    if (!alta.ok) throw new Error('el alta tenía que andar');

    await eliminarPrecio(db, actor, alta.precio.id);
    await eliminarPrecio(db, actor, alta.precio.id);

    expect(await acciones()).toEqual(['precio_referencia_creado', 'precio_referencia_eliminado']);
  });

  it('volver a cargar la clave revive LA MISMA fila, no crea una segunda', async () => {
    const alta = await guardarPrecio(db, actor, VENTANA, 'manual');
    if (!alta.ok) throw new Error('el alta tenía que andar');
    await eliminarPrecio(db, actor, alta.precio.id);

    const revivida = await guardarPrecio(db, actor, { ...VENTANA, precio: 160000 }, 'csv');

    expect(revivida.ok).toBe(true);
    if (!revivida.ok) return;
    // El mismo id: la fila volvió con su historia, no nació otra.
    expect(revivida.precio.id).toBe(alta.precio.id);
    expect(revivida.precio.activo).toBe(true);
    expect(revivida.precio.precio).toBe(160000);
    expect(revivida.precio.origen).toBe('csv');

    expect(await filasDe(estudioId)).toHaveLength(1);
    expect(await listarPrecios(db, estudioId)).toHaveLength(1);
  });

  it('revivirla por import también, y cuenta como nueva en el resumen', async () => {
    const { filas } = importarCsvPrecios(
      ['clave_item,descripcion,unidad,precio', 'aberturas.ventana.dvh,Ventana DVH,m2,145000'].join(
        '\n',
      ),
    );
    const primera = await persistirImportPrecios(db, actor, filas, HOY);
    expect(primera.nuevos).toBe(1);

    const [fila] = await filasDe(estudioId);
    await eliminarPrecio(db, actor, fila.id);

    const segunda = await persistirImportPrecios(db, actor, filas, HOY);

    // Para el usuario la clave no estaba y ahora está: es una nueva.
    expect(segunda).toMatchObject({ nuevos: 1, actualizados: 0, sinCambios: 0 });
    expect(await filasDe(estudioId)).toHaveLength(1);
    expect(await listarPrecios(db, estudioId)).toHaveLength(1);
  });

  it('un id de otro estudio no existe (RNF-4)', async () => {
    const alta = await guardarPrecio(db, actorAjeno, VENTANA, 'manual');
    if (!alta.ok) throw new Error('el alta tenía que andar');

    await expect(eliminarPrecio(db, actor, alta.precio.id)).rejects.toBeInstanceOf(
      PrecioNoEncontradoError,
    );
    expect(await filasDe(otroEstudioId)).toHaveLength(1);
  });

  it('con rol de solo lectura no borra', async () => {
    const alta = await guardarPrecio(db, actor, VENTANA, 'manual');
    if (!alta.ok) throw new Error('el alta tenía que andar');

    await expect(eliminarPrecio(db, lector, alta.precio.id)).rejects.toBeInstanceOf(
      RolInsuficienteError,
    );
    expect(await filasDe(estudioId)).toHaveLength(1);
  });
});

describe('persistirImportPrecios', () => {
  const CSV = [
    'clave_item,descripcion,unidad,precio,fecha',
    'aberturas.ventana.dvh,Ventana DVH,m2,145000,2026-08-10',
    'seco.placa.durlock,Placa de durlock,u,"18.500,50",',
    'pintura.latex.interior,Látex interior,l,9800,2026-08-01',
  ].join('\n');

  it('persiste las filas del CSV con su origen y la fecha que le pasan', async () => {
    const { filas, errores } = importarCsvPrecios(CSV);
    expect(errores).toEqual([]);

    const resumen = await persistirImportPrecios(db, actor, filas, HOY);

    expect(resumen.nuevos).toBe(3);
    expect(resumen.actualizados).toBe(0);
    expect(resumen.sinCambios).toBe(0);
    expect(resumen.errores).toEqual([]);

    const guardadas = await listarPrecios(db, estudioId);
    expect(guardadas.map((fila) => fila.claveItem)).toEqual([
      'aberturas.ventana.dvh',
      'pintura.latex.interior',
      'seco.placa.durlock',
    ]);
    expect(guardadas.every((fila) => fila.origen === 'csv')).toBe(true);

    const durlock = guardadas.find((fila) => fila.claveItem === 'seco.placa.durlock');
    expect(durlock?.precio).toBe(18500.5);
    // La fila del CSV no traía fecha: entra con la que pasó la pantalla.
    expect(durlock?.fecha).toBe(HOY);
  });

  it('el mismo CSV dos veces no duplica ni vuelve a escribir', async () => {
    const { filas } = importarCsvPrecios(CSV);
    await persistirImportPrecios(db, actor, filas, HOY);
    const segunda = await persistirImportPrecios(db, actor, filas, HOY);

    expect(segunda.nuevos).toBe(0);
    expect(segunda.actualizados).toBe(0);
    expect(segunda.sinCambios).toBe(3);
    expect(await filasDe(estudioId)).toHaveLength(3);

    // Tres altas + el resumen de cada import. Ninguna edición.
    expect(await acciones()).toEqual([
      'precio_referencia_creado',
      'precio_referencia_creado',
      'precio_referencia_creado',
      'precios_importados',
      'precios_importados',
    ]);
  });

  it('un CSV con un precio nuevo actualiza y lo cuenta como actualizado', async () => {
    const { filas } = importarCsvPrecios(CSV);
    await persistirImportPrecios(db, actor, filas, HOY);

    const { filas: segundas } = importarCsvPrecios(
      ['clave_item,descripcion,unidad,precio', 'aberturas.ventana.dvh,Ventana DVH,m2,160000'].join(
        '\n',
      ),
    );
    const resumen = await persistirImportPrecios(db, actor, segundas, HOY);

    expect(resumen).toMatchObject({ nuevos: 0, actualizados: 1, sinCambios: 0 });
    const [ventana] = await db
      .select()
      .from(preciosReferencia)
      .where(
        and(
          eq(preciosReferencia.estudioId, estudioId),
          eq(preciosReferencia.claveItem, 'aberturas.ventana.dvh'),
        ),
      );
    expect(ventana.precio).toBe(160000);
    expect(ventana.fecha).toBe(HOY);
  });

  it('una fila que rebota contra el schema del dominio sale con su línea, no desaparece', async () => {
    // El parser no capea largos; `zDatosPrecio` sí. La cuenta tiene que cerrar.
    const largo = 'x'.repeat(300);
    const { filas } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        `aberturas.ventana.dvh,${largo},m2,145000`,
        'pintura.latex,Látex,l,9800',
      ].join('\n'),
    );

    const resumen = await persistirImportPrecios(db, actor, filas, HOY);

    expect(resumen.nuevos).toBe(1);
    expect(resumen.errores).toHaveLength(1);
    expect(resumen.errores[0].linea).toBe(2);
    expect(resumen.nuevos + resumen.actualizados + resumen.sinCambios + resumen.errores.length).toBe(
      filas.length,
    );
  });

  it('sin filas no escribe ni audita', async () => {
    const resumen = await persistirImportPrecios(db, actor, [], HOY);

    expect(resumen).toMatchObject({ nuevos: 0, actualizados: 0, sinCambios: 0 });
    expect(await acciones()).toEqual([]);
  });

  it('con rol de solo lectura no importa nada (RF-1201)', async () => {
    const { filas } = importarCsvPrecios(CSV);

    await expect(persistirImportPrecios(db, lector, filas, HOY)).rejects.toBeInstanceOf(
      RolInsuficienteError,
    );
    expect(await filasDe(estudioId)).toHaveLength(0);
  });
});

describe('listaDelEstudio: lo que el recompute le pasa a la cascada', () => {
  it('devuelve el mapa por clave con moneda, unidad y fecha, y solo del estudio', async () => {
    await guardarPrecio(db, actor, VENTANA, 'manual');
    await guardarPrecio(db, actorAjeno, { ...VENTANA, precio: 99000 }, 'manual');

    const lista = await listaDelEstudio(db, estudioId);

    expect(lista.size).toBe(1);
    expect(lista.get('aberturas.ventana.dvh')).toEqual({
      precio: 145000,
      moneda: 'ARS',
      unidad: 'm2',
      fecha: '2026-08-10',
    });

    // La cascada completa, con datos de verdad: sin manual, gana la lista.
    expect(resolverPrecio({ claveItem: 'aberturas.ventana.dvh', unidad: 'm2' }, lista, null)).toEqual(
      {
        unitario: 145000,
        moneda: 'ARS',
        fuente: 'lista',
        fechaPrecio: '2026-08-10',
      },
    );
  });

  it('la unidad guardada es la que la cascada chequea: en `u` el ítem por m² no la usa', async () => {
    await guardarPrecio(db, actor, { ...VENTANA, unidad: 'u' }, 'csv');

    const lista = await listaDelEstudio(db, estudioId);

    expect(lista.get('aberturas.ventana.dvh')?.unidad).toBe('u');
    expect(
      resolverPrecio({ claveItem: 'aberturas.ventana.dvh', unidad: 'm2' }, lista, null),
    ).toBeNull();
  });
});
