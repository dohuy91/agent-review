// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  FetchStatus,
  useRepositorySync,
} from "../apps/web/src/components/SyncActions.js";
import type { RepositorySync } from "../packages/shared/src/sync.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const state = (
  repositoryId: string,
  lastSuccessAt: string | null = null,
  lastError: string | null = null,
): RepositorySync => ({
  repositoryId,
  available: true,
  fetching: false,
  writesEnabled: true,
  autoFetchEnabled: true,
  actual: { branch: "refs/heads/main", head: "unchanged" },
  remotes: [
    {
      name: "origin",
      eligible: true,
      reason: null,
      lastAttemptAt: lastSuccessAt,
      lastSuccessAt,
      lastError,
      nextAttemptAt: null,
    },
  ],
  merge: {
    pending: false,
    mergeHeads: [],
    conflicts: [],
    canContinue: false,
    reason: null,
  },
  error: null,
});
function Status({ repositoryId }: { repositoryId: string }) {
  const status = useRepositorySync(repositoryId);
  return <FetchStatus {...status} onFetch={() => void status.fetchAll()} />;
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
function reply(value: unknown) {
  return { ok: true, status: 200, json: async () => value };
}
test("status-only poll surfaces unchanged-ref background success and subsequent auth failure", async () => {
  vi.useFakeTimers();
  let value = state("repo");
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method || "GET" });
    return reply(value);
  });
  render(<Status repositoryId="repo" />);
  await settle();
  expect(screen.getByRole("status").textContent).toBe("Not fetched yet");
  value = state("repo", "2026-10-03T16:00:00Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(screen.getByRole("status").textContent).toMatch(/^Fetched /);
  value = state("repo", "2026-10-03T16:00:00Z", "Authentication unavailable");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(screen.getByRole("status").textContent).toBe("Fetch failed · origin");
  expect(calls).toEqual(
    Array.from({ length: 3 }, () => ({
      url: "/api/repositories/repo/sync",
      method: "GET",
    })),
  );
});
test("poll cleans up, avoids overlapping status reads and discards responses after project switch/unmount", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  let release!: (result: any) => void,
    held = false;
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (held && url.includes("/first/"))
      return new Promise((resolve) => {
        release = resolve;
      });
    return reply(state(url.includes("/first/") ? "first" : "second"));
  });
  const view = render(<Status repositoryId="first" />);
  await settle();
  held = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(calls).toHaveLength(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(calls).toHaveLength(2);
  view.rerender(<Status repositoryId="second" />);
  await settle();
  await act(async () => {
    release(reply(state("first", "2026-10-03T16:00:00Z", "Old project error")));
  });
  expect(screen.getByRole("status").textContent).toBe("Not fetched yet");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(calls.filter((url) => url.includes("/first/"))).toHaveLength(2);
  expect(calls.filter((url) => url.includes("/second/"))).toHaveLength(2);
  view.unmount();
  const count = calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(calls).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});
