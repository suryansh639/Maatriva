/**
 * Toasts (Req 19.8).
 *
 * - One `aria-live="assertive"` region, always mounted so screen readers pick up
 *   toasts as they are added.
 * - Each toast has an optional action button (e.g. "Open patient") and a Dismiss
 *   button; Escape dismisses the toast that has focus.
 * - Toasts close automatically after 15 seconds. The timer pauses while keyboard
 *   focus or the pointer is inside the toast, so it never closes under the user.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export const TOAST_DURATION_MS = 15_000;

export type ToastTone = 'danger' | 'info';

export interface ToastInput {
  /** Short title, e.g. "RED alert". */
  title: string;
  message?: string;
  tone?: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: number;
}

export interface ToastsContextValue {
  /** Shows a toast and returns its id. */
  push: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastsContext = createContext<ToastsContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { ...toast, id }]);
    return id;
  }, []);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastsContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="assertive" aria-label="Notifications">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastsContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const duration = toast.durationMs ?? TOAST_DURATION_MS;

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [paused, duration, toast.id, onDismiss]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onDismiss(toast.id);
    }
  };

  return (
    <div
      className={`toast toast--${toast.tone ?? 'info'}`}
      role="alert"
      onKeyDown={onKeyDown}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="toast__text">
        <strong className="toast__title">{toast.title}</strong>
        {toast.message ? <span className="toast__message">{toast.message}</span> : null}
      </div>
      <div className="toast__actions">
        {toast.actionLabel && toast.onAction ? (
          <button
            type="button"
            className="toast__action"
            onClick={() => {
              toast.onAction?.();
              onDismiss(toast.id);
            }}
          >
            {toast.actionLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="toast__dismiss"
          aria-label={`Dismiss: ${toast.title}`}
          onClick={() => onDismiss(toast.id)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function useToasts(): ToastsContextValue {
  const ctx = useContext(ToastsContext);
  if (!ctx) throw new Error('useToasts must be used inside <ToastProvider>');
  return ctx;
}
