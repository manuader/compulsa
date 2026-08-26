/**
 * Motor de deducción documental (PRD §11, RF-501/505/506).
 *
 * Recibe las entidades de una obra y las láminas de las que salieron, corre las
 * cinco reglas de §11 y devuelve **propuestas** —nunca escrituras—: cada dato
 * deducido queda esperando la validación del arquitecto (Checkpoint A). Es puro
 * y determinístico: sin base, sin archivos, sin red.
 *
 * Las tres reglas de oro que este archivo hace cumplir, y que ninguna regla
 * individual puede saltear:
 *
 *   a. **≥ 2 fuentes documentales.** Una deducción que se apoya en un solo
 *      lugar del expediente no es una deducción, es una copia.
 *   b. **Confianza ≥ 0,7.** `confianza = factor de la regla × la peor confianza
 *      de las entidades que la sostienen`. Por debajo del umbral la propuesta
 *      simplemente no sale: el hueco lo levanta el checklist del rubro como
 *      consulta, que es donde tiene que estar.
 *   c. **Campos en lista blanca (RF-506).** Solo se deducen medidas de
 *      arquitectura. Nada estructural ni de seguridad —una carga, una sección,
 *      un espesor de losa— se auto-propone jamás; va a "consultar profesional
 *      competente".
 *
 * Una entidad + campo recibe **a lo sumo una** propuesta: las reglas corren en
 * orden de prioridad (planilla ↔ plano manda sobre todo lo demás porque es la
 * fuente más directa) y la primera que resuelve el campo se lo queda.
 *
 * Nota sobre imports: `reglas/*` importa de este módulo (tipos, etiquetas,
 * lectura de campos) y este módulo importa las reglas. El ciclo es sano porque
 * nadie usa nada del otro en tiempo de inicialización: todo pasa dentro de
 * `deducir()`, que corre mucho después de que ambos módulos terminaron de
 * evaluarse.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { confianzaMinima, fuentesDeEntidades } from '@/lib/computo/presentacion';
import { formatearNumero, redondear2 } from '@/lib/computo/unidades';
import { deducirCierreCotas } from '@/lib/deduccion/reglas/cierre-cotas';
import { deducirContinuidad } from '@/lib/deduccion/reglas/continuidad';
import { deducirIdemTipologia } from '@/lib/deduccion/reglas/idem-tipologia';
import { deducirPlanillaPlano } from '@/lib/deduccion/reglas/planilla-plano';
import { deducirPlantaCorte } from '@/lib/deduccion/reglas/planta-corte';
import { leerMedida } from '@/lib/hallazgos/taxonomia';
import type { Fuente, HallazgoDetectado, ReglaDeduccion, TipoEntidad, TipoLamina } from '@/types/domain';

// ---------------------------------------------------------------------------
// Contrato de salida
// ---------------------------------------------------------------------------

/**
 * Una deducción esperando validación. `valor` se mergea en
 * `entidades.atributos_json` como `{ [campo]: valor }` recién cuando el
 * arquitecto la valida; hasta entonces la entidad no se toca (P4).
 */
export interface DeduccionPropuesta {
  entidadId: string;
  campo: string;
  regla: ReglaDeduccion;
  valor: number | string;
  confianza: number;
  fuentes: Fuente[];
  /** Una frase es-AR que cita la regla y las láminas, para la bandeja y la memoria. */
  explicacion: string;
}

/** Lo mínimo que el motor necesita saber de una lámina para razonar y explicarse. */
export interface LaminaResumen {
  id: string;
  tipo: TipoLamina | null;
  codigo: string | null;
}

export interface ResultadoDeduccion {
  propuestas: DeduccionPropuesta[];
  /** No bloqueantes: dos datos de la doc que no cierran. Nunca frenan el cómputo. */
  inconsistencias: HallazgoDetectado[];
}

// ---------------------------------------------------------------------------
// Parámetros pinneados (contratos-y-formulas.md · §11 PRD)
// ---------------------------------------------------------------------------

