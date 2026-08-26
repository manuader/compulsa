import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { getDb } from '@/db/client';
import { requireUser } from '@/lib/auth/guards';
import { esRolSuficiente, ETIQUETA_ROL } from '@/lib/plataforma/roles';
import { listarInvitaciones, listarUsuarios } from '@/lib/plataforma/usuarios';

import { AccionesUsuario, FormularioInvitacion, SinPermiso } from '../ui';

export const metadata: Metadata = { title: 'Usuarios del estudio' };

const FECHA = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Gestión del equipo del estudio: invitar, cambiar rol, dar de baja.
 *
 * Es de titular (RF-1201, una de las cinco). La pantalla lo chequea para no
 * mostrar datos de más, y **los endpoints lo vuelven a chequear**: acá no hay
 * ninguna decisión de seguridad, solo la versión visible de la que ya tomó el
 * core.
 */
export default async function UsuariosPage() {
  const { usuario, estudio } = await requireUser();
  if (!esRolSuficiente(usuario, 'titular')) {
    return <SinPermiso que="gestionar los usuarios del estudio" minimo="titular" />;
  }

  const db = await getDb();
  const [equipo, invitaciones] = await Promise.all([
    listarUsuarios(db, estudio.id),
    listarInvitaciones(db, estudio.id),
  ]);
  const pendientes = invitaciones.filter(
    (invitacion) => invitacion.usadaPor === null && invitacion.expiraAt.getTime() > Date.now(),
  );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link href="/estudio" className="text-sm text-neutral-600 underline">
          ← Estudio
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          Usuarios de {estudio.nombre}
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          El titular hace todo. El colaborador hace todo menos aprobar rubros, lanzar compulsas,
          adjudicar, eliminar obras y gestionar usuarios. El de solo lectura no toca nada.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Invitar a alguien</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <FormularioInvitacion />

          {pendientes.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium text-neutral-700">
                Códigos sin usar ({pendientes.length})
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {pendientes.map((invitacion) => (
                  <li key={invitacion.codigo} className="flex items-center gap-3">
                    <code className="rounded bg-neutral-100 px-2 py-0.5 font-mono tracking-widest">
                      {invitacion.codigo}
                    </code>
                    <span className="text-neutral-600">
                      {ETIQUETA_ROL[invitacion.rol]} · vence el {FECHA.format(invitacion.expiraAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Equipo ({equipo.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Nombre</TableHeaderCell>
                <TableHeaderCell>Mail</TableHeaderCell>
                <TableHeaderCell>Estado</TableHeaderCell>
                <TableHeaderCell>Desde</TableHeaderCell>
                <TableHeaderCell>Rol y acciones</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {equipo.map((miembro) => (
                <TableRow key={miembro.id}>
                  <TableCell>{miembro.nombre}</TableCell>
                  <TableCell>{miembro.email}</TableCell>
                  <TableCell>
                    {miembro.activo ? (
                      <Badge tone="ok">Activo</Badge>
                    ) : (
                      <Badge tone="neutral">Dado de baja</Badge>
                    )}
                  </TableCell>
                  <TableCell>{FECHA.format(miembro.createdAt)}</TableCell>
                  <TableCell>
                    <AccionesUsuario usuario={miembro} esYo={miembro.id === usuario.id} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="mt-4 text-sm text-neutral-600">
            La baja es lógica: el usuario no entra más, pero la auditoría lo sigue nombrando. El
            último titular activo no se puede bajar de rol ni dar de baja — nombrá a otro titular
            primero.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
