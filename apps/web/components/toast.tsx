'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Toast notification system. One context, one viewport.
 *
 * Why custom and not a library?
 *   • We already pay for everything else (auth gate, command palette,
 *     selection menu) in our own components — adding react-hot-toast or
 *     sonner is 30 KB for behaviour we can hand-write in a hundred lines.
 *   • The viewport docks to the corner; nothing else competes for that
 *     space. No need for the layout machinery these libs ship with.
 *
 * Auto-dismiss defaults to 4s, configurable per-call. Errors live longer
 * (6s) because the message is usually load-bearing. Manual dismiss via the
 * × button is always there.
 *
 * The provider mounts the viewport inline rather than via a portal — the
 * AuthGate renders inside it anyway, so positioning with ``fixed`` is
 * enough and avoids the SSR mismatch portals can introduce.
 */

type ToastVariant = 'success' | 'error' | 'info';

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  // Convenience action — single button on the toast (e.g. "Undo", "Open").
  action?: { label: string; href?: string; onClick?: () => void };
}

interface ToastContextValue {
  toast: (
    message: string,
    opts?: {
      variant?: ToastVariant;
      durationMs?: number;
      action?: Toast['action'];
    },
  ) => void;
  success: (message: string, opts?: { durationMs?: number; action?: Toast['action'] }) => void;
  error: (message: string, opts?: { durationMs?: number; action?: Toast['action'] }) => void;
  info: (message: string, opts?: { durationMs?: number; action?: Toast['action'] }) => void;
}

const NoopCtx: ToastContextValue = {
  toast: () => undefined,
  success: () => undefined,
  error: () => undefined,
  info: () => undefined,
};

const ToastCtx = createContext<ToastContextValue>(NoopCtx);

export function useToast(): ToastContextValue {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timeoutsRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timeoutsRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (
      message: string,
      variant: ToastVariant,
      durationMs: number | undefined,
      action: Toast['action'] | undefined,
    ) => {
      // Crypto random would be nicer but Date.now + a counter is enough
      // for "uniquely identify a transient stack of <10 items".
      const id = `t${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      setToasts((prev) => [...prev, { id, message, variant, action }]);
      const ttl = durationMs ?? (variant === 'error' ? 6000 : 4000);
      const handle = setTimeout(() => dismiss(id), ttl);
      timeoutsRef.current.set(id, handle);
    },
    [dismiss],
  );

  // Clean up any pending timers on unmount.
  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      for (const handle of timeouts.values()) clearTimeout(handle);
      timeouts.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast: (message, opts) =>
        push(message, opts?.variant ?? 'info', opts?.durationMs, opts?.action),
      success: (message, opts) => push(message, 'success', opts?.durationMs, opts?.action),
      error: (message, opts) => push(message, 'error', opts?.durationMs, opts?.action),
      info: (message, opts) => push(message, 'info', opts?.durationMs, opts?.action),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const tone = toneClass(toast.variant);
  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 rounded-md border px-4 py-3 text-sm shadow-md ${tone}`}
    >
      <span className="mt-0.5 flex-shrink-0" aria-hidden="true">
        {iconFor(toast.variant)}
      </span>
      <div className="flex-1">
        <p className="leading-relaxed">{toast.message}</p>
        {toast.action && (
          <ToastAction action={toast.action} onDismiss={onDismiss} />
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="ml-1 mt-0.5 text-xs opacity-60 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

function ToastAction({
  action,
  onDismiss,
}: {
  action: NonNullable<Toast['action']>;
  onDismiss: () => void;
}) {
  if (action.href) {
    return (
      <a
        href={action.href}
        onClick={onDismiss}
        className="mt-1 inline-block text-xs font-medium underline hover:opacity-80"
      >
        {action.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        action.onClick?.();
        onDismiss();
      }}
      className="mt-1 text-xs font-medium underline hover:opacity-80"
    >
      {action.label}
    </button>
  );
}

function toneClass(variant: ToastVariant): string {
  switch (variant) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-900';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-900';
    case 'info':
      return 'border-border bg-background text-foreground';
  }
}

function iconFor(variant: ToastVariant): string {
  switch (variant) {
    case 'success':
      return '✓';
    case 'error':
      return '!';
    case 'info':
      return 'ⓘ';
  }
}
