/**
 * Las marcas de una lámina: todo lo que el overlay del visor dibuja encima del
 * plano, resuelto contra la base y ya listo para serializar.
 *
 * Vivía adentro de `app/obras/[obraId]/laminas/[laminaId]/page.tsx`, que era el
 * único lugar que mostraba una lámina. Ahora hay dos: esa página y el
 * `PanelVisor` embebido (bandeja, deducciones), que lo pide por
 * `GET /api/laminas/[laminaId]/marcas`. Las dos tienen que dibujar exactamente
 * lo mismo — un bbox que aparece en pantalla completa y no en el panel es un
 * bug de provenance (P1), no una diferencia de vista—, así que el armado es
 * uno solo y vive acá.
 *
 * Los tipos `Marca*` se importan de `overlay.tsx`, que es un `'use client'`:
 * como es un `import type` se borra al compilar y ningún módulo de cliente
 * entra al bundle del server (la página ya lo hacía).
 *
 * **Aislamiento (RNF-4):** toda consulta lleva `obra_id` en el `where`. Este
 * módulo no resuelve pertenencia —eso es de `requireObra`/`requireLaminaApi`—,
 * pero tampoco confía: con un `obraId` que no es el de la lámina devuelve
 * `null`, no las marcas de otra obra.
 */
import { and, eq, inArray } from 'drizzle-orm';

import type { MarcaDeduccion, MarcaEntidad, MarcaHallazgo } from '@/components/viewer/overlay';
import type { Db } from '@/db/client';
import { computoItems, datosObra, deducciones, entidades, hallazgos, laminas } from '@/db/schema';
import { TITULO_REGLA } from '@/lib/deduccion/memoria';
import { describirValor, etiquetaCampo } from '@/lib/deduccion/motor';
import { valorDeDeduccion } from '@/lib/deduccion/persistencia';
import { etiquetaDeDatoObra } from '@/lib/hallazgos/taxonomia';
import type { Fuente, TargetDato, ValorPropuesto } from '@/types/domain';

/** Forma canónica 8-4-4-4-12: un id de la URL es texto arbitrario hasta que se valida. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MarcasDeLamina {
  laminaId: string;
  /** Ruta a los bytes de la lámina, la que espera `VisorLamina`. */
  archivoUrl: string;
  entidades: MarcaEntidad[];
  hallazgos: MarcaHallazgo[];
  /** Solo las propuestas: una deducción decidida ya no espera nada. */
  deducciones: MarcaDeduccion[];
}

/**
 * La ruta de descarga de un `archivo_ref`.
 *
 * La ref es una ruta relativa POSIX del storage: cada segmento se codifica por
 * separado para no romper la barra que separa carpetas.
 */
