/**
 * Qué mide el pipeline sobre el dibujo, campo por campo (`medidasDeDibujo`).
 *
 * Es la decisión más delicada de la medición gráfica y por eso se testea sola:
 * el bbox está alineado a los ejes de la hoja, así que **el rectángulo no dice
 * por sí solo qué representa cada lado**. El mismo tabique dibujado en vertical
 * tiene un bbox angosto y alto; leer su ancho como largo daría 0,30 m —el
 * espesor— en vez de 6 m, y ese número entra al cómputo sin que nadie lo mire
 * dos veces. Las tres reglas que esto pinnea:
 *
 *  1. **el tipo de lámina decide el eje**: en planta se miden dimensiones en
 *     planta, en corte y vista la altura, y en una planilla o un detalle no se
 *     mide nada;
 *  2. **el largo es el lado más largo**, no el ancho del bbox;
 *  3. **si la relación de aspecto no identifica el eje, no se mide**: un
 *     rectángulo casi cuadrado no dice para dónde corre el muro, y la respuesta
 *     honesta es dejar la cota faltando.
 *
 * La hoja es la A4 apaisada de los fixtures (841,89 × 595,28 pts) a 1:50, así
 * que los números son los mismos que pinnea `pipeline-fases.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { EntidadPersistida } from '@/lib/computo/engine';
import { largoDelDibujo, medidasDeDibujo, RELACION_MINIMA_MURO } from '@/lib/pipeline/procesar';
import type { BBox, TipoEntidad, TipoLamina } from '@/types/domain';

const HOJA = { ancho: 841.89, alto: 595.28 };
const ESCALA = '1:50';
const METODO = 'medición gráfica sobre el dibujo a escala 1:50';

function entidad(
  tipo: TipoEntidad,
  bbox: BBox,
  atributos: EntidadPersistida['atributos'] = {},
): EntidadPersistida {
  return {
    id: 'e1',
    laminaId: 'l1',
    tipo,
    nombre: 'X',
    bbox,
    confianza: 0.9,
    estadoReforma: 'na',
    atributos,
  };
}

/** Horizontal y flaco: 7,43 m × 0,21 m (relación 35:1). */
const MURO_HORIZONTAL: BBox = [0.06, 0.8, 0.5, 0.02];
/** El MISMO muro dibujado en vertical: 0,21 m de ancho × 7,43 m de alto. */
const MURO_VERTICAL: BBox = [0.2, 0.1, 0.0141, 0.7076];
/** Casi cuadrado: 4,46 m × 4,73 m (relación 1,06:1). */
const BLOQUE: BBox = [0.1, 0.1, 0.3, 0.45];

interface Caso {
  nombre: string;
  tipo: TipoEntidad;
  lamina: TipoLamina | null;
  bbox: BBox;
  atributos?: EntidadPersistida['atributos'];
  espera: Array<{ campo: string; valor: number }>;
}

