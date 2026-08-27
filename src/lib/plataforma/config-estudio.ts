/**
 * Configuración del estudio (`estudios.config_json`).
 *
 * ## Se guarda parcial, se lee completa
 *
 * La columna guarda **solo lo que el estudio pisó** y `zConfigEstudio.parse()`
 * rellena el resto con los defaults del PRD (decisión de P1 §3). Por eso:
 *
 *  - **nunca** se accede a `configJson.pesosRanking` directo — se lee con
 *    `leerConfig()`, que parsea;
 *  - agregar una clave nueva al PRD no obliga a migrar ninguna fila.
 *
 * ## Merge, no clobber
 *
 * `guardarConfig` recibe solo las secciones que el formulario mandó y las
 * mergea sobre lo guardado: guardar los pesos del ranking no puede borrar los
 * desperdicios. `desperdiciosPct` se mergea **por clave** (es un mapa, no una
 * sección), y una clave con `null` la borra — que es la única forma de volver un
 * rubro a su default de plantilla.
 *
 * ## Dos validaciones que `zConfigEstudio` no hace
 *
 *  1. **Los pesos del ranking suman 1.** Si no suman, el `puntaje` de RF-1101
 *     deja de estar en [0, 1] y las comparativas de dos compulsas no se pueden
 *     comparar entre sí. Zod no lo puede expresar campo a campo: va en un
 *     `refine` del objeto.
 *  2. **El objetivo de mejora no llega a 100** — eso sí lo hace `zMandato`
 *     (`.lt(100)`), y la validación llega hasta acá por composición.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { estudios } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { requireAccion, type UsuarioConRol } from '@/lib/plataforma/roles';
import {
  zCondicionesRfq,
  zConfigEstudio,
  zInstruccionesExtraccion,
  zMandato,
  type ConfigEstudio,
} from '@/types/domain';

/** Quién configura: sesión resuelta, con su rol. */
export interface ActorConfig extends UsuarioConRol {
  usuarioId: string;
  email: string;
  estudioId: string;
}

export class EstudioNoEncontradoError extends Error {
  constructor(readonly estudioId: string) {
    super('No encontré ese estudio.');
    this.name = 'EstudioNoEncontradoError';
  }
}

/** Tolerancia de la suma de pesos: 0,5 + 0,3 + 0,2 no da exactamente 1 en binario. */
const EPSILON_PESOS = 1e-9;

export const zPesosRankingValidados = z
  .object({
    total: z.number().min(0, 'Los pesos no pueden ser negativos.').max(1),
    fidelidad: z.number().min(0, 'Los pesos no pueden ser negativos.').max(1),
    plazo: z.number().min(0, 'Los pesos no pueden ser negativos.').max(1),
  })
  .refine(
    (pesos) => Math.abs(pesos.total + pesos.fidelidad + pesos.plazo - 1) <= EPSILON_PESOS,
    'Los tres pesos tienen que sumar 1 (por ejemplo 0,5 + 0,3 + 0,2).',
  );

/**
 * Lo que el formulario puede mandar. Todo opcional: lo que no viene, no se toca.
 * En `desperdiciosPct`, `null` en una clave significa "sacale el override".
 */
export const zCambiosConfig = z.object({
  desperdiciosPct: z
    .record(
      z.string(),
      z
        .number()
        .min(0, 'El desperdicio va de 0 a 100.')
        .max(100, 'El desperdicio va de 0 a 100.')
        .nullable(),
    )
    .optional(),
  condicionesDefault: zCondicionesRfq.optional(),
  mandatoDefault: zMandato.optional(),
  pesosRanking: zPesosRankingValidados.optional(),
  mepReferencia: z
    .object({
      valor: z.number().positive('El dólar MEP tiene que ser mayor a 0.'),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha del MEP va como 2026-08-26.'),
    })
    .nullable()
    .optional(),
  // Texto libre: son las instrucciones que el estudio le escribe al analizador
  // de láminas. No hay nada que validar más allá del shape — un rubro fuera de
  // `RUBROS` sí lo rechaza `zInstruccionesExtraccion`.
  instruccionesExtraccion: zInstruccionesExtraccion.optional(),
});

