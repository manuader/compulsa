/**
 * `aplicarDeduccionesValidadas`: la capa que pone las deducciones validadas
 * encima de las entidades y dice **de dónde salió cada campo**.
 *
 * Lo que se pinea acá es el mapa que después consume el engine: qué origen le
 * corresponde a cada campo según la regla que lo dedujo. La medición gráfica
 * (§5.5) mide sobre el dibujo y por eso vale un escalón menos que el resto —sale
 * `inferido`, no `deducido`—, y esa diferencia es la que termina apareciendo en
 * la planilla como nivel de evidencia.
 *
 * Es un test puro: la función no toca base, recibe las filas ya leídas.
 */
import { describe, expect, it } from 'vitest';

import type { Deduccion } from '@/db/schema';
import type { EntidadPersistida } from '@/lib/computo/engine';
import { aplicarDeduccionesValidadas } from '@/lib/pipeline/recomputar';
import type { ReglaDeduccion } from '@/types/domain';

const LAMINA_PLANTA = 'lam-planta';
const LAMINA_CORTE = 'lam-corte';

function tabique(atributos: EntidadPersistida['atributos'] = {}): EntidadPersistida {
  return {
    id: 'ent-t1',
    laminaId: LAMINA_PLANTA,
    tipo: 'tabique',
    nombre: 'T1',
    bbox: [0.1, 0.1, 0.2, 0.2],
    confianza: 0.9,
    estadoReforma: 'na',
    atributos: { tipo: 'durlock', largoM: 5, ...atributos },
  };
}

function deduccion(parcial: Partial<Deduccion> & Pick<Deduccion, 'regla'>): Deduccion {
  return {
    id: 'ded-1',
    obraId: 'obra-1',
    entidadId: 'ent-t1',
    campo: 'alturaM',
    fuentesJson: [{ laminaId: LAMINA_CORTE, bbox: [0.2, 0.2, 0.1, 0.1] }],
    valorJson: { alturaM: 2.6 },
    confianza: 0.8,
    estado: 'validada',
    validadoPor: null,
    createdAt: new Date('2026-08-28T12:00:00Z'),
    ...parcial,
  };
}

/** El origen que el mapa le asigna a un campo, o `undefined` si no está. */
function origenDe(
  camposDeducidos: ReadonlyMap<string, ReadonlyMap<string, string>>,
  campo: string,
): string | undefined {
  return camposDeducidos.get('ent-t1')?.get(campo);
}

describe('aplicarDeduccionesValidadas · origen por campo', () => {
  it('una regla documental deja el campo en deducido y escribe el dato', () => {
    const entidad = tabique();
    const { entidades, camposDeducidos, contradichas } = aplicarDeduccionesValidadas(
      [entidad],
      [deduccion({ regla: 'planta_corte' })],
    );

    expect(entidades[0]?.atributos.alturaM).toBe(2.6);
    expect(origenDe(camposDeducidos, 'alturaM')).toBe('deducido');
    expect(contradichas).toHaveLength(0);
  });

  it('la medición gráfica deja el campo en inferido: se midió, no se leyó', () => {
    const entidad = tabique();
    const { entidades, camposDeducidos } = aplicarDeduccionesValidadas(
      [entidad],
      [deduccion({ regla: 'medicion_grafica', confianza: 0.5 })],
    );

    expect(entidades[0]?.atributos.alturaM).toBe(2.6);
    expect(origenDe(camposDeducidos, 'alturaM')).toBe('inferido');
  });

  it('cada campo lleva su propio origen', () => {
    const entidad = tabique();
    const { camposDeducidos } = aplicarDeduccionesValidadas(
      [entidad],
      [
        deduccion({ id: 'ded-1', campo: 'alturaM', regla: 'medicion_grafica' }),
        deduccion({
          id: 'ded-2',
          campo: 'caras',
          regla: 'continuidad',
          valorJson: { caras: 2 },
        }),
      ],
    );

    expect(origenDe(camposDeducidos, 'alturaM')).toBe('inferido');
    expect(origenDe(camposDeducidos, 'caras')).toBe('deducido');
  });

  it('el dato que la entidad ya trae igual sigue contando como deducido', () => {
    // `validarDeduccion` escribe el valor en la entidad: que esté escrito no lo
    // vuelve documentación.
    const { camposDeducidos } = aplicarDeduccionesValidadas(
      [tabique({ alturaM: 2.6 })],
      [deduccion({ regla: 'medicion_grafica' })],
    );
    expect(origenDe(camposDeducidos, 'alturaM')).toBe('inferido');
  });

  it('una propuesta sin validar no entra al mapa ni a la entidad', () => {
    const { entidades, camposDeducidos } = aplicarDeduccionesValidadas(
      [tabique()],
      [deduccion({ regla: 'medicion_grafica', estado: 'propuesta' })],
    );

    expect(entidades[0]?.atributos.alturaM).toBeUndefined();
    expect(camposDeducidos.size).toBe(0);
  });

  it('la documentación le gana a lo medido, y el conflicto se avisa', () => {
    const { entidades, camposDeducidos, contradichas } = aplicarDeduccionesValidadas(
      [tabique({ alturaM: 3 })],
      [deduccion({ regla: 'medicion_grafica' })],
    );

    expect(entidades[0]?.atributos.alturaM).toBe(3);
    expect(camposDeducidos.size).toBe(0);
    expect(contradichas).toHaveLength(1);
    expect(contradichas[0]?.valorDeducido).toBe(2.6);
    expect(contradichas[0]?.valorDocumentado).toBe(3);
  });

  it('sin deducciones validadas el mapa queda vacío', () => {
    const reglas: readonly ReglaDeduccion[] = ['planilla_plano', 'cruce'];
    const { camposDeducidos } = aplicarDeduccionesValidadas(
      [tabique()],
      reglas.map((regla, i) => deduccion({ id: `ded-${i}`, regla, estado: 'rechazada' })),
    );
    expect(camposDeducidos.size).toBe(0);
  });
});