const CASOS: Caso[] = [
  {
    nombre: 'muro horizontal en planta ⇒ largo = el lado largo',
    tipo: 'muro',
    lamina: 'planta',
    bbox: MURO_HORIZONTAL,
    espera: [{ campo: 'largoM', valor: 7.43 }],
  },
  {
    nombre: 'el MISMO muro dibujado en vertical mide lo mismo (no su espesor)',
    tipo: 'muro',
    lamina: 'planta',
    bbox: MURO_VERTICAL,
    espera: [{ campo: 'largoM', valor: 7.43 }],
  },
  {
    nombre: 'tabique vertical en planta ⇒ largo = el lado largo',
    tipo: 'tabique',
    lamina: 'planta',
    bbox: MURO_VERTICAL,
    espera: [{ campo: 'largoM', valor: 7.43 }],
  },
  {
    nombre: 'un rectángulo casi cuadrado NO se mide: no dice para dónde corre',
    tipo: 'muro',
    lamina: 'planta',
    bbox: BLOQUE,
    espera: [],
  },
  {
    nombre: 'a un muro en planta no se le inventa la altura',
    tipo: 'muro',
    lamina: 'planta',
    bbox: MURO_HORIZONTAL,
    atributos: { largoM: 4 },
    espera: [],
  },
  {
    nombre: 'muro en corte ⇒ altura, y solo altura',
    tipo: 'muro',
    lamina: 'corte',
    bbox: [0.15, 0.3, 0.3, 0.2476],
    espera: [{ campo: 'alturaM', valor: 2.6 }],
  },
  {
    nombre: 'tabique en vista ⇒ altura',
    tipo: 'tabique',
    lamina: 'vista',
    bbox: [0.15, 0.3, 0.3, 0.2476],
    espera: [{ campo: 'alturaM', valor: 2.6 }],
  },
  {
    nombre: 'ambiente en planta ⇒ superficie (no depende de la orientación)',
    tipo: 'ambiente',
    lamina: 'planta',
    bbox: BLOQUE,
    espera: [{ campo: 'superficieM2', valor: 21.1 }],
  },
  {
    nombre: 'ambiente en planta con superficie ya leída ⇒ nada',
    tipo: 'ambiente',
    lamina: 'planta',
    bbox: BLOQUE,
    atributos: { superficieM2: 12 },
    espera: [],
  },
  {
    nombre: 'ambiente en corte ⇒ altura',
    tipo: 'ambiente',
    lamina: 'corte',
    bbox: [0.15, 0.3, 0.3, 0.2476],
    espera: [{ campo: 'alturaM', valor: 2.6 }],
  },
  {
    nombre: 'en una planilla no se mide: sus datos están escritos',
    tipo: 'muro',
    lamina: 'planilla',
    bbox: MURO_HORIZONTAL,
    espera: [],
  },
  {
    nombre: 'en un detalle tampoco: su recorte no mapea a un campo computable',
    tipo: 'muro',
    lamina: 'detalle',
    bbox: MURO_HORIZONTAL,
    espera: [],
  },
  {
    nombre: 'una lámina sin clasificar no declara ningún eje',
    tipo: 'muro',
    lamina: null,
    bbox: MURO_HORIZONTAL,
    espera: [],
  },
  {
    nombre: 'una abertura no se mide sobre el dibujo (su medida está acotada)',
    tipo: 'abertura',
    lamina: 'planta',
    bbox: MURO_HORIZONTAL,
    espera: [],
  },
];

describe('medidasDeDibujo', () => {
  for (const caso of CASOS) {
    it(caso.nombre, () => {
      const medidas = medidasDeDibujo(
        entidad(caso.tipo, caso.bbox, caso.atributos),
        caso.lamina,
        ESCALA,
        HOJA,
      );

      expect(medidas.map(({ campo, valor }) => ({ campo, valor }))).toEqual(caso.espera);
      for (const medida of medidas) expect(medida.metodo).toBe(METODO);
    });
  }

  it('sin escala usable no se mide nada, aunque el dibujo esté ahí', () => {
    expect(medidasDeDibujo(entidad('muro', MURO_HORIZONTAL), 'planta', 'esc. gráfica', HOJA)).toEqual(
      [],
    );
  });
});

describe('largoDelDibujo', () => {
  it('devuelve el lado largo cuando la relación de aspecto identifica el eje', () => {
    expect(largoDelDibujo({ anchoM: 6, altoM: 0.2 })).toBe(6);
    expect(largoDelDibujo({ anchoM: 0.2, altoM: 6 })).toBe(6);
    // Justo en el umbral: 3:1 entra.
    expect(largoDelDibujo({ anchoM: 3, altoM: 1 })).toBe(3);
    expect(RELACION_MINIMA_MURO).toBe(3);
  });

  it('devuelve null cuando el rectángulo no dice para dónde corre el muro', () => {
    expect(largoDelDibujo({ anchoM: 2.9, altoM: 1 })).toBeNull();
    expect(largoDelDibujo({ anchoM: 4, altoM: 4 })).toBeNull();
    expect(largoDelDibujo({ anchoM: 0, altoM: 0 })).toBeNull();
  });

  it('un lado que redondea a cero es tan flaco como se puede: el eje está claro', () => {
    expect(largoDelDibujo({ anchoM: 5, altoM: 0 })).toBe(5);
  });
});
