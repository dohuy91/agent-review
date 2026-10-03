// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import ChangedFileTree from "../apps/web/src/components/ChangedFileTree.js";
import { buildChangedFileTree } from "../apps/web/src/components/changed-file-tree.js";
import type {
  AttachedComment,
  ReviewFile,
} from "../packages/shared/src/index.js";

afterEach(cleanup);
const file = (
  path: string,
  addedLines: number | null = 2,
  deletedLines: number | null = 1,
): ReviewFile => ({
  path,
  oldPath: null,
  status: "M",
  kind: "text",
  fingerprint: path,
  oldOid: "old",
  newOid: "new",
  oldMode: "100644",
  newMode: "100644",
  addedLines,
  deletedLines,
});
const paths = () =>
  screen.getAllByRole("treeitem").map((row) => row.getAttribute("data-path"));
const item = (path: string) =>
  screen
    .getAllByRole("treeitem")
    .find((row) => row.getAttribute("data-path") === path)!;

test("tree groups nested Unicode paths, sorts folders before files and aggregates exact counts", () => {
  const tree = buildChangedFileTree([
    file("z.txt"),
    file("目录/nested/文件.ts", 4, 0),
    file("a.txt"),
    file("src/b.ts", 3, 2),
    file("src/a.ts", 0, 5),
  ]);
  expect(tree.map((node) => node.path)).toEqual([
    "src",
    "目录",
    "a.txt",
    "z.txt",
  ]);
  expect(tree[0]).toMatchObject({
    type: "folder",
    addedLines: 3,
    deletedLines: 7,
    fileCount: 2,
  });
  expect(tree[0]!.children.map((node) => node.path)).toEqual([
    "src/a.ts",
    "src/b.ts",
  ]);
  expect(tree[1]).toMatchObject({
    addedLines: 4,
    deletedLines: 0,
    fileCount: 1,
  });
});

test("file tree presents selected status, rename, reviewed/comment badges, and unavailable counters honestly", () => {
  const renamed = {
    ...file("src/renamed.ts", 4, 2),
    status: "R",
    oldPath: "old/name.ts",
  };
  const binary = {
    ...file("assets/binary", null, null),
    kind: "binary" as const,
  };
  const comments = [
    { id: "one", path: "old/name.ts", attachedPath: "src/renamed.ts" },
    { id: "two", path: "src/renamed.ts" },
  ] as AttachedComment[];
  render(
    <ChangedFileTree
      files={[renamed, binary]}
      selected={renamed.path}
      onSelect={vi.fn()}
      reviewed={new Set([renamed.path])}
      comments={comments}
    />,
  );
  expect(screen.getByRole("heading", { name: "Changed files" })).toBeTruthy();
  expect(screen.getByRole("tree", { name: "Changed files" })).toBeTruthy();
  expect(item(renamed.path).getAttribute("aria-selected")).toBe("true");
  expect(item(renamed.path).getAttribute("aria-label")).toMatch(
    /renamed.*4 lines added.*2 lines deleted.*reviewed.*2 comments/i,
  );
  expect(item(renamed.path).textContent).toContain("old/name.ts");
  expect(item(renamed.path).textContent).toContain("+4");
  expect(item(renamed.path).textContent).toContain("−2");
  expect(item(binary.path).textContent).toContain("—");
  expect(item("assets").textContent).not.toContain("+0");
});

test("collapse survives observation refresh and selected ancestors expand only when selection changes", () => {
  const files = [file("src/deep/a.ts"), file("src/deep/b.ts"), file("root.ts")];
  const props = { files, selected: "src/deep/a.ts", onSelect: vi.fn() };
  const view = render(<ChangedFileTree {...props} />);
  fireEvent.click(item("src"));
  expect(item("src").getAttribute("aria-expanded")).toBe("false");
  expect(paths()).toEqual(["src", "root.ts"]);
  view.rerender(
    <ChangedFileTree {...props} files={files.map((entry) => ({ ...entry }))} />,
  );
  expect(paths()).toEqual(["src", "root.ts"]);
  view.rerender(<ChangedFileTree {...props} selected="src/deep/b.ts" />);
  expect(paths()).toEqual([
    "src",
    "src/deep",
    "src/deep/a.ts",
    "src/deep/b.ts",
    "root.ts",
  ]);
  expect(item("src/deep/b.ts").getAttribute("aria-selected")).toBe("true");
  expect(props.onSelect).not.toHaveBeenCalled();
});

