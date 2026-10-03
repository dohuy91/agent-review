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
import PushActions, {
  comparisonDestination,
} from "../apps/web/src/components/PushActions.js";
import type {
  Repository,
  ReviewObservation,
} from "../packages/shared/src/index.js";
import type { PushPreview } from "../packages/shared/src/push.js";

const repository: Repository = {
  id: "repo",
  root: "/fixture",
  gitDir: "/fixture/.git",
  commonDir: "/fixture/.git",
  projectId: "project",
  branch: "refs/heads/main",
  head: "a".repeat(40),
};
const review: ReviewObservation = {
  id: "review",
  repositoryId: "repo",
  fingerprint: "fingerprint",
  base: "b".repeat(40),
  mergeBase: "b".repeat(40),
  branch: "refs/heads/topic/example",
  head: "c".repeat(40),
  targetRef: "refs/heads/topic/example",
  worktree: { branch: repository.branch, head: repository.head },
  executionEligible: false,
  mode: "branch",
  files: [],
};
function plan(overrides: Partial<PushPreview> = {}): PushPreview {
  return {
    previewId: "plan",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    repositoryId: "repo",
    reviewId: "review",
    reviewFingerprint: "fingerprint",
    localRef: review.branch!,
    sourceOid: review.head,
    worktree: review.worktree!,
    remote: "origin",
    recipient: {
      url: "https://push.example.test/team/repository.git",
      transport: "https",
    },
    destinationRef: review.branch!,
    destinationOid: "b".repeat(40),
    newBranch: false,
    upToDate: false,
    outgoing: {
      total: 1,
      commits: [
        {
          oid: review.head,
          subject: "Update synthetic feature",
          committedAt: "2026-10-03T00:00:00Z",
        },
      ],
      truncated: false,
    },
    ...overrides,
  };
}
function reply(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data } as Response;
}
function setup(preview = plan(), selectedReview = review) {
  const calls: { url: string; body: any }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    return reply(
      url.endsWith("push-preview")
        ? preview
        : {
            ok: true,
            outcome: "pushed",
            remote: preview.remote,
            recipient: preview.recipient,
            localRef: preview.localRef,
            sourceOid: preview.sourceOid,
            destinationRef: preview.destinationRef,
          },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const props = {
    repository,
    review: selectedReview,
    enabled: true,
    remotes: ["origin", "upstream"],
    comparisonDestinations: [
      {
        trackingRef: "refs/remotes/upstream/main",
        remote: "upstream",
        destinationRef: "refs/heads/main",
      },
      {
        trackingRef: "refs/remotes/origin/release/v2",
        remote: "origin",
        destinationRef: "refs/heads/release/v2",
      },
    ],
    onRefresh: vi.fn(),
    onDialogChange: vi.fn(),
  };
  const rendered = render(<PushActions {...props} />);
  return { calls, fetch, props, ...rendered };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("does no network on mount and confirms the exact selected non-worktree branch and push recipient", async () => {
  const { calls, props } = setup();
  expect(calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm push" });
  expect(calls[0]).toEqual({
    url: "/api/repositories/repo/push-preview",
    body: {
      reviewId: "review",
      localRef: "refs/heads/topic/example",
      remote: "origin",
      destinationRef: "refs/heads/topic/example",
      inspectRemote: true,
    },
  });
  expect(
    within(dialog).getByText("https://push.example.test/team/repository.git"),
  ).toBeTruthy();
  expect(within(dialog).getByText("Update synthetic feature")).toBeTruthy();
  expect(dialog.closest(".modal-backdrop")?.parentElement).toBe(document.body);
  expect(calls).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm push" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].body).toEqual({ previewId: "plan", confirmed: true });
  await screen.findByRole("status");
  expect(props.onRefresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("requires a new explicit plan after cancellation or mismatched target and never pushes", async () => {
  const { calls } = setup(plan({ sourceOid: "d".repeat(40) }));
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /does not match/i,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls).toHaveLength(1);
});

test("ignores an old preview after changing repository or unmounting", async () => {
  let resolve!: (response: Response) => void;
  const { fetch, rerender, props, unmount } = setup();
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  rerender(
    <PushActions
      {...props}
      repository={{ ...repository, id: "other" }}
      review={null}
      enabled={false}
    />,
  );
  resolve(reply(plan()));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  unmount();
  expect(props.onRefresh).not.toHaveBeenCalled();
});

test("reports uncertain transport outcomes without automatically retrying", async () => {
  const { fetch, calls } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog");
  fetch.mockImplementationOnce(async () => {
    throw new TypeError("network failed");
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm push" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /uncertain.*inspect.*remote/i,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(calls).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("preserves explicit rejection detail instead of replacing it with a generic 409", async () => {
  const { fetch } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog");
  fetch.mockResolvedValueOnce(
    reply(
      { error: "Remote rejected non-fast-forward push", outcome: "rejected" },
      409,
    ),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm push" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /rejected non-fast-forward/i,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("read-only, historical and detached contexts cannot preview", () => {
  const { rerender, props, calls } = setup();
  for (const overrides of [
    { enabled: false },
    { review: { ...review, historical: true } },
    { review: { ...review, targetRef: undefined, branch: null } },
  ]) {
    rerender(<PushActions {...props} {...overrides} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Preview push",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  }
  expect(calls).toHaveLength(0);
});

test("expired and up-to-date previews cannot transmit a push", async () => {
  const { calls } = setup(
    plan({
      upToDate: true,
      outgoing: { total: 0, commits: [], truncated: false },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Confirm push",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls).toHaveLength(1);
});

test("an already-expired plan is visibly blocked before transmission", async () => {
  const { calls } = setup(
    plan({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toMatch(/expired/i),
  );
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Confirm push",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(calls).toHaveLength(1);
});

test("same-name default uses the comparison remote, while comparison destination is a separate explicit option", async () => {
  const compared = { ...review, baseRef: "refs/remotes/upstream/main" };
  const { fetch, calls } = setup(plan({ remote: "upstream" }), compared);
  expect(
    (screen.getByLabelText("Push remote") as HTMLSelectElement).value,
  ).toBe("upstream");
  expect(
    (screen.getByLabelText("Push destination branch") as HTMLInputElement)
      .value,
  ).toBe("refs/heads/topic/example");
  expect(
    (screen.getByLabelText("Push to comparison branch") as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.click(screen.getByLabelText("Push to comparison branch"));
  expect(
    (screen.getByLabelText("Push destination branch") as HTMLInputElement)
      .value,
  ).toBe("refs/heads/main");
  expect(
    (screen.getByLabelText("Push remote") as HTMLSelectElement).disabled,
  ).toBe(true);
  fetch.mockResolvedValueOnce(
    reply(
      plan({
        remote: "upstream",
        destinationRef: "refs/heads/main",
        comparisonRef: compared.baseRef,
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog");
  expect(calls).toHaveLength(0); // One-shot mock still proves the request through fetch.
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
    remote: "upstream",
    localRef: "refs/heads/topic/example",
    destinationRef: "refs/heads/main",
    comparisonRef: compared.baseRef,
  });
  expect(
    within(dialog).getByText(/destination branch name differs/i),
  ).toBeTruthy();
  expect(within(dialog).getByText(/commonly protected branch/i)).toBeTruthy();
});

test("comparison destinations retain slash names and use exact configured remote names without local/SHA guesses", () => {
  expect(
    comparisonDestination(
      "refs/remotes/origin/topic/one",
      ["origin", "upstream"],
      [
        {
          trackingRef: "refs/remotes/origin/topic/one",
          remote: "origin",
          destinationRef: "refs/heads/release/topic/one",
        },
      ],
    ),
  ).toEqual({
    remote: "origin",
    destinationRef: "refs/heads/release/topic/one",
  });
  expect(
    comparisonDestination(
      "refs/remotes/team/upstream/topic/one",
      ["team", "team/upstream"],
      [
        {
          trackingRef: "refs/remotes/team/upstream/topic/one",
          remote: "team/upstream",
          destinationRef: "refs/heads/topic/one",
        },
      ],
    ),
  ).toEqual({
    remote: "team/upstream",
    destinationRef: "refs/heads/topic/one",
  });
  for (const base of [
    undefined,
    "refs/heads/main",
    "a".repeat(40),
    "refs/remotes/origin/HEAD",
    "refs/remotes/missing/main",
  ])
    expect(comparisonDestination(base, ["origin"])).toBeNull();
});

test("comparison selection is unavailable without unique authoritative mapping metadata", () => {
  const { props, rerender, calls } = setup(plan(), {
    ...review,
    baseRef: "refs/remotes/origin/main",
  });
  expect(
    (screen.getByLabelText("Push to comparison branch") as HTMLInputElement)
      .disabled,
  ).toBe(true);
  rerender(
    <PushActions
      {...props}
      comparisonDestinations={[
        {
          trackingRef: "refs/remotes/origin/main",
          remote: "origin",
          destinationRef: "refs/heads/main",
        },
        {
          trackingRef: "refs/remotes/origin/main",
          remote: "origin",
          destinationRef: "refs/heads/release",
        },
      ]}
    />,
  );
  expect(
    (screen.getByLabelText("Push to comparison branch") as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(calls).toHaveLength(0);
});

test("renamed comparison mapping selects its configured source and binds it to the preview", async () => {
  const compared = { ...review, baseRef: "refs/remotes/origin/main" };
  const { props, rerender, fetch } = setup(plan(), compared);
  rerender(
    <PushActions
      {...props}
      comparisonDestinations={[
        {
          trackingRef: compared.baseRef,
          remote: "origin",
          destinationRef: "refs/heads/release",
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByLabelText("Push to comparison branch"));
  expect(
    (screen.getByLabelText("Push destination branch") as HTMLInputElement)
      .value,
  ).toBe("refs/heads/release");
  fetch.mockResolvedValueOnce(
    reply(
      plan({
        destinationRef: "refs/heads/release",
        comparisonRef: compared.baseRef,
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  await screen.findByRole("dialog");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
    comparisonRef: compared.baseRef,
    destinationRef: "refs/heads/release",
  });
});

test("changing the comparison invalidates an open destination plan and restores the same-name default", async () => {
  const { props, rerender } = setup(plan({ remote: "upstream" }), {
    ...review,
    baseRef: "refs/remotes/upstream/main",
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  await screen.findByRole("dialog");
  rerender(
    <PushActions
      {...props}
      review={{
        ...review,
        id: "new-review",
        baseRef: "refs/remotes/origin/release/v2",
      }}
    />,
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    (screen.getByLabelText("Push remote") as HTMLSelectElement).value,
  ).toBe("origin");
  expect(
    (screen.getByLabelText("Push destination branch") as HTMLInputElement)
      .value,
  ).toBe(review.targetRef ?? review.branch);
});
