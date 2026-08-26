import type { ComponentPropsWithRef } from 'react';

export type BadgeTone = 'ok' | 'warn' | 'error' | 'neutral' | 'info';

const BASE =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

const TONES: Record<BadgeTone, string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-900',
  error: 'bg-red-100 text-red-800',
  neutral: 'bg-neutral-200 text-neutral-800',
  info: 'bg-sky-100 text-sky-800',
};

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return <span className={[BASE, TONES[tone], className].filter(Boolean).join(' ')} {...props} />;
}