/** Cuánto "descuenta" cada regla sobre la confianza de las entidades que usa. */
export const FACTOR_POR_REGLA: Record<ReglaDeduccion, number> = {
  planilla_plano: 0.95,
  planta_corte: 0.9,
  continuidad: 0.85,
  idem_tipologia: 0.75,
  cierre_cotas: 0.9,
};

/** Orden de prioridad: la primera regla que resuelve un campo se lo queda. */
export const PRIORIDAD_REGLAS = [
  'planilla_plano',
  'planta_corte',
  'continuidad',
  'idem_tipologia',
  'cierre_cotas',
] as const satisfies readonly ReglaDeduccion[];

/** Regla de oro §11.b: por debajo, la propuesta no sale. */
export const UMBRAL_DEDUCCION = 0.7;

/** Deducción documental = combinar ≥ 2 fuentes de la misma documentación. */
export const MINIMO_FUENTES = 2;

/**
 * Los únicos campos que el motor propone (RF-506). Son medidas de arquitectura
 * y nada más: agregar acá un dato estructural o de seguridad —una carga, una
 * sección de viga, una armadura— viola el PRD, no es una mejora.
 */
export const CAMPOS_DEDUCIBLES = [
  'anchoM',
  'altoM',
  'alturaM',
  'largoM',
  'superficieM2',
  'perimetroM',
  'vanosM2',
  'caras',
] as const;

/**
 * Una `cota` no tiene medidas propias: su dato es el valor que acota. Es el
 * único campo fuera de `CAMPOS_DEDUCIBLES`, y solo lo propone `cierre_cotas`.
 */
export const CAMPOS_DEDUCIBLES_COTA = ['valorM'] as const;

/** ¿Este campo de esta entidad es deducible, o va a consulta? (RF-506) */
export function esCampoDeducible(tipo: TipoEntidad, campo: string): boolean {
  const permitidos: readonly string[] = tipo === 'cota' ? CAMPOS_DEDUCIBLES_COTA : CAMPOS_DEDUCIBLES;
  return permitidos.includes(campo);
}

// ---------------------------------------------------------------------------
// Vocabulario compartido por las reglas
// ---------------------------------------------------------------------------

/**
 * Lo que una regla propone, antes de que el motor le ponga precio: la confianza
 * y las fuentes salen de `aportes`, que son TODAS las entidades que sostienen la
 * deducción —la que se completa incluida, porque su lectura también puede estar
 * floja—.
 */
export interface CandidatoDeduccion {
  destino: EntidadPersistida;
  campo: string;
  valor: number | string;
  aportes: readonly EntidadPersistida[];
  explicacion: string;
}

export interface SalidaRegla {
  candidatos: CandidatoDeduccion[];
  inconsistencias: HallazgoDetectado[];
}

/** Acceso a las láminas por entidad: las reglas razonan y se explican con esto. */
export interface ContextoDeduccion {
  tipoLamina(entidad: EntidadPersistida): TipoLamina | null;
  /** Código para las explicaciones: `A-03`, o `sin código` si el rótulo no lo trae. */
  codigoLamina(entidad: EntidadPersistida): string;
}

export type FnRegla = (entidades: readonly EntidadPersistida[], ctx: ContextoDeduccion) => SalidaRegla;

/** Cómo se nombra cada campo en una frase es-AR. */
export const ETIQUETA_CAMPO: Record<string, string> = {
  anchoM: 'ancho',
  altoM: 'alto',
  alturaM: 'altura',
  largoM: 'largo',
  superficieM2: 'superficie',
  perimetroM: 'perímetro',
  vanosM2: 'vanos',
  caras: 'cantidad de caras',
  valorM: 'valor',
};

export function etiquetaCampo(campo: string): string {
  return ETIQUETA_CAMPO[campo] ?? campo;
}

/** Unidad con la que se escribe cada campo. `caras` es un conteo: no lleva. */
const UNIDAD_CAMPO: Record<string, string> = {
  anchoM: 'm',
  altoM: 'm',
  alturaM: 'm',
  largoM: 'm',
  perimetroM: 'm',
  valorM: 'm',
  superficieM2: 'm²',
  vanosM2: 'm²',
};

