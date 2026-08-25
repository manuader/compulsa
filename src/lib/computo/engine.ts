/**
 * Entrada pública del motor de cómputo.
 *
 * (La orquestación — plantillas + sanity checks + regla de confianza — se
 * implementa en el último ciclo de esta tarea; por ahora este archivo fija el
 * tipo de entidad que consumen todos los módulos del motor.)
 */
import type { EntidadDetectada } from '@/types/domain';

/**
 * Una entidad ya guardada: lo que detectó el análisis (`EntidadDetectada`) más
 * su identidad en la base y la lámina de la que salió. El motor necesita las
 * dos cosas: `laminaId` + `bbox` arman la `Fuente` de cada ítem (P1) e `id`
 * permite que un hallazgo apunte al campo exacto que hay que completar.
 */
export type EntidadPersistida = EntidadDetectada & { id: string; laminaId: string };
