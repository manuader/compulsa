/**
 * Harness de precisión: `npm run golden`.
 *
 * Para cada obra de `tests/golden/<caso>/` monta una PGlite **en memoria**, sube y
 * procesa sus documentos con el pipeline real y compara los `cantCompra` que
 * salieron contra los de `expected-computo.json`.
 *
 * Tres cosas que este archivo tiene que sostener:
 *
 *  1. **El esperado se escribe A MANO** (ver `expected-computo.json` de cada caso,
 *     donde cada ítem lleva su derivación al lado del número). Nada acá genera ni
 *     "corrige" el esperado: un harness que aprende del pipeline no mide nada.
 *  2. **Contrato de precisión RNF-1:** si el error promedio de un rubro pasa el
 *     2 %, el proceso sale con código 1. Un ítem esperado que no aparece, o uno
 *     que aparece sin estar esperado, también es fallo — y se lista por nombre.
 *  3. **Nunca red.** El provider de análisis se inyecta explícitamente como el
 *     mock: aunque quien corre esto tenga `ANTHROPIC_API_KEY` exportada, el
 *     golden mide el motor de cómputo, no a Claude.
 *
 * `tests/integration/golden.test.ts` importa `correrCasoGolden()` y corre el
 * mismo chequeo dentro de `npm test`.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { resetDb, setDbForTests, type Db } from '@/db/client';
import { computoItems, deducciones, estudios, hallazgos, obras, usuarios } from '@/db/schema';
import { crearProviderMock } from '@/lib/analysis/mock';
import { validarDeduccion } from '@/lib/deduccion/persistencia';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { crearStorageLocal } from '@/lib/storage/local';
import { RUBROS, TIPOS_OBRA, type Origen, type RubroId } from '@/types/domain';

import { createTestDb } from '../tests/helpers/test-db';

/** Raíz del golden set. `tsx`, `vitest` y `next` corren desde la raíz del repo. */
export const DIR_GOLDEN = path.join(process.cwd(), 'tests', 'golden');

/** RNF-1: error promedio máximo tolerado por rubro. */
export const UMBRAL_ERROR_RUBRO = 0.02;

/** El estudio y el usuario del harness: existen solo para colgarles la obra. */
const ESTUDIO_GOLDEN = 'Estudio Golden';
const EMAIL_GOLDEN = 'golden@compulsa.ar';

// ---------------------------------------------------------------------------
// Contratos de los archivos del caso
// ---------------------------------------------------------------------------

const zConfig = z.object({
  nombre: z.string().trim().min(1),
  tipoObra: z.enum(TIPOS_OBRA),
  /** La zona no cambia ningún número; existe porque `obras.zona` es NOT NULL. */
  zona: z.string().trim().min(1).default('CABA'),
  /** Rutas relativas a la raíz del repo. */
  documentos: z.array(z.string().trim().min(1)).min(1),
  /**
   * Paso opcional entre el análisis y la comparación: **validar todas las
   * deducciones que el motor propuso** (§11), como haría el arquitecto en la
   * bandeja, y recomputar.
   *
   * Existe porque un caso que ejercita la deducción no se puede medir sin ese
   * clic: mientras la propuesta está sin validar, el dato no está en la entidad
   * y el ítem no sale. Se valida con el mismo núcleo que la pantalla
   * (`validarDeduccion`), no escribiendo la entidad a mano, así que lo que el
   * golden mide es el camino real.
   */
  validarDeducciones: z.boolean().default(false),
});

export type ConfigGolden = z.infer<typeof zConfig>;

const zEsperado = z
  .array(
    z.object({
      claveItem: z.string().trim().min(1),
      cantCompra: z.number().nonnegative(),
      /** Cómo se calculó el número a mano. Documentación, no dato del chequeo. */
      derivacion: z.string().optional(),
    }),
  )
  .min(1)
  // Una clave repetida (copiar y pegar un ítem y olvidarse de cambiarle el
  // nombre) contaría dos veces en el promedio del rubro y taparía el error.
  .superRefine((items, ctx) => {
    const vistas = new Set<string>();
    for (const item of items) {
      if (vistas.has(item.claveItem)) {
        ctx.addIssue({ code: 'custom', message: `la clave "${item.claveItem}" está repetida.` });
      }
      vistas.add(item.claveItem);
    }
  });

