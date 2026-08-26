/**
 * Shortlist de proveedores para un rubro (RF-802).
 *
 * Dominio puro: entra la agenda del estudio y sale el orden en el que hay que
 * ofrecerla. Dos invariantes valen más que el ranking:
 *
 *  1. **`opt_out` jamás entra** (PRD §13). No es un criterio de orden: es un
 *     filtro, y por eso se testea con un proveedor que ganaría todos los
 *     desempates si se lo dejara competir.
 *  2. **El orden es determinístico**: mismo input, mismo output, sin `Date.now()`
 *     ni azar. El desempate final es el nombre, así que nunca hay dos corridas
 *     con dos listas distintas.
 */
import { describe, expect, it } from 'vitest';

import { armarShortlist, type ProveedorShortlist } from '@/lib/proveedores/shortlist';

function proveedor(datos: Partial<ProveedorShortlist> & { id: string; nombre: string }): ProveedorShortlist {
  return {
    rubros: ['aberturas'],
    zona: 'CABA',
    optInWa: false,
    optOut: false,
    score: null,
    ...datos,
  };
}

/** El pin: seis proveedores, los cuatro grupos cubiertos y un opt_out que no entra. */
const AGENDA: ProveedorShortlist[] = [
  proveedor({ id: 'p1', nombre: 'Aberturas Sur', optInWa: true, score: 0.7, zona: 'Quilmes' }),
  proveedor({ id: 'p2', nombre: 'Vidriería Central', optInWa: true, score: 0.9, zona: 'Rosario' }),
  proveedor({ id: 'p3', nombre: 'Zingueria Oeste', zona: 'caba' }),
  proveedor({ id: 'p4', nombre: 'Aluminios Litoral', zona: 'Rosario' }),
  proveedor({ id: 'p5', nombre: 'Carpintería Norte', optInWa: true, score: 0.5, zona: 'CABA' }),
  proveedor({
    id: 'p6',
    nombre: 'Aberturas Prohibidas',
    optInWa: true,
    optOut: true,
    score: 1,
    zona: 'CABA',
  }),
];

// `p1` cotizó dos veces; `p2` y `p5` nunca (no están en el mapa o están en cero).
const HISTORICO = new Map<string, number>([
  ['p1', 2],
  ['p5', 0],
  ['p6', 9],
]);

describe('armarShortlist', () => {
  it('ordena por los cuatro grupos y deja el opt_out afuera', () => {
    const shortlist = armarShortlist(AGENDA, 'aberturas', 'CABA', HISTORICO);

    expect(shortlist.map((r) => r.proveedor.id)).toEqual(['p1', 'p2', 'p5', 'p3', 'p4']);
    expect(shortlist.map((r) => r.grupo)).toEqual([
      'red_con_historial',
      'red',
      'red',
      'zona',
      'resto',
    ]);
    expect(shortlist).toHaveLength(5);
    expect(shortlist.some((r) => r.proveedor.id === 'p6')).toBe(false);
  });

  it('expone cuántas veces cotizó cada uno, que es lo que la pantalla muestra', () => {
    const shortlist = armarShortlist(AGENDA, 'aberturas', 'CABA', HISTORICO);

    expect(shortlist[0].cotizaciones).toBe(2);
    expect(shortlist[1].cotizaciones).toBe(0);
    expect(shortlist[3].cotizaciones).toBe(0);
  });

  it('un opt_out con historial e invitación aceptada tampoco entra', () => {
    // El caso que importa: `p6` es opt-in, tiene el mejor score y el mejor
    // historial. Si el filtro fuera un criterio de orden, saldría primero.
    const soloProhibido = armarShortlist([AGENDA[5]], 'aberturas', 'CABA', HISTORICO);
    expect(soloProhibido).toEqual([]);
  });

  it('dentro del grupo manda el score desc y el null va último', () => {
    const conNull = [
      proveedor({ id: 'a', nombre: 'Zeta', optInWa: true, score: 0.4 }),
      proveedor({ id: 'b', nombre: 'Alfa', optInWa: true, score: null }),
      proveedor({ id: 'c', nombre: 'Beta', optInWa: true, score: 0.8 }),
    ];

    const shortlist = armarShortlist(conNull, 'aberturas', 'CABA', new Map());
    expect(shortlist.map((r) => r.proveedor.id)).toEqual(['c', 'a', 'b']);
  });

  it('con el mismo score desempata el nombre, no el orden de la agenda', () => {
    const empatados = [
      proveedor({ id: 'z', nombre: 'Zapata Aberturas', score: 0.6 }),
      proveedor({ id: 'a', nombre: 'Ábalos Aberturas', score: 0.6 }),
      proveedor({ id: 'm', nombre: 'Medina Aberturas', score: 0.6 }),
    ];

    const shortlist = armarShortlist(empatados, 'aberturas', 'CABA', new Map());
    expect(shortlist.map((r) => r.proveedor.id)).toEqual(['a', 'm', 'z']);
  });

  it('la zona matchea normalizada: «caba», «CABA» y «Caba » son la misma', () => {
    const shortlist = armarShortlist(AGENDA, 'aberturas', ' Caba ', new Map());

    // Sin historial los tres opt-in caen juntos en «red» y los ordena el score;
    // p3 es el único que entra por zona (su 'caba' matchea el ' Caba ' pedido).
    expect(shortlist.map((r) => r.proveedor.id)).toEqual(['p2', 'p1', 'p5', 'p3', 'p4']);
    expect(shortlist.find((r) => r.proveedor.id === 'p3')?.grupo).toBe('zona');
  });

  it('solo entran los proveedores del rubro pedido', () => {
    const mezcla = [
      proveedor({ id: 'pin', nombre: 'Pinturería', rubros: ['pintura'] }),
      proveedor({ id: 'mix', nombre: 'Corralón', rubros: ['gruesa', 'aberturas'] }),
    ];

    expect(armarShortlist(mezcla, 'aberturas', 'CABA', new Map()).map((r) => r.proveedor.id)).toEqual(
      ['mix'],
    );
  });

  it('una agenda vacía devuelve una lista vacía, no un error', () => {
    expect(armarShortlist([], 'seco', 'CABA', new Map())).toEqual([]);
  });
});
