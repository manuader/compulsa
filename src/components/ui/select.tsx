import type { ComponentPropsWithRef } from 'react';

const BASE =
  'block w-full rounded-md border bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-100';

export interface SelectProps extends ComponentPropsWithRef<'select'> {
  label?: string;
  error?: string;
}

export function Select({ label, error, className, children, ...props }: SelectProps) {
  const select = (
    <select
      aria-invalid={error ? true : undefined}
      className={[BASE, error ? 'border-red-600' : 'border-neutral-300', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </select>
  );

  if (!label && !error) return select;

  return (
    <label className="block">
      {label ? (
        <span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span>
      ) : null}
      {select}
      {error ? <span className="mt-1 block text-sm text-red-700">{error}</span> : null}
    </label>
  );
}
