'use client';

/**
 * Confirmación de escala desde el visor.
 *
 * Cuando el rótulo declara una escala pero no se pudo verificar contra las
 * cotas, la lámina se computa igual y el badge dice "Escala 1:20 (a confirmar)".
 * Hasta acá eso era un cartel sin salida: el único formulario de escala vivía en
 * el expediente, así que el arquitecto tenía que irse de la lámina que estaba
 * mirando —justo la pantalla donde puede leer el rótulo y decidir— para
 * confirmar lo que acababa de ver.
 *
 * El input arranca **prellenado con la escala declarada**: en el 99% de los
 * casos el arquitecto mira el rótulo, ve que dice lo mismo y confirma con un
 * click. Se puede corregir, y ahí `actualizarLamina()` decide si re-analiza.
 *
 * Es el mismo PATCH que usa el expediente (`/api/laminas/[laminaId]`), no una
 * segunda vía: la lógica —auditoría incluida— vive en el pipeline.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export interface FormConfirmarEscalaProps {
  laminaId: string;
  /** La que declaró el rótulo: es el valor inicial del input. */
  escalaDeclarada: string;
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : 'Algo salió mal.';
}

export function FormConfirmarEscala({ laminaId, escalaDeclarada }: FormConfirmarEscalaProps) {
  const router = useRouter();
  const [escala, setEscala] = useState(escalaDeclarada);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cambiada = escala.trim() !== escalaDeclarada;

  async function confirmar(): Promise<void> {
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await fetch(`/api/laminas/${laminaId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ escala: escala.trim(), escalaConfiable: true }),
      });
      if (!respuesta.ok) {
        const cuerpo = (await respuesta.json().catch(() => null)) as { error?: string } | null;
        throw new Error(cuerpo?.error ?? 'No pude confirmar la escala. Probá de nuevo.');
      }
      router.refresh();
    } catch (fallo) {
      setError(mensajeDe(fallo));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm text-amber-900">
          El rótulo dice <strong className="font-medium">{escalaDeclarada}</strong>, pero no la pude
          verificar contra las cotas. Estoy computando con esa escala: confirmala si es la del plano,
          o corregila y la vuelvo a analizar.
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(evento) => {
            evento.preventDefault();
            if (escala.trim() === '') return;
            void confirmar();
          }}
        >
          <Input
            name="escala"
            aria-label="Escala de la lámina"
            placeholder="Escala (ej. 1:100)"
            value={escala}
            disabled={ocupado}
            onChange={(evento) => setEscala(evento.target.value)}
            className="w-40"
          />
          <Button type="submit" size="sm" disabled={ocupado || escala.trim() === ''}>
            {cambiada ? 'Corregir y volver a analizar' : `Confirmar escala ${escalaDeclarada}`}
          </Button>
        </form>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
