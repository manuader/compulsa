/**
 * Cómo se leen las dos columnas de la derecha de la auditoría: el objeto y el
 * diff.
 *
 * Vive afuera de `page.tsx` por lo mismo que `frases.ts`: los exports de una
 * página los valida Next igual que los de un `route.ts` (CLAUDE.md §9), así que
 * desde ahí esto no se puede exportar — y sin exportarlo no hay test que fije
 * el orden de los campos, que es justo lo que estaba mal.
 *
 * Módulo puro: sin React, sin DB, sin imports de la app.
 */
/** "computo_items:seco.placas" → "seco.placas". El prefijo es la tabla, no el objeto. */
export function objeto(targetRef: string | null): string {
  if (!targetRef) return '—';
  const corte = targetRef.indexOf(':');
  return corte === -1 ? targetRef : targetRef.slice(corte + 1);
}

/**
 * Los campos del diff que se muestran **primero**, en este orden.
 *
 * El corte a tres campos es sano —el detalle completo está en la base y esta
 * columna es para reconocer la fila— pero cortaba por el orden en que `jsonb`
 * devuelve las claves, que no es el que se escribió. Resultado: en una fila de
 * `analisis_llm`, los tres primeros eran `modelo`, `documentoNombre` y
 * `numeroPagina`, y **`tokensEntrada` —que es lo que domina la factura— no
 * aparecía nunca**. RNF-7 pide que el costo se mida *y* se vea; se estaba
 * cumpliendo la mitad.
 */
const CAMPOS_PRIORITARIOS = [
  'tokensEntrada',
  'tokensSalida',
  'tokensCacheLectura',
  'tokensCacheEscritura',
];

/** Los prioritarios que estén, en su orden, y después el resto como venga. */
export function ordenarCampos(campos: readonly string[]): string[] {
  const presentes = CAMPOS_PRIORITARIOS.filter((campo) => campos.includes(campo));
  return [...presentes, ...campos.filter((campo) => !presentes.includes(campo))];
}

/**
 * El diff, en una línea legible.
 *
 * Los diffs del repo tienen dos formas: `{ campo: { antes, despues } }` para las
 * ediciones y `{ campo: valor }` para las metadatas. Se muestran las dos sin
 * pretender que son la misma cosa, y se corta a tres campos: el detalle completo
 * está en la base, esta columna es para reconocer la fila.
 */
export function detalle(diff: Record<string, unknown> | null): string {
  if (!diff) return '—';

  const partes: string[] = [];
  for (const campo of ordenarCampos(Object.keys(diff))) {
    if (partes.length === 3) {
      partes.push('…');
      break;
    }
    const valor = diff[campo];
    if (valor !== null && typeof valor === 'object' && 'antes' in valor && 'despues' in valor) {
      const cambio = valor as { antes: unknown; despues: unknown };
      partes.push(`${campo}: ${corto(cambio.antes)} → ${corto(cambio.despues)}`);
    } else {
      partes.push(`${campo}: ${corto(valor)}`);
    }
  }
  return partes.join(' · ');
}

function corto(valor: unknown): string {
  if (valor === null || valor === undefined) return '—';
  if (typeof valor === 'string') return valor.length > 40 ? `${valor.slice(0, 39)}…` : valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  const texto = JSON.stringify(valor);
  return texto.length > 40 ? `${texto.slice(0, 39)}…` : texto;
}
