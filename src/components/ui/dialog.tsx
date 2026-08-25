'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Modal sobre `<dialog>` nativo: trae ESC, foco atrapado y backdrop sin JS extra.
 * `onClose` se dispara también al apretar ESC o al clickear fuera.
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-0 text-neutral-900 shadow-xl backdrop:bg-neutral-900/40"
    >
      <div className="flex items-center justify-between gap-4 border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
        >
          ✕
        </button>
      </div>
      <div className="px-4 py-4 text-sm">{children}</div>
      {footer ? (
        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-4 py-3">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
