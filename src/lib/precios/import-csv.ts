/**
 * Import de la lista de precios de referencia del estudio desde un CSV pegado
 * a mano (§5.6).
 *
 * Mismo contrato que el import de la agenda (`@/lib/proveedores/import-csv`), y
 * a propósito: es el mismo gesto para el usuario y la misma promesa de formato.
 *
 * ## Qué hace y qué NO hace
 *
 * `importarCsvPrecios` es **puro**: parsea, valida y devuelve `{ filas, errores }`.
 * No abre la base, no sabe de qué estudio se trata y **no mira el reloj** — una
 * fila sin fecha sale con `fecha: undefined` y es quien persiste el que decide
 * con qué fecha entra (`persistirImportPrecios`, que la recibe por parámetro).
 * Así el preview del navegador y el parseo del server dan exactamente lo mismo.
 *
 * ## La regla de oro del formato
 *
 * Una línea mala no rompe el archivo. Las buenas entran igual y las malas salen
 * en `errores` con **el número de línea del archivo** (la cabecera es la 1) y un
 * motivo en castellano que dice qué arreglar.
 *
 * ## Coma decimal, porque el CSV sale de un Excel argentino
 *
 * `"12,50"` son doce pesos con cincuenta. La regla completa está en
 * `parsearPrecio`: la coma siempre es el decimal; el punto se lee según lo que
 * tenga atrás, que es la única forma de no romper ni al Excel local ni al que
 * exportó en inglés.
 */
import { UNIDADES, type Unidad } from '@/types/domain';

/** Una fila válida del CSV, lista para `persistirImportPrecios`. */
export interface FilaPrecio {
  /** Número de línea **del archivo** de la que salió (cabecera = 1). */
  linea: number;
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  precio: number;
  /** `YYYY-MM-DD`. Ausente si el CSV no traía columna o la celda vino vacía. */
  fecha?: string;
}

export interface ErrorImportPrecio {
  /** Número de línea **del archivo**, con la cabecera como línea 1. */
  linea: number;
  motivo: string;
}

export interface ResultadoImportPrecios {
  filas: FilaPrecio[];
  errores: ErrorImportPrecio[];
}

const LISTA_UNIDADES = UNIDADES.join(', ');

type CampoPrecio = 'claveItem' | 'descripcion' | 'unidad' | 'precio' | 'fecha';

/** Alias de cabecera → campo. Se comparan ya normalizados (sin tildes, minúsculas). */
const COLUMNAS: Record<string, CampoPrecio> = {
  'clave item': 'claveItem',
  clave: 'claveItem',
  item: 'claveItem',
  codigo: 'claveItem',
  descripcion: 'descripcion',
  detalle: 'descripcion',
  concepto: 'descripcion',
  unidad: 'unidad',
  un: 'unidad',
  um: 'unidad',
  unidad_medida: 'unidad',
  precio: 'precio',
  'precio unitario': 'precio',
  unitario: 'precio',
  importe: 'precio',
  fecha: 'fecha',
  'fecha precio': 'fecha',
  vigencia: 'fecha',
};

/** Sin estas cuatro no hay precio que valga; la fecha sí es opcional. */
const OBLIGATORIAS: CampoPrecio[] = ['claveItem', 'descripcion', 'unidad', 'precio'];

/** Cómo se llama cada columna obligatoria en el mensaje de error. */
const NOMBRE_COLUMNA: Record<CampoPrecio, string> = {
  claveItem: 'clave_item',
  descripcion: 'descripcion',
  unidad: 'unidad',
  precio: 'precio',
  fecha: 'fecha',
};

/**
 * Unidades escritas como las escribe un Excel: con superíndice, en mayúscula,
 * con punto o con el nombre entero. Las claves ya vienen normalizadas.
 */
const ALIAS_UNIDAD: Record<string, Unidad> = {
  'm2': 'm2',
  'm²': 'm2',
  mts2: 'm2',
  'm3': 'm3',
  'm³': 'm3',
  mts3: 'm3',
  u: 'u',
  'u.': 'u',
  un: 'u',
  'un.': 'u',
  unidad: 'u',
  m: 'm',
  mt: 'm',
  metro: 'm',
  ml: 'ml',
  'm lineal': 'ml',
  'metro lineal': 'ml',
  l: 'l',
  lt: 'l',
  litro: 'l',
  kg: 'kg',
  kilo: 'kg',
  kgs: 'kg',
};

