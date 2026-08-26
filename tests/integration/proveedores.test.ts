/**
 * Agenda de proveedores del estudio (RF-801/802).
 *
 * Se testean los **núcleos** de `@/lib/proveedores/gestion` (no los envoltorios
 * `*Action`, que solo agregan `requireUser()` y `revalidatePath()`): lo que hay
 * que proteger es qué queda escrito en la base, para qué estudio, y con qué
 * rastro.
 *
 * Las cuatro cosas que estos tests cuidan:
 *
 *  1. **Aislamiento (RNF-4):** la agenda es del estudio. Un `proveedorId` de
 *     otro estudio no es un 403, es un "no existe".
 *  2. **Compliance §13:** el `opt_out` es permanente, apaga el opt-in y saca al
 *     proveedor de toda shortlist. No hay función que lo revierta.
 *  3. **El import no duplica:** dedup por nombre normalizado (sin tildes, en
 *     minúsculas), con merge de rubros y de contactos.
 *  4. **Todo lo que muta, audita** (CLAUDE.md §4), y el rol se chequea en el
 *     core y no solo en la UI (RF-1201).
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import { auditoria, estudios, proveedores, usuarios, type Proveedor } from '@/db/schema';
import {
  ProveedorNoContactableError,
  ProveedorNoEncontradoError,
  RolInsuficienteError,
  crearProveedor,
  editarProveedor,
  listarProveedores,
  marcarOptIn,
  marcarOptOut,
  persistirImport,
  type ActorProveedor,
} from '@/lib/proveedores/gestion';
import { importarCsv } from '@/lib/proveedores/import-csv';
import { armarShortlist } from '@/lib/proveedores/shortlist';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let estudioId: string;
let otroEstudioId: string;
let actor: ActorProveedor;
let actorAjeno: ActorProveedor;
let lector: ActorProveedor;

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio, otro] = await db
    .insert(estudios)
    .values([{ nombre: 'Estudio Norte' }, { nombre: 'Estudio Sur' }])
    .returning();
  estudioId = estudio.id;
  otroEstudioId = otro.id;

  const [titular, colaboradorAjeno, lectura] = await db
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
        email: 'arq@estudiosur.ar',
        nombre: 'Sur',
        passwordHash: 'x',
        rol: 'colaborador',
      },
      {
        estudioId: estudio.id,
        email: 'pasante@estudionorte.ar',
        nombre: 'Pasante',
        passwordHash: 'x',
        rol: 'lectura',
      },
    ])
    .returning();

  actor = { usuarioId: titular.id, email: titular.email, rol: 'titular' };
  actorAjeno = { usuarioId: colaboradorAjeno.id, email: colaboradorAjeno.email, rol: 'colaborador' };
  lector = { usuarioId: lectura.id, email: lectura.email, rol: 'lectura' };
});

/** Alta directa para armar escenarios; devuelve la fila. */
async function alta(
  datos: { nombre: string; rubros?: ('aberturas' | 'seco' | 'pintura' | 'gruesa')[]; zona?: string },
  destino = estudioId,
): Promise<Proveedor> {
  const resultado = await crearProveedor(
    db,
    destino,
    { rubros: ['aberturas'], zona: 'CABA', ...datos },
    destino === estudioId ? actor : actorAjeno,
  );
  if (!resultado.ok) throw new Error(`No se pudo crear: ${JSON.stringify(resultado.errores)}`);
  return resultado.proveedor;
}

function auditoriaDe(accion: string) {
  return db.select().from(auditoria).where(eq(auditoria.accion, accion));
}

// ---------------------------------------------------------------------------

