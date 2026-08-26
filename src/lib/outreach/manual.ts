/**
 * Canal manual: el único activo (global-constraints, PRD §13).
 *
 * "Enviar" por este canal no manda nada por la red. El mensaje ya quedó escrito
 * en `mensajes` como borrador (`pendiente_envio_manual`, ver `threads.ts`) y lo
 * que sigue lo hace una persona: copia el texto, adjunta los recortes y lo manda
 * por donde tenga trato con ese proveedor. Por eso `enviar()` devuelve `ok`: el
 * canal cumplió con lo suyo —dejar el mensaje listo y registrado— y el envío de
 * verdad lo confirma el usuario después con `registrarEnvio()`.
 *
 * Lo que este canal **no** hace es igual de importante: no promete un envío que
 * no ocurrió. Mientras nadie registre el envío, el contacto sigue en
 * `pendiente` y el mensaje sigue siendo un borrador.
 */
import type { CanalOutreach, MensajeSaliente, ResultadoEnvio } from './canal';

export function crearCanalManual(): CanalOutreach {
  return {
    canal: 'manual',

    async enviar(mensaje: MensajeSaliente): Promise<ResultadoEnvio> {
      // Único chequeo real: un mensaje vacío no se le manda a nadie. Que el
      // canal sea manual no lo convierte en un buzón sin reglas.
      if (mensaje.cuerpo.trim() === '') {
        return { ok: false, motivo: 'El mensaje no tiene texto: no hay nada para mandarle al proveedor.' };
      }
      return { ok: true };
    },
  };
}