export type ItemEsperado = z.infer<typeof zEsperado>[number];

// ---------------------------------------------------------------------------
// Resultado de la comparación
// ---------------------------------------------------------------------------

export interface ComparacionItem {
  claveItem: string;
  rubro: RubroId;
  esperado: number;
  real: number;
  /** |real − esperado| / esperado, en fracción (0,02 = 2 %). */
  error: number;
}

export interface FilaRubro {
  rubro: RubroId;
  items: number;
  errorMax: number;
  errorProm: number;
}

export interface ResultadoGolden {
  /** Nombre de la carpeta dentro de `tests/golden/`. */
  caso: string;
  config: ConfigGolden;
  comparaciones: ComparacionItem[];
  /** Claves esperadas que el pipeline no emitió. */
  ausentes: string[];
  /** Claves emitidas que el golden no espera. */
  extras: string[];
  porRubro: FilaRubro[];
  ok: boolean;
  /**
   * `claveItem → origen` de lo que emitió el pipeline. No entra en el contrato
   * de precisión —el 2 % de RNF-1 se mide sobre `cantCompra`— pero un caso que
   * ejercita la deducción necesita poder afirmar que el ítem salió `deducido`:
   * la cantidad sola no lo distingue de un ítem explícito que dio el mismo
   * número. Vacío en la comparación pura, que no corre el pipeline.
   */
  origenes: Record<string, Origen>;
  /**
   * Las claves de los hallazgos que quedaron **abiertos** al final de la
   * corrida, ordenadas. Tampoco entra en el contrato de precisión, y existe por
   * el mismo motivo que `origenes`: el golden 3 no se sostiene con las
   * cantidades solas. Que los tabiques computen 62,40 m² no dice nada si el
   * arquitecto igual tiene cuatro consultas de altura esperándolo en la
   * bandeja; lo que esta ola cambió es justamente que no las tiene. Vacío en la
   * comparación pura, que no corre el pipeline.
   */
  hallazgosAbiertos: string[];
}

// ---------------------------------------------------------------------------
// Núcleo puro de la comparación
// ---------------------------------------------------------------------------

/** `"seco.placas"` → `"seco"`. Una clave sin rubro conocido es un error del golden. */
export function rubroDeClave(claveItem: string): RubroId {
  const prefijo = claveItem.split('.')[0] ?? '';
  const rubro = RUBROS.find((r) => r === prefijo);
  if (!rubro) {
    throw new Error(
      `La clave "${claveItem}" no empieza con un rubro conocido (${RUBROS.join(', ')}).`,
    );
  }
  return rubro;
}

/**
 * Error relativo del ítem. Con esperado 0 no hay denominador: coincidir es 0 %
 * de error y cualquier otra cosa es 100 %, que es lo que hace fallar al rubro.
 */
export function errorRelativo(esperado: number, real: number): number {
  if (esperado === 0) return real === 0 ? 0 : 1;
  return Math.abs(real - esperado) / esperado;
}

/** Agrega los errores por rubro, en el orden canónico de `RUBROS`. */
export function agruparPorRubro(comparaciones: readonly ComparacionItem[]): FilaRubro[] {
  return RUBROS.flatMap((rubro) => {
    const items = comparaciones.filter((c) => c.rubro === rubro);
    if (items.length === 0) return [];
    const errores = items.map((c) => c.error);
    return [
      {
        rubro,
        items: items.length,
        errorMax: Math.max(...errores),
        errorProm: errores.reduce((suma, e) => suma + e, 0) / errores.length,
      },
    ];
  });
}

/**
 * Compara el cómputo real contra el esperado. Puro: los tests lo pueden ejercitar
 * sin levantar una base.
 */
