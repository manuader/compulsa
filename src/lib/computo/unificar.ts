/**
 * Unificación por elemento: la misma cosa dicha en dos láminas es UNA cosa.
 *
 * Un tabique dibujado en la planta y cortado en el corte son dos filas de
 * `entidades` —cada lámina se analiza sola— y **un solo tabique de la obra**. El
 * cruce (§5.3) es el que las reconoce y les escribe el mismo
 * `entidades.elemento_id`; este módulo es el que hace que el cómputo lo use.
 *
 * Sin esto, en cuanto lo deducido entra solo al cómputo (§5.4) el mismo muro se
 * computa dos veces: la planta le presta el largo al corte, el corte le presta
 * la altura a la planta, y las dos quedan computables. Son 52 m² de placa donde
 * hay 26.
 *
 * ## Qué hace, exactamente
 *
 * Agrupa por `elemento_id` y devuelve **una** entidad por grupo:
 *
 *  - **la base es la de mayor confianza** (empate ⇒ la de id menor: el orden en
 *    que Postgres devuelve las filas no es estable —un `UPDATE` mueve una fila
 *    al final del heap— y el cómputo no puede depender de eso);
 *  - los campos que a la base le faltan los completan las hermanas, en orden
 *    (*fill gaps*): es exactamente lo que hacía la deducción `continuidad`, pero
 *    sin fila que validar;
 *  - las **fuentes de todas** viajan en la entidad unificada (`fuentesUnificadas`),
 *    así el ítem cita las dos láminas. P1 no se negocia porque dos filas se
 *    hayan vuelto una;
 *  - la **confianza es la peor del grupo**, no la de la base: el ítem descansa
 *    sobre las dos lecturas fusionadas, y con la máxima se colaría por el gate
 *    del §11.b un dato leído al 0,5. Que sea la peor del grupo entero —y no solo
 *    de las que aportaron un campo— además la hace independiente de cuál entidad
 *    quedó de base, que es una elección arbitraria cuando las confianzas empatan;
 *  - el `estadoReforma` es el de la base. Una hermana que dice otra cosa no
 *    cambia el alcance de la obra por un `fill gap`.
 *
 * ## Manda el nivel de evidencia, no quién quedó de base
 *
 * Elegir la base por confianza alcanzaba mientras todo lo que traía una entidad
 * estaba escrito en su lámina. Ya no: el overlay de deducciones (§5.4) y la
 * medición gráfica (§5.5) le llenan campos a la base **antes** de unificar, y un
 * `largoM` medido sobre el dibujo a 0,5 de confianza le ganaba a un `largoM`
 * acotado en la lámina hermana solo por estar del lado de la base. Eso invierte
 * la cadena del §5.2, donde medir es el último respaldo.
 *
 * Por eso `unificarPorElemento` recibe el mapa de orígenes por campo y resuelve
 * **campo por campo con el nivel de evidencia**: `explicito < supuesto <
 * deducido < inferido`, y a igual nivel gana la base (que es la de mayor
 * confianza). Un campo que la base traía `inferido` y la hermana trae escrito se
 * computa con el de la hermana, y el aporte queda registrado para que la marca
 * de origen viaje con el valor.
 *
 * ## Lo que NO hace: elegir entre dos lecturas del mismo nivel
 *
 * Si dos entidades declaran el mismo campo **con el mismo nivel de evidencia** y
 * valores distintos (más de un 1 % de diferencia), no se elige el mejor: se
 * conserva el de la base **y se emite un `ConflictoUnificacion`**, que el
 * recompute convierte en una consulta no bloqueante. Elegir en silencio sería
 * exactamente el "deducir es inventar" que el PRD prohíbe: la planta dice 2,60 y
 * el corte 2,40, y quién tiene razón lo sabe el arquitecto.
 *
 * Una diferencia **entre niveles distintos** no es un conflicto y no abre
 * consulta: lo escrito le gana a lo medido, que es lo que el PRD ya dice. La
 * lectura perdedora no se pierde — la deducción que la sostenía sigue en la
 * bandeja de deducciones con su fuente.
 *
 * Módulo **hoja**: puro, sin I/O y sin imports del motor (solo el tipo de la
 * entidad, que se borra al compilar). El engine no lo conoce; lo aplican
 * `recomputarObra` y `persistirResumen` antes de computar.
 */
