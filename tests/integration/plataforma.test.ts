/**
 * Plataforma del estudio (F4): invitaciones, gestión de usuarios, configuración,
 * checklists editables y notificaciones.
 *
 * Se testean los **núcleos** de `src/lib/plataforma/*` —reciben la base y el
 * actor explícitos— y no los envoltorios `*Action`, que solo agregan la sesión y
 * la revalidación. Lo que hay que proteger acá son cinco invariantes:
 *
 *  1. Una invitación se usa **una sola vez** y vence a los 7 días.
 *  2. Aceptarla suma al usuario al estudio que la emitió, con el rol de la
 *     invitación — nunca crea un estudio nuevo.
 *  3. El estudio no se puede quedar sin titular activo.
 *  4. La configuración se **mergea**: guardar los pesos no borra los desperdicios.
 *  5. Un checklist desactivado deja de frenar la aprobación del rubro.
 */
import { readFile } from 'node:fs/promises';

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  checklistsEstudio,
  computoItems,
  documentos,
  entidades,
  estudios,
  invitaciones,
  laminas,
  notificaciones,
  obras,
  sesiones,
  usuarios,
} from '@/db/schema';
import { crearSesion, leerSesion, loginCore, registrarEstudioCore } from '@/lib/auth/session';
import {
  archivarObra,
  editarObra,
  eliminarDocumento,
  eliminarObra,
} from '@/lib/obras/gestion';
import {
  CHECKLIST_DEFAULT,
  checklistEfectivo,
  checklistEfectivoDeTodos,
  ajustarHallazgosAlChecklist,
  contarBloqueantes,
  guardarItemChecklist,
  listarChecklist,
} from '@/lib/plataforma/checklists';
import { guardarConfig, leerConfig } from '@/lib/plataforma/config-estudio';
import {
  contarNoLeidas,
  crearNotificacion,
  listarNotificaciones,
  marcarLeida,
  marcarTodasLeidas,
} from '@/lib/plataforma/notificaciones';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import { RolInsuficienteError, UsuarioInactivoError } from '@/lib/plataforma/roles';
import {
  aceptarInvitacionCore,
  cambiarActivoUsuario,
  cambiarRolUsuario,
  crearInvitacion,
  DIAS_INVITACION,
  generarCodigoInvitacion,
  InvitacionInvalidaError,
  listarInvitaciones,
  listarUsuarios,
  UltimoTitularError,
  type ActorPlataforma,
} from '@/lib/plataforma/usuarios';
import type { StorageAdapter } from '@/lib/storage/index';
import { RUBROS } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let estudioId: string;
let titular: ActorPlataforma;
let otroEstudioId: string;

const ALTA = {
  nombreEstudio: 'Estudio Norte',
  nombre: 'Ana Beltrán',
  email: 'ana@estudionorte.ar',
  password: 'durlock1234',
};

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const alta = await registrarEstudioCore(db, ALTA);
  estudioId = alta.sesion.estudio.id;
  titular = {
    usuarioId: alta.sesion.usuario.id,
    email: alta.sesion.usuario.email,
    estudioId,
    rol: 'titular',
    activo: true,
  };

  const ajeno = await registrarEstudioCore(db, {
    nombreEstudio: 'Estudio Sur',
    nombre: 'Beto Sur',
    email: 'beto@estudiosur.ar',
    password: 'durlock1234',
  });
  otroEstudioId = ajeno.sesion.estudio.id;
});

/** Un actor con otro rol sobre el mismo estudio, sin tocar la base. */
function comoRol(rol: ActorPlataforma['rol'], activo = true): ActorPlataforma {
  return { ...titular, rol, activo };
}

async function acciones(): Promise<string[]> {
  const filas = await db.select({ accion: auditoria.accion }).from(auditoria);
  return filas.map((fila) => fila.accion);
}

// ---------------------------------------------------------------------------
// Invitaciones
// ---------------------------------------------------------------------------

