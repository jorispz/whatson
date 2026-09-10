import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

interface Dialog<T extends HTMLElement> {
  /** Attach to the panel element; give it tabIndex={-1} so it can take focus. */
  panelRef: RefObject<T>;
  /**
   * Spread onto the element that acts as the click-to-close backdrop. Closes
   * only when both mousedown and click land on the backdrop itself, so a text
   * selection that starts inside the panel and ends outside doesn't dismiss it.
   */
  backdropProps: {
    onMouseDown: (e: ReactMouseEvent) => void;
    onClick: (e: ReactMouseEvent) => void;
  };
}

/**
 * Shared modal behaviour: Escape closes, focus moves into the panel on open
 * and back to the previously focused element on close, and the page behind
 * stops scrolling while the dialog is up.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void): Dialog<T> {
  const panelRef = useRef<T>(null);
  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, []);

  return {
    panelRef,
    backdropProps: {
      onMouseDown: (e) => {
        mouseDownTarget.current = e.target;
      },
      onClick: (e) => {
        if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) onClose();
      },
    },
  };
}
