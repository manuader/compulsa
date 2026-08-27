'use client';

/**
 * Expediente: los documentos de la obra y sus láminas.
 *
 * Es la pantalla donde el análisis se vuelve visible y corregible. Dos reglas
 * de `src/app/CLAUDE.md` mandan sobre todo lo demás:
 *
 *  - §5 **estados visibles**: cada lámina muestra su `estado_analisis`, y la
 *    que está bloqueada explica qué necesita y trae el campo para dárselo.
 *    Nada de spinners eternos sin explicación.
 *  - §2 **cliente solo donde hay interactividad real**: la página es un Server
 *    Component; acá abajo está el mínimo que necesita manejar el upload, los
 *    selects y los botones.
 *
 * Toda mutación va contra `src/app/api/` y termina en un `router.refresh()`:
 * la verdad la sigue teniendo el server, no un estado local que se desincroniza.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type DragEvent } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
// Import **solo de tipos** a propósito: `@/types/domain` construye sus schemas
// Zod en el scope del módulo, así que importar de ahí un valor —aunque sea una
// lista de strings— se lleva zod entero al bundle del cliente (69 kB por dos
// arrays). Las listas de opciones se derivan de los diccionarios de etiquetas
// de más abajo, que son `Record<Union, string>`: si el dominio suma un valor,
// falta la etiqueta y no compila. La exhaustividad la garantiza el tipo.
import type { Disciplina, EstadoAnalisis, TipoLamina } from '@/types/domain';

import { eliminarDocumentoAction } from './actions';

// ---------------------------------------------------------------------------
// Datos que arma la página
// ---------------------------------------------------------------------------

export interface LaminaVista {
  id: string;
  numeroPagina: number;
  codigo: string | null;
  titulo: string | null;
  disciplina: Disciplina | null;
  tipo: TipoLamina | null;
  escala: string | null;
  escalaConfiable: boolean;
  estadoAnalisis: EstadoAnalisis;
  errorDetalle: string | null;
  archivoRef: string;
}

export interface DocumentoVista {
  id: string;
  nombreArchivo: string;
  version: number;
  subidoEl: string;
  laminas: LaminaVista[];
}

// ---------------------------------------------------------------------------
// Vocabulario de la pantalla
// ---------------------------------------------------------------------------

const ETIQUETA_ESTADO: Record<EstadoAnalisis, string> = {
  pendiente: 'Pendiente',
  procesando: 'Procesando',
  analizada: 'Analizada',
  bloqueada_escala: 'Falta la escala',
  error: 'Error',
};

const TONO_ESTADO: Record<EstadoAnalisis, BadgeTone> = {
  pendiente: 'neutral',
  procesando: 'info',
  analizada: 'ok',
  bloqueada_escala: 'warn',
  error: 'error',
};

const ETIQUETA_DISCIPLINA: Record<Disciplina, string> = {
  arquitectura: 'Arquitectura',
  estructura: 'Estructura',
  instalaciones: 'Instalaciones',
  otra: 'Otra',
};

const ETIQUETA_TIPO: Record<TipoLamina, string> = {
  planta: 'Planta',
  corte: 'Corte',
  vista: 'Vista',
  detalle: 'Detalle',
  planilla: 'Planilla',
  otra: 'Otra',
};

const DISCIPLINAS_UI = Object.keys(ETIQUETA_DISCIPLINA) as Disciplina[];
const TIPOS_UI = Object.keys(ETIQUETA_TIPO) as TipoLamina[];

// ---------------------------------------------------------------------------
// Cliente HTTP
// ---------------------------------------------------------------------------

/** Lanza con el mensaje que mandó la API, que ya viene escrito para el usuario. */
async function pedir(url: string, init: RequestInit): Promise<void> {
  const respuesta = await fetch(url, init);
  if (respuesta.ok) return;

  const cuerpo = (await respuesta.json().catch(() => null)) as { error?: string } | null;
  throw new Error(cuerpo?.error ?? 'No pude completar la acción. Probá de nuevo.');
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : 'Algo salió mal.';
}

// ---------------------------------------------------------------------------

