'use client';

/**
 * La lista de precios de referencia del estudio: tabla, alta a mano e import
 * de CSV con preview.
 *
 * Es cliente por tres cosas que no se pueden hacer en el server:
 *
 *  - el **preview del CSV se calcula mientras se escribe**, con la misma
 *    función pura que después usa el server para persistir (`importarCsvPrecios`);
 *  - borrar un precio abre un diálogo de confirmación (`src/app/CLAUDE.md` §7);
 *  - editar una fila abre el formulario con los datos cargados.
 *
 * Los datos llegan como `PrecioVista`: campos planos y **ya formateados en es-AR
 * por el server**, para que el borde servidor→cliente sea obvio y serializable.
 */
import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
// Puro y sin base: el preview del import corre en el navegador con la misma
// función que después usa el server para persistir.
import { fechaDePrecio } from '@/components/planilla/precio';
import { importarCsvPrecios } from '@/lib/precios/import-csv';
import { UNIDADES, type Unidad } from '@/types/domain';

import {
  eliminarPrecioAction,
  guardarPrecioAction,
  importarPreciosAction,
  type EstadoPrecio,
  type ResumenImportPreciosAction,
} from './actions';

export interface PrecioVista {
  id: string;
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  /** Con símbolo y separadores es-AR: «$ 145.000». */
  precioFormateado: string;
  /** El mismo número, como lo escribiría el usuario: «145.000». Para el input. */
  precioEditable: string;
  moneda: string;
  /** `YYYY-MM-DD`, como lo guarda la base. Para el input `date`. */
  fecha: string;
  /** `dd/mm/aaaa`, para la tabla. */
  fechaFormateada: string;
  origen: 'csv' | 'manual';
}

export const ETIQUETA_UNIDAD: Record<Unidad, string> = {
  u: 'u (unidad)',
  m: 'm (metro)',
  ml: 'ml (metro lineal)',
  m2: 'm² (metro cuadrado)',
  m3: 'm³ (metro cúbico)',
  l: 'l (litro)',
  kg: 'kg (kilo)',
};

const ETIQUETA_ORIGEN: Record<PrecioVista['origen'], string> = {
  csv: 'importado',
  manual: 'a mano',
};

const ESTADO_INICIAL: EstadoPrecio = {};

/**
 * El ejemplo del pegado, con **las claves que emiten las plantillas**.
 *
 * Antes decía `aberturas.ventana.dvh`, `seco.placa.durlock` y
 * `pintura.latex.interior`: tres claves que no existen en ningún cómputo. Un
 * ejemplo que enseña a cargar precios que después no matchean con nada es peor
 * que no tener ejemplo — la cascada del §5.6 busca por `clave_item` exacta.
 * Estas tres son las de `seco`, `pintura` y `gruesa`, y las mismas que siembra
 * `scripts/seed.ts`.
 */
const EJEMPLO_CSV = `clave_item;descripcion;unidad;precio;fecha
seco.placas;Placa de roca de yeso (1,20 × 2,40 m);m2;9800;2026-08-10
pintura.latex_paredes;Látex interior para paredes;l;4300;
gruesa.cemento;Cemento de albañilería;kg;"260,50";`;

/** Hoy en ISO (`2026-09-02`), que es la que va a poner el server si el CSV no trae ninguna. */
function hoyIso(): string {
  const hoy = new Date();
  const mes = String(hoy.getMonth() + 1).padStart(2, '0');
  const dia = String(hoy.getDate()).padStart(2, '0');
  return `${hoy.getFullYear()}-${mes}-${dia}`;
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : 'Algo salió mal.';
}

// ---------------------------------------------------------------------------
// Tabla
// ---------------------------------------------------------------------------

