'use client';

/**
 * La tabla de la agenda y las tres acciones de cada fila.
 *
 * Es cliente porque las tres acciones abren un diálogo antes de escribir
 * (`src/app/CLAUDE.md` §6: lo sensible se confirma). Las dos de consentimiento
 * merecen ese diálogo por una razón que no es de UX sino de compliance (§13):
 *
 *  - **Opt-in de WhatsApp:** el texto del diálogo dice qué está afirmando quien
 *    lo aprieta —que el proveedor aceptó recibir mensajes del estudio—. El
 *    sistema no puede verificarlo; lo único que puede hacer es no dejar que se
 *    marque de taquito y guardar quién lo marcó y cuándo.
 *  - **No contactar:** el diálogo avisa que es **permanente**. Y no hay ninguna
 *    acción para revertirlo: la fila de un proveedor con opt-out no ofrece
 *    "reactivar", porque el core tampoco tiene con qué.
 *
 * Los datos llegan como `ProveedorVista`: campos planos, sin `Date` ni tipos de
 * la base, para que el borde servidor→cliente sea obvio y serializable.
 */
import Link from 'next/link';
import { useActionState, useState, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { importarCsv } from '@/lib/proveedores/import-csv';
import { RUBROS, type RubroId } from '@/types/domain';

import {
  crearProveedorAction,
  editarProveedorAction,
  importarProveedoresAction,
  marcarOptInAction,
  marcarOptOutAction,
  type EstadoNuevoProveedor,
  type ResumenImportAction,
} from './actions';

export interface ProveedorVista {
  id: string;
  nombre: string;
  rubros: RubroId[];
  zona: string;
  telefono: string | null;
  email: string | null;
  whatsapp: string | null;
  contacto: string | null;
  optInWa: boolean;
  optOut: boolean;
  /** Fecha ya formateada en el server; `null` si nunca dio consentimiento. */
  optInRegistradoEn: string | null;
}

/** El texto que el usuario tiene que poder afirmar antes de que se guarde el opt-in (§13). */
export const TEXTO_COMPLIANCE_OPT_IN =
  'Confirmá que el proveedor aceptó recibir mensajes de WhatsApp del estudio';

export const ETIQUETA_RUBRO: Record<RubroId, string> = {
  aberturas: 'Aberturas',
  seco: 'Construcción en seco',
  pintura: 'Pintura',
  gruesa: 'Obra gruesa',
};

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : 'Algo salió mal.';
}

// ---------------------------------------------------------------------------

