/**
 * Parser de presupuestos determinístico: fixture si lo hay, heurística si no.
 *
 * Es el provider por defecto sin `ANTHROPIC_API_KEY` y **siempre** en tests. A
 * diferencia del mock de láminas, este no se rinde cuando no encuentra fixture:
 * cae a una **heurística de texto plano** para que el flujo manual completo
 * —pegar el presupuesto que mandó el corralón y conciliarlo— funcione sin
 * fixtures y sin gastar un token. Un fixture sirve para pinnear un caso; la
 * heurística es lo que usa el usuario real que no tiene la key puesta.
 *
 * ## Las reglas de la heurística (determinísticas, conservadoras y testeadas)
 *
 * 1. **Los montos llevan `$`.** Un número suelto en una descripción es una
 *    medida ("12,5 mm", "1,20 × 2,40"), no un precio. Exigir el símbolo es lo
 *    que permite leer descripciones con números sin inventar importes.
 * 2. **Una línea sin monto no es un ítem** y se saltea. Preferimos perder el
 *    "flete sin cargo" a inventarle un precio.
 * 3. **Formato es-AR:** miles con punto y decimales con coma (`1.234.567,89`).
 * 4. **Dos montos ⇒ unitario y total** (en ese orden, que es como se imprime una
 *    planilla); **un solo monto ⇒ total de la línea**, y el unitario queda
 *    `null` — `precioUnitarioDe()` de la conciliación lo deriva si hay cantidad,
 *    y si no hay, sale una repregunta. Adivinar cuál de los dos es sería
 *    inventar un precio unitario.
 * 5. **La cantidad se lee adelante o atrás de la descripción, y solo con unidad
 *    conocida** (`u`, `m`, `ml`, `m2`, `m3`, `l`, `kg`, con los sinónimos que
 *    normaliza `normalizarUnidad`). Sin unidad reconocible no hay cantidad: los
 *    "70 mm" de un montante son parte del nombre del producto.
 * 6. **Las líneas de subtotal, descuento e IVA no son ítems**, y el total sale
 *    de la línea que dice TOTAL — nunca de sumar las líneas, que es lo que haría
 *    aparecer un total que el proveedor no escribió.
 *
 * Lo que la heurística **nunca** hace: adivinar el código del ítem
 * (`claveItemSugerida` queda `null`; el pedido no lo publica, así que un
 * proveedor que lo cite es cosa del provider real) ni asumir el IVA.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizarUnidad } from '@/lib/compulsa/conciliacion';
import { UNIDADES, type LineaPresupuesto } from '@/types/domain';

import {
  METADATOS_VACIOS,
  zPresupuestoParseado,
  type EntradaPresupuesto,
  type MetadatosPresupuesto,
  type PresupuestoParseado,
  type PresupuestoProvider,
} from './presupuesto-tipos';
import { slug } from './tipos';

/**
 * `tests/fixtures/analysis/presupuestos/`, resuelto desde la raíz del repo por
 * los mismos motivos que `DIR_FIXTURES_ANALISIS` (ver `mock.ts`).
 */
export const DIR_FIXTURES_PRESUPUESTOS = pathToFileURL(
  resolve(process.cwd(), 'tests', 'fixtures', 'analysis', 'presupuestos'),
);

const cache = new Map<string, PresupuestoParseado | null>();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function comoDirectorio(dir: URL | string): URL {
  if (typeof dir !== 'string') return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
  return new URL(`${pathToFileURL(resolve(dir)).href}/`);
}

