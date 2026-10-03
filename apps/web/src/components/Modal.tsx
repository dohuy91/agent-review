import React, { useEffect, useRef } from "react";
export default function Modal({
  children,
  onClose,
  label,
  returnFocus,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label?: string;
  returnFocus?: React.RefObject<HTMLElement | null>;
}) {
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      returnFocus?.current || (document.activeElement as HTMLElement | null);
    const modal = host.current!;
    const first = modal.querySelector<HTMLElement>(
      "input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)",
    );
    first?.focus();
    function contain(event: FocusEvent) {
      if (event.target instanceof Node && !modal.contains(event.target))
        first?.focus();
    }
    document.addEventListener("focusin", contain);
    return () => {
      document.removeEventListener("focusin", contain);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  function key(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      host.current!.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
      ),
    );
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={host}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={key}
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose}>
          ×
        </button>
        {children}
      </section>
    </div>
  );
}
