import React from "react";
import type { Repository } from "../../../../packages/shared/src/index.js";
export default function ProjectTabs({
  repositories,
  selected,
  onSelect,
  onOpen,
}: {
  repositories: Repository[];
  selected: string;
  onSelect: (id: string) => void;
  onOpen: () => void;
}) {
  return (
    <nav className="project-tabs" role="tablist" aria-label="Projects">
      {repositories.map((repository) => (
        <button
          key={repository.id}
          role="tab"
          aria-selected={repository.id === selected}
          className={repository.id === selected ? "selected" : ""}
          title={repository.root}
          onClick={() => onSelect(repository.id)}
        >
          {repository.root.split(/[\\/]/).filter(Boolean).at(-1) ||
            repository.root}
        </button>
      ))}
      <button
        className="project-open"
        aria-label="Open repository"
        title="Open repository"
        onClick={onOpen}
      >
        ＋
      </button>
    </nav>
  );
}
