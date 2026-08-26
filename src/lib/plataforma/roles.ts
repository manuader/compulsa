/**
 * Matriz de roles del estudio (RF-1201).
 *
 * Una sola jerarquía, `lectura < colaborador < titular`, y una sola función que
 * la aplica: `requireRolCore`. Vive en un módulo puro —sin base, sin Next— para
 * que la usen tanto los núcleos de `src/lib/**` como los envoltorios `*Action`
 * de `src/app/**`, y para que los tests la ejerciten sin levantar nada.
 *
 * ## Las tres reglas, textuales
 *
 * 1. **`lectura` no muta nada.** Ninguna acción de la tabla le alcanza.
 * 2. **`colaborador` hace todo menos cinco cosas:** aprobar rubros, lanzar
 *    compulsas, adjudicar, eliminar obras y gestionar usuarios. Esas cinco son
 *    `ACCIONES_SENSIBLES` y todas piden `titular`.
 * 3. **`titular` hace todo.**
 *
 * Más una cuarta que no es de rol sino de estado: **un usuario inactivo queda
 * afuera de todo.** La baja lógica (`usuarios.activo = false`) no le cambia el
 * rol —la auditoría lo sigue nombrando con el que tenía—, le corta la entrada.
 * Por eso el chequeo de `activo` va **antes** que el de jerarquía: a un titular
 * desactivado hay que decirle que está desactivado, no que le falta rol.
 *
 * ## Por qué el enforcement no puede estar solo en la UI
 *
 * Todo `*Action` de un archivo `'use server'` es un endpoint HTTP que el cliente
 * invoca con el payload que quiera: esconder el botón no esconde el endpoint.
 * La regla se aplica en el core o en el envoltorio que resuelve la sesión, y la
 * UI solo repite lo que el server ya decidió.
 */
import { ROLES_USUARIO, type RolUsuario } from '@/types/domain';

/** Lo mínimo que hace falta saber de quien pide hacer algo. */
export interface UsuarioConRol {
  rol: RolUsuario;
  activo: boolean;
}

/** `lectura` nunca es un mínimo: pedir "al menos lectura" es no pedir nada. */
export type RolMinimo = 'colaborador' | 'titular';

/** Orden de la jerarquía. El número no se persiste: es interno de este módulo. */
const NIVEL: Record<RolUsuario, number> = {
  lectura: 0,
  colaborador: 1,
  titular: 2,
};

export const ETIQUETA_ROL: Record<RolUsuario, string> = {
  titular: 'Titular',
  colaborador: 'Colaborador',
  lectura: 'Solo lectura',
};

/** Cómo se nombra el rol dentro de una oración ("Tu rol es solo lectura."). */
const ROL_EN_ORACION: Record<RolUsuario, string> = {
  titular: 'titular',
  colaborador: 'colaborador',
  lectura: 'solo lectura',
};

export class UsuarioInactivoError extends Error {
  constructor() {
    super('Tu usuario está desactivado: pedile a un titular del estudio que te reactive.');
    this.name = 'UsuarioInactivoError';
  }
}

export class RolInsuficienteError extends Error {
  constructor(
    readonly rol: RolUsuario,
    readonly minimo: RolMinimo,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'RolInsuficienteError';
  }
}

/** `true` si el usuario está activo y su rol llega al mínimo pedido. */
export function esRolSuficiente(usuario: UsuarioConRol, minimo: RolMinimo): boolean {
  return usuario.activo && NIVEL[usuario.rol] >= NIVEL[minimo];
}

/**
 * Puerta de toda mutación. No devuelve nada: o pasa, o lanza.
 *
 * `accion` es el infinitivo de lo que se quiso hacer ("aprobar un rubro"), y
 * entra tal cual en el mensaje: un "no tenés permiso" pelado no le dice al
 * usuario ni qué falló ni a quién pedírselo.
 */
