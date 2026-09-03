/**
 * Un pool de tareas con cap, sin dependencias nuevas.
 *
 * El pipeline pasó de "una lámina a la vez, a ciegas" a cinco fases (§4 del
 * diseño), y dos de esas fases son un lote de llamadas al modelo: el inventario
 * de rótulos y la extracción. Hacerlas en serie es esperar N veces la latencia
 * de la red; hacerlas todas juntas es abrir 25 llamadas simultáneas contra la
 * API —rate limits, memoria, y una factura que el usuario no pidió—. El medio es
 * este pool: **como mucho `cap` en vuelo**, y el que se libera toma la
 * siguiente.
 *
 * Tres propiedades que el resto del pipeline da por ciertas:
 *
 *  1. **Nunca más de `cap` tareas en vuelo.** Es plata del usuario y es el
 *     límite que el proveedor de la API mira.
 *  2. **El resultado sale en el orden de la entrada.** La lámina 3 es la
 *     tercera del array aunque haya terminado primera: el pipeline empareja
 *     resultados con láminas por posición.
 *  3. **Un rechazo no tira el lote.** Cada ítem vuelve *settled* —`{ok: true,
 *     valor}` o `{ok: false, error}`—, así que una lámina ilegible no puede
 *     dejar sin analizar a las otras veinticuatro. Quien llama decide qué hacer
 *     con cada error (en el pipeline: dejarlo escrito en la lámina y seguir).
 *
 * Módulo puro: sin I/O, sin DB, sin red. Se testea con promesas diferidas.
 */

/**
 * Cuántas láminas se analizan a la vez. Cuatro es el número del plan: alcanza
 * para que la latencia de la red deje de dominar y no dispara los rate limits
 * de la API con un expediente grande.
 */
export const CAP_ANALISIS = 4;

/** Variable de entorno que pisa el cap, para poder bajarlo en una máquina chica. */
export const VAR_PARALELISMO = 'PARALELISMO_ANALISIS';

/**
 * El resultado de una tarea, siempre resuelto: o vino un valor, o vino un error.
 * Es el mismo shape que `Promise.allSettled` pero con nombres del dominio y sin
 * el `status`/`reason` que obliga a un `switch` en cada uso.
 */
export type ResultadoParalelo<R> = { ok: true; valor: R } | { ok: false; error: unknown };

/**
 * El cap efectivo: el default, salvo que el entorno declare otro.
 *
 * Recibe el entorno como parámetro (default `process.env`) para poder testearlo
 * sin ensuciar el proceso. Un valor que no sea un entero ≥ 1 se ignora: un
 * `PARALELISMO_ANALISIS=0` mal escrito no puede dejar el pipeline sin obreros, y
 * fallar por eso sería peor que seguir con el default.
 */
export function capDeAnalisis(env: Record<string, string | undefined> = process.env): number {
  const crudo = env[VAR_PARALELISMO];
  if (crudo === undefined || crudo.trim() === '') return CAP_ANALISIS;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < 1) return CAP_ANALISIS;
  return Math.floor(n);
}

/**
 * Corre `fn` sobre cada ítem con como mucho `cap` en vuelo y devuelve un
 * resultado por ítem, **en el orden de la entrada**.
 *
 * No lanza nunca: un `fn` que rechaza —o que tira en forma sincrónica— deja su
 * error en la posición de su ítem y el lote sigue.
 */
export async function enParalelo<T, R>(
  items: readonly T[],
  cap: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<ResultadoParalelo<R>[]> {
  const resultados = new Array<ResultadoParalelo<R>>(items.length);
  if (items.length === 0) return [];

  // Ni menos de uno (un cap roto no puede dejar el lote sin correr) ni más
  // obreros que ítems (los de más arrancarían y terminarían sin hacer nada).
  const obreros = Math.max(1, Math.min(Math.floor(cap) || 1, items.length));

  // El cursor compartido es lo que hace que el que se libera tome la siguiente:
  // repartir de antemano dejaría a un obrero con las cuatro láminas lentas y a
  // los otros tres mirando.
  let siguiente = 0;
  const obrero = async (): Promise<void> => {
    for (;;) {
      const indice = siguiente;
      if (indice >= items.length) return;
      siguiente += 1;
      try {
        resultados[indice] = { ok: true, valor: await fn(items[indice] as T, indice) };
      } catch (error) {
        resultados[indice] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: obreros }, () => obrero()));
  return resultados;
}