describe('códigos de invitación', () => {
  it('son de 8 caracteres, legibles y sin los que se confunden a mano', () => {
    const codigos = Array.from({ length: 200 }, () => generarCodigoInvitacion());

    for (const codigo of codigos) {
      expect(codigo).toHaveLength(8);
      expect(codigo).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
    // Sin O/0, I/1, L: un código dictado por teléfono no se puede tipear mal.
    expect(codigos.join('')).not.toMatch(/[O0I1L]/);
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});

describe('invitación end-to-end', () => {
  it('crear → registrarse con el código → el usuario queda en el estudio con ese rol', async () => {
    const invitacion = await crearInvitacion(db, titular, 'colaborador');

    expect(invitacion.estudioId).toBe(estudioId);
    expect(invitacion.rol).toBe('colaborador');
    expect(invitacion.usadaPor).toBeNull();
    const dias = (invitacion.expiraAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(Math.round(dias)).toBe(DIAS_INVITACION);

    const alta = await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });

    expect(alta.sesion.estudio.id).toBe(estudioId);
    expect(alta.sesion.usuario.rol).toBe('colaborador');
    expect(alta.sesion.usuario.activo).toBe(true);
    expect(alta.token).toHaveLength(64);

    // No se creó ningún estudio nuevo: siguen siendo los dos del setup.
    expect(await db.select().from(estudios)).toHaveLength(2);

    const [quemada] = await db
      .select()
      .from(invitaciones)
      .where(eq(invitaciones.codigo, invitacion.codigo));
    expect(quemada.usadaPor).toBe(alta.sesion.usuario.id);
  });

  it('el código admite minúsculas y espacios al tipearlo', async () => {
    const invitacion = await crearInvitacion(db, titular, 'lectura');

    const alta = await aceptarInvitacionCore(db, {
      codigo: `  ${invitacion.codigo.toLowerCase()} `,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });

    expect(alta.sesion.usuario.rol).toBe('lectura');
  });

  it('reusar un código ya usado falla, y no crea un segundo usuario', async () => {
    const invitacion = await crearInvitacion(db, titular, 'colaborador');
    await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });

    await expect(
      aceptarInvitacionCore(db, {
        codigo: invitacion.codigo,
        nombre: 'Dani Ruiz',
        email: 'dani@estudionorte.ar',
        password: 'durlock1234',
      }),
    ).rejects.toThrow(InvitacionInvalidaError);

    const filas = await db.select().from(usuarios).where(eq(usuarios.estudioId, estudioId));
    expect(filas.map((f) => f.email).sort()).toEqual(['ana@estudionorte.ar', 'caro@estudionorte.ar']);
  });

  it('una invitación vencida falla, y el motivo queda tipado aunque el mensaje no lo diga', async () => {
    const invitacion = await crearInvitacion(db, titular, 'colaborador');
    await db
      .update(invitaciones)
      .set({ expiraAt: new Date(Date.now() - 1000) })
      .where(eq(invitaciones.codigo, invitacion.codigo));

    const error = await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvitacionInvalidaError);
    expect((error as InvitacionInvalidaError).motivo).toBe('vencida');
    // El mensaje NO dice cuál de los tres motivos fue: decirlo le contaría a
    // cualquiera qué códigos existen (ver el test siguiente).
    expect((error as Error).message).toContain('Pedile uno nuevo al titular');

    expect(await db.select().from(usuarios).where(eq(usuarios.estudioId, estudioId))).toHaveLength(1);
  });

  it('un código inventado falla igual que uno usado: no se filtra si existe', async () => {
    const invitacion = await crearInvitacion(db, titular, 'colaborador');
    await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });

    let usado: string | undefined;
    let inventado: string | undefined;
    await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'X',
      email: 'x@estudionorte.ar',
      password: 'durlock1234',
    }).catch((error: Error) => {
      usado = error.message;
    });
    await aceptarInvitacionCore(db, {
      codigo: 'ZZZZZZZZ',
      nombre: 'X',
      email: 'x@estudionorte.ar',
      password: 'durlock1234',
    }).catch((error: Error) => {
      inventado = error.message;
    });

    expect(usado).toBe(inventado);
  });

  it('solo el titular crea invitaciones', async () => {
    await expect(crearInvitacion(db, comoRol('colaborador'), 'lectura')).rejects.toThrow(
      RolInsuficienteError,
    );
    await expect(crearInvitacion(db, comoRol('lectura'), 'lectura')).rejects.toThrow(
      RolInsuficienteError,
    );
    await expect(crearInvitacion(db, comoRol('titular', false), 'lectura')).rejects.toThrow(
      /desactivado/,
    );
  });

  it('queda auditada al crearse y al usarse, y notifica a los titulares', async () => {
    const invitacion = await crearInvitacion(db, titular, 'colaborador');
    await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });

    expect(await acciones()).toContain('invitacion_creada');
    expect(await acciones()).toContain('invitacion_usada');

    const avisos = await listarNotificaciones(db, titular.usuarioId);
    expect(avisos).toHaveLength(1);
    expect(avisos[0].titulo).toBe('Se sumó alguien al estudio');
    expect(avisos[0].cuerpo).toContain('Caro Díaz');
    expect(avisos[0].cuerpo).toContain('colaborador');
    expect(avisos[0].link).toBe('/estudio/usuarios');
  });

  it('lista las invitaciones del estudio y no las de otro', async () => {
    await crearInvitacion(db, titular, 'colaborador');
    await crearInvitacion(db, titular, 'lectura');

    const lista = await listarInvitaciones(db, estudioId);
    expect(lista.map((i) => i.rol).sort()).toEqual(['colaborador', 'lectura']);
    expect(await listarInvitaciones(db, otroEstudioId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gestión de usuarios
// ---------------------------------------------------------------------------

describe('gestión de usuarios', () => {
  async function sumarColaborador(email = 'caro@estudionorte.ar'): Promise<string> {
    const invitacion = await crearInvitacion(db, titular, 'colaborador');
    const alta = await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email,
      password: 'durlock1234',
    });
    return alta.sesion.usuario.id;
  }

  it('lista los usuarios del estudio, nunca los de otro', async () => {
    await sumarColaborador();
    const lista = await listarUsuarios(db, estudioId);

    expect(lista.map((u) => u.email)).toEqual(['ana@estudionorte.ar', 'caro@estudionorte.ar']);
    expect(lista.every((u) => 'passwordHash' in u)).toBe(false);
  });

  it('el titular cambia el rol de otro y queda auditado', async () => {
    const caroId = await sumarColaborador();

    await cambiarRolUsuario(db, titular, caroId, 'titular');

    const [caro] = await db.select().from(usuarios).where(eq(usuarios.id, caroId));
    expect(caro.rol).toBe('titular');
    expect(await acciones()).toContain('usuario_rol_cambiado');
  });

  it('un colaborador no puede cambiar roles ni desactivar', async () => {
    const caroId = await sumarColaborador();

    await expect(cambiarRolUsuario(db, comoRol('colaborador'), caroId, 'lectura')).rejects.toThrow(
      RolInsuficienteError,
    );
    await expect(cambiarActivoUsuario(db, comoRol('colaborador'), caroId, false)).rejects.toThrow(
      RolInsuficienteError,
    );
  });

  it('el último titular NO puede bajarse a colaborador', async () => {
    await sumarColaborador();

    await expect(cambiarRolUsuario(db, titular, titular.usuarioId, 'colaborador')).rejects.toThrow(
      UltimoTitularError,
    );

    const [ana] = await db.select().from(usuarios).where(eq(usuarios.id, titular.usuarioId));
    expect(ana.rol).toBe('titular');
  });

  it('el último titular NO puede desactivarse', async () => {
    await sumarColaborador();

    await expect(cambiarActivoUsuario(db, titular, titular.usuarioId, false)).rejects.toThrow(
      UltimoTitularError,
    );

    const [ana] = await db.select().from(usuarios).where(eq(usuarios.id, titular.usuarioId));
    expect(ana.activo).toBe(true);
  });

  it('con dos titulares, uno se puede bajar', async () => {
    const caroId = await sumarColaborador();
    await cambiarRolUsuario(db, titular, caroId, 'titular');

    await cambiarRolUsuario(db, titular, titular.usuarioId, 'colaborador');

    const [ana] = await db.select().from(usuarios).where(eq(usuarios.id, titular.usuarioId));
    expect(ana.rol).toBe('colaborador');
  });

  it('un titular desactivado no cuenta para el mínimo de titulares', async () => {
    const caroId = await sumarColaborador();
    await cambiarRolUsuario(db, titular, caroId, 'titular');
    await cambiarActivoUsuario(db, titular, caroId, false);

    // Caro es titular pero está inactivo: Ana es la única titular ACTIVA.
    await expect(cambiarActivoUsuario(db, titular, titular.usuarioId, false)).rejects.toThrow(
      UltimoTitularError,
    );
  });

  it('desactivar y reactivar queda auditado', async () => {
    const caroId = await sumarColaborador();

    await cambiarActivoUsuario(db, titular, caroId, false);
    let [caro] = await db.select().from(usuarios).where(eq(usuarios.id, caroId));
    expect(caro.activo).toBe(false);

    await cambiarActivoUsuario(db, titular, caroId, true);
    [caro] = await db.select().from(usuarios).where(eq(usuarios.id, caroId));
    expect(caro.activo).toBe(true);

    expect((await acciones()).filter((a) => a === 'usuario_activo_cambiado')).toHaveLength(2);
  });

  it('no toca usuarios de otro estudio, ni para leer ni para escribir', async () => {
    const [ajeno] = await db.select().from(usuarios).where(eq(usuarios.estudioId, otroEstudioId));

    await expect(cambiarRolUsuario(db, titular, ajeno.id, 'lectura')).rejects.toThrow(
      /No encontré ese usuario/,
    );
    const [sigue] = await db.select().from(usuarios).where(eq(usuarios.id, ajeno.id));
    expect(sigue.rol).toBe('titular');
  });
});

// ---------------------------------------------------------------------------
// La baja lógica le corta la entrada, no solo la escritura
// ---------------------------------------------------------------------------

/**
 * `roles.ts` promete que "un usuario inactivo queda afuera de todo". Eso no lo
 * puede sostener solo el guard de rol: si la sesión se sigue resolviendo, el
 * desactivado conserva **lectura completa** del estudio hasta que su cookie
 * venza sola (30 días), y si además se puede loguear, la baja no le sacó nada.
 */
describe('baja lógica: sesión y login', () => {
  async function sumarColaborador(): Promise<string> {
    const invitacion = await crearInvitacion(db, titular, 'colaborador');
    const alta = await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });
    return alta.sesion.usuario.id;
  }

  it('un usuario desactivado no puede loguearse, y no se le crea sesión', async () => {
    const caroId = await sumarColaborador();
    const sesionesAntes = await db.select().from(sesiones).where(eq(sesiones.usuarioId, caroId));

    await cambiarActivoUsuario(db, titular, caroId, false);

    const alta = await loginCore(db, {
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });

    expect(alta).toBeNull();
    // Ni una sesión más que las que ya tenía: el login no llegó a crearla.
    expect(await db.select().from(sesiones).where(eq(sesiones.usuarioId, caroId))).toHaveLength(
      sesionesAntes.length,
    );
  });

  it('el login de un desactivado da lo mismo que una contraseña mala: null pelado', async () => {
    const caroId = await sumarColaborador();
    await cambiarActivoUsuario(db, titular, caroId, false);

    // Desactivado con la contraseña buena, activo con la contraseña mala y un
    // mail que no existe: los tres devuelven exactamente lo mismo. Distinguir
    // el primero le contaría a un desconocido que la cuenta existe y está dada
    // de baja.
    expect(await loginCore(db, { email: 'caro@estudionorte.ar', password: 'durlock1234' })).toBeNull();
    expect(await loginCore(db, { email: 'ana@estudionorte.ar', password: 'mala' })).toBeNull();
    expect(await loginCore(db, { email: 'nadie@estudionorte.ar', password: 'durlock1234' })).toBeNull();
  });

  it('la sesión YA ABIERTA de un usuario deja de resolver al desactivarlo', async () => {
    const caroId = await sumarColaborador();
    const { token } = await crearSesion(db, caroId);

    const antes = await leerSesion(db, token);
    expect(antes?.usuario.id).toBe(caroId);

    await cambiarActivoUsuario(db, titular, caroId, false);

    // La cookie sigue en el browser y la fila de `sesiones` sigue en la base:
    // lo que se cortó es que el token resuelva a alguien.
    expect(await leerSesion(db, token)).toBeNull();
    expect(await db.select().from(sesiones).where(eq(sesiones.token, token))).toHaveLength(1);
  });

  it('reactivarlo le devuelve la sesión si todavía no venció', async () => {
    const caroId = await sumarColaborador();
    const { token } = await crearSesion(db, caroId);

    await cambiarActivoUsuario(db, titular, caroId, false);
    expect(await leerSesion(db, token)).toBeNull();

    await cambiarActivoUsuario(db, titular, caroId, true);

    const devuelta = await leerSesion(db, token);
    expect(devuelta?.usuario.id).toBe(caroId);
    expect(devuelta?.usuario.activo).toBe(true);
    expect(devuelta?.estudio.id).toBe(estudioId);
  });

  it('reactivado, también puede volver a loguearse', async () => {
    const caroId = await sumarColaborador();
    await cambiarActivoUsuario(db, titular, caroId, false);
    await cambiarActivoUsuario(db, titular, caroId, true);

    const alta = await loginCore(db, {
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });

    expect(alta?.sesion.usuario.id).toBe(caroId);
  });

  it('una sesión vencida sigue sin resolver aunque el usuario esté activo', async () => {
    const caroId = await sumarColaborador();
    const { token } = await crearSesion(db, caroId);
    await db
      .update(sesiones)
      .set({ expiraAt: new Date(Date.now() - 1000) })
      .where(eq(sesiones.token, token));

    expect(await leerSesion(db, token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// La carrera del último titular
// ---------------------------------------------------------------------------

/**
 * El guard del último titular era read-then-write: `SELECT count(*)` y después
 * `UPDATE`. Dos pedidos concurrentes contra **dos titulares distintos** leían
 * "queda otro" los dos, pasaban los dos, y el estudio se quedaba con cero.
 *
 * Estos tests corren las dos llamadas en paralelo de verdad (`Promise.allSettled`,
 * sin `await` en el medio) y exigen que gane exactamente una. Contra la versión
 * anterior fallan.
 */
describe('carrera: el estudio nunca se queda sin titular activo', () => {
  let segundoTitularId: string;

  beforeEach(async () => {
    const invitacion = await crearInvitacion(db, titular, 'titular');
    const alta = await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });
    segundoTitularId = alta.sesion.usuario.id;
  });

  async function titularesActivos(): Promise<number> {
    const filas = await db
      .select({ id: usuarios.id })
      .from(usuarios)
      .where(
        and(
          eq(usuarios.estudioId, estudioId),
          eq(usuarios.rol, 'titular'),
          eq(usuarios.activo, true),
        ),
      );
    return filas.length;
  }

  /** El actor del otro titular, para que las dos llamadas sean de gente distinta. */
  function comoSegundoTitular(): ActorPlataforma {
    return { ...titular, usuarioId: segundoTitularId, email: 'caro@estudionorte.ar' };
  }

  it('arranca con los dos titulares activos', async () => {
    expect(await titularesActivos()).toBe(2);
  });

  it('dos bajas simultáneas, una por cada titular: gana una sola', async () => {
    const resultados = await Promise.allSettled([
      cambiarActivoUsuario(db, titular, titular.usuarioId, false),
      cambiarActivoUsuario(db, comoSegundoTitular(), segundoTitularId, false),
    ]);

    const rechazados = resultados.filter((r) => r.status === 'rejected');
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rechazados).toHaveLength(1);
    expect((rechazados[0] as PromiseRejectedResult).reason).toBeInstanceOf(UltimoTitularError);

    expect(await titularesActivos()).toBe(1);
  });

  it('dos bajadas de rol simultáneas, una por cada titular: gana una sola', async () => {
    const resultados = await Promise.allSettled([
      cambiarRolUsuario(db, titular, titular.usuarioId, 'colaborador'),
      cambiarRolUsuario(db, comoSegundoTitular(), segundoTitularId, 'lectura'),
    ]);

    const rechazados = resultados.filter((r) => r.status === 'rejected');
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rechazados).toHaveLength(1);
    expect((rechazados[0] as PromiseRejectedResult).reason).toBeInstanceOf(UltimoTitularError);

    expect(await titularesActivos()).toBe(1);
  });

  it('una baja y una bajada de rol simultáneas tampoco se cruzan', async () => {
    const resultados = await Promise.allSettled([
      cambiarActivoUsuario(db, titular, titular.usuarioId, false),
      cambiarRolUsuario(db, comoSegundoTitular(), segundoTitularId, 'colaborador'),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await titularesActivos()).toBe(1);
  });

  it('el que pierde la carrera no queda auditado (no pasó nada que auditar)', async () => {
    await Promise.allSettled([
      cambiarActivoUsuario(db, titular, titular.usuarioId, false),
      cambiarActivoUsuario(db, comoSegundoTitular(), segundoTitularId, false),
    ]);

    const auditadas = (await acciones()).filter((a) => a === 'usuario_activo_cambiado');
    expect(auditadas).toHaveLength(1);
  });

  it('con tres titulares, dos bajas simultáneas pasan las dos', async () => {
    const invitacion = await crearInvitacion(db, titular, 'titular');
    const tercero = await aceptarInvitacionCore(db, {
      codigo: invitacion.codigo,
      nombre: 'Dani Paz',
      email: 'dani@estudionorte.ar',
      password: 'durlock1234',
    });
    expect(await titularesActivos()).toBe(3);

    const resultados = await Promise.allSettled([
      cambiarActivoUsuario(db, titular, segundoTitularId, false),
      cambiarActivoUsuario(db, titular, tercero.sesion.usuario.id, false),
    ]);

    // El guard no es "no toques a los titulares": es "que quede uno".
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await titularesActivos()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Configuración del estudio
// ---------------------------------------------------------------------------

describe('configuración del estudio', () => {
  it('un estudio sin config lee los defaults del PRD', async () => {
    const config = await leerConfig(db, estudioId);

    expect(config.desperdiciosPct).toEqual({});
    expect(config.condicionesDefault.ivaDiscriminado).toBe(true);
    expect(config.condicionesDefault.validezMinimaDias).toBe(7);
    expect(config.mandatoDefault).toEqual({
      objetivoMejoraPct: 5,
      palancas: ['volumen', 'plazo_pago'],
      maxRondas: 2,
    });
    expect(config.pesosRanking).toEqual({ total: 0.5, fidelidad: 0.3, plazo: 0.2 });
    expect(config.mepReferencia).toBeNull();
  });

  it('guarda solo lo pisado: la columna queda parcial', async () => {
    const resultado = await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } });
    expect(resultado.ok).toBe(true);

    const [fila] = await db.select().from(estudios).where(eq(estudios.id, estudioId));
    expect(fila.configJson).toEqual({ desperdiciosPct: { seco: 15 } });

    const config = await leerConfig(db, estudioId);
    expect(config.desperdiciosPct).toEqual({ seco: 15 });
    expect(config.pesosRanking).toEqual({ total: 0.5, fidelidad: 0.3, plazo: 0.2 });
  });

  it('mergea: guardar los pesos no borra los desperdicios', async () => {
    await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } });
    await guardarConfig(db, titular, { pesosRanking: { total: 0.6, fidelidad: 0.2, plazo: 0.2 } });

    const config = await leerConfig(db, estudioId);
    expect(config.desperdiciosPct).toEqual({ seco: 15 });
    expect(config.pesosRanking).toEqual({ total: 0.6, fidelidad: 0.2, plazo: 0.2 });
  });

  it('los desperdicios se mergean por clave y se borran con null', async () => {
    await guardarConfig(db, titular, { desperdiciosPct: { seco: 15, pintura: 8 } });
    await guardarConfig(db, titular, { desperdiciosPct: { seco: 20 } });
    expect((await leerConfig(db, estudioId)).desperdiciosPct).toEqual({ seco: 20, pintura: 8 });

    await guardarConfig(db, titular, { desperdiciosPct: { pintura: null } });
    expect((await leerConfig(db, estudioId)).desperdiciosPct).toEqual({ seco: 20 });
  });

  it('rechaza pesos de ranking que no suman 1', async () => {
    const resultado = await guardarConfig(db, titular, {
      pesosRanking: { total: 0.5, fidelidad: 0.3, plazo: 0.3 },
    });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error('debía fallar');
    expect(resultado.errores.pesosRanking).toContain('sumar 1');

    const [fila] = await db.select().from(estudios).where(eq(estudios.id, estudioId));
    expect(fila.configJson).toEqual({});
  });

  it('rechaza un mandato con 100% de objetivo (el motor no lo soporta)', async () => {
    const resultado = await guardarConfig(db, titular, {
      mandatoDefault: { objetivoMejoraPct: 100, palancas: ['volumen'], maxRondas: 2 },
    });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error('debía fallar');
    expect(resultado.errores.mandatoDefault).toContain('100');
  });

  it('acepta el MEP manual con valor y fecha', async () => {
    const resultado = await guardarConfig(db, titular, {
      mepReferencia: { valor: 1450.5, fecha: '2026-08-26' },
    });

    expect(resultado.ok).toBe(true);
    expect((await leerConfig(db, estudioId)).mepReferencia).toEqual({
      valor: 1450.5,
      fecha: '2026-08-26',
    });
  });

  it('un lectura no configura nada; un colaborador sí', async () => {
    await expect(guardarConfig(db, comoRol('lectura'), { desperdiciosPct: {} })).rejects.toThrow(
      RolInsuficienteError,
    );
    const resultado = await guardarConfig(db, comoRol('colaborador'), {
      desperdiciosPct: { seco: 15 },
    });
    expect(resultado.ok).toBe(true);
  });

  it('audita el cambio con el antes y el después', async () => {
    await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } });

    const [fila] = await db
      .select()
      .from(auditoria)
      .where(eq(auditoria.accion, 'config_estudio_actualizada'));
    expect(fila.targetRef).toBe(`estudios:${estudioId}`);
    expect(fila.diffJson).toMatchObject({
      desperdiciosPct: { antes: {}, despues: { seco: 15 } },
    });
  });

  it('no audita ni escribe si no cambió nada', async () => {
    await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } });
    await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } });

    const filas = await db
      .select()
      .from(auditoria)
      .where(eq(auditoria.accion, 'config_estudio_actualizada'));
    expect(filas).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Checklists por estudio
