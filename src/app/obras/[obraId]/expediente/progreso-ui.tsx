'use client';

/**
 * En qué anda el análisis del expediente, mientras anda.
 *
 * El pipeline pasa por cinco fases (`obras.analisis_json`) y hasta acá el
 * arquitecto no veía ninguna: subía diez láminas, la pantalla quedaba igual y la
 * única señal era el estado de cada lámina cambiando de a una, sin decir que
 * después venía un cruce del expediente entero y una relectura. Una barra que no
 * dice qué está pasando es un spinner eterno con otra cara, y el §6 de `app/CLAUDE.md`
 * lo prohíbe.
 *
 * **El polling es suave y se apaga solo.** Mientras la fase no es `listo` ni
 * `error` se pide un `router.refresh()` cada pocos segundos —el Server Component
 * vuelve a leer `analisis_json` y baja la fase nueva—; cuando termina, el
 * intervalo se limpia y la pantalla deja de pedir nada. No hay websocket ni
 * `EventSource`: el análisis de una obra dura minutos, no horas, y una consulta
 * cada cuatro segundos durante ese rato es más barata que una conexión abierta.
 *
 * `textoDeFase` es puro y está pinneado en `tests/unit/expediente-fase.test.ts`:
 * es lo único de acá que se puede equivocar sin que se note.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { FaseAnalisis } from '@/types/domain';

/** Cada cuánto se vuelve a preguntar mientras el análisis corre. */
export const REFRESCO_MS = 4000;

/** `true` mientras el análisis sigue corriendo: es lo que enciende el polling. */
export function enCurso(fase: FaseAnalisis | null): boolean {
  return fase !== null && fase.fase !== 'listo' && fase.fase !== 'error';
}

/**
 * Cuánto puede pasar sin noticias antes de que «Analizando» deje de ser cierto.
 *
 * Diez minutos: el doble del `maxDuration` del POST del upload, que es adentro
 * de donde corre el análisis. Pasado eso, lo que hay no es un análisis lento
 * sino uno que se cortó sin poder escribir su fase — el proceso se murió, el
 * deploy reinició, la máquina se quedó sin memoria.
 *
 * **Es el mismo número que `TTL_FASE_ANALISIS_MS` de `types/domain.ts`**, que
 * escribe la rama del pipeline: cuando las dos estén juntas, esta constante se
 * borra y se importa aquella.
 */
export const FASE_VIEJA_MS = 10 * 60 * 1000;

/**
 * La marca de tiempo que el pipeline deja en cada avance de fase
 * (`FaseAnalisis.desde`), o `null` si esta versión todavía no la escribe.
 *
 * Se lee con un ensanchamiento explícito y no con un `any` porque el campo lo
 * agrega la rama del pipeline en paralelo a esta: hasta que estén juntas, esto
 * devuelve `null` y la pantalla se comporta como antes. El día que el tipo lo
 * declare, este acceso sigue siendo el mismo y el `typeof` sobra sin molestar
 * — y entonces `faseColgada` se borra y su lugar lo ocupa `faseVencida()`, que
 * es la misma función del lado del dominio.
 */
export function selloDeFase(fase: FaseAnalisis): string | null {
  const sello = (fase as FaseAnalisis & { desde?: unknown }).desde;
  return typeof sello === 'string' ? sello : null;
}

/**
 * `true` si la fase quedó **colgada**: dice que está corriendo pero hace rato
 * que nadie la toca. Gemela de `faseVencida()` de `types/domain.ts`, que la
 * rama del pipeline escribió del lado del dominio; sobrevive una sola.
 *
 * Sin esto, un pipeline que se murió sin escribir su error deja la pantalla
 * diciendo «Analizando las láminas · 3 de 25» para siempre, con la barra
 * quieta y el polling pidiendo cada cuatro segundos. Un spinner eterno con otra
 * cara es justo lo que el §6 de `app/CLAUDE.md` prohíbe.
 *
 * Sin sello no se puede saber, y no se inventa: devuelve `false`.
 */
