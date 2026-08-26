'use server';

/**
 * Server Actions de sesión: alta de estudio, ingreso y salida.
 *
 * Son envoltorios finos sobre `src/lib/auth/session.ts`. Lo único que agregan
 * es la validación Zod del formulario (el server nunca confía en el payload) y
 * la traducción de "falló" a mensajes es-AR que la pantalla muestra inline.
 */
import { z } from 'zod';

import { EmailYaRegistradoError, login, logout, registrarEstudio } from '@/lib/auth/session';

/** Estado que `useActionState` devuelve al formulario. Todo serializable. */
export interface EstadoAuth {
  /** Error que no es de un campo puntual ("El mail o la contraseña no son correctos."). */
  mensaje?: string;
  /** Error por campo, con la clave del `name` del input. */
  errores?: Record<string, string>;
  /** Lo tipeado, para no vaciarle el formulario al usuario. Nunca la contraseña. */
  valores?: Record<string, string>;
}

const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Escribí un mail válido.'));

const zLogin = z.object({
  email: zEmail,
  password: z.string().min(1, 'Escribí tu contraseña.'),
});

const zRegistro = z.object({
  nombreEstudio: z.string().trim().min(1, 'Poné el nombre del estudio.'),
  nombre: z.string().trim().min(1, 'Poné tu nombre.'),
  email: zEmail,
  password: z.string().min(8, 'La contraseña necesita al menos 8 caracteres.'),
});

/** Primer mensaje por campo: el formulario muestra uno solo debajo de cada input. */
function erroresPorCampo(error: z.ZodError): Record<string, string> {
  const errores: Record<string, string> = {};
  for (const issue of error.issues) {
    const campo = String(issue.path[0] ?? '');
    if (campo && !(campo in errores)) errores[campo] = issue.message;
  }
  return errores;
}

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);
  return typeof valor === 'string' ? valor : '';
}

async function irAlWorkspace(): Promise<never> {
  const { redirect } = await import('next/navigation');
  return redirect('/obras');
}

export async function ingresarAction(
  _estadoPrevio: EstadoAuth,
  formData: FormData,
): Promise<EstadoAuth> {
  const crudo = { email: texto(formData, 'email'), password: texto(formData, 'password') };
  const valores = { email: crudo.email };

  const parseo = zLogin.safeParse(crudo);
  if (!parseo.success) return { errores: erroresPorCampo(parseo.error), valores };

  const sesion = await login(parseo.data);
  // Mail inexistente y contraseña equivocada dan el MISMO mensaje: decir cuál de
  // los dos falló es contarle a un desconocido qué mails están registrados.
  if (!sesion) return { mensaje: 'El mail o la contraseña no son correctos.', valores };

  return irAlWorkspace();
}

export async function registrarAction(
  _estadoPrevio: EstadoAuth,
  formData: FormData,
): Promise<EstadoAuth> {
  const crudo = {
    nombreEstudio: texto(formData, 'nombreEstudio'),
    nombre: texto(formData, 'nombre'),
    email: texto(formData, 'email'),
    password: texto(formData, 'password'),
  };
  const valores = {
    nombreEstudio: crudo.nombreEstudio,
    nombre: crudo.nombre,
    email: crudo.email,
  };

  const parseo = zRegistro.safeParse(crudo);
  if (!parseo.success) return { errores: erroresPorCampo(parseo.error), valores };

  try {
    await registrarEstudio(parseo.data);
  } catch (error) {
    if (error instanceof EmailYaRegistradoError) {
      return { errores: { email: 'Ya hay una cuenta con ese mail. Probá ingresando.' }, valores };
    }
    throw error;
  }

  return irAlWorkspace();
}

export async function salirAction(): Promise<never> {
  await logout();
  const { redirect } = await import('next/navigation');
  return redirect('/login');
}