function esArchivoInexistente(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function parsearFixture(ruta: string, crudo: string): PresupuestoParseado {
  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (error) {
    throw new Error(
      `Fixture de presupuesto inválido (${ruta}): no es JSON válido — ${(error as Error).message}`,
    );
  }

  const resultado = zPresupuestoParseado.safeParse(json);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Fixture de presupuesto inválido (${ruta}): ${detalle}`);
  }
  return resultado.data;
}

function cargarFixture(dir: URL, clave: string): PresupuestoParseado | null {
  const url = new URL(`${clave}.json`, dir);
  const enCache = cache.get(url.href);
  if (enCache !== undefined) return enCache;

  let crudo: string;
  try {
    crudo = readFileSync(url, 'utf8');
  } catch (error) {
    if (!esArchivoInexistente(error)) throw error;
    cache.set(url.href, null);
    return null;
  }

  const presupuesto = parsearFixture(fileURLToPath(url), crudo);
  cache.set(url.href, presupuesto);
  return presupuesto;
}

// ---------------------------------------------------------------------------
// Heurística de texto plano
// ---------------------------------------------------------------------------

/** Minúsculas y sin tildes, para poder escribir las reglas una sola vez. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** `$ 1.234.567,89` → 1234567.89. Solo cuenta lo que lleva el símbolo. */
const RE_MONTO = /\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;

/**
 * Cantidad + unidad al principio de la descripción: "31,68 m2 Placa…".
 *
 * El token de la unidad admite dígitos (`m2`, `m3`) y por eso no alcanza con la
 * forma: lo que decide es que `normalizarUnidad` lo reconozca.
 */
const RE_CANTIDAD_ADELANTE = /^(\d+(?:[.,]\d+)?)\s*([^\s$]+)\s+(.+)$/;

/** Cantidad + unidad al final: "Cinta de papel para juntas 90 ml". */
const RE_CANTIDAD_ATRAS = /^(.*?)[\s—–\-|:;,]*(\d+(?:[.,]\d+)?)\s*([^\s$]+)\s*$/;

/** Separadores de columna que quedan pegados al recortar la descripción. */
const RE_SEPARADORES_AL_FINAL = /[\s—–\-|:;,.]+$/;

const RE_TOTAL = /^(importe\s+)?total\b/;
const RE_IGNORAR = /^(sub\s?total|descuento|bonificacion|neto gravado|son pesos|percepcion)/;
const RE_VALIDEZ = /validez[^0-9]{0,40}?(\d+)\s*dias?/;
const RE_PLAZO = /plazo[^0-9]{0,40}?(\d+)\s*dias?/;
const RE_FORMA_PAGO = /(?:forma|condiciones)\s+de\s+pago\s*:?\s*(.+)$/;
/** Frases que dicen que el precio NO lleva el IVA adentro. Se chequean primero. */
const RE_IVA_EXCLUIDO = /sin iva|no incluid|no incluye|mas iva|mas el iva|\+\s*iva|iva discriminado|iva aparte|neto de iva/;

const UNIDADES_CONOCIDAS = new Set<string>(UNIDADES);

function numeroEsAr(texto: string): number | null {
  const valor = Number(texto.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(valor) ? valor : null;
}

function montosDe(linea: string): number[] {
  const montos: number[] = [];
  for (const coincidencia of linea.matchAll(RE_MONTO)) {
    const valor = numeroEsAr(coincidencia[1]);
    if (valor !== null) montos.push(valor);
  }
  return montos;
}

/** La unidad si es una de las del dominio (con sinónimos); si no, `null`. */
function unidadConocida(texto: string): string | null {
  const normalizada = normalizarUnidad(texto);
  return normalizada !== null && UNIDADES_CONOCIDAS.has(normalizada) ? normalizada : null;
}

interface CantidadLeida {
  descripcion: string;
  cantidad: number | null;
  unidad: string | null;
}

/**
 * Cantidad y unidad de una descripción, buscándolas primero adelante y después
 * atrás. Si ninguna de las dos formas da una **unidad conocida**, la descripción
 * queda entera y sin cantidad.
 */
function leerCantidad(descripcion: string): CantidadLeida {
  const adelante = RE_CANTIDAD_ADELANTE.exec(descripcion);
  if (adelante) {
    const unidad = unidadConocida(adelante[2]);
    const cantidad = numeroEsAr(adelante[1]);
    if (unidad !== null && cantidad !== null) {
      return { descripcion: adelante[3].trim(), cantidad, unidad };
    }
  }

  const atras = RE_CANTIDAD_ATRAS.exec(descripcion);
  if (atras) {
    const unidad = unidadConocida(atras[3]);
    const cantidad = numeroEsAr(atras[2]);
    if (unidad !== null && cantidad !== null && atras[1].trim() !== '') {
      return {
        descripcion: atras[1].replace(RE_SEPARADORES_AL_FINAL, '').trim(),
        cantidad,
        unidad,
      };
    }
  }

  return { descripcion, cantidad: null, unidad: null };
}

function leerIva(normalizada: string): boolean {
  if (RE_IVA_EXCLUIDO.test(normalizada)) return false;
  // "IVA incluido", "precios con IVA incluido". Una línea que solo dice "IVA
  // 21% $ …" es el IVA discriminado como renglón aparte: el precio no lo lleva.
  return /incluid/.test(normalizada);
}

/**
 * Lee un presupuesto escrito en texto plano. Exportada para tests y para que la
 * UI pueda hacer un preview sin round-trip.
 */
export function parsearTextoPlano(texto: string): PresupuestoParseado {
  const lineas: LineaPresupuesto[] = [];
  const metadatos: MetadatosPresupuesto = { ...METADATOS_VACIOS };

  for (const cruda of texto.split(/\r?\n/)) {
    const linea = cruda.trim();
    if (linea === '') continue;

    const normalizada = normalizar(linea);
    let esMetadato = false;

    if (normalizada.includes('iva')) {
      metadatos.incluyeIva = leerIva(normalizada);
      esMetadato = true;
    }
    if (RE_TOTAL.test(normalizada)) {
      const montos = montosDe(linea);
      if (montos.length > 0) metadatos.total = montos[montos.length - 1];
      esMetadato = true;
    }
    const validez = RE_VALIDEZ.exec(normalizada);
    if (validez) {
      metadatos.validezDias = Number(validez[1]);
      esMetadato = true;
    }
    const plazo = RE_PLAZO.exec(normalizada);
    if (plazo) {
      metadatos.plazoDias = Number(plazo[1]);
      esMetadato = true;
    }
    const formaPago = RE_FORMA_PAGO.exec(linea) ?? RE_FORMA_PAGO.exec(normalizada);
    if (formaPago) {
      metadatos.formaPago = formaPago[1].trim();
      esMetadato = true;
    }
    if (RE_IGNORAR.test(normalizada)) esMetadato = true;
    if (esMetadato) continue;

    const montos = montosDe(linea);
    if (montos.length === 0) continue;

    const antesDelPrecio = linea.slice(0, linea.indexOf('$')).replace(RE_SEPARADORES_AL_FINAL, '').trim();
    if (antesDelPrecio === '') continue;

    const { descripcion, cantidad, unidad } = leerCantidad(antesDelPrecio);
    if (descripcion === '') continue;

    lineas.push({
      descripcion,
      unidad,
      cantidad,
      precioUnitario: montos.length >= 2 ? montos[0] : null,
      precioTotal: montos[montos.length - 1],
      claveItemSugerida: null,
      notas: null,
    });
  }

  return { lineas, metadatos };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * `dirFixtures` existe para los tests (y para apuntar a otro set de fixtures);
 * por defecto usa `tests/fixtures/analysis/presupuestos/`.
 */
export function crearProviderPresupuestoMock(
  dirFixtures: URL | string = DIR_FIXTURES_PRESUPUESTOS,
): PresupuestoProvider {
  const dir = comoDirectorio(dirFixtures);

  return {
    async parsear(entrada: EntradaPresupuesto): Promise<PresupuestoParseado> {
      const fixture = cargarFixture(dir, slug(entrada.nombre));
      // Copia: el fixture queda cacheado y el core no debería poder ensuciarlo.
      if (fixture) return structuredClone(fixture);

      if (entrada.texto !== undefined && entrada.texto.trim() !== '') {
        return parsearTextoPlano(entrada.texto);
      }

      // Sin fixture y sin texto no hay nada que leer: el mock no abre PDFs (eso
      // es el provider real). Vacío honesto en vez de líneas inventadas.
      return { lineas: [], metadatos: { ...METADATOS_VACIOS } };
    },
  };
}