export function faseColgada(fase: FaseAnalisis | null, ahora: number): boolean {
  if (fase === null || !enCurso(fase)) return false;
  const sello = selloDeFase(fase);
  if (sello === null) return false;
  const cuando = Date.parse(sello);
  return Number.isFinite(cuando) && ahora - cuando > FASE_VIEJA_MS;
}

/** "3 de 25", o `null` si la fase no lleva la cuenta. */
function avance(fase: FaseAnalisis): string | null {
  if (fase.total === undefined) return null;
  return `${fase.completadas ?? 0} de ${fase.total}`;
}

/**
 * La fase, en castellano y diciendo qué se está haciendo.
 *
 * Nombra el trabajo, no el paso interno: «cruzando la información del
 * expediente» es algo que un arquitecto entiende; «fase 3 de 5» no dice nada
 * sobre por qué la pantalla todavía no muestra la planilla.
 */
export function textoDeFase(fase: FaseAnalisis): string {
  const cuantas = avance(fase);
  switch (fase.fase) {
    case 'inventario':
      return cuantas === null
        ? 'Inventariando la documentación'
        : `Inventariando la documentación · ${cuantas}`;
    case 'extraccion':
      return cuantas === null ? 'Analizando las láminas' : `Analizando las láminas · ${cuantas}`;
    case 'cruce':
      return 'Cruzando la información del expediente';
    case 'relectura': {
      const total = fase.total;
      if (total === undefined) return 'Releyendo las láminas que hacen falta';
      return total === 1 ? 'Releyendo 1 lámina' : `Releyendo ${total} láminas`;
    }
    case 'listo':
      return 'Listo';
    case 'error':
      return fase.detalle === undefined || fase.detalle === ''
        ? 'El análisis terminó con problemas'
        : `El análisis terminó con problemas: ${fase.detalle}`;
  }
}

/** El detalle que acompaña a la fase, para que la espera se entienda. */
function ayudaDeFase(fase: FaseAnalisis): string | null {
  switch (fase.fase) {
    case 'inventario':
      return 'Se leen los rótulos para saber qué es cada lámina antes de analizarla.';
    case 'extraccion':
      return 'Se leen los elementos y sus medidas, lámina por lámina.';
    case 'cruce':
      return 'Se buscan los datos que una lámina dice y otra calla, y las contradicciones entre las dos.';
    case 'relectura':
      return 'Hay láminas que hay que volver a mirar con lo que dicen las otras, antes de preguntarte nada.';
    case 'listo':
      return null;
    case 'error':
      return 'Lo que se pudo analizar está computado; el resto quedó como estaba. Abajo, cada lámina dice cómo terminó y se puede reprocesar de a una.';
  }
}

/**
 * Cómo se llama el estado en el badge, y con qué tono.
 *
 * Decía «Analizando» en rojo mientras el texto de al lado contaba que el
 * análisis había terminado con problemas y el polling ya se había apagado: el
 * badge afirmaba que algo estaba pasando cuando no pasaba nada.
 */
export function etiquetaDeEstado(
  fase: FaseAnalisis,
  colgada: boolean,
): { texto: string; tono: BadgeTone } {
  if (fase.fase === 'listo') return { texto: 'Analizado', tono: 'ok' };
  if (fase.fase === 'error') return { texto: 'Con problemas', tono: 'error' };
  if (colgada) return { texto: 'Sin novedades', tono: 'warn' };
  return { texto: 'Analizando', tono: 'info' };
}

export interface ProgresoAnalisisProps {
  /** La fase que el pipeline dejó escrita, o `null` si la obra nunca se analizó. */
  fase: FaseAnalisis | null;
  /**
   * A dónde postear «Reintentar el cruce», o `null` para no ofrecerlo.
   *
   * La ruta es `POST /api/obras/[obraId]/cruce`, que rehace las tres fases de
   * obra (cruce, relectura y cómputo final) y se niega con 409 si hay una
   * corrida viva encima. Es un prop y no una constante porque un botón que pega
   * contra un 404 es peor que no tener botón: la página lo pasa cuando la ruta
   * existe, y así esta pantalla no depende de en qué orden entren las ramas.
   */
  reintentoDeCruce?: string | null;
}

