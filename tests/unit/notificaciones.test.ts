/**
 * El validador del destino de una notificación (`destinoInterno`).
 *
 * Abrir una notificación es un `<form>` que escribe y **después redirige**, así
 * que el `link` viaja en el POST y llega del cliente. El chequeo que había
 * —«empieza con `/` y no con `//`»— dejaba pasar `/\evil.com`: los navegadores
 * normalizan la barra invertida a barra (WHATWG URL), así que ese destino se
 * resuelve como `https://evil.com` con la sesión del usuario puesta.
 *
 * Es una función pura sobre un string, o sea que se puede pinnear caso por caso
 * sin levantar una base: acá está la tabla completa de lo que pasa y lo que no.
 */
import { describe, expect, it } from 'vitest';

import { DESTINO_POR_DEFECTO, destinoInterno } from '@/lib/plataforma/notificaciones';

describe('destinoInterno: qué se acepta', () => {
  it('deja pasar las rutas que la app escribe de verdad', () => {
    const rutas = [
      '/estudio',
      '/estudio/usuarios',
      '/obras/9f1d3e7a-0000-4000-8000-000000000001/deducciones',
      '/obras/9f1d3e7a-0000-4000-8000-000000000001/compulsas/abc#contacto-def',
      '/estudio/auditoria?obra=9f1d3e7a-0000-4000-8000-000000000001',
    ];

    for (const ruta of rutas) expect(destinoInterno(ruta)).toBe(ruta);
  });
});

describe('destinoInterno: el open redirect', () => {
  it('la barra invertida no es una ruta interna (el bug)', () => {
    // El navegador resuelve las cuatro como `https://evil.com/...`.
    expect(destinoInterno('/\\evil.com')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('/\\/evil.com')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('/\\\\evil.com')).toBe(DESTINO_POR_DEFECTO);
    // Y tampoco cuando aparece más adelante, no solo en la segunda posición.
    expect(destinoInterno('/estudio/\\evil.com')).toBe(DESTINO_POR_DEFECTO);
  });

  it('protocol-relative y absolutas tampoco', () => {
    expect(destinoInterno('//evil.com')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('https://evil.com')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('http://evil.com')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('javascript:alert(1)')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('data:text/html,<script>')).toBe(DESTINO_POR_DEFECTO);
  });

  it('con un carácter de control adelante tampoco: hay parsers que lo recortan', () => {
    expect(destinoInterno('/\tevil')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('/\nevil')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('/ evil')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('\t//evil.com')).toBe(DESTINO_POR_DEFECTO);
  });

  it('lo vacío, lo ausente y lo desmedido caen al default', () => {
    expect(destinoInterno('')).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno(null)).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno(undefined)).toBe(DESTINO_POR_DEFECTO);
    expect(destinoInterno('estudio')).toBe(DESTINO_POR_DEFECTO); // sin la barra
    expect(destinoInterno(`/${'a'.repeat(2_000)}`)).toBe(DESTINO_POR_DEFECTO);
  });
});
