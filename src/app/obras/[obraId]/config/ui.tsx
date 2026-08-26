'use client';

/**
 * Configuración de la obra.
 *
 * Dos mitades con temperaturas distintas:
 *
 *  - **Datos de la obra:** los mismos cuatro campos del alta, con los mismos
 *    componentes y la misma validación (`@/lib/obras/schema`). Guardar sin haber
 *    cambiado nada no escribe ni audita.
 *  - **Zona de riesgo:** archivar, desarchivar y eliminar. Cada una explica qué
 *    hace *antes* de hacerla (`src/app/CLAUDE.md` §6: las acciones destructivas
 *    piden confirmación), y la eliminación —la única irreversible del producto—
 *    exige escribir el nombre exacto de la obra, que es lo que convierte un clic
 *    distraído en un acto deliberado.
 */
import Link from 'next/link';
import { useActionState, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { EstadoObra } from '@/db/schema';
import type { TipoObra } from '@/types/domain';

import {
  archivarObraAction,
  desarchivarObraAction,
  editarObraAction,
  eliminarObraAction,
  type EstadoEdicionObra,
} from '../../actions';

export interface ObraConfig {
  id: string;
  nombre: string;
  zona: string;
  tipo: TipoObra;
  moneda: string;
  estado: EstadoObra;
}

const ESTADO_INICIAL: EstadoEdicionObra = {};

export function ConfiguracionObra({ obra }: { obra: ObraConfig }) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <DatosDeLaObra obra={obra} />
      <ZonaDeRiesgo obra={obra} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

function DatosDeLaObra({ obra }: { obra: ObraConfig }) {
  const [estado, action, pendiente] = useActionState(editarObraAction, ESTADO_INICIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Datos de la obra</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-neutral-600">
          Cambiar estos datos no toca el cómputo: el nombre y la zona son para reconocer la obra, y
          la moneda es la que se muestra en la planilla y en el XLSX.
        </p>

        <form action={action} className="flex flex-col gap-4">
          {/* La obra viaja acá, pero el server no le cree: la que vale es la que
              devuelve `requireObra()` (RNF-4). */}
          <input type="hidden" name="obraId" value={obra.id} />

          {estado.guardado ? (
            <p
              role="status"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            >
              {estado.guardado}
            </p>
          ) : null}

          <Input
            label="Nombre de la obra"
            name="nombre"
            defaultValue={estado.valores?.nombre ?? obra.nombre}
            error={estado.errores?.nombre}
          />
          <Input
            label="Zona"
            name="zona"
            defaultValue={estado.valores?.zona ?? obra.zona}
            error={estado.errores?.zona}
          />
          <Select
            label="Tipo de obra"
            name="tipo"
            defaultValue={estado.valores?.tipo ?? obra.tipo}
            error={estado.errores?.tipo}
          >
            <option value="nueva">Obra nueva</option>
            <option value="reforma">Reforma</option>
            <option value="ampliacion">Ampliación</option>
          </Select>
          <Select
            label="Moneda"
            name="moneda"
            defaultValue={estado.valores?.moneda ?? obra.moneda}
            error={estado.errores?.moneda}
          >
            <option value="ARS">Pesos (ARS)</option>
            <option value="USD">Dólares (USD)</option>
          </Select>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pendiente}>
              {pendiente ? 'Guardando…' : 'Guardar cambios'}
            </Button>
            <Link
              href={`/obras/${obra.id}`}
              className="px-3 text-sm text-neutral-600 hover:text-neutral-900"
            >
              Volver al tablero
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Zona de riesgo
// ---------------------------------------------------------------------------

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : 'Algo salió mal.';
}

function ZonaDeRiesgo({ obra }: { obra: ObraConfig }) {
  const [corriendo, iniciar] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<'archivar' | 'eliminar' | null>(null);
  const [confirmacion, setConfirmacion] = useState('');

  const archivada = obra.estado === 'archivada';
  const puedeEliminar = confirmacion.trim() === obra.nombre;

  /**
   * Archivar y eliminar terminan en un `redirect()` del server: la promesa de la
   * action no vuelve con un `ok` sino con la navegación. Solo se muestra error
   * cuando la action **sí** devolvió algo y devolvió un `ok: false`.
   */
  function ejecutar(accion: () => Promise<{ ok: boolean; error?: string } | void>): void {
    setError(null);
    iniciar(async () => {
      try {
        const resultado = await accion();
        if (resultado && !resultado.ok) {
          setError(resultado.error ?? 'No pude completar la acción.');
          return;
        }
        setDialogo(null);
      } catch (fallo) {
        setError(mensajeDe(fallo));
      }
    });
  }

  return (
    <Card id="zona-de-riesgo" className="scroll-mt-6 border-red-300">
      <CardHeader className="border-red-200">
        <CardTitle className="text-red-800">Zona de riesgo</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {error}
          </p>
        ) : null}

        {archivada ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-md">
                <p className="text-sm font-medium text-neutral-900">Desarchivar la obra</p>
                <p className="text-sm text-neutral-600">
                  Vuelve al listado de obras activas tal como estaba: no se perdió nada al
                  archivarla.
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={corriendo}
                onClick={() => ejecutar(() => desarchivarObraAction({ obraId: obra.id }))}
              >
                {corriendo ? 'Trabajando…' : 'Desarchivar'}
              </Button>
            </div>

            <hr className="border-neutral-200" />

            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-md">
                <p className="text-sm font-medium text-neutral-900">Eliminar definitivamente</p>
                <p className="text-sm text-neutral-600">
                  Borra la obra y todo lo que tiene adentro. No se puede deshacer.
                </p>
              </div>
              <Button variant="danger" disabled={corriendo} onClick={() => setDialogo('eliminar')}>
                Eliminar definitivamente
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-md">
              <p className="text-sm font-medium text-neutral-900">Archivar la obra</p>
              <p className="text-sm text-neutral-600">
                Sale del listado de obras y deja de estorbar, sin perder nada. La podés desarchivar
                cuando quieras.
              </p>
            </div>
            <Button variant="secondary" disabled={corriendo} onClick={() => setDialogo('archivar')}>
              Archivar obra
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog
        open={dialogo === 'archivar'}
        onClose={() => setDialogo(null)}
        title="Archivar la obra"
        footer={
          <>
            <Button variant="secondary" disabled={corriendo} onClick={() => setDialogo(null)}>
              Cancelar
            </Button>
            <Button
              disabled={corriendo}
              onClick={() => ejecutar(() => archivarObraAction({ obraId: obra.id }))}
            >
              {corriendo ? 'Archivando…' : 'Archivar obra'}
            </Button>
          </>
        }
      >
        <p>
          «{obra.nombre}» va a desaparecer del listado de obras. No se borra nada: los documentos,
          el cómputo y las consultas quedan como están, y la obra se sigue pudiendo abrir desde{' '}
          <span className="font-medium">Ver archivadas</span>.
        </p>
        <p className="mt-2">Se puede desarchivar en cualquier momento.</p>
      </Dialog>

      <Dialog
        open={dialogo === 'eliminar'}
        onClose={() => {
          setDialogo(null);
          setConfirmacion('');
        }}
        title="Eliminar la obra definitivamente"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={corriendo}
              onClick={() => {
                setDialogo(null);
                setConfirmacion('');
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="danger"
              disabled={corriendo || !puedeEliminar}
              onClick={() =>
                ejecutar(() => eliminarObraAction({ obraId: obra.id, confirmacion }))
              }
            >
              {corriendo ? 'Eliminando…' : 'Eliminar para siempre'}
            </Button>
          </>
        }
      >
        <p>
          Se borran <span className="font-medium">para siempre</span> los documentos y sus archivos,
          las láminas, el cómputo entero, las consultas de la bandeja y hasta el registro de
          auditoría de la obra. Esto no se puede deshacer y no hay copia.
        </p>
        <p className="mt-3">
          Para confirmar, escribí el nombre exacto de la obra: <strong>{obra.nombre}</strong>
        </p>
        <div className="mt-2">
          <Input
            aria-label="Nombre de la obra para confirmar"
            placeholder={obra.nombre}
            value={confirmacion}
            disabled={corriendo}
            onChange={(evento) => setConfirmacion(evento.target.value)}
          />
        </div>
      </Dialog>
    </Card>
  );
}
