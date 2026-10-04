import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  AttachedComment,
  ReviewFile,
} from "../../../../packages/shared/src/index.js";
import {
  buildChangedFileTree,
  fileAncestorPaths,
  visibleFileNodes,
  type ChangedFileNode,
} from "./changed-file-tree.js";
import "./ChangedFileTree.css";

export type ChangedFileFilter = "all" | "unreviewed" | "reviewed";
export interface ChangedFileTreeProps {
  files: ReviewFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  reviewed?: Set<string>;
  comments?: AttachedComment[];
  filter?: ChangedFileFilter;
  onFilterChange?: (filter: ChangedFileFilter) => void;
  loading?: boolean;
  conflicts?: string[];
}
const statusNames: Record<string, string> = {
  A: "Added",
  D: "Deleted",
  M: "Modified",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Unmerged",
};
function FileIcon({ name }: { name: string }) {
  const kind = name.endsWith(".json")
    ? "json"
    : name.endsWith(".md")
      ? "markdown"
      : "code";
  return (
    <svg
      className={`changed-tree-file-icon changed-tree-file-icon-${kind}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "json" ? (
        <path d="M9 3H7a2 2 0 0 0-2 2v4c0 2-1 3-3 3 2 0 3 1 3 3v4a2 2 0 0 0 2 2h2m6-18h2a2 2 0 0 1 2 2v4c0 2 1 3 3 3-2 0-3 1-3 3v4a2 2 0 0 1-2 2h-2" />
      ) : (
        <>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6" />
          {kind === "markdown" ? (
            <path d="m8 17 3-4 3 2 3-4" />
          ) : (
            <path d="M8 13h8M8 17h5" />
          )}
        </>
      )}
    </svg>
  );
}
const emptyReviewed = new Set<string>();
const emptyComments: AttachedComment[] = [];
function countsLabel(node: ChangedFileNode) {
  return node.addedLines === null || node.deletedLines === null
    ? "Line counts unavailable"
    : `${node.addedLines} lines added, ${node.deletedLines} lines deleted`;
}
function Counts({ node }: { node: ChangedFileNode }) {
  return (
    <span className="changed-tree-counts" aria-hidden="true">
      {node.addedLines === null && node.deletedLines === null ? (
        <span className="changed-tree-unknown">—</span>
      ) : (
        <>
          <span className="changed-tree-added">
            {node.addedLines === null ? "—" : `+${node.addedLines}`}
          </span>
          <span className="changed-tree-deleted">
            {node.deletedLines === null ? "—" : `−${node.deletedLines}`}
          </span>
        </>
      )}
    </span>
  );
}
export default function ChangedFileTree({
  files,
  selected,
  onSelect,
  reviewed = emptyReviewed,
  comments = emptyComments,
  filter: controlledFilter,
  onFilterChange,
  loading = false,
  conflicts = [],
}: ChangedFileTreeProps) {
  const [query, setQuery] = useState("");
  const [localFilter, setLocalFilter] = useState<ChangedFileFilter>("all");
  const filter = controlledFilter ?? localFilter;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(
    selected ? `file:${selected}` : null,
  );
  const previousSelected = useRef(selected);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(
    new Map<string, (element: HTMLButtonElement | null) => void>(),
  );
  const restoreRemovedFocus = useRef(false);
  const treeElement = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const headingId = useId();
  const reviewedCount = files.filter((file) => reviewed.has(file.path)).length;
  const filtered = useMemo(
    () =>
      files.filter(
        (file) =>
          file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
          (filter === "all" ||
            reviewed.has(file.path) === (filter === "reviewed")),
      ),
    [files, filter, reviewed, query],
  );
  const conflictSet = useMemo(
    () =>
      new Set([
        ...conflicts,
        ...files
          .filter((file) => file.kind === "conflict" || file.status === "U")
          .map((file) => file.path),
      ]),
    [conflicts.join("\0"), files],
  );
  const tree = useMemo(() => {
    if (!conflictSet.size) return buildChangedFileTree(filtered);
    const group = (
      name: string,
      path: string,
      members: ReviewFile[],
    ): ChangedFileNode => {
      const children = buildChangedFileTree(members);
      const prefixFolders = (nodes: ChangedFileNode[]) =>
        nodes.forEach((node) => {
          if (node.type === "folder") {
            node.id = `${path}:${node.id}`;
            prefixFolders(node.children);
          }
        });
      prefixFolders(children);
      return {
        id: `group:${path}`,
        group: true,
        type: "folder",
        name,
        path,
        file: null,
        children,
        fileCount: members.length,
        addedLines: children.every((node) => node.addedLines !== null)
          ? children.reduce((sum, node) => sum + node.addedLines!, 0)
          : null,
        deletedLines: children.every((node) => node.deletedLines !== null)
          ? children.reduce((sum, node) => sum + node.deletedLines!, 0)
          : null,
      };
    };
    return [
      group(
        "Conflicts",
        "__conflicts__",
        filtered.filter((file) => conflictSet.has(file.path)),
      ),
      group(
        "Other changes",
        "__other_changes__",
        filtered.filter((file) => !conflictSet.has(file.path)),
      ),
    ].filter((node) => node.fileCount);
  }, [filtered, conflictSet]);
  const visible = useMemo(
    () => visibleFileNodes(tree, collapsed),
    [tree, collapsed],
  );
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments) {
      const path = comment.attachedPath ?? comment.path;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return counts;
  }, [comments]);
  const activeId = visible.some(({ node }) => node.id === focusedId)
    ? focusedId
    : (visible.find(
        ({ node }) => node.type === "file" && node.path === selected,
      )?.node.id ??
      visible[0]?.node.id ??
      null);
  useEffect(() => {
    if (previousSelected.current === selected) return;
    previousSelected.current = selected;
    if (selected) {
      const ancestors = fileAncestorPaths(selected);
      setCollapsed(
        (previous) =>
          new Set(
            [...previous].filter(
              (path) =>
                !(
                  path === "group:__conflicts__" && conflictSet.has(selected)
                ) &&
                !(
                  path === "group:__other_changes__" &&
                  !conflictSet.has(selected)
                ) &&
                !ancestors.includes(path) &&
                !ancestors.some((ancestor) =>
                  path.endsWith(`:folder:${ancestor}`),
                ),
            ),
          ),
      );
    }
  }, [selected]);
  useEffect(() => {
    if (focusedId === activeId) return;
    const ownedFocus =
      treeElement.current?.contains(document.activeElement) ||
      (restoreRemovedFocus.current && document.activeElement === document.body);
    restoreRemovedFocus.current = false;
    setFocusedId(activeId);
    if (ownedFocus && activeId) rows.current.get(activeId)?.focus();
  }, [activeId, focusedId]);
  const focus = (id: string | undefined | null) => {
    if (!id) return;
    setFocusedId(id);
    rows.current.get(id)?.focus();
  };
  const rowRef = (id: string) => {
    let callback = rowRefs.current.get(id);
    if (!callback) {
      callback = (element) => {
        if (element) rows.current.set(id, element);
        else {
          if (document.activeElement === rows.current.get(id))
            restoreRemovedFocus.current = true;
          rows.current.delete(id);
        }
      };
      rowRefs.current.set(id, callback);
    }
    return callback;
  };
  const collapseKey = (node: ChangedFileNode) =>
    node.group || node.id.startsWith("__") ? node.id : node.path;
  const toggle = (node: ChangedFileNode) => {
    const key = collapseKey(node);
    const closing = !collapsed.has(key);
    if (
      closing &&
      focusedId?.startsWith("file:") &&
      focusedId.slice(5).startsWith(`${node.path}/`)
    )
      focus(node.id);
    if (
      closing &&
      focusedId?.startsWith("folder:") &&
      focusedId.slice(7).startsWith(`${node.path}/`)
    )
      focus(node.id);
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const activate = (node: ChangedFileNode) =>
    node.type === "folder" ? toggle(node) : onSelect(node.path);
  const keyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    node: ChangedFileNode,
  ) => {
    const index = visible.findIndex((entry) => entry.node.id === node.id),
      current = visible[index];
    const handled = [
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
      "Enter",
      " ",
      "*",
    ].includes(event.key);
    if (handled) event.preventDefault();
    switch (event.key) {
      case "ArrowDown":
        focus(visible[Math.min(index + 1, visible.length - 1)]?.node.id);
        break;
      case "ArrowUp":
        focus(visible[Math.max(index - 1, 0)]?.node.id);
        break;
      case "Home":
        focus(visible[0]?.node.id);
        break;
      case "End":
        focus(visible.at(-1)?.node.id);
        break;
      case "ArrowRight":
        if (node.type === "folder") {
          if (collapsed.has(collapseKey(node))) toggle(node);
          else focus(visible[index + 1]?.node.id);
        }
        break;
      case "ArrowLeft":
        if (node.type === "folder" && !collapsed.has(collapseKey(node)))
          toggle(node);
        else focus(current?.parentId);
        break;
      case "Enter":
      case " ":
        activate(node);
        break;
      case "*": {
        const siblings = visible
          .filter(
            (entry) =>
              entry.parentId === current?.parentId &&
              entry.node.type === "folder",
          )
          .map((entry) => collapseKey(entry.node));
        setCollapsed(
          (previous) =>
            new Set([...previous].filter((path) => !siblings.includes(path))),
        );
        break;
      }
      default:
        if (
          event.key.length === 1 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          const now = Date.now(),
            typed = event.key.toLocaleLowerCase();
          search.current = {
            text:
              now - search.current.time > 700
                ? typed
                : search.current.text + typed,
            time: now,
          };
          const term = [...search.current.text].every(
            (letter) => letter === typed,
          )
            ? typed
            : search.current.text;
          const ordered = [
            ...visible.slice(index + 1),
            ...visible.slice(0, index + 1),
          ];
          focus(
            ordered.find(({ node: candidate }) =>
              candidate.name.toLocaleLowerCase().startsWith(term),
            )?.node.id,
          );
          event.preventDefault();
        }
    }
  };
  const renderNodes = (
    nodes: ChangedFileNode[],
    level: number,
  ): React.ReactNode =>
    nodes.map((node, position) => {
      const isFolder = node.type === "folder",
        expanded = !collapsed.has(collapseKey(node)),
        isReviewed = reviewed.has(node.path),
        notes = commentCounts.get(node.path) ?? 0,
        groupId = `${headingId}-${encodeURIComponent(node.id)}`,
        unavailableKind =
          node.file && !["text", "conflict"].includes(node.file.kind)
            ? node.file.kind
            : null;
      const label = isFolder
        ? `${node.group ? node.name : `Folder ${node.path}`}, ${node.fileCount} changed ${node.fileCount === 1 ? "file" : "files"}, ${countsLabel(node)}`
        : `${node.path}, ${statusNames[node.file?.status ?? ""] ?? node.file?.status ?? "Changed"}, ${countsLabel(node)}, ${isReviewed ? "reviewed" : "unreviewed"}${notes ? `, ${notes} ${notes === 1 ? "comment" : "comments"}` : ""}${node.file?.oldPath ? `, renamed from ${node.file.oldPath}` : ""}${unavailableKind ? `, ${unavailableKind}: source display unavailable` : conflictSet.has(node.path) ? ", conflict: resolve and stage in the working tree" : ""}`;
      return (
        <div role="none" key={node.id}>
          <button
            ref={rowRef(node.id)}
            role="treeitem"
            data-path={node.path}
            data-kind={node.type}
            aria-label={label}
            aria-level={level}
            aria-posinset={position + 1}
            aria-setsize={nodes.length}
            aria-expanded={isFolder ? expanded : undefined}
            aria-owns={isFolder && expanded ? groupId : undefined}
            aria-selected={isFolder ? undefined : selected === node.path}
            tabIndex={activeId === node.id ? 0 : -1}
            className={`changed-tree-row ${isFolder ? "changed-tree-folder" : "changed-tree-file"}${!isFolder && selected === node.path ? " active" : ""}`}
            style={{ "--tree-level": level } as React.CSSProperties}
            title={
              isFolder
                ? `${expanded ? "Collapse" : "Expand"} ${node.path}`
                : `${node.path}${node.file?.oldPath ? ` (renamed from ${node.file.oldPath})` : ""}`
            }
            onFocus={() => setFocusedId(node.id)}
            onClick={() => activate(node)}
            onKeyDown={(event) => keyDown(event, node)}
          >
            <span className="changed-tree-icon" aria-hidden="true">
              {isFolder ? (
                <svg
                  className={`changed-tree-chevron${expanded ? " expanded" : ""}`}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="m6 3 5 5-5 5" />
                </svg>
              ) : (
                <span
                  className={`changed-tree-status changed-tree-status-${node.file?.status[0]}`}
                  title={statusNames[node.file?.status[0] ?? ""] ?? "Changed"}
                />
              )}
            </span>
            {isFolder ? (
              <svg
                className="changed-tree-folder-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                <path d="M3 7h18" />
              </svg>
            ) : (
              <FileIcon name={node.name} />
            )}
            <span className="changed-tree-name">
              <span>{node.name}</span>
              {node.file?.oldPath && (
                <small>Renamed from {node.file.oldPath}</small>
              )}
            </span>
            {!isFolder && (unavailableKind || notes > 0 || isReviewed) && (
              <span className="changed-tree-badges" aria-hidden="true">
                {unavailableKind && (
                  <span
                    className="changed-tree-kind"
                    title={`${unavailableKind}: source display unavailable`}
                  >
                    {unavailableKind}
                  </span>
                )}
                {notes > 0 && (
                  <span className="changed-tree-comment">◌ {notes}</span>
                )}
                {isReviewed && <span className="changed-tree-reviewed">✓</span>}
              </span>
            )}
            {!isFolder && conflictSet.has(node.path) ? (
              <span className="conflict-badge" aria-label="Conflict">
                !
              </span>
            ) : isFolder && node.group ? (
              <span className="group-count">{node.fileCount}</span>
            ) : (
              <Counts node={node} />
            )}
          </button>
          {isFolder && expanded && (
            <div
              role="group"
              id={groupId}
              style={{ "--tree-level": level } as React.CSSProperties}
            >
              {renderNodes(node.children, level + 1)}
            </div>
          )}
        </div>
      );
    });
  return (
    <section className="changed-file-tree" aria-labelledby={headingId}>
      <div className="changed-tree-heading">
        <h2 id={headingId}>Changed files</h2>
        <span>{files.length}</span>
      </div>
      <input
        className="changed-tree-search"
        aria-label="Filter files"
        placeholder="⌕ Filter files…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading && (
        <p className="changed-tree-message" role="status">
          Refreshing changed files…
        </p>
      )}
      {visible.length > 0 ? (
        <div
          className="changed-tree-items"
          role="tree"
          aria-label="Changed files"
          aria-busy={loading}
          ref={treeElement}
        >
          {renderNodes(tree, 1)}
        </div>
      ) : (
        !loading && (
          <p className="changed-tree-message">
            {!files.length
              ? "No changed files"
              : filter === "unreviewed"
                ? "All changed files are reviewed"
                : "No reviewed files yet"}
          </p>
        )
      )}
      <div className="changed-tree-toolbar">
        <span>
          {reviewedCount} of {files.length} reviewed
        </span>
        <select
          aria-label="Changed file filter"
          value={filter}
          onChange={(event) => {
            const next = event.target.value as ChangedFileFilter;
            if (controlledFilter === undefined) setLocalFilter(next);
            onFilterChange?.(next);
          }}
        >
          <option value="all">All</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="reviewed">Reviewed</option>
        </select>
      </div>
    </section>
  );
}
