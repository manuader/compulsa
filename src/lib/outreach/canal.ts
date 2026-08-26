/**
 * El canal de outreach: por dónde sale un mensaje al proveedor.
 *
 * Hoy hay **un solo canal activo, el manual** (global-constraints): el sistema
 * redacta el mensaje y una persona del estudio lo manda. WhatsApp, voz y mail
 * existen como stubs que fallan con un error de configuración honesto
 * (`stubs.ts`) — nunca como un envío silencioso que no ocurrió.
 *
 * Eso no es una limitación temporal disfrazada de arquitectura: el §13 del PRD
 * prohíbe el contacto frío por WhatsApp, y el canal manual es justamente el que
 * deja la decisión de mandar —y por dónde— en manos de una persona, con el
 * consentimiento del proveedor a la vista.
 *
 * ## El cuerpo del mensaje y sus adjuntos
 *
 * `mensajes` (P1) guarda un `cuerpo` de texto y nada más: no hay columna de
 * adjuntos. Los recortes de plano (RF-703) se guardan en el storage y sus refs
 * viajan **dentro del cuerpo**, después de `MARCA_ADJUNTOS`, que es una marca
 * que ninguna persona escribe. `partirCuerpo()` los separa de nuevo: la UI
 * muestra `texto` en el botón "Copiar" y `adjuntos` como descargas. Es una
 * concesión al esquema, está acotada a estas dos funciones y tiene tests.
 *
 * Módulo sin I/O: define el contrato y la composición del cuerpo. Quien
 * persiste es el core (`src/lib/compulsa/flujo.ts`).
 */
import type { Canal } from '@/types/domain';

import { crearCanalManual } from './manual';
import { crearCanalStub } from './stubs';

/** Un mensaje listo para salir. `adjuntos` son refs del storage, no bytes. */
export interface MensajeSaliente {
  contactoId: string;
  canal: Canal;
  cuerpo: string;
  adjuntos: readonly string[];
}

/**
 * El envío salió o no salió, con motivo. Nunca se tira una excepción por un
 * canal caído: el mensaje ya está escrito en la base y lo que falta es decirle
 * al usuario qué pasó.
 */
export type ResultadoEnvio = { ok: true } | { ok: false; motivo: string };

export interface CanalOutreach {
  readonly canal: Canal;
  enviar(mensaje: MensajeSaliente): Promise<ResultadoEnvio>;
}

/**
 * El canal existe en el dominio pero no está configurado en esta instalación.
 *
 * El mensaje nombra **las variables de entorno que faltan**: un "no disponible"
 * a secas obliga a leer el código para saber qué hay que hacer.
 */
export class CanalNoConfiguradoError extends Error {
  constructor(
    readonly canal: Canal,
    readonly variables: readonly string[],
  ) {
    super(
      `El canal ${canal} no está configurado en esta instalación. ` +
        `Configurá ${variables.join(' y ')} para habilitarlo. ` +
        'Mientras tanto, el pedido sale por el canal manual: el sistema escribe el mensaje y lo mandás vos.',
    );
    this.name = 'CanalNoConfiguradoError';
  }
}

/**
 * Separador entre el texto que ve el proveedor y las refs de los adjuntos.
 *
 * Los corchetes dobles no aparecen en un texto de gremio y el bloque va al
 * final: si alguien copia el cuerpo crudo por accidente, lo peor que pasa es
 * que se vea una lista de rutas, no que se pierda el pedido.
 */
export const MARCA_ADJUNTOS = '\n\n[[adjuntos]]\n';

/** El cuerpo que se guarda en `mensajes`: el texto y, si hay, las refs. */
export function componerCuerpo(texto: string, adjuntos: readonly string[] = []): string {
  const refs = adjuntos.filter((ref) => ref.trim() !== '');
  if (refs.length === 0) return texto;
  return `${texto}${MARCA_ADJUNTOS}${refs.join('\n')}`;
}

/** La inversa de `componerCuerpo`. Un cuerpo sin marca devuelve `adjuntos: []`. */
export function partirCuerpo(cuerpo: string): { texto: string; adjuntos: string[] } {
  const corte = cuerpo.indexOf(MARCA_ADJUNTOS);
  if (corte === -1) return { texto: cuerpo, adjuntos: [] };

  const texto = cuerpo.slice(0, corte);
  const adjuntos = cuerpo
    .slice(corte + MARCA_ADJUNTOS.length)
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => linea !== '');
  return { texto, adjuntos };
}

/**
 * El canal pedido, o un error de configuración.
 *
 * `manual.ts` y `stubs.ts` importan de este módulo el contrato y el error, así
 * que hay un ciclo de imports: se resuelve solo porque las fábricas se usan
 * dentro del cuerpo de esta función y no en la evaluación del módulo.
 */
export function getCanal(canal: Canal): CanalOutreach {
  if (canal === 'manual') return crearCanalManual();
  return crearCanalStub(canal);
}

