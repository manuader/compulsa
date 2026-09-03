/**
 * Precios del estudio: la cascada que decide de dónde sale un precio y el
 * parser del CSV de la lista de referencia (§5.6).
 *
 * Las dos piezas son **puras**: sin base, sin reloj, sin red. El precio lo
 * calcula el recompute con lo que le pasan, y el CSV se parsea igual en el
 * navegador (preview) que en el server (persistencia).
 *
 * Lo que estos tests protegen:
 *
 *  1. **La IA jamás pone un precio.** `fuente` solo puede ser `manual`,
 *     `lista` o `indice`, y el orden entre las tres está pinneado.
 *  2. **Una línea mala no rompe el archivo** (misma promesa que el import de
 *     proveedores): las buenas entran y las malas salen con su número de línea.
 *  3. **Coma decimal.** El CSV sale de un Excel argentino: `"12,50"` son doce
 *     pesos con cincuenta, no mil doscientos cincuenta.
 */
import { describe, expect, it } from 'vitest';

import { importarCsvPrecios, parsearPrecio } from '@/lib/precios/import-csv';
import {
  admiteIndice,
  CLAVES_CON_INDICE,
  MONEDA_DEFAULT,
  resolverPrecio,
} from '@/lib/precios/resolver';
import type { PrecioEstimado, Unidad } from '@/types/domain';

// ---------------------------------------------------------------------------
// Cascada
// ---------------------------------------------------------------------------

const MANUAL: PrecioEstimado = {
  unitario: 100,
  moneda: 'ARS',
  fuente: 'manual',
  fechaPrecio: '2026-08-20',
};

/** La lista del estudio, tal cual la arma el recompute: por `claveItem`. */
function lista(precio: number, unidad: Unidad = 'm2') {
  return new Map([['seco.placas', { precio, moneda: 'ARS', unidad, fecha: '2026-08-10' }]]);
}