export function compararComputo(
  caso: string,
  config: ConfigGolden,
  esperados: readonly ItemEsperado[],
  reales: ReadonlyMap<string, number>,
): ResultadoGolden {
  const comparaciones: ComparacionItem[] = [];
  const ausentes: string[] = [];

  for (const esperado of esperados) {
    const real = reales.get(esperado.claveItem);
    if (real === undefined) {
      ausentes.push(esperado.claveItem);
      continue;
    }
    comparaciones.push({
      claveItem: esperado.claveItem,
      rubro: rubroDeClave(esperado.claveItem),
      esperado: esperado.cantCompra,
      real,
      error: errorRelativo(esperado.cantCompra, real),
    });
  }

  const esperadas = new Set(esperados.map((e) => e.claveItem));
  const extras = [...reales.keys()].filter((clave) => !esperadas.has(clave)).sort();

  const porRubro = agruparPorRubro(comparaciones);
  const ok =
    ausentes.length === 0 &&
    extras.length === 0 &&
    porRubro.every((fila) => fila.errorProm <= UMBRAL_ERROR_RUBRO);

  return {
    caso,
    config,
    comparaciones,
    ausentes: ausentes.sort(),
    extras,
    porRubro,
    ok,
    origenes: {},
    hallazgosAbiertos: [],
  };
}

// ---------------------------------------------------------------------------
// Corrida del pipeline
// ---------------------------------------------------------------------------

async function leerJson(ruta: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(ruta, 'utf8'));
  } catch (error) {
    throw new Error(`No pude leer ${ruta}: ${(error as Error).message}`);
  }
}