test("tree keyboard navigation uses one tab stop, folder arrows, home/end and explicit file activation", () => {
  const onSelect = vi.fn();
  render(
    <ChangedFileTree
      files={[file("src/a.ts"), file("src/deep/b.ts"), file("z.ts")]}
      selected="src/a.ts"
      onSelect={onSelect}
    />,
  );
  item("src/a.ts").focus();
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(item("src"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(paths()).toEqual(["src", "z.ts"]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(item("src/deep"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(item("src/deep/b.ts"));
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledWith("src/deep/b.ts");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(item("src/deep"));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(item("z.ts"));
  fireEvent.keyDown(document.activeElement!, { key: " " });
  expect(onSelect).toHaveBeenLastCalledWith("z.ts");
  expect(
    screen.getAllByRole("treeitem").filter((row) => row.tabIndex === 0),
  ).toHaveLength(1);
});

test("reviewed/all filters keep accurate visible folder counts and never auto-select files", () => {
  const onSelect = vi.fn();
  render(
    <ChangedFileTree
      files={[file("src/reviewed.ts", 5, 2), file("src/pending.ts", 3, 1)]}
      selected="src/pending.ts"
      reviewed={new Set(["src/reviewed.ts", "unrelated"])}
      onSelect={onSelect}
    />,
  );
  const filter = screen.getByRole("combobox", { name: "Changed file filter" });
  fireEvent.change(filter, { target: { value: "reviewed" } });
  expect(paths()).toEqual(["src", "src/reviewed.ts"]);
  expect(item("src").textContent).toContain("+5");
  fireEvent.change(filter, { target: { value: "unreviewed" } });
  expect(paths()).toEqual(["src", "src/pending.ts"]);
  expect(item("src").textContent).toContain("+3");
  fireEvent.change(filter, { target: { value: "all" } });
  expect(paths()).toEqual(["src", "src/pending.ts", "src/reviewed.ts"]);
  expect(screen.getByText("1 reviewed")).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();
});

test("keyboard typeahead reaches nested files and focus returns to folder when it closes", () => {
  render(
    <ChangedFileTree
      files={[file("src/alpha.ts"), file("src/beta.ts"), file("z.ts")]}
      selected="src/alpha.ts"
      onSelect={vi.fn()}
    />,
  );
  item("src/alpha.ts").focus();
  fireEvent.keyDown(document.activeElement!, { key: "b" });
  expect(document.activeElement).toBe(item("src/beta.ts"));
  fireEvent.click(item("src"));
  expect(document.activeElement).toBe(item("src"));
  expect(item("src").tabIndex).toBe(0);
});

test("unknown old-snapshot and invalid counters remain unknown in aggregate folders", () => {
  const unknown = { ...file("src/legacy.ts") };
  delete unknown.addedLines;
  delete unknown.deletedLines;
  const invalid = file("src/invalid.ts", Infinity, -1);
  const tree = buildChangedFileTree([
    unknown,
    invalid,
    file("src/known.ts", 4, 2),
  ]);
  expect(tree[0]).toMatchObject({
    addedLines: null,
    deletedLines: null,
    fileCount: 3,
  });
  render(
    <ChangedFileTree
      files={[unknown, invalid]}
      selected={null}
      onSelect={vi.fn()}
    />,
  );
  expect(item("src").getAttribute("aria-label")).toContain(
    "Line counts unavailable",
  );
  expect(item("src/legacy.ts").textContent).not.toContain("+0");
});

test("empty filters/loading have clear states and changing files never steals external focus", () => {
  const onSelect = vi.fn();
  const props = {
    files: [file("a.ts")],
    selected: "a.ts",
    onSelect,
    reviewed: new Set(["a.ts"]),
  };
  const view = render(<ChangedFileTree {...props} />);
  const filter = screen.getByRole("combobox", { name: "Changed file filter" });
  filter.focus();
  fireEvent.change(filter, { target: { value: "unreviewed" } });
  expect(screen.getByText("All changed files are reviewed")).toBeTruthy();
  expect(document.activeElement).toBe(filter);
  view.rerender(<ChangedFileTree {...props} files={[]} loading />);
  expect(screen.getByRole("status").textContent).toContain(
    "Refreshing changed files",
  );
  expect(onSelect).not.toHaveBeenCalled();
});

test("refresh that removes the focused file preserves keyboard focus within the remaining tree", () => {
  const onSelect = vi.fn();
  const view = render(
    <ChangedFileTree
      files={[file("src/a.ts"), file("src/b.ts")]}
      selected="src/a.ts"
      onSelect={onSelect}
    />,
  );
  item("src/a.ts").focus();
  view.rerender(
    <ChangedFileTree
      files={[file("src/b.ts")]}
      selected="src/a.ts"
      onSelect={onSelect}
    />,
  );
  expect(document.activeElement).toBe(item("src"));
  expect(onSelect).not.toHaveBeenCalled();
});

test("refresh does not restore tree focus after the user deliberately blurs it", () => {
  const files = [file("src/a.ts"), file("src/b.ts")];
  const view = render(
    <ChangedFileTree files={files} selected="src/a.ts" onSelect={vi.fn()} />,
  );
  item("src/a.ts").focus();
  view.rerender(
    <ChangedFileTree
      files={files.map((entry) => ({ ...entry }))}
      selected="src/a.ts"
      onSelect={vi.fn()}
    />,
  );
  item("src/a.ts").blur();
  view.rerender(
    <ChangedFileTree
      files={[files[1]!]}
      selected="src/a.ts"
      onSelect={vi.fn()}
    />,
  );
  expect(document.activeElement).toBe(document.body);
});

test("expanded folder treeitems own their child group for assistive technologies", () => {
  render(
    <ChangedFileTree
      files={[file("src/deep/a.ts")]}
      selected={null}
      onSelect={vi.fn()}
    />,
  );
  const groupId = item("src").getAttribute("aria-owns");
  expect(groupId).toBeTruthy();
  expect(document.getElementById(groupId!)?.getAttribute("role")).toBe("group");
  fireEvent.click(item("src"));
  expect(item("src").hasAttribute("aria-owns")).toBe(false);
});

test("folder ownership is a single stable collision-free IDREF for spaces, Unicode and punctuation", () => {
  const files = [file("my folder/目录 %?#[x]/a.ts"), file("my%20folder/b.ts")];
  const props = { files, selected: null, onSelect: vi.fn() };
  const view = render(
    <>
      <ChangedFileTree {...props} />
      <ChangedFileTree {...props} />
    </>,
  );
  const ownership = () =>
    screen
      .getAllByRole("treeitem")
      .filter((row) => row.dataset.kind === "folder")
      .map((row) => row.getAttribute("aria-owns")!);
  const ids = ownership();
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id.split(/\s+/)).toHaveLength(1);
    const group = document.getElementById(id)!;
    expect(group.getAttribute("role")).toBe("group");
    expect(within(group).getAllByRole("treeitem").length).toBeGreaterThan(0);
  }
  view.rerender(
    <>
      <ChangedFileTree {...props} files={[...files].reverse()} />
      <ChangedFileTree {...props} files={[...files].reverse()} />
    </>,
  );
  expect(ownership()).toEqual(ids);
});

test.each([
  "binary",
  "symlink",
  "submodule",
  "conflict",
  "unsupported",
] as const)(
  "%s files expose a compact kind badge and accessible unavailable-source indication",
  (kind) => {
    const source = { ...file("src/special", null, null), kind };
    render(
      <ChangedFileTree
        files={[source]}
        selected={source.path}
        onSelect={vi.fn()}
      />,
    );
    const row = item(source.path);
    expect(row.getAttribute("aria-label")).toContain(
      `${kind}: source display unavailable`,
    );
    expect(row.querySelector(".changed-tree-kind")?.textContent).toBe(kind);
    expect(row.textContent).toContain("—");
  },
);
