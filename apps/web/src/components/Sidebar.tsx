import React from "react";
import type {
  Repository,
  RepositoryRestoreError,
  ReviewFile,
  AttachedComment,
} from "../../../../packages/shared/src/index.js";
import ChangedFileTree from "./ChangedFileTree.js";
export default function Sidebar({
  repositories,
  selected,
  onSelect,
  files,
  selectedPath,
  reviewed,
  comments,
  onSelectFile,
  loading,
  onClose,
  errors = [],
}: {
  repositories: Repository[];
  selected: string;
  onSelect: (id: string) => void;
  files: ReviewFile[];
  selectedPath: string;
  reviewed: Set<string>;
  comments: AttachedComment[];
  onSelectFile: (path: string) => void;
  loading?: boolean;
  onClose: () => void;
  errors?: RepositoryRestoreError[];
}) {
  return (
    <aside
      className="sidebar"
      id="project-pane"
      aria-label="Changed file navigation"
    >
      <div className="sidebar-repository">
        <label htmlFor="registered-worktree">Repository / Project</label>
        <button
          className="mobile-close"
          aria-label="Close changed files"
          onClick={onClose}
        >
          ×
        </button>
        <select
          id="registered-worktree"
          aria-label="Registered worktree"
          value={selected}
          title={repositories.find((r) => r.id === selected)?.root}
          onChange={(event) => onSelect(event.target.value)}
        >
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.root.split("/").pop()} · {r.root}
            </option>
          ))}
        </select>
        {repositories.find((r) => r.id === selected)?.root && (
          <small
            className="repository-path"
            title={repositories.find((r) => r.id === selected)?.root}
          >
            {repositories.find((r) => r.id === selected)?.root}
          </small>
        )}
      </div>
      <ChangedFileTree
        key={selected}
        files={files}
        selected={selectedPath}
        reviewed={reviewed}
        comments={comments}
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
