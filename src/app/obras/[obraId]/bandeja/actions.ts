'use server';

/**
 * Endpoints de la bandeja de consultas: sesión, obra y revalidación.
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** que el
 * cliente puede invocar con el payload que quiera. Por eso acá no hay ni una
 * línea de lógica de dominio: los núcleos que mutan la base viven en
 * `@/lib/bandeja/resolver` —reciben la obra y el actor explícitos, y no tienen
 * forma de saber quién los llama— y este archivo exporta **solo** los
 * envoltorios `*Action`, que son las cuatro líneas que faltan:
 *
 *   1. `requireUser()` — hay sesión válida.
 *   2. `requireObra()` — la obra es del estudio del usuario (RNF-4). El `obraId`
 *      que vale es el que devuelve el guard, **no** el que vino en el JSON.
 *   3. el núcleo, con el actor sacado de la sesión.
 *   4. `revalidatePath()` de las tres pantallas que muestran las consultas.
 *
 * Si alguna vez hay que exportar algo más de este archivo, la pregunta es si
 * ese algo puede ser invocado por un cliente cualquiera; si la respuesta no es
 * un sí rotundo, va al resolver.
 */
import { z } from 'zod';

import { requireObra, requireUser } from '@/lib/auth/guards';
import {
  requireAccion,
  RolInsuficienteError,
  UsuarioInactivoError,
} from '@/lib/plataforma/roles';
import {
  confirmarLote,
  descartarHallazgo,
  descartarLote,
  confirmarSupuesto,
  marcarExistente,
  responderHallazgo,
  zUuid,
  type ActorBandeja,
  type EntradaHallazgo,
  type EntradaLote,
  type EntradaRespuesta,
  type ResultadoAccion,
  type ResultadoConfirmacionLote,
  type ResultadoLote,
} from '@/lib/bandeja/resolver';
import { buscarDatosFaltantes } from '@/lib/pipeline/busqueda';
import {
  rechazarDatoDeObra,
  type EntradaDatoObra,
} from '@/lib/datos-obra/persistencia';

/**
 * La bandeja, la planilla y el tablero muestran las mismas consultas desde el
 * server: tras resolver una, las tres tienen que volver a leerse.
 */
async function revalidar(obraId: string): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath(`/obras/${obraId}/bandeja`);
  revalidatePath(`/obras/${obraId}/computo`);
  revalidatePath(`/obras/${obraId}`);
}

const PAYLOAD_ILEGIBLE = 'No pude leer la obra de la consulta.';

/**
 * Resolver una consulta muta la obra: es de colaborador para arriba (RF-1201).
 * `lectura` mira la bandeja pero no la toca. El chequeo va acá, en el envoltorio
 * que resuelve la sesión, porque los núcleos del resolver reciben el actor
 * explícito y no saben quién los llama.
 */
function mensajeDeRol(error: unknown): string | null {
  if (error instanceof RolInsuficienteError || error instanceof UsuarioInactivoError) {
    return error.message;
  }
  return null;
}

/**
 * Sesión válida + obra del estudio (RNF-4).
 *
 * El payload de una server action es texto que manda el cliente: el `obraId`
 * se valida antes de tocarlo y la obra que vale es la que devuelve
 * `requireObra`, no la que vino en el JSON.
 */
type Contexto = (ActorBandeja & { obraId: string }) | { error: string } | null;

async function contexto(entrada: unknown): Promise<Contexto> {
  const parseo = z.object({ obraId: zUuid }).safeParse(entrada);
  if (!parseo.success) return null;

  const { usuario } = await requireUser();
  try {
    requireAccion(usuario, 'resolver_hallazgo');
  } catch (error) {
    const mensaje = mensajeDeRol(error);
    if (mensaje) return { error: mensaje };
    throw error;
  }

  const obra = await requireObra(parseo.data.obraId);
  return { obraId: obra.id, usuarioId: usuario.id, email: usuario.email };
}

/** `true` si el contexto es un rechazo por rol y no un actor. */
function esRechazo(ctx: Contexto): ctx is { error: string } {
  return ctx !== null && 'error' in ctx;
}

