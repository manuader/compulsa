import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import { estudios, obras, sesiones, usuarios } from '@/db/schema';
import { hashearPassword, verificarPassword } from '@/lib/auth/password';
import { ObraNoEncontradaError, requireObraCore } from '@/lib/auth/guards';
import {
  borrarSesion,
  crearSesion,
  DURACION_SESION_MS,
  EmailYaRegistradoError,
  leerSesion,
  loginCore,
  registrarEstudioCore,
} from '@/lib/auth/session';
import { createTestDb } from '../helpers/test-db';

let db: Db;

const ALTA = {
  nombreEstudio: 'Estudio Norte',
  nombre: 'Ana Beltrán',
  email: 'ana@estudionorte.ar',
  password: 'durlock1234',
};

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

describe('hash de contraseñas', () => {
  it('nunca guarda la contraseña en claro y valida contra su hash', async () => {
    const hash = await hashearPassword('durlock1234');

    expect(hash).not.toContain('durlock1234');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verificarPassword('durlock1234', hash)).toBe(true);
    expect(await verificarPassword('durlock1235', hash)).toBe(false);
    expect(await verificarPassword('', hash)).toBe(false);
  });

  it('usa un salt distinto por hash', async () => {
    const a = await hashearPassword('durlock1234');
    const b = await hashearPassword('durlock1234');

    expect(a).not.toBe(b);
    expect(await verificarPassword('durlock1234', a)).toBe(true);
    expect(await verificarPassword('durlock1234', b)).toBe(true);
  });

  it('devuelve false ante un hash corrupto en vez de explotar', async () => {
    expect(await verificarPassword('durlock1234', 'basura')).toBe(false);
    expect(await verificarPassword('durlock1234', 'scrypt$16384$8$1$zz$zz')).toBe(false);
  });
});

describe('registro de estudio', () => {
  it('crea estudio, usuario titular y sesión válida', async () => {
    const alta = await registrarEstudioCore(db, ALTA);

    expect(alta.sesion.estudio.nombre).toBe('Estudio Norte');
    expect(alta.sesion.usuario.nombre).toBe('Ana Beltrán');
    expect(alta.sesion.usuario.email).toBe('ana@estudionorte.ar');
    expect(alta.sesion.usuario.rol).toBe('titular');
    expect(alta.sesion.usuario.estudioId).toBe(alta.sesion.estudio.id);
    expect(alta.token).toHaveLength(64);

    const [guardado] = await db
      .select()
      .from(usuarios)
      .where(eq(usuarios.id, alta.sesion.usuario.id));
    expect(guardado.passwordHash).not.toContain(ALTA.password);
    expect(await verificarPassword(ALTA.password, guardado.passwordHash)).toBe(true);

    const sesion = await leerSesion(db, alta.token);
    expect(sesion?.usuario.id).toBe(alta.sesion.usuario.id);
    expect(sesion?.estudio.id).toBe(alta.sesion.estudio.id);
  });

  it('la sesión dura 30 días', async () => {
    expect(DURACION_SESION_MS).toBe(2_592_000_000);

    const antes = Date.now();
    const { token } = await registrarEstudioCore(db, ALTA);
    const [fila] = await db.select().from(sesiones).where(eq(sesiones.token, token));

    const duracion = fila.expiraAt.getTime() - antes;
    expect(duracion).toBeGreaterThan(DURACION_SESION_MS - 60_000);
    expect(duracion).toBeLessThanOrEqual(DURACION_SESION_MS + 60_000);
  });

  it('normaliza el mail (minúsculas y sin espacios)', async () => {
    const alta = await registrarEstudioCore(db, { ...ALTA, email: '  Ana@EstudioNorte.AR ' });
    expect(alta.sesion.usuario.email).toBe('ana@estudionorte.ar');

    const sesion = await loginCore(db, { email: 'ANA@estudionorte.ar', password: ALTA.password });
    expect(sesion).not.toBeNull();
  });

  it('rechaza un mail ya registrado sin crear nada', async () => {
    await registrarEstudioCore(db, ALTA);

    await expect(
      registrarEstudioCore(db, { ...ALTA, nombreEstudio: 'Estudio Sur' }),
    ).rejects.toBeInstanceOf(EmailYaRegistradoError);

    expect(await db.select().from(usuarios)).toHaveLength(1);
    expect(await db.select().from(estudios)).toHaveLength(1);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await registrarEstudioCore(db, ALTA);
  });

  it('con la contraseña correcta devuelve la sesión', async () => {
    const alta = await loginCore(db, { email: ALTA.email, password: ALTA.password });

    expect(alta).not.toBeNull();
    expect(alta?.sesion.usuario.email).toBe('ana@estudionorte.ar');
    expect(await leerSesion(db, alta!.token)).not.toBeNull();
  });

  it('con la contraseña errónea devuelve null y no abre sesión', async () => {
    const alta = await loginCore(db, { email: ALTA.email, password: 'durlock1235' });

    expect(alta).toBeNull();
    expect(await db.select().from(sesiones)).toHaveLength(1); // solo la del registro
  });

  it('con un mail inexistente devuelve null', async () => {
    expect(await loginCore(db, { email: 'beto@otro.ar', password: ALTA.password })).toBeNull();
  });
});