export function TablaPrecios({
  precios,
  puedeGestionar,
}: {
  precios: PrecioVista[];
  /**
   * Colaborador para arriba (RF-1201). En `false` no se dibujan las acciones:
   * esconder los botones es cortesía, el que rechaza la mutación es el core.
   */
  puedeGestionar: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [aBorrar, setABorrar] = useState<PrecioVista | null>(null);
  const [aEditar, setAEditar] = useState<PrecioVista | null>(null);
  const [borrando, iniciarBorrado] = useTransition();

  if (precios.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        Todavía no cargaste ningún precio. Cargá uno a mano o pegá tu lista en CSV: el cómputo los
        usa para estimar el costo de cada ítem, y sin lista solo queda el índice de precios de tus
        propias compulsas.
      </p>
    );
  }

  function confirmarBorrado(): void {
    if (!aBorrar) return;
    setError(null);
    const precio = aBorrar;
    iniciarBorrado(async () => {
      try {
        const resultado = await eliminarPrecioAction({ precioId: precio.id });
        if (!resultado.ok) {
          setError(resultado.error);
          return;
        }
        setABorrar(null);
      } catch (fallo) {
        setError(mensajeDe(fallo));
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Clave del ítem</TableHeaderCell>
            <TableHeaderCell>Descripción</TableHeaderCell>
            <TableHeaderCell>Unidad</TableHeaderCell>
            <TableHeaderCell numeric>Precio</TableHeaderCell>
            <TableHeaderCell>Fecha</TableHeaderCell>
            <TableHeaderCell>Origen</TableHeaderCell>
            {puedeGestionar ? <TableHeaderCell>Acciones</TableHeaderCell> : null}
          </TableRow>
        </TableHead>
        <TableBody>
          {precios.map((precio) => (
            <TableRow key={precio.id}>
              <TableCell>
                <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs">
                  {precio.claveItem}
                </code>
              </TableCell>
              <TableCell>{precio.descripcion}</TableCell>
              <TableCell>{precio.unidad}</TableCell>
              <TableCell numeric>{precio.precioFormateado}</TableCell>
              <TableCell>{precio.fechaFormateada}</TableCell>
              <TableCell>
                <Badge tone="neutral">{ETIQUETA_ORIGEN[precio.origen]}</Badge>
              </TableCell>
              {puedeGestionar ? (
                <TableCell>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setAEditar(precio)}>
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setABorrar(precio)}>
                      Borrar
                    </Button>
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog
        open={aEditar !== null}
        onClose={() => setAEditar(null)}
        title={aEditar ? `Editar ${aEditar.descripcion}` : ''}
      >
        {aEditar ? (
          <FormularioPrecio
            key={aEditar.id}
            inicial={aEditar}
            alGuardar={() => setAEditar(null)}
            textoBoton="Guardar cambios"
          />
        ) : null}
      </Dialog>

      <Dialog
        open={aBorrar !== null}
        onClose={() => setABorrar(null)}
        title="Borrar el precio de referencia"
        footer={
          <>
            <Button variant="secondary" onClick={() => setABorrar(null)} disabled={borrando}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={confirmarBorrado} disabled={borrando}>
              {borrando ? 'Borrando…' : 'Borrar'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-700">
          Vas a sacar <strong>{aBorrar?.descripcion}</strong>{' '}
          <span className="font-mono text-xs text-neutral-500">({aBorrar?.claveItem})</span> de la
          lista del estudio. Los ítems que se estaban costeando con este precio pasan al índice, o se
          quedan sin precio hasta que cargues otro.
        </p>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alta y edición
// ---------------------------------------------------------------------------

/**
 * El mismo formulario para el alta y para la edición: el core es un upsert por
 * `(estudio, clave_item)`, así que cargar una clave que ya está la actualiza.
 *
 * En la edición la clave viaja en un input de solo lectura: cambiarla no sería
 * editar esta fila sino crear otra, y el usuario tiene el botón de alta al lado
 * para eso.
 */
export function FormularioPrecio({
  inicial,
  alGuardar,
  textoBoton = 'Agregar a la lista',
}: {
  inicial?: PrecioVista;
  alGuardar?: () => void;
  textoBoton?: string;
}) {
  const [estado, accion, enviando] = useActionState(guardarPrecioAction, ESTADO_INICIAL);
  const form = useRef<HTMLFormElement>(null);
  const editando = inicial !== undefined;

  // Un alta que salió bien deja el formulario limpio para el próximo ítem; una
  // edición cierra el diálogo. En los dos casos el server ya revalidó la tabla.
  useEffect(() => {
    if (!estado.mensaje) return;
    if (editando) alGuardar?.();
    else form.current?.reset();
  }, [estado.mensaje, editando, alGuardar]);

  const valores = estado.valores;

  return (
    <form ref={form} action={accion} className="flex flex-col gap-4">
      {estado.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {estado.error}
        </p>
      ) : null}
      {estado.mensaje && !editando ? (
        <p
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {estado.mensaje}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="claveItem"
          label="Clave del ítem"
          placeholder="seco.placas"
          defaultValue={valores?.claveItem ?? inicial?.claveItem ?? ''}
          readOnly={editando}
          required
          error={estado.errores?.claveItem}
        />
        <Input
          name="descripcion"
          label="Descripción"
          placeholder="Placa de roca de yeso (1,20 × 2,40 m)"
          defaultValue={valores?.descripcion ?? inicial?.descripcion ?? ''}
          required
          error={estado.errores?.descripcion}
        />
        <Select
          name="unidad"
          label="Unidad"
          defaultValue={valores?.unidad ?? inicial?.unidad ?? 'u'}
          error={estado.errores?.unidad}
        >
          {UNIDADES.map((unidad) => (
            <option key={unidad} value={unidad}>
              {ETIQUETA_UNIDAD[unidad]}
            </option>
          ))}
        </Select>
        <Input
          name="precio"
          label="Precio unitario"
          inputMode="decimal"
          placeholder="145.000,50"
          defaultValue={valores?.precio ?? inicial?.precioEditable ?? ''}
          required
          error={estado.errores?.precio}
        />
        <Input
          name="moneda"
          label="Moneda"
          placeholder="ARS"
          defaultValue={valores?.moneda ?? inicial?.moneda ?? 'ARS'}
          error={estado.errores?.moneda}
        />
        <Input
          name="fecha"
          type="date"
          label="Fecha del precio"
          defaultValue={valores?.fecha ?? inicial?.fecha ?? ''}
          error={estado.errores?.fecha}
        />
      </div>

      <p className="text-xs text-neutral-500">
        La clave del ítem es la misma que usa la planilla del cómputo (por ejemplo{' '}
        <code className="rounded bg-neutral-100 px-1">aberturas.ventana.dvh</code>). Si ya cargaste
        esa clave, se pisa el precio: no se duplica. Sin fecha, va la de hoy.
      </p>

      <div>
        <Button type="submit" disabled={enviando}>
          {enviando ? 'Guardando…' : textoBoton}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function ImportadorCsvPrecios() {
  const [texto, setTexto] = useState('');
  const [resumen, setResumen] = useState<ResumenImportPreciosAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [corriendo, iniciar] = useTransition();

  const preview = texto.trim() === '' ? null : importarCsvPrecios(texto);
  const filas = preview?.filas ?? [];
  const errores = preview?.errores ?? [];

  function confirmar(): void {
    setError(null);
    iniciar(async () => {
      try {
        const resultado = await importarPreciosAction({ texto });
        if (!resultado.ok) {
          setError(resultado.error);
          return;
        }
        setResumen(resultado.resumen);
        setTexto('');
      } catch (fallo) {
        setError(mensajeDe(fallo));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      {resumen ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          <p className="font-medium">
            {resumen.nuevos} {resumen.nuevos === 1 ? 'nuevo' : 'nuevos'}, {resumen.actualizados}{' '}
            {resumen.actualizados === 1 ? 'actualizado' : 'actualizados'}, {resumen.errores.length}{' '}
            {resumen.errores.length === 1 ? 'error' : 'errores'}.
          </p>
          {resumen.sinCambios > 0 ? (
            <p className="mt-1">
              {resumen.sinCambios}{' '}
              {resumen.sinCambios === 1
                ? 'ya estaba igual y no se tocó'
                : 'ya estaban igual y no se tocaron'}
              .
            </p>
          ) : null}
          {/* Las líneas que no entraron se listan con su número: el textarea ya
              se vació, así que este es el único lugar donde el usuario puede ver
              qué le falta arreglar antes de volver a pegarlas. */}
          {resumen.errores.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-red-800">
              {resumen.errores.map((problema) => (
                <li key={problema.linea}>
                  <span className="font-medium">Línea {problema.linea}:</span> {problema.motivo}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700">
          Pegá el CSV (columnas: clave_item, descripcion, unidad, precio y, si querés, fecha)
        </span>
        <textarea
          value={texto}
          onChange={(evento) => setTexto(evento.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={EJEMPLO_CSV}
          className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-neutral-900"
        />
      </label>

      <p className="text-xs text-neutral-500">
        Separador coma o punto y coma (lo detecto solo) y coma decimal en el precio
        («12,50» son doce pesos con cincuenta). Una clave que ya esté en la lista se pisa con el
        precio nuevo; la fila que quede igual no se toca. Sin fecha, va la de hoy.
      </p>

      {preview ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={filas.length > 0 ? 'ok' : 'neutral'}>
              {filas.length} {filas.length === 1 ? 'fila lista' : 'filas listas'}
            </Badge>
            <Badge tone={errores.length > 0 ? 'error' : 'neutral'}>
              {errores.length} {errores.length === 1 ? 'error' : 'errores'}
            </Badge>
          </div>

          {errores.length > 0 ? (
            <ul className="flex flex-col gap-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {errores.map((problema) => (
                <li key={problema.linea}>
                  <span className="font-medium">Línea {problema.linea}:</span> {problema.motivo}
                </li>
              ))}
            </ul>
          ) : null}

          {filas.length > 0 ? (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Clave del ítem</TableHeaderCell>
                  <TableHeaderCell>Descripción</TableHeaderCell>
                  <TableHeaderCell>Unidad</TableHeaderCell>
                  <TableHeaderCell numeric>Precio</TableHeaderCell>
                  <TableHeaderCell>Fecha</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filas.map((fila) => (
                  <TableRow key={fila.linea}>
                    <TableCell>
                      <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs">
                        {fila.claveItem}
                      </code>
                    </TableCell>
                    <TableCell>{fila.descripcion}</TableCell>
                    <TableCell>{fila.unidad}</TableCell>
                    {/* El preview corre en el navegador: el número se muestra con
                        el formato local del cliente, que para es-AR es el mismo
                        que usa el server en la tabla de arriba. */}
                    <TableCell numeric>{fila.precio.toLocaleString('es-AR')}</TableCell>
                    {/* Una columna de fechas con un «hoy» en minúscula en el
                        medio se lee como un valor más, y las de arriba venían
                        en ISO mientras la tabla de al lado las escribe en
                        es-AR. Sin fecha en el CSV va la de hoy, y se muestra
                        la fecha. */}
                    <TableCell>{fechaDePrecio(fila.fecha ?? hoyIso())}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </>
      ) : null}

      <div className="flex items-center gap-2">
        <Button disabled={corriendo || filas.length === 0} onClick={confirmar}>
          {corriendo
            ? 'Importando…'
            : `Importar ${filas.length} ${filas.length === 1 ? 'precio' : 'precios'}`}
        </Button>
        <Link
          href="/estudio"
          className="text-sm font-medium text-neutral-700 underline hover:text-neutral-900"
        >
          Volver al estudio
        </Link>
      </div>
    </div>
  );
}