/** Un archivo del golden mal escrito se reporta con su ruta, no con un stack de Zod. */
async function leerArchivo<T>(schema: z.ZodType<T>, ruta: string): Promise<T> {
  const resultado = schema.safeParse(await leerJson(ruta));
  if (resultado.success) return resultado.data;
  const detalle = resultado.error.issues
    .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Golden inválido (${ruta}): ${detalle}`);
}

/** Los casos del golden set: cada subcarpeta de `tests/golden/`, ordenadas. */
export async function listarCasosGolden(): Promise<string[]> {
  const entradas = await readdir(DIR_GOLDEN, { withFileTypes: true });
  return entradas
    .filter((entrada) => entrada.isDirectory())
    .map((entrada) => entrada.name)
    .sort();
}

/** El estudio, el usuario y la obra sobre los que corre el caso. */
async function armarObra(db: Db, config: ConfigGolden) {
  const [estudio] = await db.insert(estudios).values({ nombre: ESTUDIO_GOLDEN }).returning();
  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: EMAIL_GOLDEN,
      nombre: 'Harness Golden',
      // El golden nunca hace login: no hay contraseña que hashear.
      passwordHash: 'sin-login',
      rol: 'titular',
    })
    .returning();
  const [obra] = await db
    .insert(obras)
    .values({
      estudioId: estudio.id,
      nombre: config.nombre,
      zona: config.zona,
      tipo: config.tipoObra,
    })
    .returning();
  return { usuario, obra };
}

/**
 * Valida, una por una, todas las deducciones que el motor dejó en `propuesta`.
 *
 * Se relee la tabla después de cada validación porque validar recomputa la obra,
 * y un recompute puede retirar una propuesta que dejó de sostenerse: quedarse
 * con la lista de la primera lectura llevaría a validar un id que ya no está.
 * El tope de vueltas es una red de seguridad contra un ciclo, no una regla del
 * dominio.
 */
async function validarDeduccionesPropuestas(
  db: Db,
  obraId: string,
  actor: { usuarioId: string; email: string },
): Promise<number> {
  const TOPE = 100;
  let validadas = 0;

  for (let vuelta = 0; vuelta < TOPE; vuelta += 1) {
    const [propuesta] = await db
      .select({ id: deducciones.id, campo: deducciones.campo })
      .from(deducciones)
      .where(and(eq(deducciones.obraId, obraId), eq(deducciones.estado, 'propuesta')))
      .orderBy(deducciones.campo)
      .limit(1);
    if (!propuesta) return validadas;

    const resultado = await validarDeduccion(
      { obraId, deduccionId: propuesta.id },
      { ...actor, rol: 'titular' },
    );
    if (!resultado.ok) {
      throw new Error(`No pude validar la deducción de "${propuesta.campo}": ${resultado.error}`);
    }
    validadas += 1;
  }

  throw new Error(`Más de ${TOPE} deducciones propuestas: algo está en loop.`);
}

/**
 * Corre un caso del golden set de punta a punta y devuelve la comparación.
 *
 * Monta su propia base en memoria y su propio storage temporal: no toca
 * `data/pglite/` ni `data/uploads/`, así que correr el golden no ensucia el
 * entorno de desarrollo.
 */
export async function correrCasoGolden(caso: string): Promise<ResultadoGolden> {
  const dir = path.join(DIR_GOLDEN, caso);
  const config = await leerArchivo(zConfig, path.join(dir, 'config.json'));
  const esperados = await leerArchivo(zEsperado, path.join(dir, 'expected-computo.json'));

  const db = await createTestDb();
  // Todo el pipeline (y `registrarAuditoria`) resuelve la base por `getDb()`.
  setDbForTests(db);
  const raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-golden-'));
  const storage = crearStorageLocal(raizStorage);
  // Explícito a propósito: el golden jamás sale a la red, tenga o no key quien lo corra.
  const provider = crearProviderMock();

  try {
    const { usuario, obra } = await armarObra(db, config);

    for (const relativa of config.documentos) {
      const ruta = path.resolve(process.cwd(), relativa);
      const bytes = await readFile(ruta);
      const archivo = new File([new Uint8Array(bytes)], path.basename(ruta), {
        type: 'application/pdf',
      });
      const documento = await subirDocumento(db, storage, obra.id, usuario.id, archivo);
      await procesarDocumento(documento.id, { db, storage, provider });
    }

    if (config.validarDeducciones) {
      await validarDeduccionesPropuestas(db, obra.id, {
        usuarioId: usuario.id,
        email: usuario.email,
      });
    }

    const filas = await db
      .select({
        claveItem: computoItems.claveItem,
        cantCompra: computoItems.cantCompra,
        origen: computoItems.origen,
      })
      .from(computoItems)
      .where(and(eq(computoItems.obraId, obra.id), eq(computoItems.estado, 'activo')));

    const abiertos = await db
      .select({ clave: hallazgos.clave })
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obra.id), eq(hallazgos.estado, 'abierto')))
      .orderBy(hallazgos.clave);

    const reales = new Map(filas.map((fila) => [fila.claveItem, fila.cantCompra]));
    return {
      ...compararComputo(caso, config, esperados, reales),
      origenes: Object.fromEntries(filas.map((fila) => [fila.claveItem, fila.origen])),
      hallazgosAbiertos: abiertos.map((fila) => fila.clave),
    };
  } finally {
    await rm(raizStorage, { recursive: true, force: true });
    resetDb();
  }
}

// ---------------------------------------------------------------------------
// Salida por consola (es-AR)
// ---------------------------------------------------------------------------

/** `0.0234` → `"2,34 %"`. */
export function formatearPorcentaje(fraccion: number): string {
  return `${(fraccion * 100).toFixed(2).replace('.', ',')} %`;
}

const ANCHOS = { rubro: 12, items: 7, errorMax: 12, errorProm: 12 } as const;

function fila(rubro: string, items: string, errorMax: string, errorProm: string): string {
  return (
    `  ${rubro.padEnd(ANCHOS.rubro)}` +
    `${items.padStart(ANCHOS.items)}` +
    `${errorMax.padStart(ANCHOS.errorMax)}` +
    `${errorProm.padStart(ANCHOS.errorProm)}`
  );
}

const SEPARADOR = `  ${'─'.repeat(ANCHOS.rubro + ANCHOS.items + ANCHOS.errorMax + ANCHOS.errorProm)}`;

/** La tabla por rubro con el total de la obra al pie. */
export function tablaGolden(resultado: ResultadoGolden): string {
  const lineas = [fila('rubro', 'ítems', 'error máx', 'error prom'), SEPARADOR];

  for (const f of resultado.porRubro) {
    const marca = f.errorProm > UMBRAL_ERROR_RUBRO ? '   ✗' : '';
    lineas.push(
      fila(f.rubro, String(f.items), formatearPorcentaje(f.errorMax), formatearPorcentaje(f.errorProm)) +
        marca,
    );
  }

  const errores = resultado.comparaciones.map((c) => c.error);
  lineas.push(SEPARADOR);
  lineas.push(
    fila(
      'TOTAL',
      String(resultado.comparaciones.length),
      errores.length > 0 ? formatearPorcentaje(Math.max(...errores)) : '—',
      errores.length > 0
        ? formatearPorcentaje(errores.reduce((suma, e) => suma + e, 0) / errores.length)
        : '—',
    ),
  );

  return lineas.join('\n');
}

/** Qué falló, con nombre y apellido: claves ausentes, extras y rubros por encima del umbral. */
export function motivosDeFallo(resultado: ResultadoGolden): string[] {
  const motivos: string[] = [];

  for (const clave of resultado.ausentes) {
    motivos.push(`falta el ítem esperado "${clave}": el pipeline no lo emitió.`);
  }
  for (const clave of resultado.extras) {
    motivos.push(`el pipeline emitió "${clave}", que el golden no espera.`);
  }
  for (const f of resultado.porRubro) {
    if (f.errorProm <= UMBRAL_ERROR_RUBRO) continue;
    motivos.push(
      `el rubro ${f.rubro} promedia ${formatearPorcentaje(f.errorProm)} de error, ` +
        `por encima del ${formatearPorcentaje(UMBRAL_ERROR_RUBRO)} que tolera RNF-1.`,
    );
  }

  return motivos;
}

/** Los ítems que no dieron exacto, para poder ver cuál se movió. */
export function desviosDelCaso(resultado: ResultadoGolden): string[] {
  return resultado.comparaciones
    .filter((c) => c.error > 0)
    .sort((a, b) => b.error - a.error)
    .map(
      (c) =>
        `${c.claveItem}: esperado ${c.esperado}, real ${c.real} (${formatearPorcentaje(c.error)}).`,
    );
}

function imprimirCaso(resultado: ResultadoGolden): void {
  const { config } = resultado;
  console.log('');
  console.log(`Golden «${resultado.caso}» — ${config.nombre} (obra ${config.tipoObra})`);
  console.log(tablaGolden(resultado));

  const desvios = desviosDelCaso(resultado);
  if (desvios.length > 0) {
    console.log('');
    console.log('  Ítems con desvío:');
    for (const linea of desvios) console.log(`    · ${linea}`);
  }

  const motivos = motivosDeFallo(resultado);
  if (motivos.length === 0) {
    console.log('');
    console.log(`  ✓ Todos los rubros por debajo del ${formatearPorcentaje(UMBRAL_ERROR_RUBRO)}.`);
    return;
  }

  console.log('');
  console.log('  ✗ Fallos:');
  for (const motivo of motivos) console.log(`    · ${motivo}`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const casos = await listarCasosGolden();
  if (casos.length === 0) {
    console.error(`No hay ningún caso en ${DIR_GOLDEN}.`);
    process.exit(1);
  }

  let fallaron = 0;
  for (const caso of casos) {
    const resultado = await correrCasoGolden(caso);
    imprimirCaso(resultado);
    if (!resultado.ok) fallaron += 1;
  }

  console.log('');
  if (fallaron > 0) {
    const plural = fallaron === 1 ? 'caso' : 'casos';
    console.error(`Golden ROJO: ${fallaron} ${plural} de ${casos.length} fuera de contrato.`);
    process.exit(1);
  }
  const plural = casos.length === 1 ? 'caso' : 'casos';
  console.log(`Golden VERDE: ${casos.length} ${plural} dentro del contrato de precisión (RNF-1).`);
}

/** Solo cuando se ejecuta como script; importarlo desde un test no corre nada. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error('');
    console.error(`Golden ROJO: ${(error as Error).message}`);
    process.exit(1);
  }
}