describe('alta y listado', () => {
  it('crea el proveedor con sus contactos y lo audita', async () => {
    const resultado = await crearProveedor(
      db,
      estudioId,
      {
        nombre: 'Corralón del Norte',
        rubros: ['gruesa', 'seco'],
        zona: 'San Isidro',
        telefono: '11-4444-5555',
        email: 'ventas@corralon.ar',
      },
      actor,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.proveedor.nombre).toBe('Corralón del Norte');
    expect(resultado.proveedor.rubros).toEqual(['gruesa', 'seco']);
    expect(resultado.proveedor.contactosJson).toEqual({
      telefono: '11-4444-5555',
      email: 'ventas@corralon.ar',
    });
    // Alta a mano: sin consentimiento hasta que alguien lo registre (§13).
    expect(resultado.proveedor.optInWa).toBe(false);
    expect(resultado.proveedor.optInRegistradoEn).toBeNull();
    expect(resultado.proveedor.optOut).toBe(false);
    expect(resultado.proveedor.origen).toBe('manual');

    const auditadas = await auditoriaDe('proveedor_creado');
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0].actorNombre).toBe('arq@estudionorte.ar');
    expect(auditadas[0].targetRef).toBe(`proveedores:${resultado.proveedor.id}`);
    expect(auditadas[0].diffJson).toMatchObject({ nombre: 'Corralón del Norte', zona: 'San Isidro' });
  });

  it('rechaza el alta sin nombre y sin rubros, con un mensaje por campo', async () => {
    const resultado = await crearProveedor(
      db,
      estudioId,
      { nombre: '   ', rubros: [], zona: 'CABA' },
      actor,
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(Object.keys(resultado.errores).sort()).toEqual(['nombre', 'rubros']);
    expect(await db.select().from(proveedores)).toHaveLength(0);
    expect(await auditoriaDe('proveedor_creado')).toHaveLength(0);
  });

  it('lista solo los del estudio, ordenados por nombre', async () => {
    await alta({ nombre: 'Zingueria Oeste' });
    await alta({ nombre: 'Aberturas Sur' });
    await alta({ nombre: 'Ajeno S.A.' }, otroEstudioId);

    const lista = await listarProveedores(db, estudioId);
    expect(lista.map((p) => p.nombre)).toEqual(['Aberturas Sur', 'Zingueria Oeste']);

    const ajena = await listarProveedores(db, otroEstudioId);
    expect(ajena.map((p) => p.nombre)).toEqual(['Ajeno S.A.']);
  });

  it('filtra por rubro y por zona (la zona matchea normalizada)', async () => {
    await alta({ nombre: 'Pinturería Central', rubros: ['pintura'], zona: 'CABA' });
    await alta({ nombre: 'Corralón Pilar', rubros: ['gruesa', 'seco'], zona: 'Pilar' });
    await alta({ nombre: 'Seco Caba', rubros: ['seco'], zona: 'caba' });

    expect((await listarProveedores(db, estudioId, { rubro: 'seco' })).map((p) => p.nombre)).toEqual([
      'Corralón Pilar',
      'Seco Caba',
    ]);
    expect((await listarProveedores(db, estudioId, { zona: ' CABA ' })).map((p) => p.nombre)).toEqual(
      ['Pinturería Central', 'Seco Caba'],
    );
    expect(
      (await listarProveedores(db, estudioId, { rubro: 'seco', zona: 'caba' })).map((p) => p.nombre),
    ).toEqual(['Seco Caba']);
  });
});

describe('aislamiento entre estudios (RNF-4)', () => {
  it('editar un proveedor de otro estudio es un «no existe», no un 403', async () => {
    const ajeno = await alta({ nombre: 'Ajeno S.A.' }, otroEstudioId);

    await expect(
      editarProveedor(db, estudioId, ajeno.id, { zona: 'Robada' }, actor),
    ).rejects.toBeInstanceOf(ProveedorNoEncontradoError);

    const [sinTocar] = await db.select().from(proveedores).where(eq(proveedores.id, ajeno.id));
    expect(sinTocar.zona).toBe('CABA');
  });

  it('el opt-in y el opt-out tampoco cruzan de estudio', async () => {
    const ajeno = await alta({ nombre: 'Ajeno S.A.' }, otroEstudioId);

    await expect(marcarOptIn(db, estudioId, ajeno.id, 'whatsapp', actor)).rejects.toBeInstanceOf(
      ProveedorNoEncontradoError,
    );
    await expect(marcarOptOut(db, estudioId, ajeno.id, actor)).rejects.toBeInstanceOf(
      ProveedorNoEncontradoError,
    );

    const [sinTocar] = await db.select().from(proveedores).where(eq(proveedores.id, ajeno.id));
    expect(sinTocar.optInWa).toBe(false);
    expect(sinTocar.optOut).toBe(false);
  });

  it('un id que no tiene forma de uuid es un «no existe» y no un error del driver', async () => {
    await expect(marcarOptOut(db, estudioId, 'no-es-uuid', actor)).rejects.toBeInstanceOf(
      ProveedorNoEncontradoError,
    );
  });
});

