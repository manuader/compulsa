/**
 * Resumen ejecutivo de la obra (RF-205), arriba del expediente.
 *
 * Server Component y puramente presentacional: los números los calcula
 * `src/lib/pipeline/resumen.ts` y quedan guardados en `obras.resumen_json`, así
 * que acá no hay ni una cuenta. Lo único que aporta la pantalla es el orden de
 * lectura, que es el de las preguntas que uno se hace al volver a una obra:
 * **qué es**, **qué alcanza a computar**, **qué le falta al legajo** y **qué está
 * preguntando el sistema**.
 *
 * Lo que no tiene es tan importante como lo que tiene: no hay barras de
 * progreso ni "85 % completo". Un legajo no se completa por porcentaje; le falta
 * la estructura, o le falta la escala de una lámina, y eso se dice con nombre y
 * apellido.
 */
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { SIN_CLASIFICAR, type ResumenObra } from '@/lib/pipeline/resumen';
import type { Disciplina, TipoLamina } from '@/types/domain';

const ETIQUETA_DISCIPLINA: Record<Disciplina | typeof SIN_CLASIFICAR, string> = {
  arquitectura: 'Arquitectura',
  estructura: 'Estructura',
  instalaciones: 'Instalaciones',
  otra: 'Otra',
  [SIN_CLASIFICAR]: 'Sin clasificar',
};

const ETIQUETA_TIPO: Record<TipoLamina | typeof SIN_CLASIFICAR, string> = {
  planta: 'Planta',
  corte: 'Corte',
  vista: 'Vista',
  detalle: 'Detalle',
  planilla: 'Planilla',
  otra: 'Otra',
  [SIN_CLASIFICAR]: 'Sin clasificar',
};

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{titulo}</h4>
      {children}
    </div>
  );
}

export interface ResumenEjecutivoProps {
  obraId: string;
  resumen: ResumenObra | null;
}

export function ResumenEjecutivo({ obraId, resumen }: ResumenEjecutivoProps) {
  if (resumen === null) {
    return (
      <Card>
        <CardContent className="text-sm text-neutral-600">
          El resumen de la obra se arma solo cuando termina de analizarse el primer documento.
        </CardContent>
      </Card>
    );
  }

  const { laminas, alcance, documentacion, consultas } = resumen;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-neutral-900">Resumen de la obra</h3>
        <p className="text-sm text-neutral-700">{resumen.titular}</p>
      </CardHeader>

      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Bloque titulo={`Láminas (${laminas.total})`}>
          <p className="flex flex-wrap gap-2">
            {laminas.porDisciplina.map((entrada) => (
              <Badge key={entrada.disciplina} tone="neutral">
                {ETIQUETA_DISCIPLINA[entrada.disciplina]} · {entrada.cantidad}
              </Badge>
            ))}
          </p>
          <p className="flex flex-wrap gap-2">
            {laminas.porTipo.map((entrada) => (
              <Badge key={entrada.tipo} tone="neutral">
                {ETIQUETA_TIPO[entrada.tipo]} · {entrada.cantidad}
              </Badge>
            ))}
          </p>
          {laminas.bloqueadas > 0 || laminas.conError > 0 ? (
            <p className="text-sm text-neutral-600">
              {laminas.bloqueadas > 0 ? `${laminas.bloqueadas} sin escala. ` : null}
              {laminas.conError > 0 ? `${laminas.conError} con error de análisis.` : null}
            </p>
          ) : null}
        </Bloque>

        <Bloque titulo="Alcance">
          {alcance.length === 0 ? (
            <p className="text-sm text-neutral-600">
              Todavía no hay nada computado: falta documentación o falta la escala.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-neutral-700">
              {alcance.map((rubro) => (
                <li key={rubro.rubro}>
                  <Link
                    href={`/obras/${obraId}/computo?rubro=${rubro.rubro}`}
                    className="font-medium text-neutral-900 underline"
                  >
                    {rubro.nombre}
                  </Link>{' '}
                  — {rubro.items} {rubro.items === 1 ? 'ítem' : 'ítems'}
                  {rubro.ejemplos.length > 0 ? (
                    <span className="text-neutral-500"> ({rubro.ejemplos.join('; ')})</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Bloque>

        <Bloque titulo="Documentación">
          <p className="text-sm text-neutral-700">
            Presente:{' '}
            {documentacion.disciplinasPresentes.length === 0
              ? 'nada clasificado todavía'
              : documentacion.disciplinasPresentes
                  .map((disciplina) => ETIQUETA_DISCIPLINA[disciplina].toLowerCase())
                  .join(', ')}
            .
          </p>
          {documentacion.disciplinasAusentes.length > 0 ? (
            <p className="text-sm text-neutral-700">
              Sin ninguna lámina:{' '}
              {documentacion.disciplinasAusentes
                .map((disciplina) => ETIQUETA_DISCIPLINA[disciplina].toLowerCase())
                .join(', ')}
              .
            </p>
          ) : null}
          {documentacion.trabadas.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-neutral-700">
              {documentacion.trabadas.map((lamina) => (
                <li key={lamina.laminaId}>
                  <Link
                    href={`/obras/${obraId}/laminas/${lamina.laminaId}`}
                    className="font-medium text-neutral-900 underline"
                  >
                    {lamina.codigo ?? lamina.titulo ?? 'Lámina sin rótulo'}
                  </Link>{' '}
                  <span className="text-neutral-600">{lamina.motivo}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Bloque>

        <Bloque titulo="Consultas abiertas">
          {consultas.abiertas === 0 ? (
            <p className="text-sm text-neutral-600">Ninguna. El expediente cierra por ahora.</p>
          ) : (
            <>
              <p className="text-sm text-neutral-700">
                <Link href={`/obras/${obraId}/bandeja`} className="font-medium underline">
                  {consultas.abiertas} {consultas.abiertas === 1 ? 'consulta' : 'consultas'}
                </Link>
                {consultas.bloqueantes > 0 ? `, ${consultas.bloqueantes} bloqueantes.` : '.'}
              </p>
              <ul className="flex flex-col gap-1 text-sm text-neutral-700">
                {consultas.destacadas.map((consulta) => (
                  <li key={consulta.clave} className="flex items-start gap-2">
                    {consulta.bloqueante ? <Badge tone="error">Bloquea</Badge> : null}
                    <span>{consulta.descripcion}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Bloque>
      </CardContent>
    </Card>
  );
}
