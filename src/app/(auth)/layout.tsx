/**
 * Portero de las pantallas de auth, al revés que el resto.
 *
 * `/login` y `/register` son las dos rutas que el middleware **no** cubre (son
 * la salida del embudo, ver el `matcher` de `src/middleware.ts`): sin esto, un
 * usuario con sesión abierta que vuelve a `/login` ve el formulario de entrar,
 * se pregunta si se cayó la sesión y escribe la contraseña de nuevo.
 *
 * Va en un layout server y no en las páginas porque las dos páginas son
 * `'use client'` (usan `useActionState`) y desde el cliente no se puede leer la
 * cookie httpOnly. `getSession()` valida el token contra la base, así que una
 * cookie vencida no atrapa a nadie acá adentro: ese caso ve el login, que es lo
 * que corresponde.
 */
import type { ReactNode } from 'react';

import { getSession } from '@/lib/auth/session';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const sesion = await getSession();
  if (sesion) {
    const { redirect } = await import('next/navigation');
    redirect('/obras');
  }

  return children;
}
