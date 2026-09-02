/**
 * La regla 6 de `tests/CLAUDE.md`, mecanizada.
 *
 * «Un fixture del mock puede tapar que algo no funciona en producción, y ya pasó
 * dos veces». Las dos veces fueron la misma forma: el fixture traía una clave
 * que el prompt real **no le pedía al modelo**, la suite validaba una salida
 * imposible y en producción el dato no aparecía nunca. La tercera fue `nivel` en
 * un `tabique`: todos los fixtures de la ola lo traían, la regla 7 de `SISTEMA`
 * lo enumeraba solo para `ambiente` y terminaba con «No inventes claves nuevas».
 * Resultado: pintura consumía `altura_local.PB` y seco preguntaba
 * `altura_local.general`, o sea la misma altura dos veces, en la obra real.
 *
 * Este test lee **el prompt de producción como texto** —no importa `claude.ts`,
 * que arrastra el SDK y la base— y cruza la lista de claves que la regla 7
 * enumera por tipo de entidad contra las que los fixtures usan. Es el mismo
 * truco de `exports-de-next.test.ts`: leer la fuente es más barato que un build
 * y señala la línea exacta.
 *
 * Qué NO chequea, a propósito: que el prompt no declare de más. Una clave
 * enumerada que ningún fixture usa es una clave que el modelo puede devolver y
 * que todavía no ejercitamos; eso no es una mentira, es cobertura pendiente.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const CLAUDE_TS = path.join(process.cwd(), 'src', 'lib', 'analysis', 'claude.ts');
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'analysis');

/**
 * Las claves que la regla 7 de `SISTEMA` enumera para cada tipo de entidad.
 *
 * Cada renglón es `   - <tipo>[ (aclaración)]: clave, clave, clave — prosa`.
 * La prosa arranca en la raya (—) y no se mira: ahí el prompt explica qué
 * significa cada clave, con backticks y comas que no son separadores.
 */
export function clavesDeclaradasPorTipo(fuente: string): Map<string, Set<string>> {
  const porTipo = new Map<string, Set<string>>();
  for (const linea of fuente.split('\n')) {
    const encabezado = /^ {3}- ([a-zñ]+)(?: \([^)]*\))?: (.*)$/.exec(linea);
    if (encabezado === null) continue;
    const [, tipo, resto] = encabezado as unknown as [string, string, string];
    const enumeracion = (resto.split(' — ')[0] as string)
      .split(',')
      .map((parte) => (parte.trim().split(' (')[0] as string).trim())
      .filter((clave) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(clave));
    porTipo.set(tipo, new Set(enumeracion));
  }
  return porTipo;
}

interface EntidadDeFixture {
  tipo: string;
  nombre?: string;
  atributos?: Record<string, unknown>;
}

/** Los fixtures de la familia de láminas: los de `busqueda/` y `cruce/` tienen otro shape. */
function fixturesDeLaminas(): { archivo: string; entidades: EntidadDeFixture[] }[] {
  return readdirSync(FIXTURES)
    .filter((entrada) => entrada.endsWith('.json'))
    .sort()
    .map((entrada) => {
      const crudo = JSON.parse(readFileSync(path.join(FIXTURES, entrada), 'utf8')) as {
        entidades?: EntidadDeFixture[];
      };
      return { archivo: entrada, entidades: crudo.entidades ?? [] };
    });
}

describe('el prompt de extracción y los fixtures del mock dicen lo mismo', () => {
  const declaradas = clavesDeclaradasPorTipo(readFileSync(CLAUDE_TS, 'utf8'));

  it('la regla 7 enumera claves para todos los tipos que los fixtures usan', () => {
    const tipos = new Set(
      fixturesDeLaminas().flatMap(({ entidades }) => entidades.map((entidad) => entidad.tipo)),
    );
    for (const tipo of [...tipos].sort()) {
      expect(declaradas.has(tipo), `\`SISTEMA\` no enumera claves para "${tipo}"`).toBe(true);
    }
  });

  /**
   * El corazón del test: una clave que un fixture usa y el prompt no pide es una
   * clave que el provider real **no puede devolver**. Verde acá, vacía en
   * producción.
   */
  it('ningún fixture usa una clave que el prompt no le pide al modelo', () => {
    const intrusas: string[] = [];
    for (const { archivo, entidades } of fixturesDeLaminas()) {
      for (const entidad of entidades) {
        const permitidas = declaradas.get(entidad.tipo) ?? new Set<string>();
        for (const clave of Object.keys(entidad.atributos ?? {})) {
          if (permitidas.has(clave)) continue;
          intrusas.push(`${archivo}: ${entidad.tipo} "${entidad.nombre ?? '?'}" → ${clave}`);
        }
      }
    }
    expect(intrusas).toEqual([]);
  });

  /**
   * El caso que originó el test, pinneado aparte: la altura de local se resuelve
   * por nivel (`altura_local.<nivel>`), así que si un tabique o un muro no
   * pueden traer su `nivel`, la pregunta de la altura se parte en dos —una por
   * `PB` para los ambientes y otra por `general` para los tabiques— y el
   * arquitecto tipea dos veces el mismo número.
   */
  it('tabique y muro pueden traer su nivel, como el ambiente', () => {
    for (const tipo of ['ambiente', 'tabique', 'muro']) {
      expect(declaradas.get(tipo)?.has('nivel'), `\`${tipo}\` sin \`nivel\``).toBe(true);
    }
  });
});