describe('resolverPrecio: la cascada del §5.6', () => {
  const item = { claveItem: 'seco.placas', unidad: 'm2' as const };

  it('con las tres fuentes gana el precio manual del ítem', () => {
    const precio = resolverPrecio({ ...item, precioManual: MANUAL }, lista(90), {
      p50: 80,
      mes: '2026-08',
      n: 5,
    });

    expect(precio).toEqual({
      unitario: 100,
      moneda: 'ARS',
      fuente: 'manual',
      fechaPrecio: '2026-08-20',
    });
  });

  it('sin manual gana la lista del estudio, con la fecha de la fila', () => {
    const precio = resolverPrecio(item, lista(90), { p50: 80, mes: '2026-08', n: 5 });

    expect(precio).toEqual({
      unitario: 90,
      moneda: 'ARS',
      fuente: 'lista',
      fechaPrecio: '2026-08-10',
    });
  });

  it('con el índice solo, el p50 del mes más reciente', () => {
    const precio = resolverPrecio(item, new Map(), { p50: 80, mes: '2026-08', n: 5 });

    expect(precio).toEqual({
      unitario: 80,
      moneda: MONEDA_DEFAULT,
      fuente: 'indice',
      // El índice es mensual: la fecha del precio es el mes, sin día. Ponerle un
      // día sería inventar precisión que la fila no tiene.
      fechaPrecio: '2026-08',
    });
  });

  it('sin ninguna de las tres devuelve null, no cero', () => {
    expect(resolverPrecio(item, new Map(), null)).toBeNull();
  });

  it('un índice sin muestras (n = 0) no es un precio', () => {
    expect(resolverPrecio(item, new Map(), { p50: 80, mes: '2026-08', n: 0 })).toBeNull();
  });

  it('la lista matchea por clave exacta: una clave parecida no cuenta', () => {
    const precio = resolverPrecio({ claveItem: 'seco.placas.verdes', unidad: 'm2' }, lista(90), null);
    expect(precio).toBeNull();
  });

  it('el precio manual se devuelve siempre con fuente «manual», aunque llegue mal etiquetado', () => {
    const malEtiquetado: PrecioEstimado = { ...MANUAL, fuente: 'indice' };
    const precio = resolverPrecio({ ...item, precioManual: malEtiquetado }, lista(90), null);

    expect(precio?.fuente).toBe('manual');
    expect(precio?.unitario).toBe(100);
  });

  it('un manual con un unitario que no es número se saltea y sigue la cascada', () => {
    const roto = { ...MANUAL, unitario: Number.NaN };
    const precio = resolverPrecio({ ...item, precioManual: roto }, lista(90), null);

    expect(precio).toEqual({
      unitario: 90,
      moneda: 'ARS',
      fuente: 'lista',
      fechaPrecio: '2026-08-10',
    });
  });

  it('la moneda de la lista viaja al ítem: no se asume que todo es en pesos', () => {
    const enDolares = new Map([
      ['seco.placas', { precio: 90, moneda: 'USD', unidad: 'm2' as const, fecha: '2026-08-10' }],
    ]);

    expect(resolverPrecio(item, enDolares, null)?.moneda).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
// La unidad de la lista contra la del ítem
// ---------------------------------------------------------------------------

describe('resolverPrecio: la unidad de la fila tiene que ser la del ítem', () => {
  const item = { claveItem: 'seco.placas', unidad: 'm2' as const };

  it('una fila por unidad contra un ítem por m² no se usa: sigue la cascada', () => {
    // El caso del CSV: `seco.placas / u / 45000`. El subtotal multiplica el
    // unitario por `cantCompra`, que está en m²; usar esa fila da un número que
    // se ve bien, está mal, y entra al total de la obra y al XLSX.
    const precio = resolverPrecio(item, lista(45000, 'u'), null);
    expect(precio).toBeNull();
  });

  it('con la unidad mal, cae al índice en vez de mentir', () => {
    const precio = resolverPrecio(item, lista(45000, 'u'), { p50: 80, mes: '2026-08', n: 5 });
    expect(precio).toEqual({
      unitario: 80,
      moneda: MONEDA_DEFAULT,
      fuente: 'indice',
      fechaPrecio: '2026-08',
    });
  });

  it('con la unidad bien, la fila se usa como siempre', () => {
    expect(resolverPrecio(item, lista(45000, 'm2'), null)?.unitario).toBe(45000);
  });

  it('el precio manual del arquitecto no pasa por el chequeo: es suyo', () => {
    const precio = resolverPrecio({ ...item, precioManual: MANUAL }, lista(45000, 'u'), null);
    expect(precio?.fuente).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// El índice solo costea claves comparables entre obras
// ---------------------------------------------------------------------------

describe('resolverPrecio: el índice no cruza obras por una clave de esta obra', () => {
  const CORTE = { p50: 80, mes: '2026-08', n: 5 };

  /**
   * `aberturas.V1` es la ventana que **en esta obra** se llama V1. En la obra de
   * al lado, V1 es otra cosa. `price_index` es único por
   * `(estudio, clave_item, zona, mes)` y se alimenta de las adjudicaciones con
   * estas mismas claves: sin el filtro, adjudicar una le pone precio a la otra
   * y la planilla lo muestra con `fuente: 'indice'` y una fecha, como si fuera
   * evidencia.
   */
  it.each([
    ['aberturas.V1', 'u'],
    ['aberturas.P2', 'u'],
    ['terminaciones.solado.porcelanato_beige', 'm2'],
    ['terminaciones.revestimiento.ceramico_blanco', 'm2'],
    ['sanitaria.artefacto.inodoro_1', 'u'],
    ['sanitaria.canieria.cloacal.110', 'ml'],
    ['sanitaria.accesorio.codo90.110', 'u'],
  ] as const)('no costea %s con el índice', (claveItem, unidad) => {
    expect(resolverPrecio({ claveItem, unidad }, new Map(), CORTE)).toBeNull();
  });

  it.each([
    ['seco.placas', 'm2'],
    ['seco.tornillos', 'u'],
    ['pintura.latex_paredes', 'l'],
    ['gruesa.cemento', 'kg'],
    ['terminaciones.contrapiso', 'm2'],
    ['demolicion.muros', 'm2'],
    ['electrica.boca.toma', 'u'],
  ] as const)('sí costea %s: la clave es literal de la plantilla', (claveItem, unidad) => {
    expect(resolverPrecio({ claveItem, unidad }, new Map(), CORTE)?.fuente).toBe('indice');
  });

  it('la lista del estudio no pasa por el filtro: esa fila la cargó una persona', () => {
    const propia = new Map([
      ['aberturas.V1', { precio: 320000, moneda: 'ARS', unidad: 'u' as const, fecha: '2026-08-10' }],
    ]);
    const precio = resolverPrecio({ claveItem: 'aberturas.V1', unidad: 'u' }, propia, CORTE);
    expect(precio?.fuente).toBe('lista');
    expect(precio?.unitario).toBe(320000);
  });

  it('`admiteIndice` es la lista blanca, y está enumerada', () => {
    expect(admiteIndice('seco.masilla')).toBe(true);
    expect(admiteIndice('aberturas.V1')).toBe(false);
    expect(CLAVES_CON_INDICE.size).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('importarCsvPrecios: el CSV de la lista del estudio', () => {
  it('lee las cuatro columnas obligatorias con separador coma', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        'aberturas.ventana.dvh,Ventana DVH de aluminio,m2,145000',
        'seco.placa.durlock,Placa de durlock 12.5,u,18500',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    expect(filas).toEqual([
      {
        linea: 2,
        claveItem: 'aberturas.ventana.dvh',
        descripcion: 'Ventana DVH de aluminio',
        unidad: 'm2',
        precio: 145000,
      },
      {
        linea: 3,
        claveItem: 'seco.placa.durlock',
        descripcion: 'Placa de durlock 12.5',
        unidad: 'u',
        precio: 18500,
      },
    ]);
  });

  it('con punto y coma y comillas: la coma de adentro es texto, no separador', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item;descripcion;unidad;precio',
        'pintura.latex.interior;"Látex interior, mate";l;"12,50"',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    expect(filas).toHaveLength(1);
    expect(filas[0].descripcion).toBe('Látex interior, mate');
    // El pin del plan: coma decimal.
    expect(filas[0].precio).toBe(12.5);
  });

  it('lee la coma decimal con separador de miles', () => {
    const { filas } = importarCsvPrecios(
      ['clave_item,descripcion,unidad,precio', 'gruesa.ladrillo,Ladrillo hueco,u,"1.234,50"'].join(
        '\n',
      ),
    );

    expect(filas[0].precio).toBe(1234.5);
  });

  it('con los dos separadores manda el último: el CSV puede venir de un Excel en inglés', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        'a.b,Local,u,"1.234,50"',
        'c.d,Inglés,u,"1,234.50"',
        'e.f,Inglés con miles,u,"1,234,500.75"',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    // Leer «1,234.50» con la regla local daría 1,2345: un precio dividido por
    // mil, en silencio. Por eso el último separador es el decimal.
    expect(filas.map((fila) => fila.precio)).toEqual([1234.5, 1234.5, 1234500.75]);
  });

  it('un separador solo, una sola vez, es SIEMPRE el decimal: esta app es es-AR', () => {
    const { filas } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        'a.b,Uno,u,12.50',
        'c.d,Dos,u,1.234',
        'e.f,Tres,u,$ 2 500',
        'g.h,Cuatro,u,"1,234"',
        'i.j,Cinco,u,"0,1234"',
      ].join('\n'),
    );

    // «1,234» es uno con doscientos treinta y cuatro, NO mil doscientos treinta
    // y cuatro: leerlo como miles sería multiplicar el precio por mil por
    // adivinar un idioma que nadie declaró. Y «1.234» es lo mismo, por simetría.
    expect(filas.map((fila) => fila.precio)).toEqual([12.5, 1.234, 2500, 1.234, 0.1234]);
  });

  it('un separador repetido no puede ser el decimal: ahí sí es de miles', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        'a.b,Con puntos,u,1.234.500',
        'c.d,Con comas,u,"1,234,500"',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    expect(filas.map((fila) => fila.precio)).toEqual([1234500, 1234500]);
  });

  it('un separador repetido que no arma grupos de miles no es un número', () => {
    const { filas, errores } = importarCsvPrecios(
      ['clave_item,descripcion,unidad,precio', 'a.b,Roto,u,1.2.3'].join('\n'),
    );

    expect(filas).toEqual([]);
    expect(errores[0].linea).toBe(2);
  });

  it('una unidad que no existe se reporta con su línea y esa fila no entra', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        'aberturas.ventana.dvh,Ventana DVH,m2,145000',
        'seco.perfil.montante,Montante,xx,4200',
        'pintura.latex,Látex,l,9800',
      ].join('\n'),
    );

    expect(filas.map((fila) => fila.claveItem)).toEqual(['aberturas.ventana.dvh', 'pintura.latex']);
    expect(errores).toHaveLength(1);
    expect(errores[0].linea).toBe(3);
    expect(errores[0].motivo).toContain('xx');
    expect(errores[0].motivo).toContain('m2');
  });

  it('normaliza las unidades que un Excel escribe distinto', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        'a.b,Solado,M²,45000',
        'c.d,Zócalo,ML,3200',
        'e.f,Artefacto,Un.,90000',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    expect(filas.map((fila) => fila.unidad)).toEqual(['m2', 'ml', 'u']);
  });

  it('la fecha es opcional y acepta el formato del Excel argentino', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio,fecha',
        'a.b,Con fecha ISO,u,100,2026-08-10',
        'c.d,Con fecha AR,u,200,31/12/2026',
        'e.f,Sin fecha,u,300,',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    expect(filas.map((fila) => fila.fecha)).toEqual(['2026-08-10', '2026-12-31', undefined]);
  });

  it('una fecha que no existe en el calendario es un error de línea', () => {
    const { filas, errores } = importarCsvPrecios(
      ['clave_item,descripcion,unidad,precio,fecha', 'a.b,Imposible,u,100,2026-02-30'].join('\n'),
    );

    expect(filas).toEqual([]);
    expect(errores).toEqual([
      { linea: 2, motivo: 'La fecha «2026-02-30» no existe. Escribila como 2026-08-26.' },
    ]);
  });

  it('un precio que no es un número, o que no es positivo, no entra', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        'a.b,A convenir,u,a convenir',
        'c.d,Regalado,u,0',
        'e.f,Bien,u,100',
      ].join('\n'),
    );

    expect(filas.map((fila) => fila.claveItem)).toEqual(['e.f']);
    expect(errores.map((error) => error.linea)).toEqual([2, 3]);
  });

  it('sin clave de ítem o sin descripción no hay fila', () => {
    const { filas, errores } = importarCsvPrecios(
      [
        'clave_item,descripcion,unidad,precio',
        ',Sin clave,u,100',
        'a.b,,u,100',
        'c.d,Bien,u,100',
      ].join('\n'),
    );

    expect(filas.map((fila) => fila.claveItem)).toEqual(['c.d']);
    expect(errores.map((error) => error.linea)).toEqual([2, 3]);
  });

  it('sin la cabecera esperada no importa nada y dice qué falta', () => {
    const { filas, errores } = importarCsvPrecios('nombre,zona\nAlgo,CABA');

    expect(filas).toEqual([]);
    expect(errores).toHaveLength(1);
    expect(errores[0].linea).toBe(1);
    expect(errores[0].motivo).toContain('clave_item');
  });

  it('tolera BOM, CRLF, tildes en la cabecera y filas vacías del Excel', () => {
    const { filas, errores } = importarCsvPrecios(
      '﻿Clave Item;Descripción;Unidad;Precio\r\na.b;X;u;1\r\n;;;\r\n',
    );

    expect(errores).toEqual([]);
    expect(filas).toHaveLength(1);
  });

  it('una línea con más columnas que la cabecera está corrida: es un error, no una fila', () => {
    const { filas, errores } = importarCsvPrecios(
      ['clave_item,descripcion,unidad,precio', 'a.b,Detalle, con coma sin comillas,u,100'].join(
        '\n',
      ),
    );

    expect(filas).toEqual([]);
    expect(errores).toHaveLength(1);
    expect(errores[0].linea).toBe(2);
  });

  // El formulario de alta y edición manda el precio como texto y lo lee con
  // este mismo parser (`guardarPrecioAction`), así que el valor que la pantalla
  // pone en el input tiene que volver a entrar igual. Con separador de miles no
  // volvía: «145.000» es un punto solo y un punto solo es el decimal.
  it('lo que la pantalla pone en el input vuelve a entrar sin cambiar de valor', () => {
    const comoLoEscribeLaPantalla = (n: number): string =>
      Number.isInteger(n) ? String(n) : String(n).replace('.', ',');

    for (const precio of [145000, 18500.5, 12.56, 9800, 0.5, 1234500]) {
      expect(parsearPrecio(comoLoEscribeLaPantalla(precio))).toBe(precio);
    }
  });

  it('sin texto no explota: lo dice y devuelve el error en la línea 1', () => {
    expect(importarCsvPrecios('   ')).toEqual({
      filas: [],
      errores: [{ linea: 1, motivo: 'Pegá el CSV: no llegó ninguna línea.' }],
    });
  });
});
