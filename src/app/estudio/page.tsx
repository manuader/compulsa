import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { requireUser } from '@/lib/auth/guards';
import { ahorroDelEstudio, type AhorroDelEstudio } from '@/lib/compulsa/adjudicar';
import { formatearMonto } from '@/lib/compulsa/comparativa';
import { listarNotificaciones } from '@/lib/plataforma/notificaciones';
import { esRolSuficiente, ETIQUETA_ROL } from '@/lib/plataforma/roles';

import { abrirNotificacionAction } from './actions';

export const metadata: Metadata = { title: 'Estudio' };

/** Cuántas muestra la lista completa. Más que esto es un log, no una bandeja. */
const MAX_EN_LISTA = 50;

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Panel del estudio: los accesos de plataforma y **todas** las notificaciones
 * del usuario (la campanita del header muestra las últimas diez; acá está el
 * resto).
 *
 * La pantalla es de cualquiera con sesión: son sus propios avisos. Los accesos
 * a usuarios y auditoría se muestran solo si el rol alcanza — el server los
 * rechaza igual, esto es para no ofrecer lo que va a decir que no.
 */
export default async function EstudioPage() {
  const { usuario, estudio } = await requireUser();
  const db = await getDb();
  const [avisos, ahorro] = await Promise.all([
    listarNotificaciones(db, usuario.id, MAX_EN_LISTA),
    ahorroDelEstudio(db, estudio.id),
  ]);
  const esTitular = esRolSuficiente(usuario, 'titular');
  const esColaborador = esRolSuficiente(usuario, 'colaborador');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            {estudio.nombre}
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            Entrás como {usuario.nombre} · {ETIQUETA_ROL[usuario.rol].toLowerCase()}
          </p>
        </div>
      </header>

      <AhorroAcumulado ahorro={ahorro} />

      <nav className="grid gap-4 sm:grid-cols-3" aria-label="Secciones del estudio">
        <AccesoEstudio
          href="/estudio/usuarios"
          titulo="Usuarios"
          descripcion="Invitar, cambiar roles y dar de baja."
          habilitado={esTitular}
          motivo="Solo el titular"
        />
        <AccesoEstudio
          href="/estudio/configuracion"
          titulo="Configuración"
          descripcion="Desperdicios, condiciones, mandato, ranking, MEP y checklists."
          habilitado={esColaborador}
          motivo="Colaborador o titular"
        />
        <AccesoEstudio
          href="/estudio/auditoria"
          titulo="Auditoría"
          descripcion="Todo lo que se hizo, con quién y cuándo."
          habilitado={esTitular}
          motivo="Solo el titular"
        />
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>Tus notificaciones</CardTitle>
        </CardHeader>
        <CardContent>
          {avisos.length === 0 ? (
            <p className="text-sm text-neutral-600">
              No tenés avisos todavía. Acá van a aparecer las cotizaciones conciliadas, las
              deducciones nuevas y las compulsas que se quedaron sin respuesta.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {avisos.map((aviso) => (
                <li key={aviso.id}>
                  <form action={abrirNotificacionAction}>
                    <input type="hidden" name="notificacionId" value={aviso.id} />
                    <input type="hidden" name="link" value={aviso.link ?? ''} />
                    <button
                      type="submit"
                      className="block w-full py-3 text-left hover:bg-neutral-50"
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-neutral-900">
                            {aviso.titulo}
                          </span>
                          {aviso.leida ? null : <Badge tone="info">nuevo</Badge>}
                        </span>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {FECHA.format(aviso.createdAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-sm text-neutral-600">{aviso.cuerpo}</span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** "1 compulsa" / "3 compulsas": el plural se escribe, no se deja "1 compulsa(s)". */
function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * Ahorro acumulado del estudio (RF-1104): la suma de lo ahorrado en todas las
 * compulsas adjudicadas, de todas las obras.
 *
 * **Una cifra por moneda.** Sumar pesos con dólares necesitaría un tipo de
 * cambio que nadie escribió, y el sistema no inventa números (P4). Sin nada
 * adjudicado se muestra un guion y se explica de dónde va a salir: un "$ 0" se
 * leería como "no ahorramos nada" en vez de "todavía no hay contra qué medir",
 * que es el mismo criterio que el tablero de obra.
 */
function AhorroAcumulado({ ahorro }: { ahorro: AhorroDelEstudio }) {
  const vacio = ahorro.porMoneda.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ahorro acumulado del estudio</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {vacio ? (
          <>
            <p className="text-2xl font-semibold tabular-nums text-neutral-900">—</p>
            <p className="text-sm text-neutral-600">
              Sale al adjudicar: la mediana de las ofertas menos lo que se adjudicó, más lo que se
              consiguió negociando. Todavía no hay ninguna compulsa adjudicada.
            </p>
          </>
        ) : (
          <>
            <dl className="flex flex-wrap gap-x-10 gap-y-3">
              {ahorro.porMoneda.map((entrada) => (
                <div key={entrada.moneda}>
                  <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                    {entrada.moneda}
                  </dt>
                  <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
                    {formatearMonto(entrada.moneda, entrada.ahorro)}
                  </dd>
                  <dd className="text-xs text-neutral-500">
                    {plural(entrada.adjudicadas, 'compulsa adjudicada', 'compulsas adjudicadas')}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-neutral-600">
              Sobre {plural(ahorro.obras, 'obra', 'obras')} del estudio. Mediana de las ofertas menos
              lo adjudicado, más las mejoras de negociación.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AccesoEstudio({
  href,
  titulo,
  descripcion,
  habilitado,
  motivo,
}: {
  href: string;
  titulo: string;
  descripcion: string;
  habilitado: boolean;
  motivo: string;
}) {
  const cuerpo = (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-base font-medium text-neutral-900">{titulo}</span>
        {habilitado ? null : <Badge tone="neutral">{motivo}</Badge>}
      </span>
      <span className="mt-1 block text-sm text-neutral-600">{descripcion}</span>
    </>
  );

  if (!habilitado) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 opacity-70">
        {cuerpo}
      </div>
    );
  }

  return (
    <Link
      href={href}
      className="rounded-lg border border-neutral-200 bg-white p-4 hover:border-neutral-400"
    >
      {cuerpo}
    </Link>
  );
}