/** `1,50 m`, `18,40 m²`, `2` — el valor tal como se lee en una frase. */
export function describirValor(campo: string, valor: number | string): string {
  if (typeof valor !== 'number') return valor;
  const unidad = UNIDAD_CAMPO[campo];
  return unidad === undefined ? formatearNumero(valor) : `${formatearNumero(valor, 2)} ${unidad}`;
}

/**
 * Lee un campo deducible: además de estar, tiene que ser un número positivo.
 * Los ocho campos de la lista blanca son todos medidas o conteos, así que "no
 * está" y "no es una medida válida" son la misma cosa para el motor.
 */
export function leerCampo(entidad: EntidadPersistida, campo: string): number | null {
  return leerMedida(entidad, campo);
}

/** `"1,50 m y 2,00 m"`, `"2,00 m, 1,60 m y 1,50 m"` — enumeración es-AR. */
export function enumerar(partes: readonly string[]): string {
  if (partes.length === 0) return '';
  if (partes.length === 1) return partes[0]!;
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------------

/**
 * Qué función implementa cada regla. El ORDEN de ejecución no vive acá sino en
 * `PRIORIDAD_REGLAS`: una sola lista manda, y así no hay forma de que la
 * prioridad documentada y la real se separen.
 */
const IMPLEMENTACIONES: Record<ReglaDeduccion, FnRegla> = {
  planilla_plano: deducirPlanillaPlano,
  planta_corte: deducirPlantaCorte,
  continuidad: deducirContinuidad,
  idem_tipologia: deducirIdemTipologia,
  cierre_cotas: deducirCierreCotas,
};

function crearContexto(laminas: readonly LaminaResumen[]): ContextoDeduccion {
  const porId = new Map(laminas.map((lamina) => [lamina.id, lamina]));
  const lamina = (entidad: EntidadPersistida): LaminaResumen | null => porId.get(entidad.laminaId) ?? null;
  return {
    tipoLamina: (entidad) => lamina(entidad)?.tipo ?? null,
    codigoLamina: (entidad) => lamina(entidad)?.codigo ?? 'sin código',
  };
}

/**
 * Corre las cinco reglas de §11 sobre las entidades de la obra.
 *
 * Devuelve propuestas (a validar) e inconsistencias (hallazgos no bloqueantes:
 * la documentación se contradice y hace falta que alguien decida cuál dato
 * vale). Ninguna de las dos cosas toca la base: esto es dominio puro.
 */
export function deducir(
  entidades: readonly EntidadPersistida[],
  laminas: readonly LaminaResumen[],
): ResultadoDeduccion {
  const ctx = crearContexto(laminas);
  const propuestas: DeduccionPropuesta[] = [];
  const inconsistencias: HallazgoDetectado[] = [];
  const resueltos = new Set<string>();
  const clavesVistas = new Set<string>();

  for (const regla of PRIORIDAD_REGLAS) {
    const salida = IMPLEMENTACIONES[regla](entidades, ctx);

    for (const hallazgo of salida.inconsistencias) {
      if (clavesVistas.has(hallazgo.clave)) continue;
      clavesVistas.add(hallazgo.clave);
      inconsistencias.push(hallazgo);
    }

    for (const candidato of salida.candidatos) {
      const clave = `${candidato.destino.id} ${candidato.campo}`;
      if (resueltos.has(clave)) continue; // ya lo resolvió una regla de más prioridad
      if (!esCampoDeducible(candidato.destino.tipo, candidato.campo)) continue; // RF-506

      const confianza = redondear2(FACTOR_POR_REGLA[regla] * confianzaMinima(candidato.aportes));
      if (confianza < UMBRAL_DEDUCCION) continue; // §11.b

      const fuentes = fuentesDeEntidades(candidato.aportes);
      if (fuentes.length < MINIMO_FUENTES) continue; // ≥ 2 fuentes documentales

      resueltos.add(clave);
      propuestas.push({
        entidadId: candidato.destino.id,
        campo: candidato.campo,
        regla,
        valor: candidato.valor,
        confianza,
        fuentes,
        explicacion: candidato.explicacion,
      });
    }
  }

  return { propuestas, inconsistencias };
}
