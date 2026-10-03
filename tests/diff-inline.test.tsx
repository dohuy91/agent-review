// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import DiffView, {
  type Selection,
} from "../apps/web/src/components/DiffView.js";
import type {
  AttachedComment,
  CommentSide,
  FileDiff,
} from "../packages/shared/src/index.js";

afterEach(cleanup);

const diff: FileDiff = {
  reviewId: "review",
  path: "example.ts",
  fingerprint: "diff",
  oldContent: "/*\nold content\ncontinued comment\n*/ const done = true;",
  newContent: "/*\nnew content\ncontinued comment\n*/ const done = true;",
  contentFingerprint: "content",
  unsupportedReason: null,
  hunks: [
    {
      oldStart: 1,
      oldCount: 4,
      newStart: 1,
      newCount: 4,
      lines: [
        { type: "context", text: "/*", oldLine: 1, newLine: 1 },
        { type: "delete", text: "old content", oldLine: 2, newLine: null },
        { type: "add", text: "new content", oldLine: null, newLine: 2 },
        { type: "context", text: "continued comment", oldLine: 3, newLine: 3 },
        {
          type: "context",
          text: "*/ const done = true;",
          oldLine: 4,
          newLine: 4,
        },
      ],
    },
  ],
};
const range = (side: CommentSide): Selection => ({
  side,
  startLine: 1,
  endLine: 2,
  anchor: 1,
});
function note(overrides: Partial<AttachedComment> = {}): AttachedComment {
  return {
    id: "note",
    reviewId: "review",
    path: "example.ts",
    repositoryId: "repo",
    projectId: "project",
    worktreeRoot: "/fixture",
    mode: "working",
    base: "HEAD",
    mergeBase: "head",
    head: "head",
    branch: "main",
    reviewFingerprint: "review",
    fileFingerprint: "diff",
    sourceOid: "oid",
    anchor: { version: 1, selected: [], before: [], after: [] },
    side: "old",
    startLine: 10,
    endLine: 11,
    body: "Saved note",
    severity: "info",
    status: "open",
    createdAt: "now",
    updatedAt: "now",
    attachment: "current",
    attachedRange: { startLine: 1, endLine: 2 },
    historicalContent: "available",
    ...overrides,
  };
}
const defaults = {
  diff,
  split: false,
  dark: true,
  selection: null,
  onSelect: () => {},
};

// A misplaced hunk-bottom slot or wrong-side slot must fail these adjacency checks.
test.each(
  [false, true].flatMap((split) =>
    (["old", "new"] as const).map((side) => ({ split, side })),
  ),
)(
  "places React content below the $side range endpoint with split=$split",
  ({ split, side }) => {
    render(
      <DiffView
        {...defaults}
        split={split}
        selection={range(side)}
        inlineContent={<textarea aria-label="Inline body" />}
      />,
    );
    const slot = screen
      .getByLabelText("Inline body")
      .closest(".inline-diff-slot")!;
    expect(slot.getAttribute("data-side")).toBe(side);
    expect(slot.getAttribute("data-inline-end-line")).toBe("2");
    const row = slot.closest(".inline-diff-row")!;
    const preceding = row.previousElementSibling!;
    const following = row.nextElementSibling!;
    expect(
      within(preceding as HTMLElement).getByRole("button", {
        name: `${side} line 2`,
      }),
    ).toBeTruthy();
    expect(
      within(preceding as HTMLElement).queryByRole("button", {
        name: `${side} line 3`,
      }),
    ).toBeNull();
    expect(
      within(following as HTMLElement).getByRole("button", {
        name: `${side} line 3`,
      }),
    ).toBeTruthy();
    if (split) {
      expect(row.classList.contains("split-row")).toBe(true);
      expect(row.children).toHaveLength(2);
      expect(
        Array.from(row.children).map((child) =>
          child.getAttribute("data-side"),
        ),
      ).toEqual(["old", "new"]);
      expect(row.children[side === "old" ? 1 : 0].textContent).toBe("");
    }
  },
);

