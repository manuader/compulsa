import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button, estilosBoton } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { getDb } from '@/db/client';
import { auditoria, obras, usuarios } from '@/db/schema';
import { esUuid, requireUser } from '@/lib/auth/guards';
import { esRolSuficiente } from '@/lib/plataforma/roles';

import { SinPermiso } from '../ui';

export const metadata: Metadata = { title: 'Auditoría' };

/** Filas por página. El cursor es `(at, id)`, no un offset: ver `condicionCursor`. */
const POR_PAGINA = 50;

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Cada acción, dicha en es-AR.
 *
 * La columna `accion` guarda verbos en `snake_case` porque es una clave estable
 * que se filtra y se agrupa; esta tabla es la traducción para leerla. Una acción
 * que no esté acá se muestra humanizada (`hallazgo_reabierto` → "hallazgo
 * reabierto"): mejor un texto imperfecto que una fila que no se entiende.
 *
 * Ese ejemplo es literal: `hallazgo_reabierto` **ya no lo emite nadie** y por
 * eso salió de la tabla. Reabrir una consulta cerrada era la excepción que
 * necesitaba el bloqueo por escala, y desde "proponer en vez de bloquear" lo que
 * el arquitecto cerró no se reabre (`upsertHallazgoEscala`). Las filas viejas
 * que la tengan siguen siendo legibles, humanizadas, que es justo para lo que
 * está el fallback.
 */
const FRASE_ACCION: Record<string, string> = {
  analisis_llm: 'Analizó una lámina con el modelo',
  checklist_item_actualizado: 'Cambió un ítem del checklist',
  computo_item_actualizado: 'El recompute actualizó un ítem',
  computo_item_anulado: 'Anuló un ítem del cómputo',
  computo_item_creado: 'Agregó un ítem al cómputo',
  computo_item_desvinculado: 'Un ítem perdió su entidad de origen',
  computo_item_editado: 'Editó un ítem del cómputo',
  computo_recalculado: 'Recalculó el cómputo de la obra',
  config_estudio_actualizada: 'Cambió la configuración del estudio',
  documento_eliminado: 'Eliminó un documento',
  documento_subido: 'Subió un documento',
  entidad_actualizada: 'Completó un dato de una entidad',
  hallazgo_abierto: 'Se abrió una consulta',
  hallazgo_actualizado: 'Cambió una consulta',
  hallazgo_descartado: 'Descartó una consulta',
  hallazgo_respondido: 'Respondió una consulta',
  invitacion_creada: 'Generó una invitación',
  invitacion_usada: 'Se sumó al estudio con una invitación',
  lamina_analizada: 'Terminó de analizar una lámina',
  lamina_bloqueada_escala: 'Bloqueó una lámina por escala no verificable',
  lamina_clasificada: 'Clasificó una lámina',
  lamina_creada: 'Separó una lámina del PDF',
  lamina_error: 'Falló el análisis de una lámina',
  lamina_escala_confirmada: 'Confirmó la escala de una lámina',
  lamina_procesamiento_omitido: 'Salteó una lámina ya tomada',
  lamina_procesando: 'Tomó una lámina para analizar',
  obra_archivada: 'Archivó la obra',
  obra_archivos_pendientes: 'Quedaron archivos sin borrar en el storage',
  obra_creada: 'Creó la obra',
  obra_desarchivada: 'Desarchivó la obra',
  obra_editada: 'Editó los datos de la obra',
  obra_eliminada: 'Eliminó la obra definitivamente',
  rubro_aprobado: 'Aprobó el cómputo de un rubro',
  usuario_activo_cambiado: 'Activó o dio de baja a un usuario',
  usuario_rol_cambiado: 'Cambió el rol de un usuario',
};

function frase(accion: string): string {
  return FRASE_ACCION[accion] ?? accion.replace(/_/g, ' ');
}

/** "computo_items:seco.placas" → "seco.placas". El prefijo es la tabla, no el objeto. */
function objeto(targetRef: string | null): string {
  if (!targetRef) return '—';
  const corte = targetRef.indexOf(':');
  return corte === -1 ? targetRef : targetRef.slice(corte + 1);
}

/**
 * El diff, en una línea legible.
 *
 * Los diffs del repo tienen dos formas: `{ campo: { antes, despues } }` para las
 * ediciones y `{ campo: valor }` para las metadatas. Se muestran las dos sin
 * pretender que son la misma cosa, y se corta a tres campos: el detalle completo
 * está en la base, esta columna es para reconocer la fila.
 */
function detalle(diff: Record<string, unknown> | null): string {
  if (!diff) return '—';

  const partes: string[] = [];
  for (const [campo, valor] of Object.entries(diff)) {
    if (partes.length === 3) {
      partes.push('…');
      break;
    }
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

/**
 * Keyset por `(at, id)`, no `OFFSET`.
 *
 * Con `OFFSET` una fila nueva escrita mientras alguien pagina corre todo un
 * lugar y la página siguiente repite una fila y se saltea otra. Con el cursor
 * en el último `(at, id)` mostrado, la página siguiente es siempre "lo que
 * sigue", pase lo que pase adelante. El `id` desempata: dos filas escritas en el
 * mismo microsegundo con solo `at <` se perderían.
 */
function condicionCursor(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const [iso, id] = cursor.split('|');
  if (!iso || !id || !esUuid(id)) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;

  return or(lt(auditoria.at, at), and(eq(auditoria.at, at), lt(auditoria.id, id)));
}

interface Props {
  searchParams: Promise<{ obra?: string; cursor?: string }>;
}

/**
 * Auditoría del estudio: todo lo que se hizo, con quién y cuándo.
 *
 * Es de titular. La pantalla no ofrece "borrar" nada: la auditoría es de solo
 * lectura por definición (`src/db/CLAUDE.md` §7).
 *
 * ## Cómo se acota al estudio
 *
 * `auditoria` no tiene `estudio_id`: las filas de obra se acotan por su obra, y
 * las filas **sin obra** (alta de invitación, configuración, la fila que
 * sobrevive a `obra_eliminada`) se acotan por el mail del actor, que es único
 * por usuario. Es exacto para todo lo que escribe una persona, que es todo lo
 * que hoy se audita sin obra. Una columna `estudio_id` en `auditoria` lo haría
 * directo y dejaría de depender de que el actor sea una persona; queda como
 * tarea futura, con su migración.
 */
export default async function AuditoriaPage({ searchParams }: Props) {
  const { usuario, estudio } = await requireUser();
  if (!esRolSuficiente(usuario, 'titular')) {
    return <SinPermiso que="ver la auditoría del estudio" minimo="titular" />;
  }

  const { obra: obraFiltro, cursor } = await searchParams;
  const db = await getDb();

  const [obrasDelEstudio, equipo] = await Promise.all([
    db
      .select({ id: obras.id, nombre: obras.nombre })
      .from(obras)
      .where(eq(obras.estudioId, estudio.id))
      .orderBy(obras.nombre),
    db.select({ email: usuarios.email }).from(usuarios).where(eq(usuarios.estudioId, estudio.id)),
  ]);

  const obraElegida =
    obraFiltro && obrasDelEstudio.some((obra) => obra.id === obraFiltro) ? obraFiltro : undefined;
  const idsDeObras = obrasDelEstudio.map((obra) => obra.id);
  const mails = equipo.map((miembro) => miembro.email);

  // `or()` sin condiciones devuelve `undefined`, que en el `where` significa
  // "sin filtro" — o sea, la auditoría de TODOS los estudios. No puede pasar
  // (el usuario de la sesión ya es un mail del estudio), pero un alcance que
  // falla abierto no es algo que se deje librado a que no pueda pasar.
  const alcance: SQL | undefined = obraElegida
    ? eq(auditoria.obraId, obraElegida)
    : or(
        idsDeObras.length > 0 ? inArray(auditoria.obraId, idsDeObras) : undefined,
        mails.length > 0
          ? and(isNull(auditoria.obraId), inArray(auditoria.actorNombre, mails))
          : undefined,
      ) ?? sql`false`;

  // Se piden 51 para saber si hay página siguiente sin contar la tabla entera.
  const filas = await db
    .select({
      id: auditoria.id,
      at: auditoria.at,
      actorTipo: auditoria.actorTipo,
      actorNombre: auditoria.actorNombre,
      accion: auditoria.accion,
      targetRef: auditoria.targetRef,
      diffJson: auditoria.diffJson,
      obraId: auditoria.obraId,
    })
    .from(auditoria)
    .where(and(alcance, condicionCursor(cursor)))
    .orderBy(desc(auditoria.at), desc(auditoria.id))
    .limit(POR_PAGINA + 1);

  const pagina = filas.slice(0, POR_PAGINA);
  const hayMas = filas.length > POR_PAGINA;
  const ultima = pagina[pagina.length - 1];
  const nombreDeObra = new Map(obrasDelEstudio.map((obra) => [obra.id, obra.nombre]));

  const siguiente = new URLSearchParams();
  if (obraElegida) siguiente.set('obra', obraElegida);
  if (ultima) siguiente.set('cursor', `${ultima.at.toISOString()}|${ultima.id}`);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link href="/estudio" className="text-sm text-neutral-600 underline">
          ← Estudio
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          Auditoría de {estudio.nombre}
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Toda escritura del sistema y de las personas deja rastro acá. No se edita ni se borra.
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Un GET normal: el filtro tiene que sobrevivir a un F5 y a un link compartido. */}
          <form method="get" className="flex items-end gap-3">
            <div className="w-72">
              <Select label="Obra" name="obra" defaultValue={obraElegida ?? ''}>
                <option value="">Todas (más lo que no es de una obra)</option>
                {obrasDelEstudio.map((obra) => (
                  <option key={obra.id} value={obra.id}>
                    {obra.nombre}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              Filtrar
            </Button>
          </form>

          {pagina.length === 0 ? (
            <p className="text-sm text-neutral-600">
              {cursor ? 'No hay más registros.' : 'Todavía no hay nada registrado.'}
            </p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Fecha</TableHeaderCell>
                  <TableHeaderCell>Actor</TableHeaderCell>
                  <TableHeaderCell>Acción</TableHeaderCell>
                  <TableHeaderCell>Objeto</TableHeaderCell>
                  <TableHeaderCell>Detalle</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pagina.map((fila) => (
                  <TableRow key={fila.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {FECHA.format(fila.at)}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Badge tone={fila.actorTipo === 'usuario' ? 'info' : 'neutral'}>
                          {fila.actorTipo === 'usuario' ? 'persona' : 'agente'}
                        </Badge>
                        {fila.actorNombre}
                      </span>
                    </TableCell>
                    <TableCell>{frase(fila.accion)}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{objeto(fila.targetRef)}</span>
                      {fila.obraId && !obraElegida ? (
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          {nombreDeObra.get(fila.obraId) ?? 'obra eliminada'}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-neutral-600">{detalle(fila.diffJson)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-600">
              {pagina.length} registro{pagina.length === 1 ? '' : 's'} en esta página
            </span>
            <div className="flex gap-2">
              {cursor ? (
                <Link
                  href={obraElegida ? `/estudio/auditoria?obra=${obraElegida}` : '/estudio/auditoria'}
                  className={estilosBoton('secondary', 'sm')}
                >
                  Volver al principio
                </Link>
              ) : null}
              {hayMas ? (
                <Link
                  href={`/estudio/auditoria?${siguiente.toString()}`}
                  className={estilosBoton('primary', 'sm')}
                >
                  Más viejas →
                </Link>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