// ---------------------------------------------------------------------------

describe('checklists por estudio', () => {
  it('los defaults cubren todos los checklistItem que emiten las plantillas', async () => {
    const emitidos = new Set<string>();
    for (const archivo of ['aberturas', 'seco', 'pintura', 'gruesa']) {
      const fuente = await readFile(new URL(`../../src/lib/rubros/${archivo}.ts`, import.meta.url), 'utf8');
      for (const match of fuente.matchAll(/checklistItem:\s*`\$\{RUBRO\}\.([a-z_]+)`/g)) {
        emitidos.add(`${archivo}.${match[1]}`);
      }
    }
    // Más el degradado por confianza, que arma `taxonomia.ts` para todo rubro.
    for (const rubro of RUBROS) emitidos.add(`${rubro}.baja_confianza`);

    const declarados = new Set(
      RUBROS.flatMap((rubro) => CHECKLIST_DEFAULT[rubro].map((item) => item.itemId)),
    );

    expect(emitidos.size).toBeGreaterThan(0);
    expect([...emitidos].filter((item) => !declarados.has(item))).toEqual([]);
    expect([...declarados].filter((item) => !emitidos.has(item))).toEqual([]);
  });

  it('sin filas en la base, el checklist efectivo es el de las plantillas', async () => {
    const efectivo = await checklistEfectivo(db, estudioId, 'seco');

    expect(efectivo.get('seco.altura_tabiques')).toEqual({ activo: true, bloqueante: true });
    expect(efectivo.get('pintura.vanos_sin_descontar')).toBeUndefined();

    const pintura = await checklistEfectivo(db, estudioId, 'pintura');
    // El supuesto de vanos nace NO bloqueante: es un aviso, no un freno.
    expect(pintura.get('pintura.vanos_sin_descontar')).toEqual({ activo: true, bloqueante: false });
  });

  it('el toggle se persiste y cambia el checklist efectivo', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { activo: false });

    const efectivo = await checklistEfectivo(db, estudioId, 'seco');
    expect(efectivo.get('seco.altura_tabiques')).toEqual({ activo: false, bloqueante: true });

    const [fila] = await db
      .select()
      .from(checklistsEstudio)
      .where(and(eq(checklistsEstudio.estudioId, estudioId), eq(checklistsEstudio.rubro, 'seco')));
    expect(fila.itemId).toBe('seco.altura_tabiques');
    expect(fila.descripcion).not.toBe('');
    expect(await acciones()).toContain('checklist_item_actualizado');
  });

  it('volver a guardar el mismo ítem actualiza la fila, no agrega otra', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { activo: false });
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', {
      activo: true,
      bloqueante: false,
    });

    const filas = await db
      .select()
      .from(checklistsEstudio)
      .where(eq(checklistsEstudio.estudioId, estudioId));
    expect(filas).toHaveLength(1);
    expect(filas[0].activo).toBe(true);
    expect(filas[0].bloqueante).toBe(false);
  });

  it('el toggle de un estudio no toca al otro', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { activo: false });

    const ajeno = await checklistEfectivo(db, otroEstudioId, 'seco');
    expect(ajeno.get('seco.altura_tabiques')).toEqual({ activo: true, bloqueante: true });
  });

  it('un ítem de checklist que no existe en la plantilla se rechaza', async () => {
    await expect(
      guardarItemChecklist(db, titular, 'seco', 'seco.inventado', { activo: false }),
    ).rejects.toThrow(/no existe/);
  });

  it('un lectura no edita checklists', async () => {
    await expect(
      guardarItemChecklist(db, comoRol('lectura'), 'seco', 'seco.altura_tabiques', {
        activo: false,
      }),
    ).rejects.toThrow(RolInsuficienteError);
  });

  it('listarChecklist devuelve los defaults con el estado del estudio aplicado', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.largo_tabiques', { bloqueante: false });
    const lista = await listarChecklist(db, estudioId, 'seco');

    expect(lista.map((i) => i.itemId)).toEqual(CHECKLIST_DEFAULT.seco.map((i) => i.itemId));
    const largo = lista.find((i) => i.itemId === 'seco.largo_tabiques');
    expect(largo).toMatchObject({ activo: true, bloqueante: false, personalizado: true });
    const altura = lista.find((i) => i.itemId === 'seco.altura_tabiques');
    expect(altura).toMatchObject({ activo: true, bloqueante: true, personalizado: false });
  });
});

