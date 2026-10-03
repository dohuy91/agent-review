import React from "react";
import type { ReviewFile } from "../../../../packages/shared/src/index.js";
export default function ChangesPanel({
  files,
  selected,
  reviewed,
  onSelect,
}: {
  files: ReviewFile[];
  selected: string;
  reviewed: Set<string>;
  onSelect: (p: string) => void;
}) {
  return (
    <div className="changes">
      <div className="changes-summary">
        {files.length} changed files <small>{reviewed.size} reviewed</small>
      </div>
      {files.map((f) => (
        <button
          className={`file-row ${selected === f.path ? "active" : ""}`}
          key={f.path}
          onClick={() => onSelect(f.path)}
        >
          <span className={`status status-${f.status[0]}`}>{f.status[0]}</span>
          <span className="file-name">
            {f.path.split("/").pop()}
            <small>
              {f.path.includes("/")
                ? f.path.slice(0, f.path.lastIndexOf("/"))
                : "/"}
            </small>
          </span>
          <span>{reviewed.has(f.path) ? "✓" : "○"}</span>
        </button>
      ))}
    </div>
  );
}
