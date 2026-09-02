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
import { faseVencida, type FaseAnalisis } from '@/types/domain';

/** Cada cuánto se vuelve a preguntar mientras el análisis corre. */
export const REFRESCO_MS = 4000;

/** `true` mientras el análisis sigue corriendo: es lo que enciende el polling. */
export function enCurso(fase: FaseAnalisis | null): boolean {
  return fase !== null && fase.fase !== 'listo' && fase.fase !== 'error';
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
    const revisar = (): void => setColgada(faseVencida(fase, Date.now()));
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
          Hace más de diez minutos que esta etapa no avanza: lo más probable es que el análisis se
          haya cortado sin poder dejarlo escrito. Lo que se alcanzó a analizar está computado; el
          resto quedó como estaba. Podés volver a cruzar el expediente, o reprocesar las láminas de
          abajo de a una.
        </p>
      ) : ayuda ? (
        <p className="text-xs text-neutral-600">{ayuda}</p>
      ) : null}

      {/* Cruzar de nuevo es la única acción de obra entera que arregla una
          corrida que se cortó: reprocesar lámina por lámina vuelve a leer los
          planos, que no es lo que se rompió. Va también sobre la fase colgada,
          que es el mismo problema sin el cartel de error. */}
      {(fase.fase === 'error' || colgada) && reintentoDeCruce !== null ? (
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
