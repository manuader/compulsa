import type { ComponentPropsWithRef } from 'react';

export function Card({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={['rounded-lg border border-neutral-200 bg-white shadow-sm', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={['border-b border-neutral-200 px-4 py-3', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentPropsWithRef<'h2'>) {
  return (
    <h2
      className={['text-sm font-semibold text-neutral-900', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={['px-4 py-3', className].filter(Boolean).join(' ')} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={[
        'flex items-center gap-2 border-t border-neutral-200 px-4 py-3',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}
