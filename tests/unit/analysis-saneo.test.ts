import { describe, expect, it } from 'vitest';
import { rotuloNulo, sanearAnalisis, type AnalisisLaminaCrudo } from '@/lib/analysis/tipos';

const rotuloOk = {
  titulo: 'PLANTA BAJA',
  codigo: 'A-01',
  disciplina: 'arquitectura' as const,
  tipoLamina: 'planta' as const,
  escala: '1:50',
  escalaConfiable: true,
  revision: '0',
  confianza: 0.9,
};

function entidad(bbox: number[], confianza = 0.8) {
  return {
    tipo: 'ambiente' as const,
    nombre: 'Estar',
    bbox,
    confianza,
    estadoReforma: 'na' as const,
    atributos: { superficieM2: 20 },
  };
}

describe('sanearAnalisis: el contrato estricto sobre la salida cruda del LLM', () => {
  it('descarta la entidad con bbox corto y conserva las demás (el bug de producción)', () => {
    const crudo: AnalisisLaminaCrudo = {
      rotulo: rotuloOk,
      entidades: [entidad([0.1, 0.2, 0.3, 0.4]), entidad([0.1, 0.2, 0.3]), entidad([0.5, 0.5, 0.1, 0.1])],
    };
    const { analisis, entidadesDescartadas } = sanearAnalisis(crudo);
    expect(entidadesDescartadas).toBe(1);
    expect(analisis.entidades).toHaveLength(2);
    expect(analisis.entidades[0].bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('clampa coordenadas y confianza levemente fuera de rango en vez de descartar', () => {
    const crudo: AnalisisLaminaCrudo = {
      rotulo: rotuloOk,
      entidades: [entidad([-0.01, 0.2, 1.05, 0.4], 1.2)],
    };
    const { analisis, entidadesDescartadas } = sanearAnalisis(crudo);
    expect(entidadesDescartadas).toBe(0);
    expect(analisis.entidades[0].bbox).toEqual([0, 0.2, 1, 0.4]);
    expect(analisis.entidades[0].confianza).toBe(1);
  });

  it('un bbox de 5 elementos tampoco ubica la entidad: se descarta', () => {
    const crudo: AnalisisLaminaCrudo = {
      rotulo: rotuloOk,
      entidades: [entidad([0.1, 0.2, 0.3, 0.4, 0.5])],
    };
    expect(sanearAnalisis(crudo).entidadesDescartadas).toBe(1);
  });

  it('clampa la confianza del rótulo sin perder el resto de los campos', () => {
    const { analisis } = sanearAnalisis({
      rotulo: { ...rotuloOk, confianza: 1.4 },
      entidades: [],
    });
    expect(analisis.rotulo.confianza).toBe(1);
    expect(analisis.rotulo.escala).toBe('1:50');
    expect(analisis.rotulo.escalaConfiable).toBe(true);
  });

  it('un rótulo irrecuperable degrada a rotuloNulo (lámina bloqueada, no rota)', () => {
    const { analisis } = sanearAnalisis({
      // titulo con tipo inválido: el clamp no lo salva y el strict lo rechaza.
      rotulo: { ...rotuloOk, titulo: 123 as unknown as string },
      entidades: [entidad([0.1, 0.2, 0.3, 0.4])],
    });
    expect(analisis.rotulo).toEqual(rotuloNulo());
    expect(analisis.entidades).toHaveLength(1);
  });
});
