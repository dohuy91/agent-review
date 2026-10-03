import React, { useCallback, useEffect, useRef } from "react";
import type { PaneSide } from "../paneLayout.js";

export interface PaneSeparatorProps {
  side: PaneSide;
  label: string;
  controls?: string;
  value: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
  disabled?: boolean;
  className?: string;
}

interface Drag {
  pointerId: number;
  target: HTMLDivElement;
  move: (event: PointerEvent) => void;
  end: (event: PointerEvent) => void;
  blur: () => void;
  cursor: string;
  userSelect: string;
}

/** A vertical splitter with keyboard, touch/pen, and window-level pointer support. */
export default function PaneSeparator(props: PaneSeparatorProps) {
  const latest = useRef(props);
  latest.current = props;
  const drag = useRef<Drag | null>(null);

  const stopDrag = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    window.removeEventListener("pointermove", active.move);
    window.removeEventListener("pointerup", active.end);
    window.removeEventListener("pointercancel", active.end);
    window.removeEventListener("blur", active.blur);
    try {
      if (active.target.hasPointerCapture?.(active.pointerId))
        active.target.releasePointerCapture(active.pointerId);
    } catch {
      // A canceled pointer may already have lost capture.
    }
    active.target.removeAttribute("data-resizing");
    document.body.style.cursor = active.cursor;
    document.body.style.userSelect = active.userSelect;
  }, []);

  useEffect(() => stopDrag, [stopDrag]);
  useEffect(() => {
    if (props.disabled) stopDrag();
  }, [props.disabled, stopDrag]);

  function resize(width: number) {
    const { disabled, min, max, onResize } = latest.current;
    if (!disabled) onResize(Math.max(min, Math.min(max, Math.round(width))));
  }

  return (
    <div
      className={`pane-separator ${props.className ?? ""}`.trim()}
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-controls={props.controls}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      aria-valuetext={`${props.value} pixels`}
      aria-disabled={props.disabled || undefined}
      tabIndex={props.disabled ? -1 : 0}
      title="Drag or use left/right arrows to resize. Home or double click resets."
      style={{
        touchAction: "none",
        userSelect: "none",
        cursor: props.disabled ? "default" : "col-resize",
      }}
      onDoubleClick={() => {
        if (!props.disabled) props.onReset();
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId === event.pointerId) stopDrag();
      }}
      onKeyDown={(event) => {
        if (props.disabled || event.altKey || event.ctrlKey || event.metaKey)
          return;
        if (event.key === "Home") {
          event.preventDefault();
          props.onReset();
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          resize(
            props.value +
              direction *
                (props.side === "left" ? 1 : -1) *
                (event.shiftKey ? 50 : 10),
          );
        }
      }}
      onPointerDown={(event) => {
        if (props.disabled || event.button !== 0 || drag.current) return;
        event.preventDefault();
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startValue = props.value;
        const direction = props.side === "left" ? 1 : -1;
        const target = event.currentTarget;
        const active: Drag = {
          pointerId,
          target,
          cursor: document.body.style.cursor,
          userSelect: document.body.style.userSelect,
          move: (move) => {
            if (move.pointerId !== pointerId) return;
            move.preventDefault();
            resize(startValue + (move.clientX - startX) * direction);
          },
          end: (end) => {
            if (end.pointerId === pointerId) stopDrag();
          },
          blur: stopDrag,
        };
        drag.current = active;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        target.setAttribute("data-resizing", "true");
        window.addEventListener("pointermove", active.move, { passive: false });
        window.addEventListener("pointerup", active.end);
        window.addEventListener("pointercancel", active.end);
        window.addEventListener("blur", active.blur);
        try {
          target.setPointerCapture?.(pointerId);
        } catch {
          // Window listeners also cover browsers without pointer capture support.
        }
      }}
    />
  );
}
