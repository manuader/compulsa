/**
 * Canales que el dominio conoce y esta instalación no tiene: WhatsApp, voz y
 * mail.
 *
 * No son "próximamente": son adaptadores que fallan con un error de
 * configuración honesto (global-constraints: *servicios externos = adapter +
 * error de configuración honesto*). Preferimos que `getCanal('whatsapp')`
 * reviente nombrando `WHATSAPP_TOKEN` a que devuelva un objeto que traga
 * mensajes y no manda nada: un mensaje que el proveedor nunca recibió y el
 * sistema da por enviado es peor que un error.
 *
 * Cuando alguno se implemente de verdad, el reemplazo es una fábrica que
 * cumpla `CanalOutreach` — el core (`src/lib/compulsa/flujo.ts`) no cambia.
 */
import type { Canal } from '@/types/domain';

import { CanalNoConfiguradoError, type CanalOutreach } from './canal';

/**
 * Qué variable de entorno habilita cada canal. Es **dato**: agregar un canal es
 * agregar una fila, y el mensaje del error sale de acá.
 *
 * - `whatsapp`: token de la Cloud API de WhatsApp Business.
 * - `voz`: Retell, el proveedor de llamadas del PRD.
 * - `email`: URL SMTP del estudio.
 */
export const VARIABLES_POR_CANAL: Record<Exclude<Canal, 'manual'>, readonly string[]> = {
  whatsapp: ['WHATSAPP_TOKEN'],
  voz: ['RETELL_API_KEY'],
  email: ['SMTP_URL'],
};

/**
 * El "canal" que no existe todavía. Lanza al crearse, no al enviar: si el core
 * pudo construirlo, el mensaje ya estaría escrito y el usuario creería que
 * salió.
 */
export function crearCanalStub(canal: Canal): CanalOutreach {
  if (canal === 'manual') {
    throw new Error('El canal manual no es un stub: pedilo con `crearCanalManual()`.');
  }
  throw new CanalNoConfiguradoError(canal, VARIABLES_POR_CANAL[canal]);
}