export function ProgresoAnalisis({ fase, reintentoDeCruce = null }: ProgresoAnalisisProps) {
  const router = useRouter();
  const corriendo = enCurso(fase);
  // Arranca en `false` a propósito: `Date.now()` en el render del server y en el
  // del cliente no dan lo mismo, y una diferencia acá sería un mismatch de
  // hidratación. Lo resuelve el efecto, que corre apenas monta.
  const [colgada, setColgada] = useState(false);
  const [reintentando, setReintentando] = useState(false);
  const [errorReintento, setErrorReintento] = useState<string | null>(null);

  useEffect(() => {
    if (!corriendo) {
      setColgada(false);
      return;
    }
    // La misma vuelta que refresca revisa el reloj: si la fase dejó de moverse,
    // la pantalla lo dice en vez de seguir prometiendo que algo pasa.
    const revisar = (): void => setColgada(faseColgada(fase, Date.now()));
    revisar();
    const id = setInterval(() => {
      revisar();
      router.refresh();
    }, REFRESCO_MS);
    return () => clearInterval(id);
  }, [corriendo, fase, router]);

  async function reintentarCruce(): Promise<void> {
    if (reintentoDeCruce === null) return;
    setErrorReintento(null);
    setReintentando(true);
    try {
      const respuesta = await fetch(reintentoDeCruce, { method: 'POST' });
      if (!respuesta.ok) {
        const cuerpo = (await respuesta.json().catch(() => null)) as { error?: string } | null;
        throw new Error(cuerpo?.error ?? 'No pude volver a cruzar el expediente.');
      }
      router.refresh();
    } catch (error) {
      setErrorReintento(
        error instanceof Error ? error.message : 'No pude volver a cruzar el expediente.',
      );
    } finally {
      setReintentando(false);
    }
  }

  // Nunca se analizó nada: no hay progreso que mostrar y un cartel vacío sería
  // ruido. El bloque de upload de abajo ya dice qué hacer.
  if (fase === null) return null;

  const ayuda = ayudaDeFase(fase);
  const estado = etiquetaDeEstado(fase, colgada);
  const porcentaje =
    fase.total !== undefined && fase.total > 0
      ? Math.min(100, Math.round(((fase.completadas ?? 0) / fase.total) * 100))
      : null;

  return (
    <section
      aria-live="polite"
      className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={estado.tono}>{estado.texto}</Badge>
        <p className="text-sm font-medium text-neutral-900">{textoDeFase(fase)}</p>
      </div>

      {porcentaje !== null && corriendo && !colgada ? (
        <div
          role="progressbar"
          aria-valuenow={porcentaje}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Avance del análisis"
          className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200"
        >
          <div
            className="h-full rounded-full bg-neutral-900 transition-[width] duration-500"
            style={{ width: `${porcentaje}%` }}
          />
        </div>
      ) : null}

      {colgada ? (
        <p className="text-xs text-neutral-600">
          Hace más de media hora que esta etapa no avanza: lo más probable es que el análisis se
          haya cortado sin poder dejarlo escrito. Lo que se alcanzó a analizar está computado.
          Volvé a subir la documentación o reprocesá las láminas de abajo.
        </p>
      ) : ayuda ? (
        <p className="text-xs text-neutral-600">{ayuda}</p>
      ) : null}

      {/* Cruzar de nuevo es la única acción de obra entera que arregla un cruce
          que falló: reprocesar lámina por lámina vuelve a leer los planos, que
          no es lo que se rompió. */}
      {fase.fase === 'error' && reintentoDeCruce !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void reintentarCruce()}
            disabled={reintentando}
          >
            {reintentando ? 'Cruzando…' : 'Reintentar el cruce'}
          </Button>
          {errorReintento ? <p className="text-xs text-red-700">{errorReintento}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