export function requireRolCore(usuario: UsuarioConRol, minimo: RolMinimo, accion?: string): void {
  if (!usuario.activo) throw new UsuarioInactivoError();
  if (NIVEL[usuario.rol] >= NIVEL[minimo]) return;

  const que = accion ?? 'hacer esto';
  const mensaje =
    minimo === 'titular'
      ? `Solo el titular del estudio puede ${que}. Tu rol es ${ROL_EN_ORACION[usuario.rol]}.`
      : `Con rol de solo lectura no podés ${que}. Pedile a un colaborador o al titular que lo haga.`;

  throw new RolInsuficienteError(usuario.rol, minimo, mensaje);
}

// ---------------------------------------------------------------------------
// Tabla de acciones
// ---------------------------------------------------------------------------

/**
 * Las cinco que la matriz del PRD le saca al colaborador. Es una lista cerrada:
 * agregar una acción sensible es agregarla acá **y** en `ROL_MINIMO_ACCION`.
 */
export const ACCIONES_SENSIBLES = [
  'aprobar_rubro',
  'lanzar_compulsa',
  'adjudicar_compulsa',
  'eliminar_obra',
  'gestionar_usuarios',
] as const;

export type AccionSensible = (typeof ACCIONES_SENSIBLES)[number];

/**
 * Rol mínimo por acción del producto. El reporte de P7 lleva esta misma tabla
 * con el archivo que la aplica en cada caso; acá está la fuente de verdad para
 * el código.
 *
 * Las que hoy no tienen core (compulsa, adjudicación) están igual: la tabla es
 * el contrato con P8/P9, que llegan con la acción ya nombrada.
 */
export const ROL_MINIMO_ACCION = {
  // --- Titular (las cinco de la matriz) ---
  aprobar_rubro: 'titular',
  lanzar_compulsa: 'titular',
  adjudicar_compulsa: 'titular',
  eliminar_obra: 'titular',
  gestionar_usuarios: 'titular',

  // --- Colaborador o más (todo el resto que muta) ---
  crear_obra: 'colaborador',
  editar_obra: 'colaborador',
  archivar_obra: 'colaborador',
  subir_documento: 'colaborador',
  eliminar_documento: 'colaborador',
  editar_lamina: 'colaborador',
  reprocesar_lamina: 'colaborador',
  editar_computo: 'colaborador',
  resolver_hallazgo: 'colaborador',
  configurar_estudio: 'colaborador',
  editar_checklists: 'colaborador',
} as const satisfies Record<string, RolMinimo>;

export type AccionConRol = keyof typeof ROL_MINIMO_ACCION;

/** Frase es-AR de cada acción, para los mensajes de error. */
export const FRASE_ACCION: Record<AccionConRol, string> = {
  aprobar_rubro: 'aprobar un rubro',
  lanzar_compulsa: 'lanzar una compulsa',
  adjudicar_compulsa: 'adjudicar una compulsa',
  eliminar_obra: 'eliminar una obra',
  gestionar_usuarios: 'gestionar los usuarios del estudio',
  crear_obra: 'crear una obra',
  editar_obra: 'editar los datos de la obra',
  archivar_obra: 'archivar o desarchivar una obra',
  subir_documento: 'subir documentación',
  eliminar_documento: 'eliminar un documento',
  editar_lamina: 'editar los datos de una lámina',
  reprocesar_lamina: 'reprocesar una lámina',
  editar_computo: 'editar el cómputo',
  resolver_hallazgo: 'resolver una consulta de la bandeja',
  configurar_estudio: 'cambiar la configuración del estudio',
  editar_checklists: 'editar los checklists del estudio',
};

/** `requireRolCore` con el mínimo y la frase sacados de la tabla. */
export function requireAccion(usuario: UsuarioConRol, accion: AccionConRol): void {
  requireRolCore(usuario, ROL_MINIMO_ACCION[accion], FRASE_ACCION[accion]);
}

// ---------------------------------------------------------------------------
// Chequeo de compilación: los tres roles tienen nivel y etiqueta.
// ---------------------------------------------------------------------------

type _Completos = [
  typeof NIVEL,
  typeof ETIQUETA_ROL,
  typeof ROL_EN_ORACION,
] extends Record<number, Record<(typeof ROLES_USUARIO)[number], unknown>>
  ? true
  : never;
const _completos: _Completos = true;
void _completos;
