// @vitest-environment jsdom
import React from "react";
import { test, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import AgentPanel from "../apps/web/src/components/AgentPanel.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("Send freezes export target/profile and selected current IDs; Stop owns returned run", async () => {
  const calls: any[] = [];
  const target = { branch: "main", head: "abc", worktreeRoot: "/fixture" };
  const profile = { effective: { locator: "exact", digest: "d" }, revision: 4 };
  vi.stubGlobal("fetch", async (url: string, opts: any = {}) => {
    calls.push({ url, body: opts.body && JSON.parse(opts.body) });
    let data: any = {};
    if (url === "/api/agents")
      data = {
        agents: [{ id: "codex", available: true }],
        writesEnabled: true,
      };
    if (url === "/api/skills")
      data = { skills: [{ name: "Exact", locator: "exact", digest: "d" }] };
    if (url.includes("/export?")) data = { target, profile };
    if (opts.method === "POST" && url.endsWith("/agents"))
      data = { id: "run", status: "running" };
    if (url.endsWith("/stop")) data = { id: "run", status: "stopped" };
    return { ok: true, json: async () => data };
  });
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: any;
      close() {}
    },
  );
  render(
    <AgentPanel
      repositoryId="repo"
      reviewId="rev"
      comments={[
        { id: "current", status: "open", attachment: "current" } as any,
        { id: "old", status: "open", attachment: "outdated" } as any,
      ]}
      profile={profile as any}
      onProfile={() => {}}
    />,
  );
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send to agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  await screen.findByText(/installed agent may read and transmit/i);
  fireEvent.click(screen.getByRole("button", { name: "Confirm Send" }));
  await waitFor(() =>
    expect(
      calls.find((c) => c.url.endsWith("/agents") && c.body)?.body,
    ).toEqual({
      adapter: "codex",
      reviewId: "rev",
      commentIds: ["current"],
      expected: { target, profile },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Stop agent" }));
  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith("/run/stop"))).toBe(true),
  );
});

test("active Stop and output survive a same-repository review refresh", async () => {
  const calls: string[] = [];
  let streamReady = false;
  let message: (e: any) => void = () => {};
  const profile: any = {
    effective: { locator: "exact", digest: "d" },
    revision: 1,
  };
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: any;
      onerror: any;
      constructor() {
        streamReady = true;
        message = (e) => this.onmessage?.(e);
      }
      close() {}
    },
  );
  vi.stubGlobal("fetch", async (url: string, opts: any = {}) => {
    calls.push(url);
    let data: any = {};
    if (url === "/api/agents")
      data = {
        agents: [{ id: "codex", available: true }],
        writesEnabled: true,
      };
    else if (url === "/api/skills")
      data = { skills: [{ name: "Exact", locator: "exact", digest: "d" }] };
    else if (url.includes("/export?"))
      data = {
        target: { branch: "main", head: "abc", worktreeRoot: "/fixture" },
        profile,
      };
    else if (url.endsWith("/agents")) data = { id: "run", status: "running" };
    else if (url.endsWith("/stop")) data = { id: "run", status: "stopped" };
    return { ok: true, json: async () => data };
  });
  const props = {
    repositoryId: "repo",
    reviewId: "old",
    comments: [{ id: "note", status: "open", attachment: "current" } as any],
    profile,
    onProfile: () => {},
  };
  const view = render(<AgentPanel {...props} />);
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send to agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm Send" }));
  await screen.findByRole("button", { name: "Stop agent" });
  await waitFor(() => expect(streamReady).toBe(true));
  message({ data: JSON.stringify({ type: "output", text: "fixture output" }) });
  await screen.findByText("fixture output");
  view.rerender(<AgentPanel {...props} reviewId="new" />);
  expect(screen.getByText("fixture output")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
  await waitFor(() =>
    expect(calls.includes("/api/repositories/repo/agents/run/stop")).toBe(true),
  );
});

test("late export from previous context cannot expose confirmation in new context", async () => {
  let finish: (v: any) => void = () => {};
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/export?")) return await new Promise((r) => (finish = r));
    const data =
      url === "/api/agents"
        ? { agents: [{ id: "codex", available: true }], writesEnabled: true }
        : { skills: [{ name: "Exact", locator: "exact", digest: "d" }] };
    return { ok: true, json: async () => data };
  });
  const props = {
    repositoryId: "repo",
    reviewId: "old",
    comments: [{ id: "note", status: "open", attachment: "current" } as any],
    profile: {
      effective: { locator: "exact", digest: "d" },
      revision: 1,
    } as any,
    onProfile: () => {},
  };
  const view = render(<AgentPanel {...props} />);
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send to agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  view.rerender(<AgentPanel {...props} repositoryId="other" reviewId="new" />);
  finish({
    ok: true,
    json: async () => ({ target: {}, profile: props.profile }),
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("button", { name: "Confirm Send" })).toBeNull();
});

