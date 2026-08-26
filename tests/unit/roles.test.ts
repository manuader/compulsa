/**
 * Matriz de roles (RF-1201), que es la regla de la que cuelga todo el
 * enforcement de la plataforma:
 *
 *   lectura < colaborador < titular
 *
 * - `lectura` no muta nada.
 * - `colaborador` hace todo **menos** las cinco acciones sensibles: aprobar
 *   rubros, lanzar compulsas, adjudicar, eliminar obras y gestionar usuarios.
 * - `titular` hace todo.
 * - Un usuario **inactivo** (baja lógica) queda afuera de todo, sea cual sea su
 *   rol: la baja no le cambia el rol, le corta la entrada.
 *
 * Los tests están parametrizados sobre `ROL_MINIMO_ACCION`, que es la tabla que
 * usan los cores: si mañana alguien agrega una acción sensible y se olvida de
 * exigirle titular, este archivo lo cuenta.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCIONES_SENSIBLES,
  esRolSuficiente,
  ETIQUETA_ROL,
  RolInsuficienteError,
  ROL_MINIMO_ACCION,
  requireRolCore,
  UsuarioInactivoError,
} from '@/lib/plataforma/roles';
import { ROLES_USUARIO, type RolUsuario } from '@/types/domain';

function usuario(rol: RolUsuario, activo = true) {
  return { rol, activo };
}

describe('jerarquía de roles', () => {
  it('lectura < colaborador < titular', () => {
    expect(esRolSuficiente(usuario('lectura'), 'colaborador')).toBe(false);
    expect(esRolSuficiente(usuario('colaborador'), 'colaborador')).toBe(true);
    expect(esRolSuficiente(usuario('titular'), 'colaborador')).toBe(true);

    expect(esRolSuficiente(usuario('lectura'), 'titular')).toBe(false);
    expect(esRolSuficiente(usuario('colaborador'), 'titular')).toBe(false);
    expect(esRolSuficiente(usuario('titular'), 'titular')).toBe(true);
  });

  it('un usuario inactivo no alcanza ningún mínimo, ni siendo titular', () => {
    for (const rol of ROLES_USUARIO) {
      expect(esRolSuficiente(usuario(rol, false), 'colaborador')).toBe(false);
      expect(esRolSuficiente(usuario(rol, false), 'titular')).toBe(false);
    }
  });
});

describe('requireRolCore', () => {
  it('deja pasar sin devolver nada cuando el rol alcanza', () => {
    expect(requireRolCore(usuario('titular'), 'titular')).toBeUndefined();
    expect(requireRolCore(usuario('colaborador'), 'colaborador')).toBeUndefined();
  });

  it.each(ROLES_USUARIO)('rechaza a %s si está inactivo, con el error de baja', (rol) => {
    let capturado: unknown;
    try {
      requireRolCore(usuario(rol, false), 'colaborador');
    } catch (error) {
      capturado = error;
    }

    expect(capturado).toBeInstanceOf(UsuarioInactivoError);
    expect((capturado as Error).message).toBe(
      'Tu usuario está desactivado: pedile a un titular del estudio que te reactive.',
    );
  });

  it('el mensaje de lectura nombra el rol que hace falta, en es-AR', () => {
    expect(() => requireRolCore(usuario('lectura'), 'colaborador', 'editar el cómputo')).toThrow(
      RolInsuficienteError,
    );
    try {
      requireRolCore(usuario('lectura'), 'colaborador', 'editar el cómputo');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Con rol de solo lectura no podés editar el cómputo. Pedile a un colaborador o al titular que lo haga.',
      );
    }
  });

  it('el mensaje de colaborador dice que la acción es del titular', () => {
    try {
      requireRolCore(usuario('colaborador'), 'titular', 'aprobar un rubro');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Solo el titular del estudio puede aprobar un rubro. Tu rol es colaborador.',
      );
    }
  });

  it('sin nombre de acción el mensaje sigue siendo una oración es-AR', () => {
    try {
      requireRolCore(usuario('lectura'), 'titular');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Solo el titular del estudio puede hacer esto. Tu rol es solo lectura.',
      );
    }
  });

  it('el error tipado lleva el rol que tenía y el que hacía falta', () => {
    try {
      requireRolCore(usuario('colaborador'), 'titular', 'eliminar una obra');
    } catch (error) {
      const falla = error as RolInsuficienteError;
      expect(falla.rol).toBe('colaborador');
      expect(falla.minimo).toBe('titular');
      expect(falla.name).toBe('RolInsuficienteError');
    }
  });
});

describe('tabla de acciones: las cinco sensibles son del titular', () => {
  it('la lista de acciones sensibles es exactamente la de la matriz del PRD', () => {
    expect([...ACCIONES_SENSIBLES]).toEqual([
      'aprobar_rubro',
      'lanzar_compulsa',
      'adjudicar_compulsa',
      'eliminar_obra',
      'gestionar_usuarios',
    ]);
  });

  it.each(ACCIONES_SENSIBLES)('un colaborador NO puede %s', (accion) => {
    expect(ROL_MINIMO_ACCION[accion]).toBe('titular');
    expect(esRolSuficiente(usuario('colaborador'), ROL_MINIMO_ACCION[accion])).toBe(false);
    expect(esRolSuficiente(usuario('titular'), ROL_MINIMO_ACCION[accion])).toBe(true);
  });

  const NO_SENSIBLES = (
    Object.keys(ROL_MINIMO_ACCION) as (keyof typeof ROL_MINIMO_ACCION)[]
  ).filter((accion) => !(ACCIONES_SENSIBLES as readonly string[]).includes(accion));

  it.each(NO_SENSIBLES)('un colaborador SÍ puede %s, y lectura no', (accion) => {
    expect(ROL_MINIMO_ACCION[accion]).toBe('colaborador');
    expect(esRolSuficiente(usuario('colaborador'), 'colaborador')).toBe(true);
    expect(esRolSuficiente(usuario('lectura'), ROL_MINIMO_ACCION[accion])).toBe(false);
  });

  it('lectura queda afuera de TODAS las acciones de la tabla', () => {
    for (const minimo of Object.values(ROL_MINIMO_ACCION)) {
      expect(esRolSuficiente(usuario('lectura'), minimo)).toBe(false);
    }
  });
});

describe('etiquetas', () => {
  it('nombra los tres roles en es-AR', () => {
    expect(ETIQUETA_ROL).toEqual({
      titular: 'Titular',
      colaborador: 'Colaborador',
      lectura: 'Solo lectura',
    });
  });
});
