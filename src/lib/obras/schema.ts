/**
 * Los campos de una obra, validados en un solo lugar.
 *
 * El alta (`crearObraCore`, en `src/app/obras/actions.ts`) y la edición
 * (`editarObra`, en `src/lib/obras/gestion.ts`) tienen que aceptar exactamente
 * lo mismo: si la edición fuera más permisiva que el alta, una obra podría
 * terminar con un dato que el formulario de creación nunca habría dejado entrar.
 * Por eso el schema vive acá y no en ninguno de los dos.
 *
 * Módulo puro: sin base, sin Next. Y **fuera** de todo archivo `'use server'`,
 * donde solo pueden salir funciones async (de ahí que `MONEDAS` no se pudiera
 * exportar desde `actions.ts`).
 */
import { z } from 'zod';

import { TIPOS_OBRA } from '@/types/domain';

/** F0 computa en pesos o en dólares; el resto llega con la compulsa (F1). */
export const MONEDAS = ['ARS', 'USD'] as const;

export type Moneda = (typeof MONEDAS)[number];

export const zDatosObra = z.object({
  nombre: z
    .string()
    .trim()
    .min(1, 'Poné el nombre de la obra.')
    .max(120, 'El nombre no puede pasar de 120 caracteres.'),
  zona: z
    .string()
    .trim()
    .min(1, 'Poné la zona o localidad de la obra.')
    .max(120, 'La zona no puede pasar de 120 caracteres.'),
  tipo: z.enum(TIPOS_OBRA, { error: 'Elegí si es obra nueva, reforma o ampliación.' }),
  moneda: z.enum(MONEDAS, { error: 'Elegí la moneda con la que vas a computar.' }),
});

/**
 * La edición manda solo lo que cambia. Un campo ausente es "dejalo como está";
 * un campo presente se valida con la misma regla que en el alta.
 */
export const zCambiosObra = zDatosObra.partial();

export type DatosObra = z.infer<typeof zDatosObra>;
export type CambiosObra = z.infer<typeof zCambiosObra>;

/** Primer mensaje por campo: el formulario muestra uno solo debajo de cada input. */
export function erroresPorCampo(error: z.ZodError): Record<string, string> {
  const errores: Record<string, string> = {};
  for (const issue of error.issues) {
    const campo = String(issue.path[0] ?? '');
    if (campo && !(campo in errores)) errores[campo] = issue.message;
  }
  return errores;
}
