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
  estudios,
  invitaciones,
  notificaciones,
  usuarios,
} from '@/db/schema';
import { registrarEstudioCore } from '@/lib/auth/session';
import {
  CHECKLIST_DEFAULT,
  checklistEfectivo,
  ajustarHallazgosAlChecklist,
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
import { RolInsuficienteError } from '@/lib/plataforma/roles';
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