export function urlDeArchivo(archivoRef: string): string {
  return `/api/archivos/${archivoRef.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Todo lo que se dibuja sobre una lámina, o `null` si la lámina no es de esa
 * obra. Quien llama ya validó la sesión y el estudio.
 */
export async function armarMarcasDeLamina(
  db: Db,
  obraId: string,
  laminaId: string,
): Promise<MarcasDeLamina | null> {
  const [lamina] = await db
    .select({ id: laminas.id, archivoRef: laminas.archivoRef })
    .from(laminas)
    .where(and(eq(laminas.id, laminaId), eq(laminas.obraId, obraId)));
  if (!lamina) return null;

  const [filasEntidades, filasHallazgos, filasDeducciones] = await Promise.all([
    db
      .select({
        id: entidades.id,
        tipo: entidades.tipo,
        nombre: entidades.nombre,
        fuentes: entidades.fuentesJson,
      })
      .from(entidades)
      .where(and(eq(entidades.obraId, obraId), eq(entidades.laminaId, lamina.id))),
    db
      .select({
        id: hallazgos.id,
        descripcion: hallazgos.descripcion,
        bloqueante: hallazgos.bloqueante,
        estado: hallazgos.estado,
        fuentes: hallazgos.laminasJson,
      })
      .from(hallazgos)
      .where(eq(hallazgos.obraId, obraId)),
    // La marca va sobre la entidad que la deducción COMPLETARÍA, que es la que
    // hoy está sin acotar: por eso el join es contra `entidades.laminaId`.
    db
      .select({
        id: deducciones.id,
        campo: deducciones.campo,
        regla: deducciones.regla,
        valorJson: deducciones.valorJson,
        fuentesEntidad: entidades.fuentesJson,
      })
      .from(deducciones)
      .innerJoin(entidades, eq(deducciones.entidadId, entidades.id))
      .where(
        and(
          eq(deducciones.obraId, obraId),
          eq(deducciones.estado, 'propuesta'),
          eq(entidades.laminaId, lamina.id),
        ),
      ),
  ]);

  const deEstaLamina = (fuentes: readonly Fuente[]): Fuente[] =>
    fuentes.filter((fuente) => fuente.laminaId === lamina.id);

  const marcasEntidades: MarcaEntidad[] = filasEntidades.flatMap((fila) =>
    deEstaLamina(fila.fuentes).map((fuente) => ({
      id: fila.id,
      tipo: fila.tipo,
      nombre: fila.nombre,
      ...(fuente.detalle === undefined ? {} : { detalle: fuente.detalle }),
      bbox: fuente.bbox,
    })),
  );

  const marcasHallazgos: MarcaHallazgo[] = filasHallazgos
    .filter((fila) => fila.estado !== 'descartado')
    .flatMap((fila) =>
      deEstaLamina(fila.fuentes).map((fuente) => ({
        id: fila.id,
        descripcion: fila.descripcion,
        bloqueante: fila.bloqueante,
        bbox: fuente.bbox,
      })),
    );

  const marcasDeducciones: MarcaDeduccion[] = filasDeducciones.flatMap((fila) => {
    const valor = valorDeDeduccion(fila);
    return deEstaLamina(fila.fuentesEntidad).map((fuente) => ({
      id: fila.id,
      campo: etiquetaCampo(fila.campo),
      valor: valor === null ? '—' : describirValor(fila.campo, valor),
      regla: TITULO_REGLA[fila.regla],
      bbox: fuente.bbox,
    }));
  });

  return {
    laminaId: lamina.id,
    archivoUrl: urlDeArchivo(lamina.archivoRef),
    entidades: marcasEntidades,
    hallazgos: marcasHallazgos,
    deducciones: marcasDeducciones,
  };
}

/** Lo que `?highlight=` resalta: cómo se llama y qué zonas cita. */
export interface Destacado {
  /** Cómo nombrarlo en el aviso: "el ítem Placa de roca de yeso". */
  nombre: string;
  fuentes: Fuente[];
}

/**
 * Las zonas de una consulta, **con la de su propuesta adelante**.
 *
 * Un hallazgo cita las láminas del hueco que pregunta (`laminas_json`), pero
 * desde "proponer en vez de bloquear" puede además traer el lugar exacto donde
 * el sistema leyó lo que propone (`valor_propuesto_json.fuente`), y ese lugar
 * suele estar en **otra** lámina: la búsqueda dirigida encuentra el ancho de
 * FP01 en la planilla DET00 y la consulta está citada en la planta A-01. Va
 * primero por lo mismo que en la bandeja (`laminasDeConsulta`): es el recuadro
 * que hay que mirar para confirmar, y es al que el visor scrollea.
 *
 * Sin repetidos: si la propuesta se leyó en una zona que la consulta ya citaba,
 * resaltarla dos veces diría "2 zonas citadas" por una sola.
 */
function fuentesDeConsulta(citadas: readonly Fuente[], propuesta: ValorPropuesto | null): Fuente[] {
  const fuentes: Fuente[] = [];
  const vistas = new Set<string>();

  for (const fuente of [propuesta?.fuente, ...citadas]) {
    if (fuente === undefined) continue;
    const clave = `${fuente.laminaId}:${fuente.bbox.join(',')}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    fuentes.push(fuente);
  }

  return fuentes;
}

/**
 * Dónde están dibujadas las entidades a las que les falta un dato de obra.
 *
 * Una consulta de dato de obra nace **sin fuentes** y con razón: el hecho no se
 * leyó en ninguna lámina (P1 no se cumple citando cualquier cosa). El panel
 * embebido de la bandeja resuelve eso resaltando a **los afectados**
 * (`fuentesDeAfectadas` de `bandeja/plano.ts`), pero «Abrir en página completa»
 * no lo hacía: el mismo hallazgo que en el panel resaltaba los cuatro tabiques
 * abría la lámina con **nada** marcado. Las dos vistas tienen que dibujar lo
 * mismo (ver la cabecera de este archivo), así que acá se hace la misma
 * resolución, contra la base y no contra un mapa ya armado.
 *
 * Sin `targetDato` no hay consulta que hacer: es el caso de casi todos los
 * hallazgos.
 */
