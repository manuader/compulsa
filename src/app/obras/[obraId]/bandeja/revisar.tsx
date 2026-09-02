/**
 * La mitad server de la solapa «Para revisar» (§5.8).
 *
 * No es un `page.tsx`: es el contenido de una solapa de `/obras/[obraId]/bandeja`,
 * que es la pantalla donde el arquitecto decide. Vive en su propio archivo
 * porque la página ya carga las consultas y mezclar las dos lecturas en un solo
 * componente dejaba 500 líneas donde nadie encuentra nada.
 *
 * Lee con `getDb()` —la pertenencia ya la resolvió `requireObra()` en la
 * página— y le baja a `ParaRevisar` solo datos serializables **ya formateados en
 * es-AR**: la pantalla es cliente y el `toString()` de JS escribe "0.9".
 *
 * Qué entra a cada lista:
 *
 *  - **autovalidadas**: `estado = 'validada'` y `validado_por IS NULL`, o sea las
 *    que aplicó el sistema (§5.4). Las **contradichas** quedan afuera: la
 *    documentación ya les pasó por encima, el cómputo usa el dato escrito y
 *    ofrecerlas para rechazar sería ofrecer deshacer algo que ya no se aplica.
 *    Se muestran en su propia tarjeta de aviso, arriba.
 *  - **propuestas**: `estado = 'propuesta'` — lo que no llegó al umbral y por eso
 *    **no** entró al cómputo. Estas se validan.
 *  - **inferidos**: los ítems activos con `origen = 'inferido'`, que son el
 *    resultado de una medición gráfica (§5.5), no una fila que decidir.
 */
import { and, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getDb } from '@/db/client';
import {
  computoItems,
  deducciones,
  entidades,
  hallazgos,
  laminas,
  type Deduccion,
} from '@/db/schema';
import { formatearCantidad } from '@/lib/computo/unidades';
import { describirValor, etiquetaCampo } from '@/lib/deduccion/motor';
import { TITULO_REGLA } from '@/lib/deduccion/memoria';
import {
  estaContradicha,
  explicarDeduccion,
  valorDeDeduccion,
  valorQueDocumenta,
} from '@/lib/deduccion/persistencia';
import { esClaveDeDeduccion } from '@/lib/pipeline/claves';
import { MARCA_METODO } from '@/lib/pipeline/procesar';
import { REGLAS_DEDUCCION, type ReglaDeduccion } from '@/types/domain';

import {
  ParaRevisar,
  type DeduccionVista,
  type GrupoElemento,
  type ItemInferidoVista,
  type LaminaCitada,
  type VistaEnLamina,
} from './revisar-ui';

