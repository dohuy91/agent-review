// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import SyncActions from "../apps/web/src/components/SyncActions.js";
import type { Repository } from "../packages/shared/src/index.js";
import type {
  PullPreview,
  RepositorySync,
} from "../packages/shared/src/sync.js";
const repository = {
  id: "repo",
  root: "/fixture/repo",
  branch: "refs/heads/feature",
  head: "a".repeat(40),
} as Repository;
const sync: RepositorySync = {
  repositoryId: "repo",
  available: true,
  fetching: false,
  writesEnabled: true,
  autoFetchEnabled: true,
  actual: { branch: repository.branch, head: repository.head },
  remotes: [],
  merge: {
    pending: false,
    mergeHeads: [],
    conflicts: [],
    canContinue: false,
    reason: null,
  },
  error: null,
};
const plan = (): PullPreview => ({
  previewId: "exact",
  repositoryId: "repo",
  worktreeRoot: repository.root,
  localBranch: repository.branch!,
  localHead: repository.head,
  comparisonRef: "refs/remotes/origin/main",
  comparisonHead: "b".repeat(40),
  remote: "origin",
  operation: "merge",
  expiresAt: new Date(Date.now() + 300000).toISOString(),
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup(preview = plan()) {
  const requests: any[] = [],
    onChanged = vi.fn();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("preview")
          ? preview
          : { ok: true, outcome: "merged", sync },
    };
  });
  const props = {
    repository,
    comparisonRef: plan().comparisonRef,
    sync,
    disabled: false,
    onChanged,
    onDialogChange: vi.fn(),
  };
  const view = render(<SyncActions {...props} />);
  return { ...view, props, requests, onChanged };
}
test("Pull previews and confirms exact actual worktree using a frozen preview id", async () => {
  const { requests, onChanged } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm pull" });
  expect(requests).toEqual([
    {
      url: "/api/repositories/repo/pull-preview",
      body: { comparisonRef: "refs/remotes/origin/main" },
    },
  ]);
  expect(within(dialog).getByText(repository.root)).toBeTruthy();
  expect(within(dialog).getByText("b".repeat(40))).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm pull" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(requests[1]).toEqual({
    url: "/api/repositories/repo/pull",
    body: { previewId: "exact", confirmed: true },
  });
});
test("mismatched or expired Pull previews never execute", async () => {
  const { requests } = setup({ ...plan(), repositoryId: "other" });
  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /does not match/,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests).toHaveLength(1);
});
test("project navigation cannot replay a late Pull preview against another target", async () => {
  const { props, rerender, requests } = setup();
  let release!: (response: any) => void;
  vi.stubGlobal(
    "fetch",
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  rerender(
    <SyncActions
      {...props}
      repository={{ ...repository, id: "other" }}
      sync={null}
    />,
  );
  release({ ok: true, status: 200, json: async () => plan() });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Pull" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests).toHaveLength(0);
});
