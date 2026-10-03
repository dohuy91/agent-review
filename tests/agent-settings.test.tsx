// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const project = {
  locator: "/repo/.agents/skills/fix/SKILL.md",
  digest: "a".repeat(64),
  name: "Review fixes",
  description: "Apply findings",
  source: "project",
  sourceRoot: "/repo/.agents/skills",
};
const global = {
  locator: "/global/debug/SKILL.md",
  digest: "b".repeat(64),
  name: "Debugging",
  description: "Find root causes",
  source: "global",
  sourceRoot: "/global",
};
async function renderSettings(fetcher: any, props: any = {}) {
  vi.stubGlobal("fetch", fetcher);
  const mod: any =
    await import("../apps/web/src/components/AgentSettings.js").catch(
      () => ({}),
    );
  const Component = mod.default ?? (() => <p>Settings unavailable</p>);
  return render(<Component repositoryId="repo" reviewId="review" {...props} />);
}
const response = (data: any) => ({ ok: true, json: async () => data });
test("settings group and search project/global skills and save only exact selected settings", async () => {
  const calls: any[] = [];
  const saved = vi.fn();
  await renderSettings(
    async (url: string, opts: any = {}) => {
      calls.push({ url, body: opts.body && JSON.parse(opts.body) });
      if (url === "/api/agents")
        return response({
          agents: [
            { id: "codex", available: true },
            { id: "claude", available: true },
          ],
        });
      if (opts.method === "PUT")
        return response({
          projectId: "project",
          repositoryId: "repo",
          revision: 1,
          settings: JSON.parse(opts.body).settings,
        });
      if (url.includes("/skills?"))
        return response({ startingFolder: "/repo", skills: [project, global] });
      return response({
        projectId: "project",
        repositoryId: "repo",
        revision: 0,
        settings: { startingFolder: "/repo", adapter: "codex", skill: null },
      });
    },
    { onSaved: saved },
  );
  await screen.findByText("Review fixes");
  expect(screen.getByText("Project skills")).toBeTruthy();
  expect(screen.getByText("Global skills")).toBeTruthy();
  expect(screen.getByText("Apply findings")).toBeTruthy();
  expect(screen.getByText("/global")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search project and global skills"), {
    target: { value: "root causes" },
  });
  expect(screen.queryByText("Review fixes")).toBeNull();
  expect(screen.getByText("Debugging")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Debugging/ }));
  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: "claude" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save for project" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(calls.find((c) => c.body)?.body).toEqual({
    reviewId: "review",
    expectedRevision: 0,
    settings: {
      startingFolder: "/repo",
      adapter: "claude",
      skill: { locator: global.locator, digest: global.digest },
    },
  });
});
test("starting folder chooser browses only server-offered folders and re-discovers skills before save", async () => {
  const calls: string[] = [];
  await renderSettings(async (url: string) => {
    calls.push(url);
    if (url === "/api/agents")
      return response({ agents: [{ id: "codex", available: true }] });
    if (url.includes("/agent-folders"))
      return response({
        root: "/repo",
        path: url.includes("%2Frepo%2Fsrc") ? "/repo/src" : "/repo",
        parent: url.includes("%2Frepo%2Fsrc") ? "/repo" : null,
        folders: url.includes("%2Frepo%2Fsrc")
          ? []
          : [{ name: "src", path: "/repo/src" }],
        truncated: false,
      });
    if (url.includes("/skills?"))
      return response({ startingFolder: "/repo", skills: [project] });
    return response({
      revision: 0,
      settings: {
        startingFolder: "/repo",
        adapter: "codex",
        skill: { locator: project.locator, digest: project.digest },
      },
    });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "src" }));
  await screen.findByText("/repo/src");
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  await waitFor(() =>
    expect(calls.some((u) => u.includes("startingFolder=%2Frepo%2Fsrc"))).toBe(
      true,
    ),
  );
  expect(
    (screen.getByLabelText("Starting folder") as HTMLInputElement).value,
  ).toBe("/repo/src");
  expect(
    (screen.getByLabelText("Starting folder") as HTMLInputElement).readOnly,
  ).toBe(true);
});
test("changing repositories ignores late settings and skills results", async () => {
  let resolve: any;
  const pending = new Promise((r) => (resolve = r));
  const view = await renderSettings(async (url: string) =>
    url.includes("/repo/project-settings")
      ? pending
      : url === "/api/agents"
        ? response({ agents: [] })
        : url.includes("/skills?")
          ? response({ skills: [] })
          : response({
              revision: 0,
              settings: {
                startingFolder: "/next",
                adapter: "codex",
                skill: null,
              },
            }),
  );
  const mod: any = await import("../apps/web/src/components/AgentSettings.js");
  expect(typeof mod.default).toBe("function");
  view.rerender(<mod.default repositoryId="next" reviewId="review2" />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Starting folder") as HTMLInputElement).value,
    ).toBe("/next"),
  );
  resolve(
    response({
      revision: 8,
      settings: { startingFolder: "/late", adapter: "claude", skill: null },
    }),
  );
  await Promise.resolve();
  expect(
    (screen.getByLabelText("Starting folder") as HTMLInputElement).value,
  ).toBe("/next");
});
