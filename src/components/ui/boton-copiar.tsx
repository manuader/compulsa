'use client';

import { useState } from 'react';

import { Button } from './button';

/**
 * Copiar un texto al portapapeles.
 *
 * El canal de outreach es manual: el sistema escribe el mensaje —el pedido, la
 * repregunta, la contraoferta, la orden de compra— y la persona lo manda por
 * donde ya habla con el proveedor. Copiar no es un accesorio de estas pantallas,
 * es **la** acción, así que el botón tiene que decir siempre qué pasó.
 *
 * `navigator.clipboard.writeText` rechaza cuando el navegador no da el permiso
 * (documento sin foco, contexto no seguro, política del sistema). Si esa promesa
 * no se agarra, el usuario ve un botón que no hace nada y la consola se llena de
 * `NotAllowedError`. Por eso el `catch` y el texto de al lado: no se puede
 * copiar por vos, pero sí decirte que lo selecciones a mano.
 *
 * Vive en `src/components/ui` y no en la carpeta de una pantalla porque lo usan
 * tres (compulsas, conversaciones y comparativa) y ya hubo dos copias del mismo
 * botón con comportamientos distintos ante el mismo error.
 */
export function BotonCopiar({
  texto,
  etiqueta = 'Copiar',
  size = 'sm',
}: {
  texto: string;
  etiqueta?: string;
  size?: 'sm' | 'md';
}) {
  const [estado, setEstado] = useState<'listo' | 'copiado' | 'error'>('listo');

  async function copiar(): Promise<void> {
    try {
      await navigator.clipboard.writeText(texto);
      setEstado('copiado');
      setTimeout(() => setEstado('listo'), 2000);
    } catch {
      setEstado('error');
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size={size} variant="secondary" onClick={() => void copiar()}>
        {estado === 'copiado' ? '✓ Copiado' : etiqueta}
      </Button>
      {estado === 'error' ? (
        <span className="text-xs text-red-700">
          El navegador no dejó copiar: seleccioná el texto y copialo a mano.
        </span>
      ) : null}
    </span>
  );
}