test("preserves multiline syntax context after an inline endpoint without duplicate hidden text", () => {
  render(
    <DiffView
      {...defaults}
      selection={range("new")}
      inlineContent={<div>Composer</div>}
    />,
  );
  const row = screen.getByText("Composer").closest(".inline-diff-row")!;
  const after = row.nextElementSibling!;
  const line = Array.from(after.querySelectorAll(".cm-line")).find(
    (line) => line.textContent === "continued comment",
  )!;
  expect(line).toBeTruthy();
  expect(getComputedStyle(line.querySelector("span")!).color).toBe(
    "rgb(135, 147, 167)",
  );
  expect(screen.getByTestId("diff").querySelectorAll(".cm-line")).toHaveLength(
    diff.hunks[0].lines.length,
  );
});

test("shows a keyboard inline trigger at selection, then retains gutter focus on content updates", async () => {
  const user = userEvent.setup(),
    onInlineComment = vi.fn();
  const view = render(
    <DiffView
      {...defaults}
      selection={range("old")}
      onInlineComment={onInlineComment}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Comment inline" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(onInlineComment).toHaveBeenCalledTimes(1);
  const gutter = screen.getByRole("button", { name: "old line 2" });
  gutter.focus();
  view.rerender(
    <DiffView
      {...defaults}
      selection={range("old")}
      onInlineComment={onInlineComment}
      inlineContent={<textarea aria-label="Inline body" />}
    />,
  );
  expect(screen.queryByRole("button", { name: "Comment inline" })).toBeNull();
  expect(document.activeElement).toBe(gutter);
  view.rerender(
    <DiffView
      {...defaults}
      selection={range("old")}
      inlineContent={
        <textarea aria-label="Inline body" defaultValue="Updated" />
      }
    />,
  );
  expect(document.activeElement).toBe(gutter);
});

test("explicit null or missing endpoint has no inline slot, and disabled keeps trigger guarded", () => {
  const onInlineComment = vi.fn();
  const view = render(
    <DiffView
      {...defaults}
      selection={range("old")}
      inlineSelection={null}
      inlineContent={<div>Hidden composer</div>}
      onInlineComment={onInlineComment}
    />,
  );
  expect(screen.queryByText("Hidden composer")).toBeNull();
  expect(screen.queryByRole("button", { name: "Comment inline" })).toBeNull();
  view.rerender(
    <DiffView
      {...defaults}
      selection={{ ...range("old"), endLine: 99 }}
      inlineContent={<div>Missing endpoint</div>}
    />,
  );
  expect(screen.queryByText("Missing endpoint")).toBeNull();
  view.rerender(
    <DiffView
      {...defaults}
      disabled
      selection={range("old")}
      onInlineComment={onInlineComment}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Comment inline" });
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(trigger);
  expect(onInlineComment).not.toHaveBeenCalled();
});

test.each([false, true])(
  "saved markers use attached endpoint and expand common renderer once, split=%s",
  (split) => {
    const current = note(),
      renderComment = vi.fn((comment: AttachedComment) => (
        <article>
          <p>{comment.body}</p>
          <button>Resolve shared note</button>
        </article>
      ));
    render(
      <DiffView
        {...defaults}
        split={split}
        comments={[current]}
        renderComment={renderComment}
      />,
    );
    const marker = screen.getByRole("button", {
      name: "old lines 1–2 · 1 note · open",
    });
    expect(marker.getAttribute("aria-expanded")).toBe("false");
    expect(
      marker.closest("[data-comment-id]")?.getAttribute("data-comment-id"),
    ).toBe("note");
    const row = marker.closest(".inline-diff-row")!;
    expect(
      within(row.previousElementSibling as HTMLElement).getByRole("button", {
        name: "old line 2",
      }),
    ).toBeTruthy();
    expect(renderComment).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Resolve shared note" }),
    ).toBeNull();
    fireEvent.click(marker);
    expect(marker.getAttribute("aria-expanded")).toBe("true");
    const controlled = document.getElementById(
      marker.getAttribute("aria-controls")!,
    );
    expect(controlled).toBeTruthy();
    expect(
      controlled?.contains(
        screen.getByRole("button", { name: "Resolve shared note" }),
      ),
    ).toBe(true);
    expect(renderComment).toHaveBeenCalledWith(current);
    expect(
      screen.getAllByRole("button", { name: "Resolve shared note" }),
    ).toHaveLength(1);
    fireEvent.click(marker);
    expect(screen.queryByText("Saved note")).toBeNull();
  },
);

test("markers filter stale/missing/different-file anchors and retain separate IDs and statuses", () => {
  render(
    <DiffView
      {...defaults}
      comments={[
        note(),
        note({ id: "resolved", status: "resolved" }),
        note({ id: "outdated", attachment: "outdated" }),
        note({ id: "missing", attachedRange: null }),
        note({ id: "outside", attachedRange: { startLine: 90, endLine: 91 } }),
        note({ id: "other", path: "other.ts" }),
        note({
          id: "renamed",
          path: "old-name.ts",
          attachedPath: "example.ts",
          side: "new",
        }),
      ]}
    />,
  );
  expect(
    screen.getByRole("button", { name: "old lines 1–2 · 1 note · resolved" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "new lines 1–2 · 1 note · open" }),
  ).toBeTruthy();
  const ids = Array.from(
    screen.getByTestId("diff").querySelectorAll("[data-comment-id]"),
  ).map((node) => node.getAttribute("data-comment-id"));
  expect(ids).toEqual(["note", "resolved", "renamed"]);
});

test("gutter keyboard selection keeps side-specific anchor and shift ranges", async () => {
  const user = userEvent.setup();
  function Controlled() {
    const [selection, onSelect] = useState<Selection | null>(null);
    return (
      <>
        <DiffView
          {...defaults}
          selection={selection}
          onSelect={onSelect}
          onInlineComment={() => {}}
        />
        <output>{JSON.stringify(selection)}</output>
      </>
    );
  }
  render(<Controlled />);
  screen.getByRole("button", { name: "old line 1" }).focus();
  await user.keyboard("{Enter}");
  screen.getByRole("button", { name: "old line 3" }).focus();
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(screen.getByRole("status").textContent).toBe(
    JSON.stringify({ side: "old", startLine: 1, endLine: 3, anchor: 1 }),
  );
  expect(document.activeElement?.getAttribute("aria-label")).toBe("old line 3");
  screen.getByRole("button", { name: "new line 2" }).focus();
  await user.keyboard("{Shift>} {/Shift}");
  expect(screen.getByRole("status").textContent).toBe(
    JSON.stringify({ side: "new", startLine: 2, endLine: 2, anchor: 2 }),
  );
});

test("disabled gutters and hunk mutation guards are unchanged with inline rows", () => {
  const onSelect = vi.fn(),
    run = vi.fn();
  render(
    <DiffView
      {...defaults}
      disabled
      onSelect={onSelect}
      selection={range("old")}
      inlineContent={<div>Draft</div>}
      hunkAction={{ label: "Stage", disabled: true, run }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1" }));
  expect(onSelect).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

test("a deliberate gutter blur is not undone by an inline rerender", () => {
  const view = render(
    <DiffView
      {...defaults}
      selection={range("old")}
      onInlineComment={() => {}}
    />,
  );
  const gutter = screen.getByRole("button", { name: "old line 2" });
  gutter.focus();
  gutter.blur();
  expect(document.activeElement).toBe(document.body);
  view.rerender(
    <DiffView
      {...defaults}
      selection={range("old")}
      inlineContent={<textarea aria-label="Inline body" />}
    />,
  );
  expect(document.activeElement).toBe(document.body);
});

test.each([1, 4])(
  "first/final endpoint %s adds no empty excerpt or duplicated text",
  (endLine) => {
    const selection = {
      side: "new" as const,
      startLine: endLine,
      endLine,
      anchor: endLine,
    };
    render(
      <DiffView
        {...defaults}
        split
        selection={selection}
        inlineContent={<div>Edge composer</div>}
      />,
    );
    const row = screen.getByText("Edge composer").closest(".inline-diff-row")!;
    expect(
      within(row.previousElementSibling as HTMLElement).getByRole("button", {
        name: `new line ${endLine}`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByTestId("diff").querySelectorAll(".cm-line"),
    ).toHaveLength(diff.hunks[0].lines.length * 2);
    if (endLine === 4) expect(row.nextElementSibling).toBeNull();
    else
      expect(
        within(row.nextElementSibling as HTMLElement).getByRole("button", {
          name: "new line 2",
        }),
      ).toBeTruthy();
  },
);

test("adjacent old/new endpoints keep every split placeholder line aligned", () => {
  render(
    <DiffView
      {...defaults}
      split
      comments={[note(), note({ id: "new", side: "new" })]}
    />,
  );
  const rows = screen.getByTestId("diff").querySelectorAll(".inline-diff-row");
  expect(rows).toHaveLength(2);
  expect(rows[0].children[0].textContent).toContain("old lines 1–2");
  expect(rows[0].children[1].textContent).toBe("");
  expect(rows[1].children[1].textContent).toContain("new lines 1–2");
  expect(rows[1].children[0].textContent).toBe("");
  const middle = rows[0].nextElementSibling!;
  expect(
    Array.from(middle.querySelectorAll(".cm-line")).map(
      (line) => line.textContent,
    ),
  ).toEqual(["", "new content"]);
  expect(screen.getByTestId("diff").querySelectorAll(".cm-line")).toHaveLength(
    diff.hunks[0].lines.length * 2,
  );
});

test("multiline template strings retain highlighting after the clipped prefix", () => {
  const strings: FileDiff = {
    ...diff,
    hunks: [
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
        lines: [
          {
            type: "context",
            text: "const text = `first",
            oldLine: 1,
            newLine: 1,
          },
          { type: "context", text: "second", oldLine: 2, newLine: 2 },
          { type: "context", text: "third`;", oldLine: 3, newLine: 3 },
        ],
      },
    ],
  };
  render(
    <DiffView
      {...defaults}
      diff={strings}
      selection={{ ...range("new"), endLine: 1 }}
      inlineContent={<div>String composer</div>}
    />,
  );
  const row = screen.getByText("String composer").closest(".inline-diff-row")!;
  const token = Array.from(
    row.nextElementSibling!.querySelectorAll(".cm-line span"),
  ).find((span) => span.textContent === "second")!;
  expect(token).toBeTruthy();
  expect(getComputedStyle(token).color).toBe("rgb(195, 220, 150)");
});

test("readonly historical markers can expand default content without mutation controls", () => {
  render(
    <DiffView
      {...defaults}
      disabled
      selection={range("old")}
      comments={[note()]}
    />,
  );
  expect(screen.queryByRole("button", { name: "Comment inline" })).toBeNull();
  const marker = screen.getByRole("button", {
    name: "old lines 1–2 · 1 note · open",
  });
  expect((marker as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(marker);
  expect(screen.getByText("Saved note")).toBeTruthy();
  for (const name of ["Edit", "Resolve", "Delete", "Save comment"])
    expect(screen.queryByRole("button", { name })).toBeNull();
});

test("CRLF conflict source keeps seven CodeMirror lines and exact inline partitions", () => {
  const rawLines = ["before", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> origin/main", "after"];
  const conflict: FileDiff = {...diff, oldContent: null, newContent: rawLines.join("\r\n") + "\r\n", hunks: [{oldStart: 0, oldCount: 0, newStart: 1, newCount: rawLines.length, lines: rawLines.map((text, index) => ({type: "add", text: text + "\r", oldLine: null, newLine: index + 1}))}]};
  const view = render(<DiffView {...defaults} diff={conflict}/>);
  expect([...screen.getByTestId("diff").querySelectorAll(".cm-line")].map((line) => line.textContent)).toEqual(rawLines);
  view.rerender(<DiffView {...defaults} diff={conflict} selection={{side: "new", startLine: 3, endLine: 3, anchor: 3}} inlineContent={<textarea aria-label="Conflict note"/>}/>);
  const row = screen.getByLabelText("Conflict note").closest(".inline-diff-row")!;
  expect([...row.previousElementSibling!.querySelectorAll(".cm-line")].map((line) => line.textContent)).toEqual(rawLines.slice(0, 3));
  expect([...row.nextElementSibling!.querySelectorAll(".cm-line")].map((line) => line.textContent)).toEqual(rawLines.slice(3));
  expect(screen.queryByRole("button", {name: "old line 1"})).toBeNull();
  expect(conflict.newContent).toBe(rawLines.join("\r\n") + "\r\n");
});