export function TablaProveedores({
  proveedores,
  puedeGestionar,
}: {
  proveedores: ProveedorVista[];
  /**
   * Rol de colaborador para arriba (RF-1201). En `false` la columna de acciones
   * ni se dibuja: esconder los botones es cortesía, el que rechaza la mutación
   * es el core.
   */
  puedeGestionar: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

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
            <TableHeaderCell>Proveedor</TableHeaderCell>
            <TableHeaderCell>Rubros</TableHeaderCell>
            <TableHeaderCell>Zona</TableHeaderCell>
            <TableHeaderCell>Contacto</TableHeaderCell>
            <TableHeaderCell>WhatsApp</TableHeaderCell>
            {puedeGestionar ? <TableHeaderCell>Acciones</TableHeaderCell> : null}
          </TableRow>
        </TableHead>
        <TableBody>
          {proveedores.map((proveedor) => (
            <FilaProveedor
              key={proveedor.id}
              proveedor={proveedor}
              puedeGestionar={puedeGestionar}
              onError={setError}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FilaProveedor({
  proveedor,
  puedeGestionar,
  onError,
}: {
  proveedor: ProveedorVista;
  puedeGestionar: boolean;
  onError: (mensaje: string | null) => void;
}) {
  const [dialogo, setDialogo] = useState<'editar' | 'opt-in' | 'opt-out' | null>(null);
  const [corriendo, iniciar] = useTransition();

  function ejecutar(
    accion: () => Promise<{ ok: boolean; error?: string; errores?: Record<string, string> }>,
  ): void {
    onError(null);
    iniciar(async () => {
      try {
        const resultado = await accion();
        if (!resultado.ok) {
          // Los errores por campo del formulario de edición viven en un diálogo
          // chico: se muestra el primero arriba de la tabla, que es donde el
          // usuario ya está mirando cuando el diálogo se queda abierto.
          const porCampo = Object.values(resultado.errores ?? {})[0];
          onError(resultado.error ?? porCampo ?? 'No pude completar la acción.');
          return;
        }
        setDialogo(null);
      } catch (fallo) {
        onError(mensajeDe(fallo));
      }
    });
  }

  return (
    <TableRow>
      <TableCell>
        <span className="font-medium text-neutral-900">{proveedor.nombre}</span>
        {proveedor.contacto ? (
          <span className="block text-xs text-neutral-500">{proveedor.contacto}</span>
        ) : null}
      </TableCell>

      <TableCell>
        <div className="flex flex-wrap gap-1">
          {proveedor.rubros.map((rubro) => (
            <Badge key={rubro} tone="info">
              {ETIQUETA_RUBRO[rubro]}
            </Badge>
          ))}
        </div>
      </TableCell>

      <TableCell>{proveedor.zona}</TableCell>

      <TableCell>
        <Canales proveedor={proveedor} />
      </TableCell>

      <TableCell>
        {proveedor.optOut ? (
          <Badge tone="error" title="Pidió no ser contactado. Es permanente.">
            No contactar
          </Badge>
        ) : proveedor.optInWa ? (
          <Badge
            tone="ok"
            title={
              proveedor.optInRegistradoEn
                ? `Consentimiento registrado el ${proveedor.optInRegistradoEn}`
                : undefined
            }
          >
            Opt-in WA
          </Badge>
        ) : (
          <Badge tone="neutral">Sin opt-in</Badge>
        )}
      </TableCell>

      {!puedeGestionar ? null : (
        <TableCell>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDialogo('editar')}>
              Editar
            </Button>
            {/* Un proveedor con opt-out no ofrece ninguna acción de contacto: la
                única salida de ese estado es que él vuelva a pedir entrar, y eso
                se carga como un alta nueva. */}
            {!proveedor.optOut && !proveedor.optInWa ? (
              <Button variant="ghost" size="sm" onClick={() => setDialogo('opt-in')}>
                Marcar opt-in WA
              </Button>
            ) : null}
            {!proveedor.optOut ? (
              <Button variant="ghost" size="sm" onClick={() => setDialogo('opt-out')}>
                No contactar
              </Button>
            ) : null}
          </div>

          {/* Los tres diálogos van ADENTRO de la celda y no sueltos en el `<tr>`:
              un `<tr>` solo admite `<td>`/`<th>`, y el navegador sacaría de ahí a
              un `<dialog>` suelto. Que estén en una celda no los encierra —
              `showModal()` los sube igual a la capa superior. */}
          {/* Montado solo mientras está abierto: sus campos arrancan del proveedor
              que se está viendo, y así después de guardar no reabre con los valores
              viejos que quedaron en el `useState`. */}
          {dialogo === 'editar' ? (
            <DialogoEdicion
              proveedor={proveedor}
              corriendo={corriendo}
              onCerrar={() => setDialogo(null)}
              onGuardar={(cambios) => ejecutar(() => editarProveedorAction(cambios))}
            />
          ) : null}

          <Dialog
            open={dialogo === 'opt-in'}
            onClose={() => setDialogo(null)}
            title="Registrar el opt-in de WhatsApp"
            footer={
              <>
                <Button variant="secondary" disabled={corriendo} onClick={() => setDialogo(null)}>
                  Cancelar
                </Button>
                <Button
                  disabled={corriendo}
                  onClick={() => ejecutar(() => marcarOptInAction({ proveedorId: proveedor.id }))}
                >
                  {corriendo ? 'Registrando…' : 'Sí, lo aceptó'}
                </Button>
              </>
            }
          >
            <p>
              {TEXTO_COMPLIANCE_OPT_IN}: <strong>{proveedor.nombre}</strong>.
            </p>
            <p className="mt-2 text-neutral-600">
              Queda registrado con la fecha de hoy y con tu usuario. Nunca escribas en frío por
              WhatsApp: sin este consentimiento, el contacto va por los canales de siempre (teléfono o
              mail).
            </p>
          </Dialog>

          <Dialog
            open={dialogo === 'opt-out'}
            onClose={() => setDialogo(null)}
            title="Marcar «no contactar»"
            footer={
              <>
                <Button variant="secondary" disabled={corriendo} onClick={() => setDialogo(null)}>
                  Cancelar
                </Button>
                <Button
                  variant="danger"
                  disabled={corriendo}
                  onClick={() => ejecutar(() => marcarOptOutAction({ proveedorId: proveedor.id }))}
                >
                  {corriendo ? 'Guardando…' : 'Marcar no contactar'}
                </Button>
              </>
            }
          >
            <p>
              <strong>{proveedor.nombre}</strong> deja de recibir cualquier mensaje del estudio y no va
              a aparecer en ninguna shortlist de compulsa.
            </p>
            <p className="mt-2">
              Es <span className="font-medium">permanente</span>: desde acá no se puede deshacer. Si más
              adelante el proveedor pide volver, se lo carga de nuevo como alta.
            </p>
          </Dialog>
        </TableCell>
      )}
    </TableRow>
  );
}

function Canales({ proveedor }: { proveedor: ProveedorVista }) {
  const canales = [
    proveedor.telefono ? { clave: 'tel', etiqueta: proveedor.telefono } : null,
    proveedor.whatsapp ? { clave: 'wa', etiqueta: `WA ${proveedor.whatsapp}` } : null,
    proveedor.email ? { clave: 'mail', etiqueta: proveedor.email } : null,
  ].filter((canal): canal is { clave: string; etiqueta: string } => canal !== null);

  if (canales.length === 0) {
    return <span className="text-xs text-neutral-500">Sin datos de contacto</span>;
  }

  return (
    <div className="flex flex-col gap-0.5 text-xs text-neutral-700">
      {canales.map((canal) => (
        <span key={canal.clave}>{canal.etiqueta}</span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edición
// ---------------------------------------------------------------------------

interface CambiosProveedorUi {
  proveedorId: string;
  nombre: string;
  rubros: string[];
  zona: string;
  telefono: string;
  email: string;
}

function DialogoEdicion({
  proveedor,
  corriendo,
  onCerrar,
  onGuardar,
}: {
  proveedor: ProveedorVista;
  corriendo: boolean;
  onCerrar: () => void;
  onGuardar: (cambios: CambiosProveedorUi) => void;
}) {
  const [nombre, setNombre] = useState(proveedor.nombre);
  const [zona, setZona] = useState(proveedor.zona);
  const [telefono, setTelefono] = useState(proveedor.telefono ?? '');
  const [email, setEmail] = useState(proveedor.email ?? '');
  const [rubros, setRubros] = useState<string[]>(proveedor.rubros);

  return (
    <Dialog
      open
      onClose={onCerrar}
      title={`Editar ${proveedor.nombre}`}
      footer={
        <>
          <Button variant="secondary" disabled={corriendo} onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            disabled={corriendo}
            onClick={() =>
              onGuardar({ proveedorId: proveedor.id, nombre, rubros, zona, telefono, email })
            }
          >
            {corriendo ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Nombre"
          value={nombre}
          disabled={corriendo}
          onChange={(evento) => setNombre(evento.target.value)}
        />
        <SelectorRubros valor={rubros} onCambio={setRubros} deshabilitado={corriendo} />
        <Input
          label="Zona"
          value={zona}
          disabled={corriendo}
          onChange={(evento) => setZona(evento.target.value)}
        />
        <Input
          label="Teléfono"
          value={telefono}
          disabled={corriendo}
          onChange={(evento) => setTelefono(evento.target.value)}
        />
        <Input
          label="Mail"
          value={email}
          disabled={corriendo}
          onChange={(evento) => setEmail(evento.target.value)}
        />
        <p className="text-xs text-neutral-500">
          Vaciar un campo de contacto lo borra de la agenda.
        </p>
      </div>
    </Dialog>
  );
}

/**
 * Los rubros, como checkboxes controlados. Se comparte con el alta a través de
 * `SelectorRubrosForm`, que es la misma grilla pero sin estado: en un formulario
 * con `useActionState` los checkboxes viajan solos en el `FormData`.
 */
export function SelectorRubros({
  valor,
  onCambio,
  deshabilitado,
}: {
  valor: string[];
  onCambio: (rubros: string[]) => void;
  deshabilitado?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium text-neutral-700">Rubros</legend>
      <div className="flex flex-wrap gap-3">
        {RUBROS.map((rubro) => (
          <label key={rubro} className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              className="size-4 rounded border-neutral-300"
              checked={valor.includes(rubro)}
              disabled={deshabilitado}
              onChange={(evento) =>
                onCambio(
                  evento.target.checked
                    ? [...valor, rubro]
                    : valor.filter((elegido) => elegido !== rubro),
                )
              }
            />
            {ETIQUETA_RUBRO[rubro]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** La misma grilla, sin estado: para formularios que se mandan con `FormData`. */
export function SelectorRubrosForm({
  seleccionados,
  error,
}: {
  seleccionados: string[];
  error?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium text-neutral-700">Rubros</legend>
      <div className="flex flex-wrap gap-3">
        {RUBROS.map((rubro) => (
          <label key={rubro} className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              name="rubros"
              value={rubro}
              defaultChecked={seleccionados.includes(rubro)}
              className="size-4 rounded border-neutral-300"
            />
            {ETIQUETA_RUBRO[rubro]}
          </label>
        ))}
      </div>
      {error ? <span className="mt-1 block text-sm text-red-700">{error}</span> : null}
    </fieldset>
  );
}

/** Link de vuelta al listado, con el mismo estilo en las tres pantallas. */
function VolverAProveedores() {
  return (
    <Link href="/proveedores" className="px-3 text-sm text-neutral-600 hover:text-neutral-900">
      Cancelar
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Alta (/proveedores/nuevo)
// ---------------------------------------------------------------------------

const ESTADO_NUEVO: EstadoNuevoProveedor = {};

/**
 * Formulario de alta. El `page.tsx` que lo monta es un Server Component (así
 * puede exportar su `metadata`) y este es el único pedazo cliente.
 */
export function FormularioNuevoProveedor() {
  const [estado, action, pendiente] = useActionState(crearProveedorAction, ESTADO_NUEVO);

  return (
    <form action={action} className="flex flex-col gap-4">
      {estado.mensaje ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {estado.mensaje}
        </p>
      ) : null}

      <Input
        label="Nombre"
        name="nombre"
        placeholder="Corralón del Norte"
        defaultValue={estado.valores?.nombre}
        error={estado.errores?.nombre}
      />
      <SelectorRubrosForm
        seleccionados={estado.valores?.rubros ?? []}
        error={estado.errores?.rubros}
      />
      <Input
        label="Zona"
        name="zona"
        placeholder="San Isidro"
        defaultValue={estado.valores?.zona}
        error={estado.errores?.zona}
      />
      <Input
        label="Teléfono"
        name="telefono"
        placeholder="11-4444-5555"
        defaultValue={estado.valores?.telefono}
        error={estado.errores?.telefono}
      />
      <Input
        label="Mail"
        name="email"
        placeholder="ventas@corralon.ar"
        defaultValue={estado.valores?.email}
        error={estado.errores?.email}
      />

      <p className="text-xs text-neutral-500">
        El consentimiento de WhatsApp no se carga acá: se registra desde el listado, cuando el
        proveedor lo haya aceptado.
      </p>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pendiente}>
          {pendiente ? 'Guardando…' : 'Agregar proveedor'}
        </Button>
        <VolverAProveedores />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Import (/proveedores/importar)
// ---------------------------------------------------------------------------

const EJEMPLO_CSV = [
  'nombre,rubros,zona,telefono,email',
  'Corralón del Norte,gruesa|seco,San Isidro,11-4444-5555,ventas@corralon.ar',
  'Aberturas Sur,aberturas,Quilmes,,info@sur.ar',
].join('\n');

/**
 * Pegar → previsualizar → confirmar.
 *
 * El preview lo calcula **el cliente** con `importarCsv`, que es una función
 * pura: se ve en el momento, sin ida y vuelta al server. Al confirmar viaja el
 * texto crudo y el server lo vuelve a parsear —nunca las filas que armó el
 * cliente— porque el server no confía en el payload (`src/app/CLAUDE.md` §7).
 */
export function ImportadorCsv() {
  const [texto, setTexto] = useState('');
  const [resumen, setResumen] = useState<ResumenImportAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [corriendo, iniciar] = useTransition();

  const preview = texto.trim() === '' ? null : importarCsv(texto);
  const filas = preview?.filas ?? [];
  const errores = preview?.errores ?? [];

  function confirmar(): void {
    setError(null);
    iniciar(async () => {
      try {
        const resultado = await importarProveedoresAction({ texto });
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
          <p className="mt-2">
            <Link href="/proveedores" className="font-medium underline">
              Ver la agenda
            </Link>
          </p>
        </div>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700">
          Pegá el CSV (columnas: nombre, rubros, zona, teléfono, email)
        </span>
        <textarea
          value={texto}
          onChange={(evento) => setTexto(evento.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={EJEMPLO_CSV}
          className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-neutral-900"
        />
      </label>

      <p className="text-xs text-neutral-500">
        Separador coma o punto y coma (lo detectamos solos), varios rubros separados con{' '}
        <code className="rounded bg-neutral-100 px-1">|</code>. Un proveedor que ya esté en la
        agenda no se duplica: se le suman los rubros y los datos de contacto que falten.
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
                  <TableHeaderCell>Proveedor</TableHeaderCell>
                  <TableHeaderCell>Rubros</TableHeaderCell>
                  <TableHeaderCell>Zona</TableHeaderCell>
                  <TableHeaderCell>Teléfono</TableHeaderCell>
                  <TableHeaderCell>Mail</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filas.map((fila, indice) => (
                  <TableRow key={`${fila.nombre}-${indice}`}>
                    <TableCell>{fila.nombre}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {fila.rubros.map((rubro) => (
                          <Badge key={rubro} tone="info">
                            {ETIQUETA_RUBRO[rubro]}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{fila.zona}</TableCell>
                    <TableCell>{fila.telefono ?? '—'}</TableCell>
                    <TableCell>{fila.email ?? '—'}</TableCell>
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
            : `Importar ${filas.length} ${filas.length === 1 ? 'proveedor' : 'proveedores'}`}
        </Button>
        <VolverAProveedores />
      </div>
    </div>
  );
}
