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
import App from "../apps/web/src/App.js";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
function fixture() {
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, options: any = {}) => {
    let data: any = {};
    if (url === "/api/repositories")
      data = {
        repositories: [
          {
            id: "repo",
            root: "/fixture/project",
            projectId: "project",
            branch: "refs/heads/old-registration",
            head: "a",
          },
        ],
        selectedRepositoryId: "repo",
        base: "refs/remotes/origin/main",
      };
    else if (url.endsWith("/branches"))
      data = {
        localBranches: ["feature"],
        current: "refs/heads/feature",
        remoteBranches: ["refs/remotes/origin/main"],
      };
    else if (url.includes("/review?"))
      data = {
        id: "review",
        repositoryId: "repo",
        fingerprint: "f",
        branch: "refs/heads/feature",
        head: "a",
        mode: "full",
        files: [],
      };
    else if (url.includes("/comments")) data = { comments: [] };
    else if (url.includes("/reviewed")) data = { files: [] };
    else if (url.includes("/profiles")) data = { profiles: {}, revision: 0 };
    else if (url.endsWith("/sync"))
      data = {
        repositoryId: "repo",
        available: true,
        fetching: false,
        writesEnabled: true,
        autoFetchEnabled: true,
        actual: { branch: "refs/heads/feature", head: "a" },
        remotes: [
          {
            name: "origin",
            eligible: true,
            lastSuccessAt: null,
            lastError: null,
          },
        ],
        merge: {
          pending: false,
          mergeHeads: [],
          conflicts: [],
          canContinue: false,
        },
        error: null,
      };
    else if (url.endsWith("/remotes"))
      data = { remotes: [{ name: "origin" }, { name: "upstream" }] };
    else if (url.endsWith("/git-settings"))
      data = {
        defaultRemote:
          options.method === "PUT"
            ? JSON.parse(options.body).defaultRemote
            : "origin",
      };
    else if (url.endsWith("/sync-settings"))
      data = {
        autoFetchEnabled:
          options.method === "PUT"
            ? JSON.parse(options.body).autoFetchEnabled
            : true,
        intervalMs: 300000,
      };
    else if (url.endsWith("/project-settings"))
      data = {
        repositoryId: "repo",
        projectId: "project",
        revision: 0,
        settings: { startingFolder: "/fixture", adapter: "codex", skill: null },
      };
    if (options.method === "PUT" && !url.endsWith("/selection"))
      writes.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => data };
  });
  return writes;
}
test("Git Settings saves configured default remote and app-wide five-minute fetch toggle using exact contracts", async () => {
  const writes = fixture();
  render(<App />);
  await screen.findByText("No changes in this comparison.");
  fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
  const dialog = screen.getByRole("dialog", { name: "Project settings" });
  expect(
    within(dialog)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Project", "Git", "Agents", "Appearance"]);
  expect(await within(dialog).findByText("Push → origin/feature")).toBeTruthy();
  expect(within(dialog).queryByText(/old-registration/)).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Default remote"), {
    target: { value: "upstream" },
  });
  const toggle = within(dialog).getByRole("switch", {
    name: "Auto-fetch every 5 minutes",
  });
  await waitFor(() =>
    expect((toggle as HTMLInputElement).disabled).toBe(false),
  );
  fireEvent.click(toggle);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Save settings" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toContainEqual({
    url: "/api/repositories/repo/git-settings",
    body: { defaultRemote: "upstream" },
  });
  expect(writes).toContainEqual({
    url: "/api/sync-settings",
    body: { autoFetchEnabled: false },
  });
  fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
  expect(screen.getByText("Push → upstream/feature")).toBeTruthy();
});