describe('el checklist manda sobre el gate de aprobación', () => {
  const HALLAZGOS = [
    { rubro: 'seco' as const, bloqueante: true, estado: 'abierto' as const, checklistItem: 'seco.altura_tabiques' },
    { rubro: null, bloqueante: true, estado: 'abierto' as const, checklistItem: 'escala' },
  ];

  it('con el checklist de fábrica, los dos hallazgos siguen frenando', async () => {
    const efectivo = await checklistEfectivo(db, estudioId, 'seco');
    const ajustados = ajustarHallazgosAlChecklist(HALLAZGOS, efectivo);

    expect(ajustados.map((h) => h.bloqueante)).toEqual([true, true]);
  });

  it('desactivar el ítem lo deja de frenar, y no toca al bloqueo por escala', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { activo: false });
    const efectivo = await checklistEfectivo(db, estudioId, 'seco');
    const ajustados = ajustarHallazgosAlChecklist(HALLAZGOS, efectivo);

    expect(ajustados[0].bloqueante).toBe(false);
    // `escala` lo administra el pipeline y no está en ningún checklist: intacto.
    expect(ajustados[1].bloqueante).toBe(true);
  });

  it('marcarlo no bloqueante también lo libera, sin sacarlo de la bandeja', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { bloqueante: false });
    const efectivo = await checklistEfectivo(db, estudioId, 'seco');

    expect(ajustarHallazgosAlChecklist(HALLAZGOS, efectivo)[0].bloqueante).toBe(false);
  });

  it('un hallazgo sin checklistItem nunca se toca', async () => {
    const efectivo = await checklistEfectivo(db, estudioId, 'seco');
    const sinItem = [{ rubro: 'seco' as const, bloqueante: true, estado: 'abierto' as const }];

    expect(ajustarHallazgosAlChecklist(sinItem, efectivo)[0].bloqueante).toBe(true);
  });
});

