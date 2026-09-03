/**
 * Toda acción que se audita tiene su frase en castellano.
 *
 * El mapa de `src/app/estudio/auditoria/frases.ts` decía en su propia cabecera
 * «si agregás una acción nueva, agregala también acá, en el mismo commit», y
 * nada lo cobraba. La ola del expediente agregó once acciones sin frase y once
 * de ellas eran **las de falla** —`cruce_fallido`, `medicion_fallida`,
 * `lamina_extraccion_fallida`—: justo las filas que alguien va a leer con
 * apuro, mostradas como `lamina extraccion fallida`.
 *
 * Este test es la cobranza. Barre el código buscando los lugares donde se
 * escribe una acción de auditoría y falla si alguna no está en el mapa.
 *
 * ## Cómo barre, y qué no puede ver
 *
 * Tres formas, que son las tres que usa el repo: `accion: 'x'` en la llamada a
 * `registrarAuditoria`, el literal que le llega a los helpers `auditar(...)` de
 * cada módulo, y las constantes `ACCION_* = 'x'`. Una acción armada con una
 * variable o un template no se ve desde acá: el test es una red, no una
 * demostración. Igual atrapa el caso real, que es alguien agregando una
 * llamada nueva y olvidándose de la frase.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FRASE_ACCION, frase } from '@/app/estudio/auditoria/frases';

const RAIZ = join(process.cwd(), 'src');

/**
 * `snake_case` que aparece en posición de acción pero **no lo es**.
 *
 * `rol` y `baja` son el `accion: 'rol' | 'baja'` del constructor de
 * `AccionUsuarioError` en `plataforma/usuarios.ts`: una propiedad que se llama
 * igual y vive en un tipo, no en una fila de auditoría.
 */
const NO_SON_ACCIONES = new Set(['rol', 'baja']);

const PATRONES = [
  /accion:\s*'([a-z_]+)'/g,
  /auditar[A-Za-z]*\([^,)]+,\s*(?:actor,\s*)?'([a-z_]+)'/g,
  /ACCION[A-Z_]*\s*=\s*'([a-z_]+)'/g,
];

function archivosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivosTs(ruta));
    else if (ruta.endsWith('.ts') || ruta.endsWith('.tsx')) salida.push(ruta);
  }
  return salida;
}

function accionesDelCodigo(): string[] {
  const encontradas = new Set<string>();
  for (const ruta of archivosTs(RAIZ)) {
    // El propio mapa no cuenta: es la respuesta, no la pregunta.
    if (ruta.endsWith(join('auditoria', 'frases.ts'))) continue;
    const texto = readFileSync(ruta, 'utf8');
    for (const patron of PATRONES) {
      for (const coincidencia of texto.matchAll(patron)) {
        const accion = coincidencia[1]!;
        if (!NO_SON_ACCIONES.has(accion)) encontradas.add(accion);
      }
    }
  }
  return [...encontradas].sort();
}

describe('FRASE_ACCION: ninguna acción de auditoría se muestra en snake_case', () => {
  it('el barrido encuentra acciones (si no, el test no estaría probando nada)', () => {
    expect(accionesDelCodigo().length).toBeGreaterThan(50);
  });

  it('todas las que el código escribe tienen su frase', () => {
    const sinFrase = accionesDelCodigo().filter((accion) => FRASE_ACCION[accion] === undefined);
    expect(sinFrase).toEqual([]);
  });

  it('las frases son de las que arrancan en mayúscula y no repiten la clave', () => {
    for (const [accion, texto] of Object.entries(FRASE_ACCION)) {
      expect(texto, accion).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
      expect(texto, accion).not.toContain('_');
    }
  });

  it('una acción sin frase se sigue mostrando humanizada, no en crudo', () => {
    // El fallback se queda: una fila legible a medias es mejor que una fila con
    // un identificador de base de datos adelante de una persona.
    expect(frase('accion_que_no_existe')).toBe('accion que no existe');
  });
});
