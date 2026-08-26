/**
 * "Qué cambió": el diff de la última revisión procesada (RF-308).
 *
 * Server Component sin estado: la fila más nueva de `recomputos` ya trae el
 * antes y el después de cada ítem que se movió (lo arma `procesarDocumento` con
 * el mismo diff que el recompute usa para auditar). Acá solo se ordena para leer.
 *
 * Va colapsado en un `<details>` nativo —sin JavaScript— porque es información
 * de consulta, no de trabajo: se abre cuando alguien pregunta "¿qué me cambió la
 * revisión?" y el resto del tiempo no ocupa la pantalla.
 *
 * La columna que importa es `cantCompra`: es lo que se compra. El detalle campo
 * por campo queda en `auditoria`, que es donde hay que ir cuando la pregunta es
 * "¿y por qué?".
 */
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { ETIQUETA_UNIDAD, formatearNumero } from '@/lib/computo/unidades';
import type { CambioDeRevision, EstadoCambio, MotivoRecomputo } from '@/lib/pipeline/procesar';

const ETIQUETA_MOTIVO: Record<MotivoRecomputo, string> = {
  reproceso: 'Reproceso del documento',
  revision_nueva: 'Revisión nueva',
};

const ETIQUETA_ESTADO: Record<EstadoCambio, string> = {
  agregado: 'Nuevo',
  modificado: 'Cambió',
  anulado: 'Ya no está',
};

const TONO_ESTADO: Record<EstadoCambio, BadgeTone> = {
  agregado: 'ok',
  modificado: 'info',
  anulado: 'warn',
};

/** El diff que la página baja de `recomputos`. */
export interface RevisionVista {
  motivo: MotivoRecomputo;
  documentoNombre: string;
  version: number;
  /** Ya formateada en es-AR por la página: el componente no formatea fechas. */
  cuando: string;
  cambios: CambioDeRevision[];
}

function cantidad(valor: number | null, unidad: keyof typeof ETIQUETA_UNIDAD): string {
  return valor === null ? '—' : `${formatearNumero(valor)} ${ETIQUETA_UNIDAD[unidad]}`;
}

export interface CambiosDeRevisionProps {
  revision: RevisionVista | null;
}

export function CambiosDeRevision({ revision }: CambiosDeRevisionProps) {
  if (revision === null || revision.cambios.length === 0) return null;

  const { cambios } = revision;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-neutral-900">Qué cambió</h3>
        <Badge tone="info">{ETIQUETA_MOTIVO[revision.motivo]}</Badge>
        <span className="text-sm text-neutral-600">
          {revision.documentoNombre}
          {revision.version > 1 ? ` (versión ${revision.version})` : ''} · {revision.cuando} ·{' '}
          {cambios.length} {cambios.length === 1 ? 'ítem' : 'ítems'}
        </span>
      </CardHeader>

      <CardContent>
        <details>
          <summary className="cursor-pointer text-sm text-neutral-700">
            Ver el detalle del cómputo
          </summary>

          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Ítem</TableHeaderCell>
                  <TableHeaderCell>Estado</TableHeaderCell>
                  <TableHeaderCell numeric>Antes</TableHeaderCell>
                  <TableHeaderCell numeric>Después</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {cambios.map((cambio) => (
                  <TableRow key={cambio.claveItem}>
                    <TableCell>
                      <span className="font-medium text-neutral-900">{cambio.descripcion}</span>
                      <span className="block text-xs text-neutral-500">{cambio.claveItem}</span>
                    </TableCell>
                    <TableCell>
                      <Badge tone={TONO_ESTADO[cambio.estado]}>
                        {ETIQUETA_ESTADO[cambio.estado]}
                      </Badge>
                    </TableCell>
                    <TableCell numeric>{cantidad(cambio.cantCompraAntes, cambio.unidad)}</TableCell>
                    <TableCell numeric>
                      {cantidad(cambio.cantCompraDespues, cambio.unidad)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