/**
 * El mismo ajuste, pero para los **contadores** del tablero ("N bloquean la
 * aprobación") y de la bandeja ("N bloqueantes"), que hasta P11 contaban el
 * `bloqueante` crudo de la fila: un estudio que desactivaba un chequeo veía el
 * tablero frenando un rubro que el gate dejaba aprobar.
 */
describe('los contadores de bloqueantes miran el checklist del estudio', () => {
  const CONSULTAS = [
    {
      rubro: 'seco' as const,
      bloqueante: true,
      estado: 'abierto' as const,
      checklistItem: 'seco.altura_tabiques',
    },
    {
      rubro: 'aberturas' as const,
      bloqueante: true,
      estado: 'abierto' as const,
      checklistItem: 'aberturas.medidas_vano',
    },
    // Sin checklistItem y de obra: el bloqueo por escala no se puede desactivar.
    { rubro: null, bloqueante: true, estado: 'abierto' as const, checklistItem: 'escala' },
    // Respondida: no cuenta aunque siga marcada bloqueante.
    {
      rubro: 'seco' as const,
      bloqueante: true,
      estado: 'respondido' as const,
      checklistItem: 'seco.largo_tabiques',
    },
  ];

  it('el mapa de los cuatro rubros no pierde ningún ítem por colisión de claves', async () => {
    const efectivo = await checklistEfectivoDeTodos(db, estudioId);

    const total = RUBROS.reduce((suma, rubro) => suma + CHECKLIST_DEFAULT[rubro].length, 0);
    expect(efectivo.size).toBe(total);
    expect(efectivo.get('seco.altura_tabiques')).toEqual({ activo: true, bloqueante: true });
    expect(efectivo.get('aberturas.medidas_vano')).toEqual({ activo: true, bloqueante: true });
  });

  it('con el checklist de fábrica cuenta las tres abiertas y bloqueantes', async () => {
    const efectivo = await checklistEfectivoDeTodos(db, estudioId);

    expect(contarBloqueantes(CONSULTAS, efectivo)).toBe(3);
  });

  it('desactivar un ítem de checklist baja el contador', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { activo: false });
    const efectivo = await checklistEfectivoDeTodos(db, estudioId);

    expect(contarBloqueantes(CONSULTAS, efectivo)).toBe(2);
  });

  it('marcar un ítem no bloqueante también lo baja, y la escala sigue frenando', async () => {
    await guardarItemChecklist(db, titular, 'aberturas', 'aberturas.medidas_vano', {
      bloqueante: false,
    });
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { activo: false });
    const efectivo = await checklistEfectivoDeTodos(db, estudioId);

    // Queda solo la de escala, que no está en ningún checklist.
    expect(contarBloqueantes(CONSULTAS, efectivo)).toBe(1);
  });

  it('el checklist de otro estudio no afecta el contador de este (RNF-4)', async () => {
    await guardarItemChecklist(db, titular, 'seco', 'seco.altura_tabiques', { activo: false });
    const ajeno = await checklistEfectivoDeTodos(db, otroEstudioId);

    expect(contarBloqueantes(CONSULTAS, ajeno)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// La configuración llega al cómputo (TODO de P7 cerrado en P11)
// ---------------------------------------------------------------------------

/**
 * El desperdicio configurable no servía de nada mientras el recompute usara
 * `PLANTILLAS` directo: el formulario guardaba un número y ningún ítem se movía.
 *
 * El tabique del pin es **5,02 × 2,50 m a dos caras = 25,10 m² netos**, elegido
 * a propósito: con 26 m² (el del fixture de la obra demo) el 12 % y el 15 % dan
 * la misma compra —el bulto de 2,88 m² se come la diferencia— y un pin que no se
 * mueve no protege nada.
 *
 *   12 % (plantilla) → 28,11 m² → 28,11 / 2,88 = 9,76 ⇒ 10 placas = 28,80 m²
 *   15 % (config)    → 28,87 m² → 28,87 / 2,88 = 10,02 ⇒ 11 placas = 31,68 m²
 */
describe('la configuración del estudio llega al recompute', () => {
  let obraId: string;

  async function placas(): Promise<{ desperdicioPct: number; cantCompra: number } | undefined> {
    const [fila] = await db
      .select({ desperdicioPct: computoItems.desperdicioPct, cantCompra: computoItems.cantCompra })
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.placas')));
    return fila;
  }

  beforeEach(async () => {
    const [obra] = await db
      .insert(obras)
      .values({ estudioId, nombre: 'Casa Config', zona: 'CABA', tipo: 'nueva' })
      .returning();
    obraId = obra.id;

    const [documento] = await db
      .insert(documentos)
      .values({
        obraId,
        nombreArchivo: 'planta.pdf',
        tipo: 'plano',
        archivoRef: 'config/planta.pdf',
        mime: 'application/pdf',
        hash: 'sha256-config',
        subidoPor: titular.usuarioId,
      })
      .returning();
    const [lamina] = await db
      .insert(laminas)
      .values({
        documentoId: documento.id,
        obraId,
        numeroPagina: 1,
        archivoRef: 'config/planta-p1.pdf',
        tipo: 'planta',
        estadoAnalisis: 'analizada',
        escala: '1:100',
        escalaConfiable: true,
      })
      .returning();

    await db.insert(entidades).values({
      obraId,
      laminaId: lamina.id,
      tipo: 'tabique',
      nombre: 'T1',
      atributosJson: { tipo: 'durlock', largoM: 5.02, alturaM: 2.5, caras: 2 },
      estadoReforma: 'na',
      fuentesJson: [{ laminaId: lamina.id, bbox: [0.1, 0.2, 0.02, 0.4], detalle: 'T1' }],
      confianza: 0.9,
    });
  });

  it('sin config, el desperdicio es el de la plantilla: 12 % ⇒ 10 placas', async () => {
    await recomputarObra(obraId, { db });

    expect(await placas()).toEqual({ desperdicioPct: 12, cantCompra: 28.8 });
  });

  it('con el override del estudio en 15 %, el mismo tabique compra 11 placas', async () => {
    expect((await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } })).ok).toBe(true);
    await recomputarObra(obraId, { db });

    expect(await placas()).toEqual({ desperdicioPct: 15, cantCompra: 31.68 });
  });

  it('cambiar la config y recomputar mueve un ítem que ya estaba escrito', async () => {
    await recomputarObra(obraId, { db });
    expect((await placas())?.cantCompra).toBe(28.8);

    await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } });
    const resumen = await recomputarObra(obraId, { db });

    expect(resumen.itemsActualizados).toBeGreaterThan(0);
    expect(await placas()).toEqual({ desperdicioPct: 15, cantCompra: 31.68 });
  });

  it('el override por rubro no toca a los ítems que no se desperdician', async () => {
    await guardarConfig(db, titular, { desperdiciosPct: { seco: 15 } });
    await recomputarObra(obraId, { db });

    const [tornillos] = await db
      .select({ desperdicioPct: computoItems.desperdicioPct })
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.tornillos')));
    expect(tornillos.desperdicioPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// La matriz completa, contra los cores de verdad
// ---------------------------------------------------------------------------

/**
 * Parametrizado sobre los núcleos que mutan y aceptan un actor.
 *
 * No es un test del helper `requireRolCore` (eso está en
 * `tests/unit/roles.test.ts`): es la prueba de que **cada core lo llama**. Un
 * core nuevo que se olvide del guard no aparece acá, así que la lista se
 * actualiza a mano cuando se agrega uno — es el precio de no poder preguntarle
 * al módulo qué exporta y qué muta.
 *
 * Los que faltan porque no aceptan actor (`*Action` con sesión, rutas de API)
 * están en la tabla del reporte de P7 con el archivo que los guarda.
 */
describe('matriz de roles contra los cores que mutan', () => {
  let obraId: string;

  /** El storage revienta a propósito: si el guard corre primero, nunca se lo toca. */
  const storageQueRevienta: StorageAdapter = {
    guardar: () => Promise.reject(new Error('el guard tenía que cortar antes')),
    leer: () => Promise.reject(new Error('el guard tenía que cortar antes')),
    eliminar: () => Promise.reject(new Error('el guard tenía que cortar antes')),
  };

  beforeEach(async () => {
    const [obra] = await db
      .insert(obras)
      .values({ estudioId, nombre: 'Casa Belgrano', zona: 'CABA', tipo: 'nueva', moneda: 'ars' })
      .returning();
    obraId = obra.id;
  });

  interface CoreMutante {
    nombre: string;
    minimo: 'colaborador' | 'titular';
    correr: (actor: ActorPlataforma) => Promise<unknown>;
  }

  const CORES: CoreMutante[] = [
    {
      nombre: 'editarObra',
      minimo: 'colaborador',
      correr: (actor) => editarObra(db, estudioId, obraId, { nombre: 'Otra' }, actor),
    },
    {
      nombre: 'archivarObra',
      minimo: 'colaborador',
      correr: (actor) => archivarObra(db, estudioId, obraId, actor),
    },
    {
      nombre: 'eliminarDocumento',
      minimo: 'colaborador',
      correr: (actor) =>
        eliminarDocumento(db, storageQueRevienta, estudioId, obraId, obraId, actor),
    },
    {
      nombre: 'guardarConfig',
      minimo: 'colaborador',
      correr: (actor) => guardarConfig(db, actor, { desperdiciosPct: { seco: 15 } }),
    },
    {
      nombre: 'guardarItemChecklist',
      minimo: 'colaborador',
      correr: (actor) =>
        guardarItemChecklist(db, actor, 'seco', 'seco.altura_tabiques', { activo: false }),
    },
    {
      nombre: 'eliminarObra',
      minimo: 'titular',
      correr: (actor) => eliminarObra(db, storageQueRevienta, estudioId, obraId, actor),
    },
    {
      nombre: 'crearInvitacion',
      minimo: 'titular',
      correr: (actor) => crearInvitacion(db, actor, 'lectura'),
    },
    {
      nombre: 'cambiarRolUsuario',
      minimo: 'titular',
      correr: (actor) => cambiarRolUsuario(db, actor, actor.usuarioId, 'lectura'),
    },
    {
      nombre: 'cambiarActivoUsuario',
      minimo: 'titular',
      correr: (actor) => cambiarActivoUsuario(db, actor, actor.usuarioId, false),
    },
  ];

  const SOLO_TITULAR = CORES.filter((core) => core.minimo === 'titular');

  it('las cinco acciones sensibles de la matriz tienen core o dueño declarado', () => {
    // Lanzar compulsa y adjudicar llegan en P8/P9: hoy la tabla las declara y
    // no hay core que las implemente. El resto sí está.
    expect(SOLO_TITULAR.map((core) => core.nombre)).toEqual([
      'eliminarObra',
      'crearInvitacion',
      'cambiarRolUsuario',
      'cambiarActivoUsuario',
    ]);
  });

  it.each(CORES)('lectura no puede $nombre', async ({ correr }) => {
    await expect(correr(comoRol('lectura'))).rejects.toBeInstanceOf(RolInsuficienteError);
  });

  it.each(SOLO_TITULAR)('colaborador no puede $nombre', async ({ correr }) => {
    await expect(correr(comoRol('colaborador'))).rejects.toBeInstanceOf(RolInsuficienteError);
  });

  it.each(CORES)('un titular DESACTIVADO no puede $nombre', async ({ correr }) => {
    await expect(correr(comoRol('titular', false))).rejects.toBeInstanceOf(UsuarioInactivoError);
  });

  it.each(CORES.filter((core) => core.minimo === 'colaborador'))(
    'un colaborador SÍ puede $nombre',
    async ({ correr }) => {
      // No se chequea el resultado: cada core devuelve lo suyo y eso lo cubren
      // sus propios tests. Lo que se prueba es que el guard lo deja pasar —y
      // por eso `eliminarDocumento` falla con "no encontré ese documento", no
      // con un error de rol.
      const error = await correr(comoRol('colaborador')).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(RolInsuficienteError);
      expect(error).not.toBeInstanceOf(UsuarioInactivoError);
    },
  );
});

// ---------------------------------------------------------------------------
// Notificaciones
// ---------------------------------------------------------------------------

describe('notificaciones', () => {
  async function sumarDos(): Promise<{ caroId: string; deboId: string }> {
    const a = await crearInvitacion(db, titular, 'colaborador');
    const caro = await aceptarInvitacionCore(db, {
      codigo: a.codigo,
      nombre: 'Caro Díaz',
      email: 'caro@estudionorte.ar',
      password: 'durlock1234',
    });
    const b = await crearInvitacion(db, titular, 'lectura');
    const debo = await aceptarInvitacionCore(db, {
      codigo: b.codigo,
      nombre: 'Debo Paz',
      email: 'debo@estudionorte.ar',
      password: 'durlock1234',
    });
    return { caroId: caro.sesion.usuario.id, deboId: debo.sesion.usuario.id };
  }

  it('crea una notificación por usuario de una lista', async () => {
    const { caroId, deboId } = await sumarDos();

    const creadas = await crearNotificacion(db, [caroId, deboId], {
      titulo: 'Cotización conciliada',
      cuerpo: 'Llegó el presupuesto de Corralón Sur.',
      link: '/obras/1/comparativa',
    });

    expect(creadas).toBe(2);
    const deCaro = await listarNotificaciones(db, caroId);
    expect(deCaro).toHaveLength(1);
    expect(deCaro[0].titulo).toBe('Cotización conciliada');
    expect(deCaro[0].leida).toBe(false);
  });

  it('crea una para todo el estudio, salteando a los inactivos', async () => {
    const { caroId } = await sumarDos();
    await cambiarActivoUsuario(db, titular, caroId, false);

    const creadas = await crearNotificacion(
      db,
      { estudioId },
      { titulo: 'Compulsa sin respuesta', cuerpo: 'Hace 7 días.' },
    );

    // Ana + Debo; Caro está desactivado.
    expect(creadas).toBe(2);
    expect(await listarNotificaciones(db, caroId)).toEqual([]);
  });

  it('puede apuntar solo a los titulares del estudio', async () => {
    const { caroId } = await sumarDos();

    const creadas = await crearNotificacion(
      db,
      { estudioId, roles: ['titular'] },
      { titulo: 'Se sumó alguien al estudio', cuerpo: 'Caro Díaz.' },
    );

    expect(creadas).toBe(1);
    expect(await listarNotificaciones(db, caroId)).toEqual([]);
  });

  it('cuenta las no leídas y las marca de a una', async () => {
    const { caroId } = await sumarDos();
    await crearNotificacion(db, [caroId], { titulo: 'Una', cuerpo: 'a' });
    await crearNotificacion(db, [caroId], { titulo: 'Dos', cuerpo: 'b' });

    expect(await contarNoLeidas(db, caroId)).toBe(2);

    const [primera] = await listarNotificaciones(db, caroId);
    await marcarLeida(db, caroId, primera.id);

    expect(await contarNoLeidas(db, caroId)).toBe(1);
  });

  it('marcar leída una notificación ajena no hace nada', async () => {
    const { caroId, deboId } = await sumarDos();
    await crearNotificacion(db, [caroId], { titulo: 'Una', cuerpo: 'a' });
    const [suya] = await listarNotificaciones(db, caroId);

    await marcarLeida(db, deboId, suya.id);

    expect(await contarNoLeidas(db, caroId)).toBe(1);
  });

  it('marca todas de una y devuelve cuántas tocó', async () => {
    const { caroId } = await sumarDos();
    await crearNotificacion(db, [caroId], { titulo: 'Una', cuerpo: 'a' });
    await crearNotificacion(db, [caroId], { titulo: 'Dos', cuerpo: 'b' });

    expect(await marcarTodasLeidas(db, caroId)).toBe(2);
    expect(await contarNoLeidas(db, caroId)).toBe(0);
    expect(await marcarTodasLeidas(db, caroId)).toBe(0);
  });

  it('la lista viene de la más nueva a la más vieja y se puede acotar', async () => {
    const { caroId } = await sumarDos();
    for (let n = 1; n <= 12; n += 1) {
      await crearNotificacion(db, [caroId], { titulo: `N${n}`, cuerpo: 'x' });
    }

    // Reloj explícito: doce inserts seguidos pueden caer en el mismo instante y
    // entonces "la más nueva" no está definida. Con fechas puestas a mano, sí.
    const todas = await db
      .select()
      .from(notificaciones)
      .where(eq(notificaciones.usuarioId, caroId));
    for (const fila of todas) {
      await db
        .update(notificaciones)
        .set({ createdAt: new Date(Date.UTC(2026, 0, Number(fila.titulo.slice(1)))) })
        .where(eq(notificaciones.id, fila.id));
    }

    const ultimas = await listarNotificaciones(db, caroId, 10);
    expect(ultimas).toHaveLength(10);
    expect(ultimas[0].titulo).toBe('N12');
    expect(ultimas[9].titulo).toBe('N3');
  });

  it('una lista de destinatarios vacía no escribe nada', async () => {
    expect(await crearNotificacion(db, [], { titulo: 'Nadie', cuerpo: 'x' })).toBe(0);
    expect(await db.select().from(notificaciones)).toEqual([]);
  });
});

/**
 * La marca de "de esto ya avisé" vive en `notificaciones.clave_dedup` y la
 * garantiza el UNIQUE `(usuario_id, clave_dedup)`, no una consulta previa: dos
 * escrituras simultáneas dejan una sola fila. Va en su propia columna y no sobre
 * `link` porque el link no es único por evento —tres proveedores cotizando la
 * misma compulsa llevan al mismo lugar y son tres avisos distintos.
 */
describe('deduplicación de notificaciones por clave', () => {
  let caroId: string;

  beforeEach(async () => {
    const [caro] = await db
      .insert(usuarios)
      .values({
        estudioId,
        email: 'caro@estudionorte.ar',
        nombre: 'Caro Colaboradora',
        passwordHash: 'x',
        rol: 'colaborador',
      })
      .returning();
    caroId = caro.id;
  });

  it('con la misma clave, el segundo aviso no se escribe y la cuenta lo dice', async () => {
    const aviso = { titulo: 'Sin respuesta', cuerpo: 'x', claveDedup: 'compulsa.sin_respuesta.7' };

    expect(await crearNotificacion(db, [caroId], aviso)).toBe(1);
    expect(await crearNotificacion(db, [caroId], aviso)).toBe(0);
    expect(await crearNotificacion(db, [caroId], { ...aviso, titulo: 'Otro título' })).toBe(0);

    expect(await db.select().from(notificaciones)).toHaveLength(1);
  });

  it('dos escrituras simultáneas con la misma clave dejan una sola fila', async () => {
    const aviso = { titulo: 'Sin respuesta', cuerpo: 'x', claveDedup: 'compulsa.sin_respuesta.8' };

    const [una, otra] = await Promise.all([
      crearNotificacion(db, [caroId], aviso),
      crearNotificacion(db, [caroId], aviso),
    ]);

    expect(una + otra).toBe(1);
    expect(await db.select().from(notificaciones)).toHaveLength(1);
  });

  it('la clave es por usuario: el mismo aviso le llega a cada uno', async () => {
    const escritas = await crearNotificacion(db, [caroId, titular.usuarioId], {
      titulo: 'Sin respuesta',
      cuerpo: 'x',
      claveDedup: 'compulsa.sin_respuesta.9',
    });

    expect(escritas).toBe(2);
  });

  it('sin clave no hay dedup: dos avisos al mismo link son dos avisos', async () => {
    const link = '/obras/1/compulsas/2';
    expect(await crearNotificacion(db, [caroId], { titulo: 'Cotizó A', cuerpo: 'x', link })).toBe(1);
    expect(await crearNotificacion(db, [caroId], { titulo: 'Cotizó B', cuerpo: 'x', link })).toBe(1);

    expect(await db.select().from(notificaciones)).toHaveLength(2);
  });
});
