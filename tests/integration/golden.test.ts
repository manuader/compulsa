/**
 * El golden set como suite: `npm test` protege la precisión igual que
 * `npm run golden` (RNF-1), con el mismo harness (`scripts/golden-check.ts`).
 *
 * Dos mitades:
 *
 *  - **La corrida real:** cada obra de `tests/golden/` se procesa con el
 *    pipeline completo sobre PGlite en memoria y se compara contra su
 *    `expected-computo.json`, escrito a mano. Hoy el error es CERO en los 15
 *    ítems: el 2 % de RNF-1 es el techo del contrato, no el objetivo. Si este
 *    test se pone en rojo, o el cambio está mal o el esperado está mal —
 *    decidilo y dejalo escrito en el commit (`tests/CLAUDE.md` §3).
 *  - **El harness en sí:** los tres modos de fallo (ítem esperado ausente, ítem
 *    extra, rubro por encima del umbral) se ejercitan sobre el núcleo puro. Un
 *    harness que no sabe ponerse en rojo no protege nada.
 */
import { describe, expect, it } from 'vitest';

import {
  agruparPorRubro,
  compararComputo,
  correrCasoGolden,
  errorRelativo,
  listarCasosGolden,
  motivosDeFallo,
  rubroDeClave,
  tablaGolden,
  UMBRAL_ERROR_RUBRO,
  type ConfigGolden,
  type ItemEsperado,
  type ResultadoGolden,
} from '../../scripts/golden-check';

/** Correr un caso cuesta unos segundos: se corre una vez y se comparte. */
const corridas = new Map<string, Promise<ResultadoGolden>>();

function correr(caso: string): Promise<ResultadoGolden> {
  const previa = corridas.get(caso);
  if (previa) return previa;
  const corrida = correrCasoGolden(caso);
  corridas.set(caso, corrida);
  return corrida;
}

/** El pipeline corre de verdad (split de PDF + pdfjs + migraciones): no es un unit test. */
const TIMEOUT_MS = 120_000;

const CONFIG_DEMO: ConfigGolden = {
  nombre: 'Casa Demo — golden',
  tipoObra: 'nueva',
  zona: 'CABA',
  documentos: ['tests/fixtures/pdfs/obra-demo.pdf'],
  validarDeducciones: false,
};

function esperado(claveItem: string, cantCompra: number): ItemEsperado {
  return { claveItem, cantCompra };
}

