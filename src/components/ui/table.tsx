import type { ComponentPropsWithRef } from 'react';

/** Envuelve la tabla en un contenedor con scroll horizontal: la planilla de cómputo es ancha. */
export function Table({ className, ...props }: ComponentPropsWithRef<'table'>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table
        className={['w-full border-collapse text-sm', className].filter(Boolean).join(' ')}
        {...props}
      />
    </div>
  );
}

export function TableHead({ className, ...props }: ComponentPropsWithRef<'thead'>) {
  return <thead className={['bg-neutral-100', className].filter(Boolean).join(' ')} {...props} />;
}

export function TableBody(props: ComponentPropsWithRef<'tbody'>) {
  return <tbody {...props} />;
}

export function TableRow({ className, ...props }: ComponentPropsWithRef<'tr'>) {
  return (
    <tr
      className={['border-b border-neutral-200 last:border-b-0', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}

export interface TableCellProps extends ComponentPropsWithRef<'td'> {
  /** Columna numérica: alineada a la derecha y con dígitos de ancho fijo. */
  numeric?: boolean;
}

export function TableCell({ numeric, className, ...props }: TableCellProps) {
  return (
    <td
      className={['px-3 py-2 align-top', numeric ? 'text-right tabular-nums' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}

export interface TableHeaderCellProps extends ComponentPropsWithRef<'th'> {
  numeric?: boolean;
}

export function TableHeaderCell({ numeric, className, ...props }: TableHeaderCellProps) {
  return (
    <th
      scope="col"
      className={[
        'px-3 py-2 text-left font-medium whitespace-nowrap text-neutral-600',
        numeric ? 'text-right' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}