export type CambiosConfig = z.infer<typeof zCambiosConfig>;

export type ResultadoConfig =
  | { ok: true; config: ConfigEstudio; cambios: Record<string, { antes: unknown; despues: unknown }> }
  | { ok: false; errores: Record<string, string> };

/** Primer mensaje por sección: el formulario muestra uno debajo de cada bloque. */
function erroresPorCampo(error: z.ZodError): Record<string, string> {
  const errores: Record<string, string> = {};
  for (const issue of error.issues) {
    const campo = String(issue.path[0] ?? 'form');
    if (!(campo in errores)) errores[campo] = issue.message;
  }
  return errores;
}

async function leerParcial(db: Db, estudioId: string): Promise<Partial<ConfigEstudio>> {
  const [fila] = await db
    .select({ configJson: estudios.configJson })
    .from(estudios)
    .where(eq(estudios.id, estudioId));
  if (!fila) throw new EstudioNoEncontradoError(estudioId);
  return fila.configJson;
}

/**
 * La configuración completa del estudio: lo guardado con los defaults del PRD
 * encima de cada hueco. **Es la única forma de leer la config.**
 */
export async function leerConfig(db: Db, estudioId: string): Promise<ConfigEstudio> {
  return zConfigEstudio.parse(await leerParcial(db, estudioId));
}

/** Mapa de desperdicios mergeado por clave; las claves en `null` se van. */
function mergearDesperdicios(
  actual: Record<string, number> | undefined,
  cambios: Record<string, number | null>,
): Record<string, number> {
  const salida: Record<string, number> = { ...(actual ?? {}) };
  for (const [clave, valor] of Object.entries(cambios)) {
    if (valor === null) delete salida[clave];
    else salida[clave] = valor;
  }
  return salida;
}

/** Igualdad estructural para decidir si hubo cambio real (mismo criterio que `igualJson`). */
function igual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Valida, mergea y persiste. Sin cambios reales no escribe ni audita: una
 * auditoría que registra un no-cambio es ruido que después nadie sabe leer
 * (misma regla que `src/lib/obras/gestion.ts` §2).
 */
export async function guardarConfig(
  db: Db,
  actor: ActorConfig,
  payload: unknown,
): Promise<ResultadoConfig> {
  requireAccion(actor, 'configurar_estudio');

  const parseo = zCambiosConfig.safeParse(payload);
  if (!parseo.success) return { ok: false, errores: erroresPorCampo(parseo.error) };
  const cambios = parseo.data;

  const actual = await leerParcial(db, actor.estudioId);
  const siguiente: Partial<ConfigEstudio> = { ...actual };
  const diff: Record<string, { antes: unknown; despues: unknown }> = {};

  if (cambios.desperdiciosPct !== undefined) {
    const mergeado = mergearDesperdicios(actual.desperdiciosPct, cambios.desperdiciosPct);
    if (!igual(actual.desperdiciosPct ?? {}, mergeado)) {
      diff.desperdiciosPct = { antes: actual.desperdiciosPct ?? {}, despues: mergeado };
      siguiente.desperdiciosPct = mergeado;
    }
  }

  for (const seccion of [
    'condicionesDefault',
    'mandatoDefault',
    'pesosRanking',
    'mepReferencia',
    'instruccionesExtraccion',
  ] as const) {
    const valor = cambios[seccion];
    if (valor === undefined) continue;
    if (igual(actual[seccion], valor)) continue;
    diff[seccion] = { antes: actual[seccion] ?? null, despues: valor };
    // El `as never` es el precio de recorrer secciones heterogéneas con una
    // sola línea: cada `valor` ya viene tipado por su propio schema Zod.
    siguiente[seccion] = valor as never;
  }

  if (Object.keys(diff).length === 0) {
    return { ok: true, config: zConfigEstudio.parse(actual), cambios: {} };
  }

  await db.update(estudios).set({ configJson: siguiente }).where(eq(estudios.id, actor.estudioId));

  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'config_estudio_actualizada',
    targetRef: `estudios:${actor.estudioId}`,
    diff,
  });

  return { ok: true, config: zConfigEstudio.parse(siguiente), cambios: diff };
}