describe('golden set — corrida real del pipeline', () => {
  it(
    'todos los casos quedan dentro del contrato de precisión (RNF-1)',
    async () => {
      const casos = await listarCasosGolden();
      expect(casos).toEqual(['obra-demo', 'obra-reforma']);

      for (const caso of casos) {
        const resultado = await correr(caso);
        console.log(`\nGolden «${caso}» — ${resultado.config.nombre}\n${tablaGolden(resultado)}`);

        expect(resultado.ausentes, `ítems esperados que no salieron en ${caso}`).toEqual([]);
        expect(resultado.extras, `ítems no esperados que salieron en ${caso}`).toEqual([]);
        for (const fila of resultado.porRubro) {
          expect(fila.errorProm, `error promedio de ${fila.rubro} en ${caso}`).toBeLessThanOrEqual(
            UMBRAL_ERROR_RUBRO,
          );
        }
        expect(motivosDeFallo(resultado)).toEqual([]);
        expect(resultado.ok).toBe(true);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'obra-demo computa exactamente los 15 ítems esperados',
    async () => {
      const resultado = await correr('obra-demo');

      expect(resultado.comparaciones).toHaveLength(15);
      expect(resultado.porRubro.map((f) => [f.rubro, f.items])).toEqual([
        ['aberturas', 3],
        ['seco', 6],
        ['pintura', 2],
        ['gruesa', 4],
      ]);

      // El esperado se derivó a mano de los fixtures: la coincidencia es exacta,
      // no "dentro del 2 %". Un desvío acá es una decisión, no un redondeo.
      const desviados = resultado.comparaciones.filter((c) => c.error !== 0);
      expect(desviados).toEqual([]);

      const reales = new Map(resultado.comparaciones.map((c) => [c.claveItem, c.real]));
      expect(reales.get('aberturas.V1')).toBe(1);
      expect(reales.get('aberturas.P1')).toBe(1);
      expect(reales.get('aberturas.P2')).toBe(1);
      expect(reales.get('seco.placas')).toBe(31.68);
      expect(reales.get('seco.soleras')).toBe(10.4);
      expect(reales.get('seco.montantes')).toBe(14);
      expect(reales.get('seco.tornillos')).toBe(500);
      expect(reales.get('seco.masilla')).toBe(30);
      expect(reales.get('seco.cinta')).toBe(90);
      expect(reales.get('pintura.latex_paredes')).toBe(17);
      expect(reales.get('pintura.latex_cielorrasos')).toBe(7);
      expect(reales.get('gruesa.ladrillos')).toBe(396);
      expect(reales.get('gruesa.cemento')).toBe(150);
      expect(reales.get('gruesa.cal')).toBe(200);
      expect(reales.get('gruesa.arena')).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    'obra-reforma computa los 11 ítems de una reforma con deducciones validadas',
    async () => {
      const resultado = await correr('obra-reforma');

      expect(resultado.comparaciones).toHaveLength(11);
      expect(resultado.porRubro.map((f) => [f.rubro, f.items])).toEqual([
        ['aberturas', 2],
        ['seco', 6],
        ['pintura', 2],
        ['gruesa', 1],
      ]);
      expect(resultado.comparaciones.filter((c) => c.error !== 0)).toEqual([]);

      const reales = new Map(resultado.comparaciones.map((c) => [c.claveItem, c.real]));
      // La ventana sin acotar en la planta: la deducción «planilla ↔ plano»
      // validada le da las medidas, y es UNA sola (la planilla no suma).
      expect(reales.get('aberturas.V5')).toBe(1);
      expect(reales.get('aberturas.P3')).toBe(1);
      // El origen es lo que prueba que la deducción corrió: la cantidad sola no
      // distingue "salió de la deducción" de "salió solo de la planilla".
      expect(resultado.origenes['aberturas.V5']).toBe('deducido');
      expect(resultado.origenes['aberturas.P3']).toBe('deducido');
      expect(resultado.origenes['gruesa.demolicion']).toBe('explicito');
      // El tabique existente no aporta un metro: 4 × 2,50 × 2 = 20 m², no 35.
      expect(reales.get('seco.placas')).toBe(23.04);
      expect(reales.get('seco.montantes')).toBe(11);
      // El muro a demoler no compra materiales, solo m² de demolición.
      expect(reales.get('gruesa.demolicion')).toBe(10.4);
      expect(reales.get('gruesa.ladrillos')).toBeUndefined();
      expect(reales.get('pintura.latex_paredes')).toBe(6);
      expect(reales.get('pintura.latex_cielorrasos')).toBe(2);
    },
    TIMEOUT_MS,
  );
});

describe('el harness sabe ponerse en rojo', () => {
  it('lista por nombre el ítem esperado que el pipeline no emitió', () => {
    const resultado = compararComputo(
      'demo',
      CONFIG_DEMO,
      [esperado('seco.placas', 31.68), esperado('seco.perfileria', 4)],
      new Map([['seco.placas', 31.68]]),
    );

    expect(resultado.ausentes).toEqual(['seco.perfileria']);
    expect(resultado.ok).toBe(false);
    expect(motivosDeFallo(resultado)).toEqual([
      'falta el ítem esperado "seco.perfileria": el pipeline no lo emitió.',
    ]);
  });

  it('lista por nombre el ítem que salió sin estar esperado', () => {
    const resultado = compararComputo(
      'demo',
      CONFIG_DEMO,
      [esperado('aberturas.V1', 1)],
      new Map([
        ['aberturas.V1', 1],
        ['aberturas.P2', 1],
      ]),
    );

    expect(resultado.extras).toEqual(['aberturas.P2']);
    expect(resultado.ok).toBe(false);
    expect(motivosDeFallo(resultado)).toEqual([
      'el pipeline emitió "aberturas.P2", que el golden no espera.',
    ]);
  });

  it('falla el rubro que promedia más de 2 % de error, y no el que se mantiene abajo', () => {
    const resultado = compararComputo(
      'demo',
      CONFIG_DEMO,
      [
        esperado('gruesa.ladrillos', 396),
        esperado('gruesa.arena', 1),
        esperado('seco.placas', 100),
        esperado('seco.cinta', 90),
      ],
      new Map([
        ['gruesa.ladrillos', 396], // 0 %
        ['gruesa.arena', 0.5], // 50 % ⇒ el rubro promedia 25 %
        ['seco.placas', 103], // 3 %
        ['seco.cinta', 90], // 0 % ⇒ el rubro promedia 1,5 %, pasa
      ]),
    );

    const porRubro = new Map(resultado.porRubro.map((f) => [f.rubro, f]));
    expect(porRubro.get('gruesa')?.errorProm).toBe(0.25);
    expect(porRubro.get('gruesa')?.errorMax).toBe(0.5);
    expect(porRubro.get('seco')?.errorProm).toBe(0.015);
    expect(porRubro.get('seco')?.errorMax).toBe(0.03);

    expect(resultado.ok).toBe(false);
    expect(motivosDeFallo(resultado)).toEqual([
      'el rubro gruesa promedia 25,00 % de error, por encima del 2,00 % que tolera RNF-1.',
    ]);
  });

  it('un rubro que promedia exactamente 2 % pasa: el umbral es el techo, no la frontera', () => {
    const resultado = compararComputo(
      'demo',
      CONFIG_DEMO,
      [esperado('seco.placas', 100), esperado('seco.cinta', 100)],
      new Map([
        ['seco.placas', 104], // 4 %
        ['seco.cinta', 100], // 0 % ⇒ promedio 2 %
      ]),
    );

    expect(resultado.porRubro[0]?.errorProm).toBe(UMBRAL_ERROR_RUBRO);
    expect(resultado.ok).toBe(true);
    expect(motivosDeFallo(resultado)).toEqual([]);
  });
});

describe('núcleo del harness', () => {
  it('deriva el rubro del prefijo de la clave y rechaza una clave sin rubro', () => {
    expect(rubroDeClave('seco.placas')).toBe('seco');
    expect(rubroDeClave('aberturas.retiro.V2')).toBe('aberturas');
    expect(() => rubroDeClave('zocalos.madera')).toThrow(/no empieza con un rubro conocido/);
  });

  it('con esperado 0 el error es 0 si coincide y 100 % si no', () => {
    expect(errorRelativo(0, 0)).toBe(0);
    expect(errorRelativo(0, 3)).toBe(1);
    expect(errorRelativo(400, 396)).toBe(0.01);
  });

  it('agrupa por rubro en el orden canónico y saltea los rubros sin ítems', () => {
    const filas = agruparPorRubro([
      { claveItem: 'gruesa.cal', rubro: 'gruesa', esperado: 200, real: 200, error: 0 },
      { claveItem: 'seco.placas', rubro: 'seco', esperado: 100, real: 90, error: 0.1 },
      { claveItem: 'seco.cinta', rubro: 'seco', esperado: 100, real: 100, error: 0 },
    ]);

    expect(filas.map((f) => f.rubro)).toEqual(['seco', 'gruesa']);
    expect(filas[0]).toEqual({ rubro: 'seco', items: 2, errorMax: 0.1, errorProm: 0.05 });
  });
});
