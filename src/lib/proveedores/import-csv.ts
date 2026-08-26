/**
 * Import de la agenda de proveedores desde un CSV pegado a mano (RF-801).
 *
 * ## Qué hace y qué NO hace
 *
 * `importarCsv` es **puro**: parsea, valida y devuelve `{ filas, errores }`. No
 * abre la base, no escribe nada y no sabe de qué estudio se trata. Persistir es
 * otra cosa y vive en `@/lib/proveedores/gestion` (`persistirImport`), que es
 * quien deduplica contra la agenda existente.
 *
 * Esa separación es la que hace posible la pantalla de import: el preview con
 * los errores por línea se calcula **en el cliente**, sin round-trip, y recién
 * al confirmar el texto vuelve al server —que lo parsea de nuevo, porque el
 * server nunca confía en el payload (`src/app/CLAUDE.md` §7)—.
 *
 * ## La regla de oro del formato
 *
 * Una línea mala no rompe el archivo. Las buenas entran igual y las malas salen
 * en `errores` con **el número de línea del archivo** (la cabecera es la 1) y un
 * motivo en castellano que dice qué arreglar. Un import que se cae entero
 * porque el proveedor 40 no tiene zona no lo usa nadie.
 *
 * ## Tolerancias deliberadas
 *
 * El CSV viene de un Excel argentino o de un mail: por eso se autodetecta el
 * separador (`,` o `;`) **en la cabecera**, se aceptan comillas, espacios de
 * más, BOM, `\r\n`, tildes en los nombres de columna y las columnas opcionales
 * ausentes. Lo que NO se tolera es una línea con más columnas que la cabecera:
 * eso es un separador de más y significa que los datos están corridos, así que
 * es un error explícito y no una fila con la zona en el teléfono.
 */
import { RUBROS, type RubroId } from '@/types/domain';

/**
 * Una fila válida del CSV, lista para `persistirImport`.
 *
 * Se lleva su `linea` puesta: `persistirImport` valida de nuevo con el schema
 * del dominio (que sí capea largos) y necesita poder decir **qué línea del
 * archivo** rechazó. Sin este campo, un error de persistencia solo podría
 * nombrar un índice del array, que no es lo que el usuario tiene en pantalla.
 */
export interface FilaProveedor {
  /** Número de línea **del archivo** de la que salió (cabecera = 1). */
  linea: number;
  nombre: string;
  rubros: RubroId[];
  zona: string;
  telefono: string | null;
  email: string | null;
}

export interface ErrorImport {
  /** Número de línea **del archivo**, con la cabecera como línea 1. */
  linea: number;
  motivo: string;
}

export interface ResultadoImport {
  filas: FilaProveedor[];
  errores: ErrorImport[];
}

const LISTA_RUBROS = RUBROS.join(', ');

/** Alias de cabecera → campo. Se comparan ya normalizados (sin tildes, minúsculas). */
const COLUMNAS: Record<string, keyof FilaProveedor> = {
  nombre: 'nombre',
  proveedor: 'nombre',
  'razon social': 'nombre',
  rubros: 'rubros',
  rubro: 'rubros',
  zona: 'zona',
  localidad: 'zona',
  telefono: 'telefono',
  tel: 'telefono',
  celular: 'telefono',
  whatsapp: 'telefono',
  email: 'email',
  mail: 'email',
  'e mail': 'email',
  correo: 'email',
};

/** Sin estas tres columnas no hay proveedor que valga: `contactos_json` sí puede ir vacío. */
const OBLIGATORIAS = ['nombre', 'rubros', 'zona'] as const;

/**
 * Minúsculas, sin tildes y con los espacios colapsados.
 *
 * Es la clave de deduplicación del import (`persistirImport` la usa para no
 * cargar dos veces al mismo corralón escrito de dos formas) y la que compara
 * zonas en la shortlist. La ñ cae a n: en una agenda de proveedores eso
 * deduplica más de lo que rompe.
 */
