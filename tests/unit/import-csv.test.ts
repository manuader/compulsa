/**
 * Import de la agenda de proveedores desde un CSV pegado a mano.
 *
 * `importarCsv` es puro: no toca la base y no persiste nada. Lo que se protege
 * acá es la promesa que hace la pantalla de import — **una línea mala no rompe
 * el archivo**: las buenas entran igual y las malas salen con su número de línea
 * y un motivo en castellano que le dice al usuario qué arreglar.
 */
import { describe, expect, it } from 'vitest';

import { importarCsv, normalizarNombre } from '@/lib/proveedores/import-csv';

describe('cabecera y separador', () => {
  it('autodetecta la coma y mapea las cinco columnas', () => {
    const { filas, errores } = importarCsv(
      [
        'nombre,rubros,zona,telefono,email',
        'Corralón del Norte,gruesa|seco,San Isidro,11-4444-5555,ventas@corralon.ar',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    expect(filas).toEqual([
      {
        nombre: 'Corralón del Norte',
        rubros: ['gruesa', 'seco'],
        zona: 'San Isidro',
        telefono: '11-4444-5555',
        email: 'ventas@corralon.ar',
      },
    ]);
  });

  it('autodetecta el punto y coma por la cabecera (el Excel argentino exporta así)', () => {
    const { filas, errores } = importarCsv(
      ['nombre;rubros;zona;telefono;email', 'Aberturas Sur;aberturas;Quilmes;;info@sur.ar'].join(
        '\n',
      ),
    );

    expect(errores).toEqual([]);
    expect(filas).toHaveLength(1);
    expect(filas[0].nombre).toBe('Aberturas Sur');
    expect(filas[0].telefono).toBeNull();
    expect(filas[0].email).toBe('info@sur.ar');
  });

  it('tolera BOM, comillas, espacios y tildes en los nombres de columna', () => {
    const { filas, errores } = importarCsv(
      [
        '﻿"Nombre" ; " Rubros " ; "Zona" ; "Teléfono" ; "E-mail"',
        '"  Vidriería Central  " ; " Aberturas | Pintura " ; " CABA " ; " 11 5555 6666 " ; " hola@vidrieria.ar "',
      ].join('\r\n'),
    );

    expect(errores).toEqual([]);
    expect(filas).toEqual([
      {
        nombre: 'Vidriería Central',
        rubros: ['aberturas', 'pintura'],
        zona: 'CABA',
        telefono: '11 5555 6666',
        email: 'hola@vidrieria.ar',
      },
    ]);
  });

  it('respeta el separador adentro de las comillas', () => {
    const { filas, errores } = importarCsv(
      [
        'nombre,rubros,zona,telefono,email',
        '"Pinturería López, S.A.",pintura,"Vicente López, Munro",11-2222-3333,ventas@lopez.ar',
      ].join('\n'),
    );

    expect(errores).toEqual([]);
    expect(filas[0].nombre).toBe('Pinturería López, S.A.');
    expect(filas[0].zona).toBe('Vicente López, Munro');
  });

  it('las columnas opcionales pueden faltar en la cabecera', () => {
    const { filas, errores } = importarCsv(['nombre,rubros,zona', 'Seco Express,seco,Tigre'].join('\n'));

    expect(errores).toEqual([]);
    expect(filas).toEqual([
      { nombre: 'Seco Express', rubros: ['seco'], zona: 'Tigre', telefono: null, email: null },
    ]);
  });

  it('sin cabecera reconocible no importa nada y lo dice en la línea 1', () => {
    const { filas, errores } = importarCsv('Corralón del Norte,gruesa,San Isidro\n');

    expect(filas).toEqual([]);
    expect(errores).toHaveLength(1);
    expect(errores[0].linea).toBe(1);
    expect(errores[0].motivo).toContain('nombre');
  });

  it('un texto vacío es un error de línea 1, no una importación exitosa de cero filas', () => {
    expect(importarCsv('   \n\n')).toEqual({
      filas: [],
      errores: [{ linea: 1, motivo: 'Pegá el CSV: no llegó ninguna línea.' }],
    });
  });
});

describe('validación por línea', () => {
  const CABECERA = 'nombre,rubros,zona,telefono,email';

  function importar(...lineas: string[]) {
    return importarCsv([CABECERA, ...lineas].join('\n'));
  }

  it('una línea mala no se lleva puestas a las buenas, y el número de línea es el del archivo', () => {
    const { filas, errores } = importar(
      'Corralón del Norte,gruesa,San Isidro,,',
      ',seco,Tigre,,',
      'Aberturas Sur,aberturas,Quilmes,,',
    );

    expect(filas.map((f) => f.nombre)).toEqual(['Corralón del Norte', 'Aberturas Sur']);
    expect(errores).toEqual([
      { linea: 3, motivo: 'Falta el nombre del proveedor.' },
    ]);
  });

  it('rechaza un rubro que no existe y nombra los que sí', () => {
    const { filas, errores } = importar('Herrería Pérez,herreria,Avellaneda,,');

    expect(filas).toEqual([]);
    expect(errores[0].linea).toBe(2);
    expect(errores[0].motivo).toBe(
      'Rubro desconocido: «herreria». Los rubros válidos son: aberturas, seco, pintura, gruesa.',
    );
  });

  it('pide al menos un rubro y una zona', () => {
    const { errores } = importar('Sin Rubros,,San Isidro,,', 'Sin Zona,pintura,,,');

    expect(errores).toEqual([
      { linea: 2, motivo: 'Poné al menos un rubro: aberturas, seco, pintura, gruesa.' },
      { linea: 3, motivo: 'Falta la zona.' },
    ]);
  });

  it('normaliza y deduplica los rubros de la misma línea', () => {
    const { filas, errores } = importar('Seco y Seco, SECO | seco | Pintura ,Tigre,,');

    expect(errores).toEqual([]);
    expect(filas[0].rubros).toEqual(['seco', 'pintura']);
  });

  it('avisa cuando el mail no es un mail', () => {
    const { filas, errores } = importar('Corralón X,gruesa,Pilar,,ventas.corralon.ar');

    expect(filas).toEqual([]);
    expect(errores).toEqual([
      { linea: 2, motivo: 'El mail «ventas.corralon.ar» no parece un mail.' },
    ]);
  });

  it('salta las líneas vacías sin contarlas como error', () => {
    const { filas, errores } = importar('Corralón del Norte,gruesa,San Isidro,,', '', ',,,,', '   ');

    expect(filas).toHaveLength(1);
    expect(errores).toEqual([]);
  });

  it('una línea con más columnas que la cabecera es un error, no un dato corrido', () => {
    const { filas, errores } = importar('Corralón,gruesa,San Isidro,11-1111,mail@x.ar,de más');

    expect(filas).toEqual([]);
    expect(errores).toEqual([
      { linea: 2, motivo: 'La línea tiene 6 columnas y la cabecera tiene 5.' },
    ]);
  });
});

describe('normalizarNombre', () => {
  it('es la clave con la que se deduplica: sin tildes, minúsculas y sin espacios de más', () => {
    expect(normalizarNombre('  Corralón   del  NORTE ')).toBe('corralon del norte');
    expect(normalizarNombre('Vidriería Ñandú')).toBe(normalizarNombre('VIDRIERIA NANDU'));
  });
});
