'use client';

/**
 * "Preguntale al expediente": el panel de Q&A del expediente (RF-106).
 *
 * Colapsado por defecto — la pantalla es el expediente, esto es una herramienta
 * al costado — y con una regla de producto que el componente hace visible: **la
 * respuesta se muestra con sus láminas al lado**. Los chips no son decoración,
 * son el link al visor: una respuesta que no se puede ir a verificar en un plano
 * no vale nada, y cuando el sistema no encuentra el dato lo dice ("No encontré
 * eso en el expediente") en vez de arriesgar.
 *
 * Cliente porque hay interactividad real (`src/app/CLAUDE.md` §2): un input, un
 * estado de "consultando" y una respuesta que aparece sin recargar la página.
 */
import Link from 'next/link';
import { useId, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { preguntarAlExpedienteAction, type CitaVista } from './qa-actions';

interface Respondida {
  pregunta: string;
  respuesta: string;
  citas: CitaVista[];
}

export interface PanelQaProps {
  obraId: string;
  /** Cuántas láminas tienen texto leído: sin ninguna, no hay nada que preguntar. */
  laminasConTexto: number;
}

export function PanelQa({ obraId, laminasConTexto }: PanelQaProps) {
  const [abierto, setAbierto] = useState(false);
  const [pregunta, setPregunta] = useState('');
  const [respondida, setRespondida] = useState<Respondida | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();
  const idPanel = useId();

  function preguntar(): void {
    const texto = pregunta.trim();
    if (texto === '' || pendiente) return;
    setError(null);

    iniciar(async () => {
      const resultado = await preguntarAlExpedienteAction({ obraId, pregunta: texto });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      setRespondida({ pregunta: texto, respuesta: resultado.respuesta, citas: resultado.citas });
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-neutral-900">Preguntale al expediente</h3>
          <p className="text-sm text-neutral-600">
            Contesta con lo que dicen las láminas y te muestra en cuáles lo dice. Si no está, te
            avisa que no está.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={abierto}
          aria-controls={idPanel}
          onClick={() => setAbierto((previo) => !previo)}
        >
          {abierto ? 'Cerrar' : 'Preguntar'}
        </Button>
      </CardHeader>

      {abierto ? (
        <CardContent id={idPanel} className="flex flex-col gap-3">
          {laminasConTexto === 0 ? (
            <p className="text-sm text-neutral-600">
              Todavía no hay texto leído en ninguna lámina. Subí la documentación y esperá a que el
              análisis termine.
            </p>
          ) : null}

          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(evento) => {
              evento.preventDefault();
              preguntar();
            }}
          >
            <div className="min-w-64 flex-1">
              <Input
                label="Tu pregunta"
                value={pregunta}
                maxLength={500}
                placeholder="¿Qué vidrio llevan las ventanas?"
                onChange={(evento) => setPregunta(evento.target.value)}
              />
            </div>
            <Button type="submit" disabled={pendiente || pregunta.trim() === ''}>
              {pendiente ? 'Consultando…' : 'Preguntar'}
            </Button>
          </form>

          {error ? <p className="text-sm text-red-700">{error}</p> : null}

          {respondida ? (
            <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
              <p className="text-xs text-neutral-500">{respondida.pregunta}</p>
              <p className="text-sm text-neutral-900">{respondida.respuesta}</p>

              {respondida.citas.length > 0 ? (
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-neutral-500">Lo dice:</span>
                  {respondida.citas.map((cita) => (
                    <Link
                      key={cita.laminaId}
                      href={`/obras/${obraId}/laminas/${cita.laminaId}`}
                      className="inline-flex items-center rounded-full border border-neutral-300 bg-white px-3 py-1 font-medium text-neutral-900 hover:bg-neutral-100"
                    >
                      {cita.etiqueta}
                    </Link>
                  ))}
                </p>
              ) : (
                <p className="text-xs text-neutral-500">
                  Sin láminas que lo respalden: preferimos decírtelo antes que arriesgar un número.
                </p>
              )}
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
