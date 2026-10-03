import React from "react";
import type { Repository } from "../../../../packages/shared/src/index.js";
export default function Sidebar({
  repositories,
  selected,
  onSelect,
  branches,
  onBase,
  onClose,
}: {
  repositories: Repository[];
  selected: string;
  onSelect: (id: string) => void;
  branches: string[];
  onBase: (b: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="panel-heading">
        PROJECTS{" "}
        <button className="mobile-close" onClick={onClose}>
          ×
        </button>
      </div>
      {repositories.map((r) => (
        <div key={r.id}>
          <button
            className={`project ${selected === r.id ? "active" : ""}`}
            onClick={() => onSelect(r.id)}
          >
            ▣{" "}
            <span>
              {r.root.split("/").pop()}
              <small>{r.root}</small>
            </span>
          </button>
          {selected === r.id && (
            <div className="branch-list">
              <div className="subheading">LOCAL BRANCHES / BASE</div>
              {branches.map((b) => (
                <button key={b} onClick={() => onBase(b)}>
                  ⑂ {b}
                  {b === r.branch && <small>current</small>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="sidebar-foot">
        LOCAL REVIEW
        <br />
        <small>Your code stays on this computer</small>
      </div>
    </aside>
  );
}