import type { CamposDeducidos, EntidadPersistida } from '@/lib/computo/engine';
import type { Fuente, Origen } from '@/types/domain';

/** Un valor de atributo que se puede poner en pugna (los `null` no se comparan). */
export type ValorAtributo = number | string | boolean;

/**
 * Dos lecturas del mismo campo del mismo elemento que no coinciden.
 *
 * `valores` y `entidadIds` van alineados: el índice 0 es siempre el de la base
 * (el valor con el que se computa).
 */
export interface ConflictoUnificacion {
  elementoId: string;
  campo: string;
  valores: ValorAtributo[];
  entidadIds: string[];
  /**
   * El nivel de evidencia de cada lectura, alineado con `valores`.
   *
   * Todas son del **mismo** nivel: una diferencia entre niveles distintos la
   * resuelve la cadena del §5.2 y no llega acá. Viaja igual para que la consulta
   * pueda decir con qué evidencia se computó, en vez de afirmar que el ganador
   * es «la lectura más confiable» sin mirar de dónde salió.
   */
  origenes: Origen[];
}

export interface ResultadoUnificacion {
  /** Una entidad por elemento, más las que no tienen `elemento_id`, en orden de aparición. */
  entidades: EntidadPersistida[];
  conflictos: ConflictoUnificacion[];
  /**
   * `idUnificado → campo → idQueLoAportó`, **solo** para los campos que puso una
   * hermana.
   *
   * Existe por una razón puntual: el mapa de orígenes por campo (§5.5) está
   * indexado por id de entidad, y un `alturaM` deducido que aportó la hermana
   * quedaría sin marcar en la entidad unificada — el ítem diría «explícito»
   * apoyándose en un dato que no está escrito. `recomputarObra` usa esto para
   * mover la marca al id que sobrevive.
   */
  aportes: Map<string, Map<string, string>>;
}

/** Diferencia relativa a partir de la cual dos lecturas son dos lecturas distintas. */
export const TOLERANCIA_UNIFICACION = 0.01;

/**
 * Qué tan fuerte es cada nivel de evidencia: **menor es mejor**.
 *
 * Es la cadena del §5.2 escrita como número, la misma que usa el engine para
 * ponerle al ítem el peor origen de sus campos. Un campo que no figura en el
 * mapa de orígenes está escrito en la lámina, y por eso `explicito` es el
 * default de `nivelDe()`.
 */
const FUERZA: Record<Origen, number> = {
  explicito: 0,
  supuesto: 1,
  deducido: 2,
  inferido: 3,
};

/** Sin mapa de orígenes, todo lo que trae una entidad está escrito en su lámina. */
const SIN_ORIGENES: CamposDeducidos = new Map();

/** Una lectura del mismo campo, con de dónde salió y con qué evidencia. */
interface Lectura {
  valor: ValorAtributo;
  entidadId: string;
  origen: Origen;
}

/** Mismo criterio que `leerNumero()`: un número escrito como texto es un número. */
function comoNumero(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim() !== '') {
    const parseado = Number(valor.replace(',', '.'));
    return Number.isFinite(parseado) ? parseado : null;
  }
  return null;
}

/** `true` si un campo no trae dato: es el hueco que una hermana puede llenar. */
function vacio(valor: unknown): boolean {
  return valor === undefined || valor === null || valor === '';
}

/**
 * ¿Son la misma lectura? Los números, con 1 % de tolerancia —dos lápices sobre
 * el mismo muro no dan el mismo milímetro—; los textos, sin distinguir mayúsculas
 * ni espacios de más («Durlock» y «durlock» son el mismo sistema).
 */
