/**
 * Qué recuadros mira una consulta de la bandeja: la pieza que comparten el
 * server y el cliente.
 *
 * Existe como archivo aparte por una razón de Next, no de estética. Vivía en
 * `ui.tsx`, que es `'use client'`, y `page.tsx` —un Server Component— la
 * llamaba. Eso compila con `tsc`, pasa la suite entera y **explota en runtime**
 * con «Attempted to call fuentesDeAfectadas() from the server but
 * fuentesDeAfectadas is on the client»: lo que un módulo `'use client'` exporta
 * hacia el server no es la función, es una referencia serializable que solo
 * sirve para renderizar o para pasar como prop. La bandeja tiraba 500 al abrir
 * una obra con una consulta de dato de obra, y ningún test lo veía.
 *
 * La regla que deja: **una función pura que corre en los dos lados no vive en
 * un archivo `'use client'`.** Los tipos sí pueden (se borran al compilar); los
 * valores, no. Lo guarda `tests/unit/exports-de-next.test.ts`, al lado de la
 * regla 9 del CLAUDE.md raíz, que es la misma familia de trampa.
 *
 * Módulo hoja: sin React, sin imports de la app.
 */
import type { BBox } from '@/types/domain';

/** Una lámina y el rectángulo que hay que mirar en ella. */
export interface FuenteVista {
  laminaId: string;
  bbox: BBox;
}

/**
 * Dónde están dibujadas las entidades a las que les falta un dato de obra.
 *
 * Una consulta de dato de obra nace **sin fuentes** y con razón: el hecho no se
 * leyó en ninguna lámina, así que no hay bbox honesto que citar (P1 no se cumple
 * citando cualquier cosa). Pero eso dejaba la tarjeta sin nada para mirar —«la
 * altura de local de PB» sin un solo plano al lado— justo en la consulta que más
 * contexto necesita, porque afecta a cuatro elementos a la vez.
 *
 * La provenance que sí existe es la de **los afectados**: dónde está dibujado
 * cada tabique que está esperando la altura. Eso es lo que el panel resalta, en
 * el orden en que el hallazgo los enumera, y por eso se arma acá y no en la
 * base: no es una fuente del hallazgo, es la de las entidades que nombra.
 *
 * Puro: `tests/unit/bandeja-plano.test.ts` lo pinnea.
 */
export function fuentesDeAfectadas(
  entidadIds: readonly string[],
  porEntidad: ReadonlyMap<string, readonly FuenteVista[]>,
): FuenteVista[] {
  const fuentes: FuenteVista[] = [];
  const vistas = new Set<string>();
  for (const id of entidadIds) {
    for (const fuente of porEntidad.get(id) ?? []) {
      const clave = `${fuente.laminaId}:${fuente.bbox.join(',')}`;
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      fuentes.push(fuente);
    }
  }
  return fuentes;
}