/** Minúsculas, sin tildes y con los espacios colapsados. */
function normalizar(valor: string): string {
  return valor
    .normalize('NFD')
    // Los superíndices `²`/`³` no llevan diacrítico, así que sobreviven a esto:
    // por eso `m²` puede estar como alias de unidad más abajo.
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parte una línea de CSV respetando comillas dobles (`""` adentro es una
 * comilla literal). Devuelve los campos **sin** trim.
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

    if (caracter === '"') enComillas = true;
    else if (caracter === separador) {
      campos.push(actual);
      actual = '';
    } else actual += caracter;
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

function estaVacia(campos: string[]): boolean {
  return campos.every((campo) => campo.trim() === '');
}

/**
 * Un precio escrito por un humano → número.
 *
 * Reglas, en orden:
 *
 *  1. Se sacan el símbolo de moneda, los espacios (incluido el duro del Excel)
 *     y nada más: una letra suelta hace que la línea falle, no que se ignore.
 *  2. **Si hay coma, la coma es el decimal** y los puntos son separadores de
 *     miles: `"1.234,50"` ⇒ `1234.5`. Es la convención local.
 *  3. Si no hay coma y hay **un solo** punto con 1 o 2 dígitos atrás, el punto
 *     es decimal: `"12.50"` ⇒ `12.5`. Es lo que exporta un Excel en inglés, y
 *     leerlo como miles multiplicaría el precio por cien en silencio.
 *  4. Cualquier otro punto es separador de miles: `"1.234"` ⇒ `1234`,
 *     `"1.234.500"` ⇒ `1234500`.
 *
 * Devuelve `null` si lo que quedó no es un número finito.
 */
export function parsearPrecio(crudo: string): number | null {
  const limpio = crudo
    .replace(/[$\s  ]/g, '')
    .replace(/^ars/i, '')
    .trim();
  if (limpio === '') return null;

  let normalizado: string;
  if (limpio.includes(',')) {
    normalizado = limpio.replace(/\./g, '').replace(',', '.');
  } else {
    const decimalConPunto = /^-?\d+\.\d{1,2}$/.test(limpio);
    normalizado = decimalConPunto ? limpio : limpio.replace(/\./g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalizado)) return null;
  const numero = Number(normalizado);
  return Number.isFinite(numero) ? numero : null;
}

/**
 * Una fecha escrita por un humano → `YYYY-MM-DD`, o `null` si no es una fecha
 * del calendario.
 *
 * Acepta el ISO y el formato del Excel argentino (`31/12/2026`, también con
 * guiones). No acepta `MM/DD/YYYY`: `03/04/2026` es el 3 de abril acá, y
 * adivinar el orden según el número sería peor que rechazar el ambiguo.
 */
export function parsearFecha(crudo: string): string | null {
  const texto = crudo.trim();
  if (texto === '') return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(texto);

  let anio: number;
  let mes: number;
  let dia: number;
  if (iso) {
    [anio, mes, dia] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (local) {
    [dia, mes, anio] = [Number(local[1]), Number(local[2]), Number(local[3])];
  } else {
    return null;
  }

  // `new Date(...)` con un 30 de febrero no falla: rueda al 2 de marzo. Se
  // compara el resultado con lo que entró para que una fecha inexistente sea un
  // error y no un día distinto escrito solo.
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mes - 1 ||
    fecha.getUTCDate() !== dia
  ) {
    return null;
  }

  const dosDigitos = (n: number) => String(n).padStart(2, '0');
  return `${anio}-${dosDigitos(mes)}-${dosDigitos(dia)}`;
}

/** La unidad del dominio, o `null` si no es ninguna de las siete. */
export function parsearUnidad(crudo: string): Unidad | null {
  const normal = normalizar(crudo);
  if (normal === '') return null;
  const alias = ALIAS_UNIDAD[normal];
  if (alias) return alias;
  return UNIDADES.find((unidad) => unidad === normal) ?? null;
}

export function importarCsvPrecios(texto: string): ResultadoImportPrecios {
  // El BOM del Excel se pega a la primera celda y convertiría 'clave' en '﻿clave'.
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/);

  const indiceCabecera = lineas.findIndex((linea) => linea.trim() !== '');
  if (indiceCabecera === -1) {
    return { filas: [], errores: [{ linea: 1, motivo: 'Pegá el CSV: no llegó ninguna línea.' }] };
  }

  const separador = detectarSeparador(lineas[indiceCabecera]);
  const cabecera = partirLinea(lineas[indiceCabecera], separador).map((celda) =>
    // `clave_item` y `clave-item` son la misma columna que `clave item`; el
    // alias `unidad_medida` se guarda con guion bajo porque acá ya no lo tiene.
    normalizar(celda.replace(/[-_]/g, ' ')),
  );

  const columnas = new Map<CampoPrecio, number>();
  cabecera.forEach((titulo, indice) => {
    const campo = COLUMNAS[titulo] ?? COLUMNAS[titulo.replace(/ /g, '_')];
    if (campo && !columnas.has(campo)) columnas.set(campo, indice);
  });

  const faltantes = OBLIGATORIAS.filter((campo) => !columnas.has(campo));
  if (faltantes.length > 0) {
    return {
      filas: [],
      errores: [
        {
          linea: indiceCabecera + 1,
          motivo: `La primera línea tiene que ser la cabecera con las columnas ${OBLIGATORIAS.map(
            (campo) => NOMBRE_COLUMNA[campo],
          ).join(', ')} (faltan: ${faltantes.map((campo) => NOMBRE_COLUMNA[campo]).join(', ')}).`,
        },
      ],
    };
  }

  const filas: FilaPrecio[] = [];
  const errores: ErrorImportPrecio[] = [];

  for (let i = indiceCabecera + 1; i < lineas.length; i += 1) {
    const numero = i + 1;
    if (lineas[i].trim() === '') continue;

    const campos = partirLinea(lineas[i], separador);
    if (estaVacia(campos)) continue; // ';;;;' de un Excel que exportó filas de más

    if (campos.length > cabecera.length) {
      errores.push({
        linea: numero,
        motivo: `La línea tiene ${campos.length} columnas y la cabecera tiene ${cabecera.length}: si una descripción lleva coma, va entre comillas.`,
      });
      continue;
    }

    const leer = (campo: CampoPrecio): string => {
      const indice = columnas.get(campo);
      return indice === undefined ? '' : (campos[indice] ?? '').trim();
    };

    const claveItem = leer('claveItem');
    if (claveItem === '') {
      errores.push({
        linea: numero,
        motivo: 'Falta la clave del ítem (por ejemplo aberturas.ventana.dvh).',
      });
      continue;
    }

    const descripcion = leer('descripcion');
    if (descripcion === '') {
      errores.push({ linea: numero, motivo: 'Falta la descripción del ítem.' });
      continue;
    }

    const unidadCruda = leer('unidad');
    const unidad = parsearUnidad(unidadCruda);
    if (!unidad) {
      errores.push({
        linea: numero,
        motivo:
          unidadCruda === ''
            ? `Falta la unidad. Las unidades válidas son: ${LISTA_UNIDADES}.`
            : `Unidad desconocida: «${unidadCruda}». Las unidades válidas son: ${LISTA_UNIDADES}.`,
      });
      continue;
    }

    const precioCrudo = leer('precio');
    const precio = parsearPrecio(precioCrudo);
    if (precio === null) {
      errores.push({
        linea: numero,
        motivo:
          precioCrudo === ''
            ? 'Falta el precio.'
            : `El precio «${precioCrudo}» no es un número. Usá coma para los decimales (12,50).`,
      });
      continue;
    }
    if (precio <= 0) {
      errores.push({
        linea: numero,
        motivo: `El precio tiene que ser mayor que cero (llegó «${precioCrudo}»).`,
      });
      continue;
    }

    const fechaCruda = leer('fecha');
    let fecha: string | undefined;
    if (fechaCruda !== '') {
      const parseada = parsearFecha(fechaCruda);
      if (!parseada) {
        errores.push({
          linea: numero,
          motivo: `La fecha «${fechaCruda}» no existe. Escribila como 2026-08-26.`,
        });
        continue;
      }
      fecha = parseada;
    }

    filas.push({
      linea: numero,
      claveItem,
      descripcion,
      unidad,
      precio,
      // La clave no se pone en `undefined`: una fila sin fecha no tiene la
      // propiedad, así el `toEqual` de los tests y el diff de la auditoría no
      // arrastran un hueco.
      ...(fecha === undefined ? {} : { fecha }),
    });
  }

  return { filas, errores };
}
