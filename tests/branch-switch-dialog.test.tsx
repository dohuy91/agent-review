// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import BranchSwitchDialog from "../apps/web/src/components/BranchSwitchDialog.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a late preview for an older repository and target cannot execute or replace the current decision", async () => {
  const calls: string[] = [];
  let release!: () => void;
  vi.stubGlobal("fetch", async (url: any) => {
    const route = String(url);
    calls.push(route);
    const data = {
      previewId: route.includes("/old/") ? "old-preview" : "new-preview",
      repositoryId: "new",
      reviewId: "new-review",
      expiresAt: "later",
      from: { branch: "refs/heads/main", head: "head" },
      target: { branch: "refs/heads/sibling", head: "next" },
      status: route.includes("/old/") ? "clean" : "dirty",
      dirty: { staged: [], unstaged: ["new-file.ts"], untracked: [] },
    };
    const response = { ok: true, json: async () => data };
    if (route.includes("/old/"))
      return new Promise((resolve) => {
        release = () => resolve(response);
      });
    return response;
  });
  const complete = vi.fn();
  const props = {
    repositoryId: "old",
    reviewId: "old-review",
    targetRef: "refs/heads/feature",
    onCancel: () => {},
    onComplete: complete,
    onSaved: async () => null,
    onOpenRepository: () => {},
  };
  const view = render(<BranchSwitchDialog {...props} />);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  view.rerender(
    <BranchSwitchDialog
      {...props}
      repositoryId="new"
      reviewId="new-review"
      targetRef="refs/heads/sibling"
    />,
  );
  await screen.findByText("new-file.ts");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.some((route) => route.endsWith("/branch-switch"))).toBe(false);
  expect(screen.getByText(/refs\/heads\/sibling/)).toBeTruthy();
  expect(complete).not.toHaveBeenCalled();
});
