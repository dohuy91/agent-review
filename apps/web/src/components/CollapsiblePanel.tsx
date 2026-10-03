import React, { useId, useState } from "react";
export default function CollapsiblePanel({
  title,
  count,
  children,
  open,
  onToggle,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  open?: boolean;
  onToggle?: () => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  const visible = open ?? expanded;
  return (
    <section className="collapsible-panel">
      <button
        className="panel-toggle"
        aria-expanded={visible}
        aria-controls={id}
        onClick={() => (onToggle ? onToggle() : setExpanded(!expanded))}
      >
        <span className="collapse-icon" aria-hidden="true">
          {visible ? "▾" : "▸"}
        </span>
        {title}{" "}
        {count !== undefined && <span className="panel-count">{count}</span>}
      </button>
      <div id={id} hidden={!visible} className="panel-content">
        {children}
      </div>
    </section>
  );
}
