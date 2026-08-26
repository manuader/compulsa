'use client';

/**
 * Las piezas interactivas del hilo con un proveedor (PRD §8.7).
 *
 * Dos: el formulario para registrar lo que contestó —el canal es manual, así que
 * alguien lo transcribe— y los botones de estado. El resto de la pantalla es
 * Server Component.
 *
 * El botón de copiar y los tipos del hilo se reusan de la pantalla de compulsas:
 * son la misma cosa mostrada en otro lado, y dos copias del mismo componente se
 * desincronizan.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  cambiarEstadoContactoAction,
  registrarMensajeEntranteAction,
  type EstadoAMano,
} from '@/app/obras/[obraId]/conversaciones/actions';
import { Button } from '@/components/ui/button';

/**
 * Transcribir lo que contestó el proveedor.
 *
 * El texto se guarda **crudo**: nada se recorta ni se reformatea. Si el
 * proveedor contestó citando el pedido entero, eso es lo que quedó escrito, y es
 * lo que la pantalla muestra (P5, fix round 1).
 */
export function FormularioEntrante({
  obraId,
  contactoId,
  proveedor,
}: {
  obraId: string;
  contactoId: string;
  proveedor: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [cuerpo, setCuerpo] = useState('');
  const [error, setError] = useState<string | null>(null);

  function registrar(): void {
    setError(null);
    iniciar(async () => {
      const resultado = await registrarMensajeEntranteAction({ obraId, contactoId, cuerpo });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      setCuerpo('');
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700">
          Registrar lo que contestó {proveedor}
        </span>
        <textarea
          value={cuerpo}
          onChange={(evento) => setCuerpo(evento.target.value)}
          rows={5}
          placeholder="Pegá el mensaje tal como lo mandó, sin resumirlo."
          className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900"
        />
      </label>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button onClick={registrar} disabled={pendiente || cuerpo.trim() === ''}>
          {pendiente ? 'Guardando…' : 'Registrar el mensaje'}
        </Button>
        <span className="text-xs text-neutral-500">
          Registrarlo no cambia el estado: que haya escrito no es que haya cotizado.
        </span>
      </div>
    </div>
  );
}

const ACCIONES: { estado: EstadoAMano; etiqueta: string }[] = [
  { estado: 'cotizo', etiqueta: 'Marcar que cotizó' },
  { estado: 'sin_respuesta', etiqueta: 'Marcar sin respuesta' },
  { estado: 'cerrado', etiqueta: 'Cerrar el contacto' },
];

/**
 * Los tres estados que pone una persona. Los otros los pone el flujo (mandar el
 * pedido, registrar la cotización, proponer la negociación) y tocarlos a mano
 * dejaría el estado diciendo una cosa y el hilo otra.
 */
export function AccionesEstado({
  obraId,
  contactoId,
  estadoActual,
}: {
  obraId: string;
  contactoId: string;
  estadoActual: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function cambiar(estado: EstadoAMano): void {
    setError(null);
    iniciar(async () => {
      const resultado = await cambiarEstadoContactoAction({ obraId, contactoId, estado });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {ACCIONES.filter((accion) => accion.estado !== estadoActual).map((accion) => (
          <Button
            key={accion.estado}
            size="sm"
            variant="secondary"
            onClick={() => cambiar(accion.estado)}
            disabled={pendiente}
          >
            {accion.etiqueta}
          </Button>
        ))}
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