describe('edición', () => {
  it('audita solo lo que cambió, con antes y después', async () => {
    const proveedor = await alta({ nombre: 'Corralón del Norte', zona: 'San Isidro' });

    const resultado = await editarProveedor(
      db,
      estudioId,
      proveedor.id,
      { nombre: 'Corralón del Norte', zona: 'Pilar', rubros: ['gruesa'], telefono: '11-9999' },
      actor,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.proveedor.zona).toBe('Pilar');
    expect(resultado.proveedor.contactosJson).toEqual({ telefono: '11-9999' });
    expect(Object.keys(resultado.cambios).sort()).toEqual(['contactos', 'rubros', 'zona']);

    const [auditada] = await auditoriaDe('proveedor_editado');
    expect(auditada.diffJson).toMatchObject({
      zona: { antes: 'San Isidro', despues: 'Pilar' },
      rubros: { antes: ['aberturas'], despues: ['gruesa'] },
    });
  });

  it('guardar sin cambios no escribe ni audita', async () => {
    const proveedor = await alta({ nombre: 'Corralón del Norte', zona: 'San Isidro' });

    const resultado = await editarProveedor(
      db,
      estudioId,
      proveedor.id,
      { nombre: 'Corralón del Norte', zona: 'San Isidro', rubros: ['aberturas'] },
      actor,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.cambios).toEqual({});
    expect(await auditoriaDe('proveedor_editado')).toHaveLength(0);
  });
});

describe('consentimiento de WhatsApp (PRD §13)', () => {
  it('el opt-in fecha el consentimiento y lo audita', async () => {
    const proveedor = await alta({ nombre: 'Corralón del Norte' });
    const antes = Date.now();

    const conOptIn = await marcarOptIn(db, estudioId, proveedor.id, 'whatsapp', actor);

    expect(conOptIn.optInWa).toBe(true);
    expect(conOptIn.optInRegistradoEn).toBeInstanceOf(Date);
    expect(conOptIn.optInRegistradoEn!.getTime()).toBeGreaterThanOrEqual(antes - 1000);

    const auditadas = await auditoriaDe('proveedor_opt_in');
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0].diffJson).toMatchObject({ canal: 'whatsapp' });
  });

  it('marcar dos veces el opt-in no vuelve a fechar el consentimiento', async () => {
    const proveedor = await alta({ nombre: 'Corralón del Norte' });
    const primera = await marcarOptIn(db, estudioId, proveedor.id, 'whatsapp', actor);
    const segunda = await marcarOptIn(db, estudioId, proveedor.id, 'whatsapp', actor);

    expect(segunda.optInRegistradoEn!.getTime()).toBe(primera.optInRegistradoEn!.getTime());
    expect(await auditoriaDe('proveedor_opt_in')).toHaveLength(1);
  });

  it('el opt-out apaga el opt-in: cualquier chequeo ingenuo falla cerrado', async () => {
    const proveedor = await alta({ nombre: 'Corralón del Norte' });
    await marcarOptIn(db, estudioId, proveedor.id, 'whatsapp', actor);

    const cortado = await marcarOptOut(db, estudioId, proveedor.id, actor);

    expect(cortado.optOut).toBe(true);
    expect(cortado.optInWa).toBe(false);
    // La fecha del consentimiento original NO se borra: es el registro de que
    // alguna vez lo dio, y la auditoría necesita que siga existiendo.
    expect(cortado.optInRegistradoEn).toBeInstanceOf(Date);

    const [auditada] = await auditoriaDe('proveedor_opt_out');
    expect(auditada.diffJson).toMatchObject({
      optOut: { antes: false, despues: true },
      optInWa: { antes: true, despues: false },
    });
  });

  it('el opt-out es permanente: no se puede volver a marcar el opt-in', async () => {
    const proveedor = await alta({ nombre: 'Corralón del Norte' });
    await marcarOptOut(db, estudioId, proveedor.id, actor);

    await expect(
      marcarOptIn(db, estudioId, proveedor.id, 'whatsapp', actor),
    ).rejects.toBeInstanceOf(ProveedorNoContactableError);

    const [sinTocar] = await db.select().from(proveedores).where(eq(proveedores.id, proveedor.id));
    expect(sinTocar.optInWa).toBe(false);
    expect(sinTocar.optOut).toBe(true);
  });

  it('un proveedor con opt_out no entra a la shortlist aunque sea el mejor de la agenda', async () => {
    const estrella = await alta({ nombre: 'Aberturas Estrella' });
    const comun = await alta({ nombre: 'Aberturas Común' });
    await marcarOptIn(db, estudioId, estrella.id, 'whatsapp', actor);
    await db.update(proveedores).set({ score: 1 }).where(eq(proveedores.id, estrella.id));

    const conEstrella = armarShortlist(
      await listarProveedores(db, estudioId),
      'aberturas',
      'CABA',
      new Map([[estrella.id, 5]]),
    );
    expect(conEstrella.map((r) => r.proveedor.id)).toEqual([estrella.id, comun.id]);

    await marcarOptOut(db, estudioId, estrella.id, actor);

    const sinEstrella = armarShortlist(
      await listarProveedores(db, estudioId),
      'aberturas',
      'CABA',
      new Map([[estrella.id, 5]]),
    );
    expect(sinEstrella.map((r) => r.proveedor.id)).toEqual([comun.id]);
  });
});

