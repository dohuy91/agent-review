import React from "react";
import type {
  RepositoryRestoreError,
  ReviewFile,
  AttachedComment,
} from "../../../../packages/shared/src/index.js";
import ChangedFileTree from "./ChangedFileTree.js";
export default function Sidebar({
  selected,
  files,
  selectedPath,
  reviewed,
  comments,
  onSelectFile,
  loading,
  onClose,
  errors = [],
  conflicts = [],
}: {
  selected: string;
  files: ReviewFile[];
  selectedPath: string;
  reviewed: Set<string>;
  comments: AttachedComment[];
  onSelectFile: (path: string) => void;
  loading?: boolean;
  onClose: () => void;
  errors?: RepositoryRestoreError[];
  conflicts?: string[];
}) {
  return (
    <aside
      className="sidebar"
      id="project-pane"
      aria-label="Changed file navigation"
    >
      <button
        className="mobile-close"
        aria-label="Close changed files"
        onClick={onClose}
      >
        ×
      </button>
      <ChangedFileTree
        key={selected}
        files={files}
        selected={selectedPath}
        reviewed={reviewed}
        comments={comments}
        conflicts={conflicts}
        loading={loading}
        onSelect={onSelectFile}
      />
      {errors.map((item) => (
        <div className="registration-error" role="alert" key={item.root}>
          <strong>Unavailable repository</strong>
          <span>{item.root}</span>
          <small>{item.error}</small>
        </div>
      ))}
    </aside>
  );
}