export function mismaLectura(a: unknown, b: unknown): boolean {
  const na = comoNumero(a);
  const nb = comoNumero(b);
  if (na !== null && nb !== null) {
    if (na === nb) return true;
    const mayor = Math.max(Math.abs(na), Math.abs(nb));
    if (mayor === 0) return true;
    return Math.abs(na - nb) / mayor <= TOLERANCIA_UNIFICACION;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return a === b;
}

/** La fuente propia de una entidad, más las que ya arrastre de otra unificación. */
function fuentesDe(entidad: EntidadPersistida): Fuente[] {
  return [
    { laminaId: entidad.laminaId, bbox: entidad.bbox, detalle: entidad.nombre },
    ...(entidad.fuentesUnificadas ?? []),
  ];
}

function claveDeFuente(fuente: Fuente): string {
  return `${fuente.laminaId}|${fuente.bbox.join(',')}`;
}

interface GrupoUnificado {
  entidad: EntidadPersistida;
  conflictos: ConflictoUnificacion[];
  aportes: Map<string, string>;
}

function unificarGrupo(
  elementoId: string,
  grupo: readonly EntidadPersistida[],
  origenes: CamposDeducidos,
): GrupoUnificado {
  // Empate de confianza ⇒ gana la de id menor. NO la primera del arreglo: las
  // entidades llegan como las devuelve Postgres, y ese orden cambia solo (un
  // `UPDATE` mueve la fila al final del heap). Dos recomputes de la misma obra
  // tienen que elegir la misma base.
  const base = grupo.reduce((mejor, entidad) => {
    if (entidad.confianza !== mejor.confianza) {
      return entidad.confianza > mejor.confianza ? entidad : mejor;
    }
    return entidad.id < mejor.id ? entidad : mejor;
  });
  const hermanas = grupo.filter((entidad) => entidad !== base);

  // Un campo que no figura en el mapa está escrito en la lámina: el overlay solo
  // marca lo que él aportó.
  const nivelDe = (entidadId: string, campo: string): Origen =>
    origenes.get(entidadId)?.get(campo) ?? 'explicito';

  // Todas las lecturas de cada campo, la base primero: el orden es el desempate
  // a igual nivel de evidencia.
  const lecturas = new Map<string, Lectura[]>();
  for (const entidad of [base, ...hermanas]) {
    for (const [campo, valor] of Object.entries(entidad.atributos)) {
      if (vacio(valor)) continue;
      const cola = lecturas.get(campo) ?? [];
      cola.push({
        valor: valor as ValorAtributo,
        entidadId: entidad.id,
        origen: nivelDe(entidad.id, campo),
      });
      lecturas.set(campo, cola);
    }
  }

  const atributos = { ...base.atributos };
  const aportes = new Map<string, string>();
  const conflictos: ConflictoUnificacion[] = [];

  for (const [campo, candidatos] of lecturas) {
    // Gana el nivel de evidencia más fuerte; a igual nivel, la base (que es la
    // primera del arreglo y la de mayor confianza).
    const gana = candidatos.reduce((mejor, otra) =>
      FUERZA[otra.origen] < FUERZA[mejor.origen] ? otra : mejor,
    );

    if (gana.entidadId !== base.id || vacio(atributos[campo])) {
      atributos[campo] = gana.valor;
    }
    // El aporte se registra siempre que el valor no venga del campo de la base,
    // incluso cuando el número coincide: el que viaja con él es el **origen**, y
    // sin esto el ítem seguiría diciendo «medido» apoyado en un dato escrito.
    if (gana.entidadId !== base.id) aportes.set(campo, gana.entidadId);

    // Conflicto: solo entre lecturas del MISMO nivel que la ganadora. Una
    // diferencia contra un nivel más débil la resuelve la cadena del §5.2 y no
    // es una contradicción del expediente.
    const enPugna = candidatos.filter(
      (candidata) =>
        candidata !== gana &&
        FUERZA[candidata.origen] === FUERZA[gana.origen] &&
        !mismaLectura(candidata.valor, gana.valor),
    );
    if (enPugna.length === 0) continue;

    const conflicto: ConflictoUnificacion = {
      elementoId,
      campo,
      valores: [gana.valor],
      entidadIds: [gana.entidadId],
      origenes: [gana.origen],
    };
    for (const otra of enPugna) {
      // Uno por campo, aunque tres hermanas digan tres cosas (la clave del
      // hallazgo es por campo) y sin repetir el mismo número dos veces.
      if (conflicto.valores.some((valor) => mismaLectura(valor, otra.valor))) continue;
      conflicto.valores.push(otra.valor);
      conflicto.entidadIds.push(otra.entidadId);
      conflicto.origenes.push(otra.origen);
    }
    conflictos.push(conflicto);
  }

  // La base primero: su fuente es la que la entidad unificada sigue teniendo
  // como propia (`laminaId` + `bbox` no se tocan), y las demás viajan aparte
  // para que el ítem las cite igual.
  const fuentes: Fuente[] = [];
  const vistas = new Set<string>();
  for (const entidad of [base, ...hermanas]) {
    for (const fuente of fuentesDe(entidad)) {
      const clave = claveDeFuente(fuente);
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      fuentes.push(fuente);
    }
  }
  const extra = fuentes.slice(1);

  const entidad: EntidadPersistida = {
    ...base,
    atributos,
    confianza: grupo.reduce((peor, quien) => Math.min(peor, quien.confianza), 1),
    ...(extra.length === 0 ? {} : { fuentesUnificadas: extra }),
  };

  return { entidad, conflictos, aportes };
}

/**
 * Las entidades con los elementos ya unificados, y lo que quedó en pugna.
 *
 * Las que no tienen `elemento_id` —y los grupos de uno— pasan tal cual, sin
 * copiarse: una obra a la que el cruce todavía no le escribió nada sale de acá
 * exactamente como entró.
 *
 * `origenes` es el mapa `entidadId → campo → Origen` que arma el overlay de
 * deducciones (§5.4/§5.5). Es **opcional** y por defecto está vacío: sin él todo
 * cuenta como escrito en la lámina y la unificación se comporta como antes de
 * que existiera el parámetro —gana la base y toda diferencia es conflicto—.
 * Quien tenga el mapa **tiene que pasarlo**: sin eso, un campo que la base traía
 * medido sobre el dibujo le gana a la cota que la hermana tiene escrita.
 */
export function unificarPorElemento(
  entidades: readonly EntidadPersistida[],
  origenes: CamposDeducidos = SIN_ORIGENES,
): ResultadoUnificacion {
  const grupos = new Map<string, EntidadPersistida[]>();
  for (const entidad of entidades) {
    if (entidad.elementoId === undefined || entidad.elementoId === null) continue;
    const grupo = grupos.get(entidad.elementoId);
    if (grupo) grupo.push(entidad);
    else grupos.set(entidad.elementoId, [entidad]);
  }

  const salida: EntidadPersistida[] = [];
  const conflictos: ConflictoUnificacion[] = [];
  const aportes = new Map<string, Map<string, string>>();
  const emitidos = new Set<string>();

  for (const entidad of entidades) {
    const elementoId = entidad.elementoId ?? null;
    const grupo = elementoId === null ? undefined : grupos.get(elementoId);
    if (grupo === undefined || grupo.length === 1) {
      salida.push(entidad);
      continue;
    }
    if (emitidos.has(elementoId as string)) continue;
    emitidos.add(elementoId as string);

    const unificado = unificarGrupo(elementoId as string, grupo, origenes);
    salida.push(unificado.entidad);
    conflictos.push(...unificado.conflictos);
    if (unificado.aportes.size > 0) aportes.set(unificado.entidad.id, unificado.aportes);
  }

  return { entidades: salida, conflictos, aportes };
}