export async function responderHallazgoAction(entrada: EntradaRespuesta): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId, ...actor } = ctx;
  const resultado = await responderHallazgo({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}

export async function marcarExistenteAction(entrada: EntradaHallazgo): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId, ...actor } = ctx;
  const resultado = await marcarExistente({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}

export async function confirmarSupuestoAction(entrada: EntradaHallazgo): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId, ...actor } = ctx;
  const resultado = await confirmarSupuesto({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}

export async function descartarHallazgoAction(entrada: EntradaHallazgo): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId, ...actor } = ctx;
  const resultado = await descartarHallazgo({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}

export async function descartarLoteAction(entrada: EntradaLote): Promise<ResultadoLote> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId, ...actor } = ctx;
  const resultado = await descartarLote({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}

export async function confirmarLoteAction(
  entrada: EntradaLote,
): Promise<ResultadoConfirmacionLote> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId, ...actor } = ctx;
  const resultado = await confirmarLote({ ...entrada, obraId }, actor);
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}

/**
 * Busca en la documentación los datos que la bandeja está preguntando
 * (decisión 5): una llamada por lámina candidata, que solo escribe
 * **propuestas** —el dato entra a la entidad recién cuando alguien confirma
 * (P4)—. Gasta créditos, así que es un botón explícito, no algo que pase solo
 * al mirar la pantalla.
 *
 * El núcleo se importa **estático**, como cualquier otro de este archivo. Hubo
 * una versión con `await import()` y comentarios `webpackIgnore`, puesta cuando
 * el módulo todavía lo escribía otra rama: con esos comentarios el bundler deja
 * el specifier crudo, Node no resuelve el alias `@/` y el `catch` convertía el
 * `ERR_MODULE_NOT_FOUND` en "no disponible en esta versión". El botón estaba
 * muerto en runtime con la suite entera en verde, porque un envoltorio sin
 * lógica no tenía quién lo ejercitara. Ahora lo ejercita
 * `tests/integration/bandeja-acciones.test.ts`.
 */
interface EntradaBusqueda {
  obraId: string;
}

export async function buscarEnDocumentacionAction(
  entrada: EntradaBusqueda,
): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId } = ctx;

  // La búsqueda habla con la API de análisis: sin credenciales falla con un
  // error que nombra la variable que falta (CLAUDE.md §8), y eso es lo que
  // tiene que leer el arquitecto, no un 500.
  try {
    await buscarDatosFaltantes(obraId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No pude buscar en la documentación.',
    };
  }

  await revalidar(obraId);
  return { ok: true };
}

/**
 * Rechaza un **dato de obra que escribió el sistema**: la fila se va y la
 * consulta agrupada vuelve a «Preguntas» (§5.2, §5.4).
 *
 * Va acá y no en `deducciones/actions.ts` porque la solapa que lo ofrece es la
 * de la bandeja, y porque el rol que exige es el mismo que resolver una
 * consulta: quien puede contestar la altura de local puede decir que la que el
 * sistema leyó está mal.
 *
 * Todo lo que muta la base vive en `@/lib/datos-obra/persistencia`: acá solo
 * están la sesión, la obra, el actor con el rol de la sesión y la revalidación.
 */
export async function rechazarDatoDeObraAction(
  entrada: EntradaDatoObra,
): Promise<ResultadoAccion> {
  const ctx = await contexto(entrada);
  if (!ctx) return { ok: false, error: PAYLOAD_ILEGIBLE };
  if (esRechazo(ctx)) return { ok: false, error: ctx.error };
  const { obraId, usuarioId, email } = ctx;

  // El rol vuelve a salir de la sesión, no del payload: `contexto` ya lo
  // verificó con `requireAccion`, y el núcleo lo vuelve a exigir por su cuenta
  // porque es invocable desde cualquier otro llamador.
  const { usuario } = await requireUser();
  const resultado = await rechazarDatoDeObra(
    { obraId, datoId: entrada.datoId },
    { usuarioId, email, rol: usuario.rol },
  );
  if (resultado.ok) await revalidar(obraId);
  return resultado;
}
