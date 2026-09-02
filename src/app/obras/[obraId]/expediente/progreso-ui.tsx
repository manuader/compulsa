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
import { useEffect } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { FaseAnalisis } from '@/types/domain';

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
      return 'El cruce pidió volver sobre algunas láminas antes de preguntarte nada.';
    case 'listo':
      return null;
    case 'error':
      return 'Lo que se pudo analizar está computado; el resto quedó como estaba. Podés reprocesar las láminas que fallaron.';
  }
}

const TONO: Record<FaseAnalisis['fase'], BadgeTone> = {
  inventario: 'info',
  extraccion: 'info',
  cruce: 'info',
  relectura: 'info',
  listo: 'ok',
  error: 'error',
};

export interface ProgresoAnalisisProps {
  /** La fase que el pipeline dejó escrita, o `null` si la obra nunca se analizó. */
  fase: FaseAnalisis | null;
}

export function ProgresoAnalisis({ fase }: ProgresoAnalisisProps) {
  const router = useRouter();
  const corriendo = enCurso(fase);

  useEffect(() => {
    if (!corriendo) return;
    const id = setInterval(() => router.refresh(), REFRESCO_MS);
    return () => clearInterval(id);
  }, [corriendo, router]);

  // Nunca se analizó nada: no hay progreso que mostrar y un cartel vacío sería
  // ruido. El bloque de upload de abajo ya dice qué hacer.
  if (fase === null) return null;

  const ayuda = ayudaDeFase(fase);
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
        <Badge tone={TONO[fase.fase]}>{fase.fase === 'listo' ? 'Analizado' : 'Analizando'}</Badge>
        <p className="text-sm font-medium text-neutral-900">{textoDeFase(fase)}</p>
      </div>

      {porcentaje !== null && corriendo ? (
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

      {ayuda ? <p className="text-xs text-neutral-600">{ayuda}</p> : null}
    </section>
  );
}