describe('import desde CSV', () => {
  const CSV = [
    'nombre,rubros,zona,telefono,email',
    'Corralón del Norte,gruesa,San Isidro,11-4444-5555,ventas@corralon.ar',
    'Aberturas Sur,aberturas,Quilmes,,info@sur.ar',
  ].join('\n');

  it('persiste las filas nuevas con origen agenda y deja una auditoría por proveedor', async () => {
    const { filas, errores } = importarCsv(CSV);
    expect(errores).toEqual([]);

    const resumen = await persistirImport(db, estudioId, filas, actor);

    expect(resumen).toMatchObject({ nuevos: 2, actualizados: 0, sinCambios: 0 });
    const lista = await listarProveedores(db, estudioId);
    expect(lista.map((p) => p.nombre)).toEqual(['Aberturas Sur', 'Corralón del Norte']);
    expect(lista.every((p) => p.origen === 'agenda')).toBe(true);
    expect(await auditoriaDe('proveedor_creado')).toHaveLength(2);

    const [resumida] = await auditoriaDe('proveedores_importados');
    expect(resumida.diffJson).toMatchObject({ nuevos: 2, actualizados: 0, filas: 2 });
  });

  it('deduplica por nombre normalizado y mergea rubros y contactos', async () => {
    await crearProveedor(
      db,
      estudioId,
      {
        nombre: 'Corralón del Norte',
        rubros: ['seco'],
        zona: 'San Isidro',
        telefono: '11-1111-1111',
      },
      actor,
    );

    const { filas } = importarCsv(
      [
        'nombre,rubros,zona,telefono,email',
        '  CORRALON  DEL NORTE ,gruesa|seco,Pilar,11-9999-9999,ventas@corralon.ar',
      ].join('\n'),
    );
    const resumen = await persistirImport(db, estudioId, filas, actor);

    expect(resumen).toMatchObject({ nuevos: 0, actualizados: 1 });

    const lista = await listarProveedores(db, estudioId);
    expect(lista).toHaveLength(1);
    // Rubros unidos, sin duplicar 'seco'.
    expect(lista[0].rubros).toEqual(['seco', 'gruesa']);
    // El mail nuevo entra porque no había; el teléfono de la agenda NO se pisa.
    expect(lista[0].contactosJson).toEqual({
      telefono: '11-1111-1111',
      email: 'ventas@corralon.ar',
    });
    // Ni la zona ni el nombre cargados a mano se pisan con los del CSV.
    expect(lista[0].nombre).toBe('Corralón del Norte');
    expect(lista[0].zona).toBe('San Isidro');
  });

  it('dos líneas del mismo archivo que son el mismo proveedor entran una sola vez', async () => {
    const { filas } = importarCsv(
      [
        'nombre,rubros,zona,telefono,email',
        'Corralón del Norte,gruesa,San Isidro,,',
        'corralon del norte,pintura,San Isidro,11-2222,',
      ].join('\n'),
    );

    const resumen = await persistirImport(db, estudioId, filas, actor);

    expect(resumen).toMatchObject({ nuevos: 1, actualizados: 1 });
    const lista = await listarProveedores(db, estudioId);
    expect(lista).toHaveLength(1);
    expect(lista[0].rubros).toEqual(['gruesa', 'pintura']);
    expect(lista[0].contactosJson).toEqual({ telefono: '11-2222' });
  });

  it('reimportar el mismo archivo no cambia nada y lo dice', async () => {
    const { filas } = importarCsv(CSV);
    await persistirImport(db, estudioId, filas, actor);
    const segunda = await persistirImport(db, estudioId, filas, actor);

    expect(segunda).toMatchObject({ nuevos: 0, actualizados: 0, sinCambios: 2 });
    expect(await listarProveedores(db, estudioId)).toHaveLength(2);
    expect(await auditoriaDe('proveedor_editado')).toHaveLength(0);
  });

  it('el dedup no cruza estudios: el mismo corralón puede estar en los dos', async () => {
    await alta({ nombre: 'Corralón del Norte' }, otroEstudioId);

    const { filas } = importarCsv(CSV);
    const resumen = await persistirImport(db, estudioId, filas, actor);

    expect(resumen.nuevos).toBe(2);
    expect(await listarProveedores(db, estudioId)).toHaveLength(2);
    expect(await listarProveedores(db, otroEstudioId)).toHaveLength(1);
  });

  it('un import de cero filas no audita nada', async () => {
    const resumen = await persistirImport(db, estudioId, [], actor);
    expect(resumen).toMatchObject({ nuevos: 0, actualizados: 0, sinCambios: 0 });
    expect(await auditoriaDe('proveedores_importados')).toHaveLength(0);
  });
});

