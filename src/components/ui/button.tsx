import type { ComponentPropsWithRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800',
  secondary: 'border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100',
  danger: 'border-red-700 bg-red-700 text-white hover:bg-red-800',
  ghost: 'border-transparent bg-transparent text-neutral-700 hover:bg-neutral-200',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
};

/**
 * Las clases de un botón, sin el `<button>`.
 *
 * Es para lo que **parece** un botón pero no lo es: un `<Link>` que navega.
 * Meter un `<Button>` adentro de un `<Link>` produce `<a><button>`, que el
 * HTML no admite (contenido interactivo anidado): el navegador desarma el
 * marcado, el teclado ve dos paradas de tab para un solo destino y el lector de
 * pantalla anuncia un botón donde hay un enlace.
 *
 * `Button` usa esta misma función, así que un cambio de estilo no se puede
 * escapar de un lado (`src/app/CLAUDE.md` §8: reusar las primitivas, no
 * duplicar estilos de botón).
 */
export function estilosBoton(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return [BASE, VARIANTS[variant], SIZES[size], className].filter(Boolean).join(' ');
}

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  ...props
}: ButtonProps) {
  return <button type={type} className={estilosBoton(variant, size, className)} {...props} />;
}