export function normalizarNombre(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parte una línea de CSV respetando comillas dobles (`""` adentro es una
 * comilla literal). Devuelve los campos **sin** trim: eso lo decide quien lee
 * cada campo.
 */
function partirLinea(linea: string, separador: string): string[] {
  const campos: string[] = [];
  let actual = '';
  let enComillas = false;

  for (let i = 0; i < linea.length; i += 1) {
    const caracter = linea[i];

    if (enComillas) {
      if (caracter === '"') {
        if (linea[i + 1] === '"') {
          actual += '"';
          i += 1;
        } else {
          enComillas = false;
        }
      } else {
        actual += caracter;
      }
      continue;
    }

    if (caracter === '"') {
      enComillas = true;
    } else if (caracter === separador) {
      campos.push(actual);
      actual = '';
    } else {
      actual += caracter;
    }
  }

  campos.push(actual);
  return campos;
}

/** El separador es el que más aparece en la cabecera, fuera de comillas. Empate ⇒ coma. */
function detectarSeparador(cabecera: string): string {
  let comas = 0;
  let puntoYComas = 0;
  let enComillas = false;

  for (const caracter of cabecera) {
    if (caracter === '"') enComillas = !enComillas;
    else if (enComillas) continue;
    else if (caracter === ',') comas += 1;
    else if (caracter === ';') puntoYComas += 1;
  }

  return puntoYComas > comas ? ';' : ',';
}

/** `true` si en la línea no hay más que separadores y espacios. */
function estaVacia(campos: string[]): boolean {
  return campos.every((campo) => campo.trim() === '');
}

function parsearRubros(crudo: string): { rubros: RubroId[] } | { motivo: string } {
  const partes = crudo
    .split('|')
    .map((parte) => normalizarNombre(parte))
    .filter((parte) => parte !== '');

  if (partes.length === 0) return { motivo: `Poné al menos un rubro: ${LISTA_RUBROS}.` };

  const rubros: RubroId[] = [];
  for (const parte of partes) {
    const rubro = RUBROS.find((valido) => valido === parte);
    if (!rubro) {
      return { motivo: `Rubro desconocido: «${parte}». Los rubros válidos son: ${LISTA_RUBROS}.` };
    }
    if (!rubros.includes(rubro)) rubros.push(rubro);
  }

  return { rubros };
}

export function importarCsv(texto: string): ResultadoImport {
  // El BOM del Excel se pega a la primera celda y convertiría 'nombre' en '﻿nombre'.
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/);

  const indiceCabecera = lineas.findIndex((linea) => linea.trim() !== '');
  if (indiceCabecera === -1) {
    return { filas: [], errores: [{ linea: 1, motivo: 'Pegá el CSV: no llegó ninguna línea.' }] };
  }

  const separador = detectarSeparador(lineas[indiceCabecera]);
  const cabecera = partirLinea(lineas[indiceCabecera], separador).map((celda) =>
    normalizarNombre(celda.replace(/[-_]/g, ' ')),
  );

  // Mapa campo → índice de columna. La primera columna que reclama un campo gana:
  // un CSV con 'telefono' y 'celular' no tiene por qué elegir, se queda con la primera.
  const columnas = new Map<keyof FilaProveedor, number>();
  cabecera.forEach((titulo, indice) => {
    const campo = COLUMNAS[titulo];
    if (campo && !columnas.has(campo)) columnas.set(campo, indice);
  });

  const faltantes = OBLIGATORIAS.filter((campo) => !columnas.has(campo));
  if (faltantes.length > 0) {
    return {
      filas: [],
      errores: [
        {
          linea: indiceCabecera + 1,
          motivo: `La primera línea tiene que ser la cabecera con las columnas ${OBLIGATORIAS.join(
            ', ',
          )} (faltan: ${faltantes.join(', ')}).`,
        },
      ],
    };
  }

  const filas: FilaProveedor[] = [];
  const errores: ErrorImport[] = [];

  for (let i = indiceCabecera + 1; i < lineas.length; i += 1) {
    const numero = i + 1;
    const bruta = lineas[i];
    if (bruta.trim() === '') continue;

    const campos = partirLinea(bruta, separador);
    if (estaVacia(campos)) continue; // ';;;;' de un Excel que exportó filas de más

    if (campos.length > cabecera.length) {
      errores.push({
        linea: numero,
        motivo: `La línea tiene ${campos.length} columnas y la cabecera tiene ${cabecera.length}.`,
      });
      continue;
    }

    const leer = (campo: keyof FilaProveedor): string => {
      const indice = columnas.get(campo);
      return indice === undefined ? '' : (campos[indice] ?? '').trim();
    };

    const nombre = leer('nombre');
    if (nombre === '') {
      errores.push({ linea: numero, motivo: 'Falta el nombre del proveedor.' });
      continue;
    }

    const rubros = parsearRubros(leer('rubros'));
    if ('motivo' in rubros) {
      errores.push({ linea: numero, motivo: rubros.motivo });
      continue;
    }

    const zona = leer('zona');
    if (zona === '') {
      errores.push({ linea: numero, motivo: 'Falta la zona.' });
      continue;
    }

    const email = leer('email');
    // Chequeo mínimo a propósito: no valida dominios ni RFC 5322, solo agarra el
    // caso real —una celda con un teléfono o un nombre en la columna del mail—.
    if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errores.push({ linea: numero, motivo: `El mail «${email}» no parece un mail.` });
      continue;
    }

    const telefono = leer('telefono');

    filas.push({
      linea: numero,
      nombre,
      rubros: rubros.rubros,
      zona,
      telefono: telefono === '' ? null : telefono,
      email: email === '' ? null : email,
    });
  }

  return { filas, errores };
}