describe('vigencia de la sesión', () => {
  it('una sesión expirada no vale', async () => {
    const { token } = await registrarEstudioCore(db, ALTA);
    expect(await leerSesion(db, token)).not.toBeNull();

    await db
      .update(sesiones)
      .set({ expiraAt: new Date(Date.now() - 1_000) })
      .where(eq(sesiones.token, token));

    expect(await leerSesion(db, token)).toBeNull();
  });

  it('un token inexistente no vale', async () => {
    await registrarEstudioCore(db, ALTA);
    expect(await leerSesion(db, 'a'.repeat(64))).toBeNull();
  });

  it('cerrar sesión invalida el token', async () => {
    const { token } = await registrarEstudioCore(db, ALTA);

    await borrarSesion(db, token);

    expect(await leerSesion(db, token)).toBeNull();
    expect(await db.select().from(sesiones)).toHaveLength(0);
  });

  it('crearSesion emite tokens distintos para el mismo usuario', async () => {
    const { sesion } = await registrarEstudioCore(db, ALTA);

    const a = await crearSesion(db, sesion.usuario.id);
    const b = await crearSesion(db, sesion.usuario.id);

    expect(a.token).not.toBe(b.token);
    expect(await leerSesion(db, a.token)).not.toBeNull();
    expect(await leerSesion(db, b.token)).not.toBeNull();
  });
});

describe('requireObra: aislamiento entre estudios (RNF-4)', () => {
  it('devuelve la obra del propio estudio', async () => {
    const { sesion } = await registrarEstudioCore(db, ALTA);
    const [obra] = await db
      .insert(obras)
      .values({
        estudioId: sesion.estudio.id,
        nombre: 'Casa Belgrano',
        zona: 'CABA',
        tipo: 'reforma',
      })
      .returning();

    const encontrada = await requireObraCore(db, sesion.estudio.id, obra.id);
    expect(encontrada.id).toBe(obra.id);
    expect(encontrada.nombre).toBe('Casa Belgrano');
  });

  it('lanza ObraNoEncontradaError con una obra de otro estudio', async () => {
    const propio = await registrarEstudioCore(db, ALTA);
    const ajeno = await registrarEstudioCore(db, {
      nombreEstudio: 'Estudio Sur',
      nombre: 'Beto Ruiz',
      email: 'beto@estudiosur.ar',
      password: 'corralon1234',
    });

    const [obraAjena] = await db
      .insert(obras)
      .values({
        estudioId: ajeno.sesion.estudio.id,
        nombre: 'Casa Núñez',
        zona: 'CABA',
        tipo: 'nueva',
      })
      .returning();

    await expect(
      requireObraCore(db, propio.sesion.estudio.id, obraAjena.id),
    ).rejects.toBeInstanceOf(ObraNoEncontradaError);
  });

  it('lanza ObraNoEncontradaError con un id que no existe', async () => {
    const { sesion } = await registrarEstudioCore(db, ALTA);

    await expect(
      requireObraCore(db, sesion.estudio.id, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(ObraNoEncontradaError);
  });
});