describe('roles (RF-1201)', () => {
  it('lectura no crea, no edita, no marca consentimiento y no importa', async () => {
    const proveedor = await alta({ nombre: 'Corralón del Norte' });

    await expect(
      crearProveedor(db, estudioId, { nombre: 'X', rubros: ['seco'], zona: 'CABA' }, lector),
    ).rejects.toBeInstanceOf(RolInsuficienteError);
    await expect(
      editarProveedor(db, estudioId, proveedor.id, { zona: 'Pilar' }, lector),
    ).rejects.toBeInstanceOf(RolInsuficienteError);
    await expect(
      marcarOptIn(db, estudioId, proveedor.id, 'whatsapp', lector),
    ).rejects.toBeInstanceOf(RolInsuficienteError);
    await expect(marcarOptOut(db, estudioId, proveedor.id, lector)).rejects.toBeInstanceOf(
      RolInsuficienteError,
    );
    await expect(
      persistirImport(db, estudioId, importarCsv('nombre,rubros,zona\nX,seco,CABA').filas, lector),
    ).rejects.toBeInstanceOf(RolInsuficienteError);

    expect(await listarProveedores(db, estudioId)).toHaveLength(1);
  });

  it('lectura sí puede ver la agenda', async () => {
    await alta({ nombre: 'Corralón del Norte' });
    expect(await listarProveedores(db, estudioId)).toHaveLength(1);
  });

  it('colaborador gestiona la agenda entera', async () => {
    const colaborador: ActorProveedor = { ...actor, rol: 'colaborador' };

    const creado = await crearProveedor(
      db,
      estudioId,
      { nombre: 'Corralón del Norte', rubros: ['gruesa'], zona: 'CABA' },
      colaborador,
    );
    expect(creado.ok).toBe(true);
    if (!creado.ok) return;

    await expect(
      marcarOptIn(db, estudioId, creado.proveedor.id, 'whatsapp', colaborador),
    ).resolves.toMatchObject({ optInWa: true });
  });
});
