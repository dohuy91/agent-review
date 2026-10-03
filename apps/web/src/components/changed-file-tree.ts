import type { ReviewFile } from "../../../../packages/shared/src/index.js";

export interface ChangedFileNode {
  id: string;
  type: "folder" | "file";
  name: string;
  path: string;
  file: ReviewFile | null;
  children: ChangedFileNode[];
  addedLines: number | null;
  deletedLines: number | null;
  fileCount: number;
}
export interface VisibleFileNode {
  node: ChangedFileNode;
  level: number;
  position: number;
  setSize: number;
  parentId: string | null;
}
function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function sumCounts(values: (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return finiteCount(values.reduce<number>((sum, value) => sum + value!, 0));
}
export function buildChangedFileTree(files: ReviewFile[]): ChangedFileNode[] {
  const roots: ChangedFileNode[] = [],
    folders = new Map<string, ChangedFileNode>();
  for (const file of files) {
    const parts = file.path.split("/");
    let children = roots;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let folder = folders.get(path);
      if (!folder) {
        folder = {
          id: `folder:${path}`,
          type: "folder",
          name: parts[i]!,
          path,
          file: null,
          children: [],
          addedLines: 0,
          deletedLines: 0,
          fileCount: 0,
        };
        folders.set(path, folder);
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({
      id: `file:${file.path}`,
      type: "file",
      name: parts.at(-1)!,
      path: file.path,
      file,
      children: [],
      fileCount: 1,
      addedLines: file.kind === "text" ? finiteCount(file.addedLines) : null,
      deletedLines:
        file.kind === "text" ? finiteCount(file.deletedLines) : null,
    });
  }
  const sort = (nodes: ChangedFileNode[]) => {
    nodes.sort((a, b) =>
      a.type !== b.type
        ? a.type === "folder"
          ? -1
          : 1
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0,
    );
    for (const node of nodes)
      if (node.type === "folder") {
        sort(node.children);
        node.fileCount = node.children.reduce(
          (sum, child) => sum + child.fileCount,
          0,
        );
        node.addedLines = sumCounts(
          node.children.map((child) => child.addedLines),
        );
        node.deletedLines = sumCounts(
          node.children.map((child) => child.deletedLines),
        );
      }
  };
  sort(roots);
  return roots;
}
export function visibleFileNodes(
  tree: ChangedFileNode[],
  collapsed: Set<string>,
): VisibleFileNode[] {
  const visible: VisibleFileNode[] = [];
  const visit = (
    nodes: ChangedFileNode[],
    level: number,
    parentId: string | null,
  ) => {
    nodes.forEach((node, position) => {
      visible.push({
        node,
        level,
        position: position + 1,
        setSize: nodes.length,
        parentId,
      });
      if (node.type === "folder" && !collapsed.has(node.path))
        visit(node.children, level + 1, node.id);
    });
  };
  visit(tree, 1, null);
  return visible;
}
export function fileAncestorPaths(path: string): string[] {
  const parts = path.split("/");
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
}
