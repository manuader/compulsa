import type { ComponentPropsWithRef } from 'react';

const BASE =
  'block w-full rounded-md border bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-100';

export interface InputProps extends ComponentPropsWithRef<'input'> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className, ...props }: InputProps) {
  const input = (
    <input
      aria-invalid={error ? true : undefined}
      className={[BASE, error ? 'border-red-600' : 'border-neutral-300', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );

  if (!label && !error) return input;

  return (
    <label className="block">
      {label ? (
        <span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span>
      ) : null}
      {input}
      {error ? <span className="mt-1 block text-sm text-red-700">{error}</span> : null}
    </label>
  );
}
