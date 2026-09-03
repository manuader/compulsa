/**
 * Lo que la planilla dice del precio y del nivel de evidencia de un ítem.
 *
 * Es la mitad de la pantalla que se puede equivocar sin que nadie lo note: un
 * subtotal calculado sobre la cantidad neta en vez de la de compra, un total
 * que no declara cuántos ítems dejó afuera, un badge `inferido` sin decir que
 * se midió sobre el dibujo. Todo eso se ve prolijo y hace comprar mal.
 *
 * Dominio puro: sin React, sin base.
 */
import { describe, expect, it } from 'vitest';

import {
  detalleDeOrigen,
  fechaDePrecio,
  precioDeFila,
  precioEditable,
  subtotalDeItem,
  totalizar,
  type ItemValorizable,
} from '@/components/planilla/precio';
import type { PrecioEstimado } from '@/types/domain';

const DE_LISTA: PrecioEstimado = {
  unitario: 12_500,
  moneda: 'ARS',
  fuente: 'lista',
  fechaPrecio: '2026-08-20',
};

/** El índice es mensual: su fecha no tiene día, y eso es un dato. */
const DEL_INDICE: PrecioEstimado = {
  unitario: 800,
  moneda: 'ARS',
  fuente: 'indice',
  fechaPrecio: '2026-08',
};

function item(over: Partial<ItemValorizable> = {}): ItemValorizable {
  return { cantCompra: 31.68, precioJson: DE_LISTA, ...over };
}

describe('subtotalDeItem', () => {
  it('multiplica por la cantidad de COMPRA, que es lo que se paga', () => {
    // 12.500 × 31,68 (neta 26 + 12 % de desperdicio, redondeada al bulto).
    expect(subtotalDeItem(item())).toBe(396_000);
  });

  it('sin precio devuelve null, nunca cero', () => {
    expect(subtotalDeItem(item({ precioJson: null }))).toBeNull();
  });

  it('un unitario que no es un número no produce un NaN que envenene el total', () => {
    const roto: PrecioEstimado = { ...DE_LISTA, unitario: Number.NaN };
    expect(subtotalDeItem(item({ precioJson: roto }))).toBeNull();
  });
});

describe('precioDeFila', () => {
  it('formatea en es-AR y dice de dónde salió, con el día de la lista', () => {
    expect(precioDeFila(item())).toEqual({
      unitario: '$ 12.500',
      subtotal: '$ 396.000',
      detalle: 'Lista de precios del estudio · 20/08/2026',
      // La versión corta es la que entra en la celda: de dónde salió y de
      // cuándo es no pueden vivir solo en un `title`, que no existe ni en una
      // tablet ni en el papel.
      fuenteCorta: 'Lista',
      fecha: '20/08/2026',
    });
  });

  it('la versión corta nombra las tres fuentes en una palabra', () => {
    expect(precioDeFila(item({ precioJson: DEL_INDICE, cantCompra: 10 }))).toMatchObject({
      fuenteCorta: 'Índice',
      fecha: '08/2026',
    });
    const manual: PrecioEstimado = { ...DE_LISTA, fuente: 'manual', fechaPrecio: '2026-08-28' };
    expect(precioDeFila(item({ precioJson: manual }))).toMatchObject({
      fuenteCorta: 'A mano',
      fecha: '28/08/2026',
    });
  });

  it('el precio del índice muestra el mes, sin inventarle un día', () => {
    expect(precioDeFila(item({ precioJson: DEL_INDICE, cantCompra: 10 }))?.detalle).toBe(
      'Índice de precios del estudio · 08/2026',
    );
  });

  it('el precio cargado a mano se nombra como tal', () => {
    const manual: PrecioEstimado = { ...DE_LISTA, fuente: 'manual', fechaPrecio: '2026-08-28' };
    expect(precioDeFila(item({ precioJson: manual }))?.detalle).toBe(
      'Precio cargado a mano · 28/08/2026',
    );
  });

  it('sin precio no hay nada que mostrar', () => {
    expect(precioDeFila(item({ precioJson: null }))).toBeNull();
  });
});

describe('fechaDePrecio', () => {
  it('escribe el día en es-AR y el mes sin día', () => {
    expect(fechaDePrecio('2026-08-20')).toBe('20/08/2026');
    expect(fechaDePrecio('2026-08')).toBe('08/2026');
  });

  it('lo que no reconoce lo deja tal cual: mejor raro que inventado', () => {
    expect(fechaDePrecio('cuando se cotizó')).toBe('cuando se cotizó');
  });
});

describe('precioEditable', () => {
  it('coma decimal y sin separador de miles', () => {
    // Con `145.000` el parser leería 145: el punto es el decimal en es-AR.
    expect(precioEditable(145_000)).toBe('145000');
    expect(precioEditable(12_500.5)).toBe('12500,5');
  });
});

describe('totalizar', () => {
  it('suma los que tienen precio y cuenta los que no', () => {
    const total = totalizar(
      [item(), item({ precioJson: null }), item({ precioJson: DEL_INDICE, cantCompra: 10 })],
      'ARS',
    );
    // 396.000 + 8.000
    expect(total).toEqual({ monto: '$ 404.000', sinPrecio: 1 });
  });

  it('con todos los ítems valorizados no queda nada afuera', () => {
    expect(totalizar([item(), item()], 'ARS')).toEqual({ monto: '$ 792.000', sinPrecio: 0 });
  });

  it('sin ningún precio devuelve null: el cero sería una afirmación falsa', () => {
    expect(totalizar([item({ precioJson: null }), item({ precioJson: null })], 'ARS')).toBeNull();
    expect(totalizar([], 'ARS')).toBeNull();
  });

  it('respeta la moneda de la obra', () => {
    expect(totalizar([item()], 'USD')?.monto).toBe('USD 396.000');
  });
});

describe('detalleDeOrigen', () => {
  it('lo explícito no necesita explicación', () => {
    expect(detalleDeOrigen('explicito', ['A-01'])).toBeNull();
  });

  it('lo deducido cita las láminas que lo sostienen', () => {
    expect(detalleDeOrigen('deducido', ['A-01', 'A-05'])).toBe(
      'Se dedujo cruzando la documentación; el dato no está escrito en una sola lámina. Láminas: A-01, A-05.',
    );
  });

  it('lo inferido dice que se midió sobre el dibujo, que es lo más débil', () => {
    const texto = detalleDeOrigen('inferido', ['A-01']);
    expect(texto).toContain('Se midió sobre el dibujo a escala (medición gráfica)');
    expect(texto).toContain('la más débil de las evidencias');
    expect(texto).toContain('Láminas: A-01.');
  });

  it('lo supuesto dice qué evidencia falta, no de qué módulo nuestro salió', () => {
    // Sus dos hermanos describen la evidencia («no está escrito en una sola
    // lámina», «se midió sobre el dibujo»); este nombraba «la plantilla del
    // rubro», que es arquitectura nuestra y no le dice nada al arquitecto.
    expect(detalleDeOrigen('supuesto', [])).toBe(
      'Ninguna lámina lo dice: se computó sobre un supuesto declarado, que queda a la vista para que lo confirmes.',
    );
  });
});