async function fuentesDeAfectadas(
  db: Db,
  obraId: string,
  dato: TargetDato | null,
): Promise<Fuente[]> {
  if (dato === null || dato.entidades.length === 0) return [];

  const filas = await db
    .select({ id: entidades.id, fuentes: entidades.fuentesJson })
    .from(entidades)
    .where(and(eq(entidades.obraId, obraId), inArray(entidades.id, dato.entidades)));

  // En el orden en que el hallazgo los enumera —no el que devuelva la base—:
  // es el mismo criterio del panel, y el overlay scrollea al primero.
  const porId = new Map(filas.map((fila) => [fila.id, fila.fuentes]));
  const fuentes: Fuente[] = [];
  const vistas = new Set<string>();
  for (const id of dato.entidades) {
    for (const fuente of porId.get(id) ?? []) {
      const clave = `${fuente.laminaId}:${fuente.bbox.join(',')}`;
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      fuentes.push(fuente);
    }
  }
  return fuentes;
}

/**
 * Resuelve `?highlight=<id>` contra las cinco tablas que llevan provenance
 * (`src/app/CLAUDE.md` §4). Siempre con `obra_id` en el `where`: un id de otra
 * obra no existe (RNF-4).
 *
 * Vivía adentro de la página del visor. Se mudó acá por lo mismo que
 * `armarMarcasDeLamina`: es la otra mitad de "qué se dibuja sobre esta lámina",
 * y adentro de un `page.tsx` no se puede exportar para testear —Next valida los
 * exports de una página igual que los de un `route.ts` (`CLAUDE.md` §9)—.
 */
export async function resolverDestacado(
  db: Db,
  obraId: string,
  highlight: string,
): Promise<Destacado | null> {
  if (!UUID_RE.test(highlight)) return null;

  const [entidad] = await db
    .select({ nombre: entidades.nombre, fuentes: entidades.fuentesJson })
    .from(entidades)
    .where(and(eq(entidades.id, highlight), eq(entidades.obraId, obraId)));
  if (entidad) return { nombre: entidad.nombre, fuentes: entidad.fuentes };

  const [item] = await db
    .select({ nombre: computoItems.descripcion, fuentes: computoItems.fuentesJson })
    .from(computoItems)
    .where(and(eq(computoItems.id, highlight), eq(computoItems.obraId, obraId)));
  if (item) return { nombre: item.nombre, fuentes: item.fuentes };

  const [hallazgo] = await db
    .select({
      nombre: hallazgos.descripcion,
      fuentes: hallazgos.laminasJson,
      propuesta: hallazgos.valorPropuestoJson,
      dato: hallazgos.targetDato,
    })
    .from(hallazgos)
    .where(and(eq(hallazgos.id, highlight), eq(hallazgos.obraId, obraId)));
  if (hallazgo) {
    return {
      nombre: hallazgo.nombre,
      fuentes: [
        ...fuentesDeConsulta(hallazgo.fuentes, hallazgo.propuesta),
        ...(await fuentesDeAfectadas(db, obraId, hallazgo.dato)),
      ],
    };
  }

  const [dato] = await db
    .select({
      clave: datosObra.clave,
      valorJson: datosObra.valorJson,
      fuentes: datosObra.fuentesJson,
    })
    .from(datosObra)
    .where(and(eq(datosObra.id, highlight), eq(datosObra.obraId, obraId)));
  if (dato) {
    return {
      nombre: `${etiquetaDeDatoObra(dato.clave)}: ${dato.valorJson.valor}${dato.valorJson.unidad === undefined ? '' : ` ${dato.valorJson.unidad}`}`,
      fuentes: dato.fuentes,
    };
  }

  const [deduccion] = await db
    .select({
      campo: deducciones.campo,
      valorJson: deducciones.valorJson,
      fuentes: deducciones.fuentesJson,
    })
    .from(deducciones)
    .where(and(eq(deducciones.id, highlight), eq(deducciones.obraId, obraId)));
  if (deduccion) {
    const valor = valorDeDeduccion(deduccion);
    const nombre =
      valor === null
        ? `deducción de ${etiquetaCampo(deduccion.campo)}`
        : `${etiquetaCampo(deduccion.campo)} deducido: ${describirValor(deduccion.campo, valor)}`;
    return { nombre, fuentes: deduccion.fuentes };
  }

  return null;
}