export function Expediente({
  obraId,
  documentos,
}: {
  obraId: string;
  documentos: DocumentoVista[];
}) {
  const router = useRouter();
  const [refrescando, iniciarRefresh] = useTransition();

  const refrescar = () => iniciarRefresh(() => router.refresh());

  return (
    <div className="flex flex-col gap-6">
      <Dropzone obraId={obraId} onSubido={refrescar} />

      {documentos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-1 py-8">
            <p className="text-sm font-medium text-neutral-900">Todavía no subiste documentación.</p>
            <p className="text-sm text-neutral-600">
              Arrancá por las plantas y los cortes. Cada PDF se separa en láminas y el análisis sale
              solo.
            </p>
          </CardContent>
        </Card>
      ) : (
        documentos.map((documento) => (
          <DocumentoCard
            key={documento.id}
            obraId={obraId}
            documento={documento}
            onCambio={refrescar}
            refrescando={refrescando}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function Dropzone({ obraId, onSubido }: { obraId: string; onSubido: () => void }) {
  const entrada = useRef<HTMLInputElement>(null);
  const [encima, setEncima] = useState(false);
  const [subiendo, setSubiendo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function subir(archivos: FileList | null): Promise<void> {
    if (!archivos || archivos.length === 0) return;
    setError(null);
    setAviso(null);

    // De a uno y en orden: el análisis corre dentro del request y en paralelo
    // solo se pisarían el recompute.
    for (const archivo of Array.from(archivos)) {
      setSubiendo(archivo.name);
      const cuerpo = new FormData();
      cuerpo.set('archivo', archivo);
      try {
        const respuesta = await fetch(`/api/obras/${obraId}/documentos`, {
          method: 'POST',
          body: cuerpo,
        });
        const datos = (await respuesta.json().catch(() => null)) as {
          error?: string;
          advertencia?: string;
        } | null;
        if (!respuesta.ok) throw new Error(datos?.error ?? 'No pude subir el archivo.');
        if (datos?.advertencia) setAviso(datos.advertencia);
      } catch (fallo) {
        setError(`${archivo.name}: ${mensajeDe(fallo)}`);
        break;
      } finally {
        setSubiendo(null);
      }
    }

    if (entrada.current) entrada.current.value = '';
    onSubido();
  }

  function alSoltar(evento: DragEvent<HTMLDivElement>): void {
    evento.preventDefault();
    setEncima(false);
    void subir(evento.dataTransfer.files);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(evento) => {
          evento.preventDefault();
          setEncima(true);
        }}
        onDragLeave={() => setEncima(false)}
        onDrop={alSoltar}
        className={[
          'flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors',
          encima ? 'border-neutral-900 bg-neutral-100' : 'border-neutral-300 bg-white',
        ].join(' ')}
      >
        <p className="text-sm font-medium text-neutral-900">
          Soltá acá los PDF de la documentación
        </p>
        <p className="text-sm text-neutral-600">
          Plantas, cortes, vistas y planillas. Cada página se separa en una lámina.
        </p>
        <input
          ref={entrada}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(evento) => void subir(evento.target.files)}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={subiendo !== null}
          onClick={() => entrada.current?.click()}
        >
          {subiendo ? `Subiendo ${subiendo}…` : 'Elegir archivos'}
        </Button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {aviso ? <p className="text-sm text-amber-800">{aviso}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Un documento y sus láminas
// ---------------------------------------------------------------------------

function DocumentoCard({
  obraId,
  documento,
  onCambio,
  refrescando,
}: {
  obraId: string;
  documento: DocumentoVista;
  onCambio: () => void;
  refrescando: boolean;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cuantasLaminas =
    documento.laminas.length === 1 ? '1 lámina' : `${documento.laminas.length} láminas`;

  async function eliminar(): Promise<void> {
    setBorrando(true);
    setError(null);
    try {
      const resultado = await eliminarDocumentoAction({ obraId, documentoId: documento.id });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      setConfirmando(false);
      onCambio();
    } catch (fallo) {
      setError(mensajeDe(fallo));
    } finally {
      setBorrando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">{documento.nombreArchivo}</h2>
          {documento.version > 1 ? <Badge tone="info">v{documento.version}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-neutral-500">
            {cuantasLaminas} · subido el {documento.subidoEl}
          </p>
          <Button
            variant="danger"
            size="sm"
            disabled={borrando || refrescando}
            onClick={() => setConfirmando(true)}
          >
            Eliminar
          </Button>
        </div>
      </CardHeader>

      {error ? (
        <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <Dialog
        open={confirmando}
        onClose={() => setConfirmando(false)}
        title="Eliminar el documento"
        footer={
          <>
            <Button variant="secondary" disabled={borrando} onClick={() => setConfirmando(false)}>
              Cancelar
            </Button>
            <Button variant="danger" disabled={borrando} onClick={() => void eliminar()}>
              {borrando ? 'Eliminando…' : 'Eliminar documento'}
            </Button>
          </>
        }
      >
        <p>
          Se elimina <span className="font-medium">{documento.nombreArchivo}</span>
          {documento.version > 1 ? ` (versión ${documento.version})` : ''} y sus {cuantasLaminas}.
        </p>
        <ul className="mt-3 list-disc pl-5 text-neutral-700">
          <li>Sus láminas y las entidades que se detectaron en ellas se eliminan.</li>
          <li>
            Los ítems de cómputo que salían de esas entidades quedan{' '}
            <span className="font-medium">anulados</span>: no se borran, pero salen de la planilla y
            del XLSX.
          </li>
          <li>Las consultas de esas láminas se cierran.</li>
        </ul>
        <p className="mt-3">Esto no se puede deshacer.</p>
        {documento.version > 1 ? (
          <p className="mt-2 text-neutral-600">
            Las otras versiones de este archivo no se tocan: cada una es un documento aparte.
          </p>
        ) : null}
      </Dialog>

      <CardContent className="p-0">
        {documento.laminas.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-600">
            Este archivo no se pudo separar en láminas. Fijate que sea un PDF válido y volvé a
            subirlo.
          </p>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell numeric>Pág.</TableHeaderCell>
                <TableHeaderCell>Lámina</TableHeaderCell>
                <TableHeaderCell>Estado</TableHeaderCell>
                <TableHeaderCell>Disciplina</TableHeaderCell>
                <TableHeaderCell>Tipo</TableHeaderCell>
                <TableHeaderCell>
                  <span className="sr-only">Acciones</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {documento.laminas.map((lamina) => (
                <FilaLamina
                  key={lamina.id}
                  obraId={obraId}
                  lamina={lamina}
                  onCambio={onCambio}
                  refrescando={refrescando}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function FilaLamina({
  obraId,
  lamina,
  onCambio,
  refrescando,
}: {
  obraId: string;
  lamina: LaminaVista;
  onCambio: () => void;
  refrescando: boolean;
}) {
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ocupada = trabajando || refrescando;

  async function ejecutar(accion: () => Promise<void>): Promise<void> {
    setTrabajando(true);
    setError(null);
    try {
      await accion();
      onCambio();
    } catch (fallo) {
      setError(mensajeDe(fallo));
    } finally {
      setTrabajando(false);
    }
  }

  const parchear = (cambios: Record<string, unknown>) =>
    ejecutar(() =>
      pedir(`/api/laminas/${lamina.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
      }),
    );

  /** Computada con la escala que declara el rótulo, que nadie verificó. */
  const escalaAsumida =
    lamina.estadoAnalisis === 'analizada' && lamina.escala !== null && !lamina.escalaConfiable;

  return (
    <TableRow>
      <TableCell numeric>{lamina.numeroPagina}</TableCell>

      <TableCell>
        <div className="flex flex-col gap-1">
          {/* El expediente es la lista de láminas: desde acá se abre el visor.
              Sin este link la única puerta al visor era el acceso del tablero,
              que lleva siempre a la primera lámina de la obra. */}
          <Link
            href={`/obras/${obraId}/laminas/${lamina.id}`}
            className="font-medium text-neutral-900 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-900"
          >
            {lamina.titulo ?? 'Sin título en el rótulo'}
          </Link>
          <span className="text-xs text-neutral-500">
            {lamina.codigo ?? 'Sin código'}
            {lamina.escala ? ` · ${lamina.escala}` : ' · sin escala'}
            {lamina.escala && !lamina.escalaConfiable ? ' (sin verificar)' : ''}
          </span>
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col gap-2">
          <Badge tone={TONO_ESTADO[lamina.estadoAnalisis]}>
            {ETIQUETA_ESTADO[lamina.estadoAnalisis]}
          </Badge>

          {/* Dos láminas piden escala acá, y no es lo mismo: la bloqueada no se
              computó y espera el dato, y la de escala asumida ya está computada
              con la que declara el rótulo y solo espera el visto bueno. Las dos
              se resuelven con el mismo formulario —confirmar o corregir— y por
              eso las dos lo tienen en el expediente, que es la lista donde el
              arquitecto ve el estado de todas juntas. */}
          {lamina.estadoAnalisis === 'bloqueada_escala' || escalaAsumida ? (
            <FormEscala
              numeroPagina={lamina.numeroPagina}
              escalaDeclarada={lamina.escala}
              yaComputada={escalaAsumida}
              ocupada={ocupada}
              onConfirmar={parchear}
            />
          ) : null}

          {/* Una lámina `analizada` también puede traer detalle: el análisis salió
              bien y lo que falló fue el recompute de la obra. Es otra cosa que un
              error de la lámina, y se muestra distinto. */}
          {lamina.errorDetalle ? (
            <p
              className={`max-w-xs text-xs ${
                lamina.estadoAnalisis === 'error' ? 'text-red-700' : 'text-amber-700'
              }`}
            >
              {lamina.errorDetalle}
            </p>
          ) : null}

          {error ? <p className="max-w-xs text-xs text-red-700">{error}</p> : null}
        </div>
      </TableCell>

      <TableCell>
        <Select
          aria-label={`Disciplina de la lámina ${lamina.numeroPagina}`}
          value={lamina.disciplina ?? ''}
          disabled={ocupada}
          onChange={(evento) => {
            const valor = evento.target.value;
            if (valor === '') return;
            void parchear({ disciplina: valor });
          }}
        >
          <option value="">Sin clasificar</option>
          {DISCIPLINAS_UI.map((disciplina) => (
            <option key={disciplina} value={disciplina}>
              {ETIQUETA_DISCIPLINA[disciplina]}
            </option>
          ))}
        </Select>
      </TableCell>

      <TableCell>
        <Select
          aria-label={`Tipo de la lámina ${lamina.numeroPagina}`}
          value={lamina.tipo ?? ''}
          disabled={ocupada}
          onChange={(evento) => {
            const valor = evento.target.value;
            if (valor === '') return;
            void parchear({ tipo: valor });
          }}
        >
          <option value="">Sin clasificar</option>
          {TIPOS_UI.map((tipo) => (
            <option key={tipo} value={tipo}>
              {ETIQUETA_TIPO[tipo]}
            </option>
          ))}
        </Select>
      </TableCell>

      <TableCell>
        <div className="flex items-center justify-end gap-2">
          <a
            href={`/api/archivos/${lamina.archivoRef}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-neutral-700 underline hover:text-neutral-900"
          >
            Ver PDF
          </a>
          <Button
            variant="secondary"
            size="sm"
            disabled={ocupada}
            onClick={() =>
              void ejecutar(() => pedir(`/api/laminas/${lamina.id}/procesar`, { method: 'POST' }))
            }
          >
            {trabajando ? 'Trabajando…' : 'Reprocesar'}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Desbloqueo manual de escala (RF-201). No es un formulario de más: la lámina
 * no se computa hasta que alguien confirme con qué escala se lee.
 *
 * Si el rótulo declara una escala, el campo **viene lleno con esa**: leerla en
 * el plano, ver el input vacío y tipear "1:20" a mano era exactamente el
 * trabajo que el sistema estaba haciendo hacer de gusto. Sigue siendo editable
 * —el rótulo miente seguido, sobre todo en láminas reescaladas al imprimir— y
 * el copy cambia según haya algo declarado o no, porque no es lo mismo pedir
 * que confirmen una lectura que pedir un dato que no se tiene.
 */
function FormEscala({
  numeroPagina,
  escalaDeclarada,
  yaComputada = false,
  ocupada,
  onConfirmar,
}: {
  numeroPagina: number;
  /** La que dice el rótulo, sin verificar contra las cotas. `null` si no hay. */
  escalaDeclarada: string | null;
  /**
   * `true` si la lámina ya se analizó con la escala asumida. Cambia lo que el
   * formulario promete: confirmarla **no** vuelve a analizar nada (el cómputo
   * ya salió con esa misma escala), corregirla sí. Prometer un re-análisis que
   * no va a pasar es tan malo como no avisarlo cuando pasa.
   */
  yaComputada?: boolean;
  ocupada: boolean;
  onConfirmar: (cambios: Record<string, unknown>) => Promise<void>;
}) {
  const [escala, setEscala] = useState(escalaDeclarada ?? '');

  return (
    <form
      className="flex max-w-xs flex-col gap-2"
      onSubmit={(evento) => {
        evento.preventDefault();
        if (escala.trim() === '') return;
        void onConfirmar({ escala: escala.trim(), escalaConfiable: true });
      }}
    >
      <p className="text-xs text-neutral-600">
        {escalaDeclarada === null
          ? 'No leí ninguna escala en el rótulo y no la pude verificar contra las cotas. Indicá la del plano y la vuelvo a analizar.'
          : yaComputada
            ? `Leí ${escalaDeclarada} en el rótulo pero no la pude verificar contra las cotas. Computé con esa escala: confirmala si es la del plano, o corregila y la vuelvo a analizar.`
            : `Leí ${escalaDeclarada} en el rótulo pero no la pude verificar contra las cotas. Confirmala o corregila y vuelvo a analizar la lámina.`}
      </p>
      <Input
        name="escala"
        aria-label={`Escala de la lámina ${numeroPagina}`}
        placeholder="Escala (ej. 1:100)"
        value={escala}
        disabled={ocupada}
        onChange={(evento) => setEscala(evento.target.value)}
      />
      <Button type="submit" size="sm" disabled={ocupada || escala.trim() === ''}>
        Confirmar escala
      </Button>
    </form>
  );
}