test("unknown provider is explicit and confirmation traps focus and Escape restores Send", async () => {
  const profile: any = {
    effective: { locator: "exact", digest: "d" },
    revision: 1,
  };
  const changes: boolean[] = [];
  vi.stubGlobal("fetch", async (url: string) => ({
    ok: true,
    json: async () =>
      url === "/api/agents"
        ? { agents: [{ id: "codex", available: true }], writesEnabled: true }
        : url === "/api/skills"
          ? { skills: [{ name: "Exact", locator: "exact", digest: "d" }] }
          : {
              target: { branch: "main", head: "abc", worktreeRoot: "/fixture" },
              profile,
            },
  }));
  render(
    <>
      <input aria-label="Outside input" />
      <AgentPanel
        repositoryId="repo"
        reviewId="rev"
        comments={[
          { id: "note", status: "open", attachment: "current" } as any,
        ]}
        profile={profile}
        onProfile={() => {}}
        {...({
          onDialogChange: (value: boolean) => changes.push(value),
        } as any)}
      />
    </>,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send to agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  const send = screen.getByRole("button", { name: "Send to agent" });
  // Native browsers move focus away while the initiating Send is disabled.
  screen.getByLabelText("Outside input").focus();
  fireEvent.click(send);
  const dialog = await screen.findByRole("dialog", {
    name: "Confirm agent transmission",
  });
  expect(dialog.textContent).toContain(
    "Provider identity unknown; uses local Codex CLI settings",
  );
  expect(dialog.contains(document.activeElement)).toBe(true);
  screen.getByLabelText("Outside input").focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(send);
  expect(changes).toContain(true);
  expect(changes.at(-1)).toBe(false);
});

test("fixture provider label is frozen with export confirmation and never added to AgentStart", async () => {
  const profile: any = {
    effective: { locator: "exact", digest: "d" },
    revision: 1,
  };
  const provider = { identity: "fixture", label: "Fixture only — no provider" };
  const requests: any[] = [];
  vi.stubGlobal("fetch", async (url: string, opts: any = {}) => {
    if (opts.body) requests.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () =>
        url === "/api/agents"
          ? {
              agents: [{ id: "codex", available: true, provider }],
              writesEnabled: true,
            }
          : url === "/api/skills"
            ? { skills: [{ name: "Exact", locator: "exact", digest: "d" }] }
            : opts.method === "POST"
              ? { id: "run", status: "completed" }
              : {
                  target: {
                    branch: "main",
                    head: "abc",
                    worktreeRoot: "/fixture",
                  },
                  profile,
                },
    };
  });
  const view = render(
    <AgentPanel
      repositoryId="repo"
      reviewId="rev"
      comments={[{ id: "note", status: "open", attachment: "current" } as any]}
      profile={profile}
      onProfile={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send to agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Fixture only — no provider");
  provider.label = "Changed after confirmation";
  view.rerender(
    <AgentPanel
      repositoryId="repo"
      reviewId="rev"
      comments={[{ id: "note", status: "open", attachment: "current" } as any]}
      profile={profile}
      onProfile={() => {}}
    />,
  );
  expect(dialog.textContent).toContain("Fixture only — no provider");
  fireEvent.click(screen.getByRole("button", { name: "Confirm Send" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(Object.keys(requests[0]).sort()).toEqual([
    "adapter",
    "commentIds",
    "expected",
    "reviewId",
  ]);
});
test("adapter selection exposes truthful Claude permissions and OpenCode process-list warning", async () => {
  vi.stubGlobal("fetch", async (url: string) => ({
    ok: true,
    json: async () =>
      url === "/api/agents"
        ? {
            agents: ["codex", "claude", "opencode"].map((id) => ({
              id,
              available: true,
            })),
            writesEnabled: true,
          }
        : { skills: [] },
  }));
  render(
    <AgentPanel
      repositoryId="repo"
      reviewId="r"
      comments={[]}
      profile={null}
      onProfile={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("option", { name: /opencode/i })).toBeTruthy(),
  );
  fireEvent.change(screen.getByLabelText("Agent adapter"), {
    target: { value: "opencode" },
  });
  expect(screen.getByText(/local process list/i)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Agent adapter"), {
    target: { value: "claude" },
  });
  expect(screen.getByText(/manual permissions/i)).toBeTruthy();
});
