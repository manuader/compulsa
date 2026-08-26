/**
 * Portero del workspace.
 *
 * Corre en el runtime edge: acá NO se puede importar la base ni `node:crypto`,
 * así que el middleware solo mira si *existe* la cookie de sesión. La validación
 * real (token vigente, usuario, estudio) sigue viviendo del lado del server, en
 * `requireUser()` / `getSession()`: una cookie vencida pasa por acá y rebota
 * ahí. El middleware es comodidad de navegación, no el control de acceso.
 */
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Copia literal de `COOKIE_SESION` (`src/lib/auth/session.ts`). Importarlo de
 * ahí arrastraría `node:crypto` y drizzle al bundle edge, que no los soporta.
 */
const COOKIE_SESION = 'compulsa_session';

/**
 * El layout de obra lee este header para marcar la solapa activa sin JS de
 * cliente. Next no expone el pathname a los Server Components; el middleware
 * sí lo tiene. Si el matcher dejara de cubrir una ruta, el header falta y las
 * solapas se dibujan sin resaltado — degrada, no rompe.
 */
export const HEADER_PATHNAME = 'x-compulsa-pathname';

export function middleware(request: NextRequest) {
  if (!request.cookies.has(COOKIE_SESION)) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    return NextResponse.redirect(login);
  }

  const headers = new Headers(request.headers);
  headers.set(HEADER_PATHNAME, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Quedan afuera: las pantallas de auth (son la salida del embudo), `/api/*`
  // (cada handler valida por su cuenta) y los assets del build.
  matcher: ['/((?!login|register|api|_next/static|_next/image|favicon.ico).*)'],
};