/** "A-01 · PLANTA PB", o el número de página si el rótulo no se pudo leer. */
function etiquetaDeLamina(fila: {
  codigo: string | null;
  titulo: string | null;
  numeroPagina: number;
}): string {
  const cabeza = fila.codigo ?? `Página ${fila.numeroPagina}`;
  return fila.titulo ? `${cabeza} · ${fila.titulo}` : cabeza;
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * `true` si el valor es una regla de deducción **de las siete**.
 *
 * Contra `REGLAS_DEDUCCION` y no contra `PRIORIDAD_REGLAS`: esa lista son las
 * cinco reglas documentales que corre `deducir()` y deja afuera `cruce` y
 * `medicion_grafica`, que son justamente las dos que producen casi todo lo que
 * esta solapa muestra (§5.4 y §5.5). Filtrar con la lista corta dejaba los dos
 * chips más usados sin poder abrirse.
 */
export function esRegla(valor: string | null): valor is ReglaDeduccion {
  return valor !== null && (REGLAS_DEDUCCION as readonly string[]).includes(valor);
}

/** Láminas de las fuentes, sin repetir y en el orden en que sostienen el dato. */
function citar(
  fuentes: readonly { laminaId: string }[],
  etiquetas: ReadonlyMap<string, string>,
): LaminaCitada[] {
  const citadas: LaminaCitada[] = [];
  const vistas = new Set<string>();
  for (const fuente of fuentes) {
    if (vistas.has(fuente.laminaId)) continue;
    vistas.add(fuente.laminaId);
    const etiqueta = etiquetas.get(fuente.laminaId);
    if (etiqueta) citadas.push({ laminaId: fuente.laminaId, etiqueta });
  }
  return citadas;
}

/**
 * Cómo se llegó al número, cuando no basta con nombrar la regla.
 *
 * La medición gráfica lo guarda en `valor_json` bajo `MARCA_METODO` (§5.5): la
 * tabla `deducciones` no tiene columna `metodo` como sí la tiene `datos_obra`.
 */
function metodoDe(fila: Deduccion): string | null {
  const metodo = fila.valorJson[MARCA_METODO];
  return typeof metodo === 'string' ? metodo : null;
}

/** Un grupo por elemento (tipo + nombre) y adentro un bloque por lámina. */
function agrupar(
  filas: readonly Deduccion[],
  porEntidad: ReadonlyMap<string, { tipo: string; nombre: string; laminaId: string }>,
  etiquetaLamina: ReadonlyMap<string, string>,
  codigos: ReadonlyMap<string, string>,
): GrupoElemento[] {
  const grupos = new Map<string, GrupoElemento>();

  for (const fila of filas) {
    const entidad = porEntidad.get(fila.entidadId);
    if (!entidad) continue; // la entidad se fue con un reproceso: nada que ofrecer

    const valor = valorDeDeduccion(fila);
    const vista: DeduccionVista = {
      id: fila.id,
      campo: fila.campo,
      etiqueta: etiquetaCampo(fila.campo),
      valor: valor === null ? '—' : describirValor(fila.campo, valor),
      regla: fila.regla,
      tituloRegla: TITULO_REGLA[fila.regla],
      explicacion: explicarDeduccion(fila, codigos),
      confianza: fila.confianza,
      laminas: citar(fila.fuentesJson, etiquetaLamina),
      // Los bbox que sostienen la deducción, para resaltarlos en el panel sin
      // navegar: es lo mismo que resuelve `?highlight=<deduccionId>`.
      fuentes: fila.fuentesJson.map((fuente) => ({ laminaId: fuente.laminaId, bbox: fuente.bbox })),
      autovalidada: fila.estado === 'validada' && fila.validadoPor === null,
      metodo: metodoDe(fila),
    };

    const claveGrupo = `${entidad.tipo}::${entidad.nombre}`;
    let grupo = grupos.get(claveGrupo);
    if (!grupo) {
      grupo = {
        clave: claveGrupo,
        titulo: `${capitalizar(entidad.tipo)} ${entidad.nombre}`,
        vistas: [],
      };
      grupos.set(claveGrupo, grupo);
    }

    let enLamina: VistaEnLamina | undefined = grupo.vistas.find(
      (candidata) => candidata.entidadId === fila.entidadId,
    );
    if (!enLamina) {
      enLamina = {
        entidadId: fila.entidadId,
        laminaId: entidad.laminaId,
        lamina: etiquetaLamina.get(entidad.laminaId) ?? 'Lámina sin rótulo',
        deducciones: [],
      };
      grupo.vistas.push(enLamina);
    }
    enLamina.deducciones.push(vista);
  }

  return [...grupos.values()];
}

/** Chip de filtro: el estado de la vista viaja en la URL, no en el cliente. */
function Chip({
  href,
  activo,
  children,
}: {
  href: string;
  activo: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={activo ? 'true' : undefined}
      className={[
        'inline-flex items-center rounded-full border px-3 py-1 text-sm transition-colors',
        activo
          ? 'border-neutral-900 bg-neutral-900 text-white'
          : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100',
      ].join(' ')}
    >
      {children}
    </Link>
  );
}

export interface SolapaRevisarProps {
  obraId: string;
  /** El filtro por regla que viene en la URL (`?regla=cruce`), o `null`. */
  regla: ReglaDeduccion | null;
  /** Cómo se arma el link de un chip conservando el resto de la vista. */
  enlace: (regla: ReglaDeduccion | null) => string;
}

export async function SolapaRevisar({ obraId, regla, enlace }: SolapaRevisarProps) {
  const db = await getDb();

  const [decididas, planos, elementos, inconsistencias, items] = await Promise.all([
    db
      .select()
      .from(deducciones)
      .where(and(eq(deducciones.obraId, obraId), inArray(deducciones.estado, ['propuesta', 'validada'])))
      .orderBy(deducciones.campo),
    db
      .select({
        id: laminas.id,
        codigo: laminas.codigo,
        titulo: laminas.titulo,
        numeroPagina: laminas.numeroPagina,
      })
      .from(laminas)
      .where(eq(laminas.obraId, obraId)),
    db
      .select({
        id: entidades.id,
        tipo: entidades.tipo,
        nombre: entidades.nombre,
        laminaId: entidades.laminaId,
      })
      .from(entidades)
      .where(eq(entidades.obraId, obraId)),
    db
      .select({ clave: hallazgos.clave })
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.estado, 'abierto'))),
    db
      .select()
      .from(computoItems)
      .where(
        and(
          eq(computoItems.obraId, obraId),
          eq(computoItems.estado, 'activo'),
          eq(computoItems.origen, 'inferido'),
        ),
      )
      .orderBy(computoItems.claveItem),
  ]);

  const etiquetaLamina = new Map(planos.map((fila) => [fila.id, etiquetaDeLamina(fila)]));
  // Para el "por qué" y las citas alcanza con el código; el título es de la UI.
  const codigos = new Map(
    planos.map((fila) => [fila.id, fila.codigo ?? `Página ${fila.numeroPagina}`]),
  );
  const porEntidad = new Map(elementos.map((fila) => [fila.id, fila]));

  const superadas = decididas.filter((fila) => fila.estado === 'validada' && estaContradicha(fila));
  const aplicadas = decididas.filter(
    (fila) => fila.estado === 'validada' && fila.validadoPor === null && !estaContradicha(fila),
  );
  const propuestas = decididas.filter((fila) => fila.estado === 'propuesta');

  const deLaRegla = (filas: readonly Deduccion[]): Deduccion[] =>
    regla === null ? [...filas] : filas.filter((fila) => fila.regla === regla);

  const autovalidadas = agrupar(deLaRegla(aplicadas), porEntidad, etiquetaLamina, codigos);
  const enEspera = agrupar(deLaRegla(propuestas), porEntidad, etiquetaLamina, codigos);

  // El método de un ítem inferido sale de la medición que lo sostiene: se busca
  // por entidad, que es lo único que los liga (el ítem no guarda de qué
  // deducción salió). Sin entidad —un ítem editado a mano perdió el link— no
  // hay método que mostrar, y el ítem se lista igual: está marcado inferido.
  const mediciones = new Map<string, string>();
  for (const fila of decididas) {
    const metodo = metodoDe(fila);
    if (metodo !== null && !mediciones.has(fila.entidadId)) mediciones.set(fila.entidadId, metodo);
  }

  const inferidos: ItemInferidoVista[] = items.map((item) => ({
    id: item.id,
    claveItem: item.claveItem,
    descripcion: item.descripcion,
    cantidad: formatearCantidad(item.cantNeta, item.unidad),
    laminas: citar(item.fuentesJson, etiquetaLamina),
    metodo: item.entidadId === null ? null : (mediciones.get(item.entidadId) ?? null),
  }));

  const porRegla = new Map<ReglaDeduccion, number>();
  for (const fila of [...aplicadas, ...propuestas]) {
    porRegla.set(fila.regla, (porRegla.get(fila.regla) ?? 0) + 1);
  }
  const total = aplicadas.length + propuestas.length;
  const contradicciones = inconsistencias.filter((fila) => esClaveDeDeduccion(fila.clave)).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-neutral-600">
        Lo que el sistema completó solo, con su fuente y su método a la vista. Un dato que dos
        láminas dicen entre las dos entra al cómputo marcado{' '}
        <strong className="font-medium">deducido</strong>; una medida sacada del dibujo, marcada{' '}
        <strong className="font-medium">inferido</strong>. Nada de esto frena la aprobación de un
        rubro: si algo no te cierra, rechazalo y la consulta vuelve a «Preguntas».
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Regla</span>
        <Chip href={enlace(null)} activo={regla === null}>
          Todas ({total})
        </Chip>
        {REGLAS_DEDUCCION.filter((candidata) => (porRegla.get(candidata) ?? 0) > 0).map(
          (candidata) => (
            <Chip key={candidata} href={enlace(candidata)} activo={regla === candidata}>
              {TITULO_REGLA[candidata]} ({porRegla.get(candidata)})
            </Chip>
          ),
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {/* `<a>` y no `<Link>`: son descargas de la API, no navegación. */}
        <a
          href={`/api/obras/${obraId}/deducciones/memoria`}
          className="font-medium text-neutral-900 underline"
        >
          Bajar la memoria de deducciones (.md)
        </a>
        <a
          href={`/api/obras/${obraId}/planilla-carpinterias`}
          className="font-medium text-neutral-900 underline"
        >
          Bajar la planilla de carpinterías derivada (.xlsx)
        </a>
        {contradicciones > 0 ? (
          <Badge tone="warn">
            {contradicciones === 1
              ? '1 contradicción entre láminas en «Preguntas»'
              : `${contradicciones} contradicciones entre láminas en «Preguntas»`}
          </Badge>
        ) : null}
      </div>

      {/* Deducciones que la documentación pasó por encima: el cómputo ya usa el
          dato escrito, pero la decisión vieja quedó registrada afirmando otra
          cosa y merece una mirada. La consulta `deduccion.contradicha.*` de
          «Preguntas» es la que se acciona. */}
      {superadas.length > 0 ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-amber-900">
              {superadas.length === 1
                ? '1 deducción superada por la documentación'
                : `${superadas.length} deducciones superadas por la documentación`}
            </h2>
            <p className="text-xs text-amber-900">
              Se aplicaron en su momento, pero la lámina pasó a decir otra cosa. Manda lo escrito: el
              cómputo ya usa el dato de la documentación. Están en «Preguntas» como inconsistencia
              para que decidas cuál vale.
            </p>
            <ul className="flex flex-col gap-1">
              {superadas.map((fila) => {
                const entidad = porEntidad.get(fila.entidadId);
                const validado = valorDeDeduccion(fila);
                const documentado = valorQueDocumenta(fila);
                return (
                  <li key={fila.id} className="text-sm text-amber-900">
                    <strong className="font-medium">
                      {entidad ? `${capitalizar(entidad.tipo)} ${entidad.nombre}` : 'Elemento'}
                    </strong>{' '}
                    · {etiquetaCampo(fila.campo)}: se dedujo{' '}
                    {validado === null ? '—' : describirValor(fila.campo, validado)} y la
                    documentación dice{' '}
                    {documentado === null || typeof documentado === 'boolean'
                      ? String(documentado)
                      : describirValor(fila.campo, documentado)}
                    .{' '}
                    {entidad ? (
                      <Link
                        href={`/obras/${obraId}/laminas/${entidad.laminaId}?highlight=${fila.id}`}
                        className="underline"
                      >
                        Ver en la lámina
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <ParaRevisar
        obraId={obraId}
        autovalidadas={autovalidadas}
        propuestas={enEspera}
        inferidos={inferidos}
        filtrada={regla !== null}
      />
    </div>
  );
}
