// @vitest-environment jsdom
import React from "react";
import { test, expect, vi, afterEach } from "vitest";
import {
  act,
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
test("unverified OpenCode version shows actionable unavailable reason and blocks Send", async () => {
  const reason =
    "OpenCode unavailable: no-sharing control is verified only for 1.18.31; use that version or another adapter";
  vi.stubGlobal("fetch", async (url: string) => ({
    ok: true,
    json: async () =>
      url === "/api/agents"
        ? {
            agents: [
              {
                id: "opencode",
                available: false,
                version: "1.18.32",
                error: reason,
              },
            ],
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
  await screen.findByRole("option", { name: /opencode/i });
  fireEvent.change(screen.getByLabelText("Agent adapter"), {
    target: { value: "opencode" },
  });
  expect(screen.getByText(reason)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("compact toolbar opens comment selection and confirms exact project cwd and digest", async () => {
  const calls: any[] = [];
  const skill = {
    locator: "/repo/src/.agents/skills/fix/SKILL.md",
    digest: "c".repeat(64),
  };
  const execution = {
    startingFolder: "/repo/src",
    folderStamp: "stamp",
    settingsRevision: 3,
    adapter: "claude",
    skill,
  };
  const target = {
    branch: "feature",
    head: "abc",
    worktreeRoot: "/repo",
    projectId: "project",
  };
  const profile = { profiles: {}, effective: null, source: null, revision: 0 };
  vi.stubGlobal("fetch", async (url: string, opts: any = {}) => {
    if (opts.body) calls.push(JSON.parse(opts.body));
    let data: any = {};
    if (url === "/api/agents")
      data = {
        agents: [
          {
            id: "claude",
            available: true,
            provider: { identity: null, label: "Local Claude provider" },
          },
        ],
        writesEnabled: true,
      };
    else if (url.includes("/project-settings"))
      data = {
        revision: 3,
        settings: { startingFolder: "/repo/src", adapter: "claude", skill },
      };
    else if (url.includes("/skills?"))
      data = {
        skills: [
          {
            ...skill,
            name: "Fix",
            source: "project",
            sourceRoot: "/repo/src/.agents/skills",
          },
        ],
      };
    else if (url.includes("/agent-context?"))
      data = { target, profile, execution };
    else if (opts.method === "POST") data = { id: "run", status: "completed" };
    return { ok: true, json: async () => data };
  });
  render(
    <AgentPanel
      repositoryId="repo"
      reviewId="review"
      comments={[
        {
          id: "note",
          body: "Fix the issue",
          status: "open",
          attachment: "current",
        } as any,
      ]}
      profile={profile as any}
      {...({ compact: true, useProjectSettings: true } as any)}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Fix with Agent" });
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("checkbox"));
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
  const confirmation = await screen.findByRole("dialog", {
    name: "Confirm agent transmission",
  });
  expect(confirmation.textContent).toContain("/repo/src");
  expect(confirmation.textContent).toContain(skill.digest);
  expect(confirmation.textContent).toContain("project");
  expect(confirmation.textContent).toContain("Local Claude provider");
  expect(screen.queryByRole("dialog", { name: "Fix with Agent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Send" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual({
    adapter: "claude",
    reviewId: "review",
    commentIds: ["note"],
    expected: { target, profile, execution },
  });
  expect(document.activeElement).toBe(trigger);
});

test("closing compact selection invalidates pending preparation and does not reopen confirmation", async () => {
  let resolve: any;
  const pending = new Promise((r) => (resolve = r));
  const profile: any = {
    effective: { locator: "exact", digest: "d" },
    revision: 1,
  };
  vi.stubGlobal("fetch", async (url: string) =>
    url.includes("/export?")
      ? pending
      : {
          ok: true,
          json: async () =>
            url === "/api/agents"
              ? {
                  agents: [{ id: "codex", available: true }],
                  writesEnabled: true,
                }
              : { skills: [{ locator: "exact", digest: "d" }] },
        },
  );
  render(
    <AgentPanel
      repositoryId="repo"
      reviewId="review"
      comments={[
        {
          id: "note",
          body: "Fix",
          status: "open",
          attachment: "current",
        } as any,
      ]}
      profile={profile}
      compact
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
  fireEvent.click(await screen.findByRole("checkbox"));
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
  fireEvent.click(screen.getByRole("button", { name: "×" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  resolve({
    ok: true,
    json: async () => ({
      target: { branch: "main", head: "abc", worktreeRoot: "/repo" },
      profile,
    }),
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("compact selection keeps workspace dialog state active when profiles refresh", async () => {
  const states: boolean[] = [];
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({ skills: [], agents: [], writesEnabled: false }),
  }));
  const props = {
    repositoryId: "repo",
    reviewId: "review",
    comments: [],
    compact: true,
    onDialogChange: (open: boolean) => states.push(open),
  };
  const view = render(
    <AgentPanel
      {...props}
      profile={{ revision: 1, effective: null, profiles: {}, source: null }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
  expect(states.at(-1)).toBe(true);
  view.rerender(
    <AgentPanel
      {...props}
      profile={{ revision: 2, effective: null, profiles: {}, source: null }}
    />,
  );
  expect(screen.getByRole("dialog", { name: "Fix with Agent" })).toBeTruthy();
  expect(states.at(-1)).toBe(true);
});

for (const status of [409, 429, 503]) {
  test(`compact failed launch ${status} stays visible outside the dismissed dialog`, async () => {
    let rejectLaunch!: (response: any) => void;
    const pending = new Promise((resolve) => {
      rejectLaunch = resolve;
    });
    const profile: any = {
      effective: { locator: "exact", digest: "d" },
      revision: 1,
    };
    vi.stubGlobal("fetch", async (url: string, options: any = {}) => {
      if (options.method === "POST" && url.endsWith("/agents")) return pending;
      return {
        ok: true,
        json: async () =>
          url === "/api/agents"
            ? {
                agents: [{ id: "codex", available: true }],
                writesEnabled: true,
              }
            : url === "/api/skills"
              ? { skills: [{ locator: "exact", digest: "d" }] }
              : {
                  target: {
                    branch: "main",
                    head: "abc",
                    worktreeRoot: "/repo",
                  },
                  profile,
                },
      };
    });
    render(
      <AgentPanel
        repositoryId="repo"
        reviewId="review"
        comments={[
          {
            id: "note",
            body: "Fix",
            status: "open",
            attachment: "current",
          } as any,
        ]}
        profile={profile}
        compact
      />,
    );
    const trigger = screen.getByRole("button", { name: "Fix with Agent" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("checkbox"));
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Send" }),
    );
    if (status === 503) {
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("button", { name: "×" }));
    }
    rejectLaunch({
      ok: false,
      status,
      json: async () => ({
        error:
          status === 429 ? "Agent capacity reached" : "Provider unavailable",
      }),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      status === 409
        ? "Review changed"
        : status === 429
          ? "Agent capacity reached"
          : "Provider unavailable",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review agent setup" }));
    expect(screen.getByRole("dialog", { name: "Fix with Agent" })).toBeTruthy();
  });
}

async function compactRuntimeFixture(
  immediateFailure = false,
  delayedLaunch = false,
) {
  const streams: any[] = [],
    requests: any[] = [],
    stops: string[] = [];
  const pendingLaunches: (() => void)[] = [];
  const profile: any = {
    effective: { locator: "exact", digest: "d" },
    revision: 1,
  };
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: any;
      onerror: any;
      constructor(public url: string) {
        streams.push(this);
      }
      close() {}
    },
  );
  vi.stubGlobal("fetch", async (url: string, options: any = {}) => {
    let result: any;
    if (url === "/api/agents")
      result = {
        agents: [{ id: "codex", available: true }],
        writesEnabled: true,
      };
    else if (url === "/api/skills")
      result = { skills: [{ locator: "exact", digest: "d" }] };
    else if (options.method === "POST" && url.endsWith("/stop")) {
      stops.push(url);
      result = { id: "run-1", status: "stopped", error: null };
    } else if (options.method === "POST" && url.endsWith("/agents")) {
      requests.push(JSON.parse(options.body));
      result = {
        id: `run-${requests.length}`,
        status: immediateFailure ? "failed" : "running",
        error: immediateFailure ? "Unable to start codex" : null,
      };
    } else
      result = {
        target: { branch: "main", head: "abc", worktreeRoot: "/repo" },
        profile,
      };
    if (delayedLaunch && options.method === "POST" && url.endsWith("/agents"))
      return new Promise((resolve) =>
        pendingLaunches.push(() =>
          resolve({ ok: true, status: 201, json: async () => result }),
        ),
      );
    return { ok: true, status: 201, json: async () => result };
  });
  const props = {
    repositoryId: "repo",
    reviewId: "review",
    compact: true,
    comments: [
      { id: "note", body: "Fix", status: "open", attachment: "current" } as any,
    ],
    profile,
  };
  const view = render(<AgentPanel {...props} />);
  async function launch() {
    fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    if (!checkbox.checked) fireEvent.click(checkbox);
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Send" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
  return {
    streams,
    requests,
    stops,
    props,
    view,
    launch,
    releaseLaunch: () => pendingLaunches.shift()!(),
  };
}
for (const [status, error] of [
  [
    "needs-attention",
    "Permission denied; manual permissions require attention",
  ],
  ["failed", "Structured output event limit exceeded"],
] as const) {
  test(`compact accepted run SSE ${status} stays visible and recovery preserves output without restarting`, async () => {
    const f = await compactRuntimeFixture();
    await f.launch();
    await waitFor(() => expect(f.streams).toHaveLength(1));
    await act(async () => {
      f.streams[0].onmessage({
        data: JSON.stringify({ type: "output", text: "Owned agent output" }),
      });
      f.streams[0].onmessage({
        data: JSON.stringify({
          type: "status",
          run: { id: "run-1", status, error },
        }),
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain(error);
    expect(f.requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review agent run" }));
    expect(screen.getByRole("dialog", { name: "Fix with Agent" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(status);
    expect(screen.getByLabelText("Agent output").textContent).toBe(
      "Owned agent output",
    );
    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
    expect(f.requests).toHaveLength(1);
  });
}
test("compact 201 failed run is visible after confirmation closes", async () => {
  const f = await compactRuntimeFixture(true);
  await f.launch();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Unable to start codex",
  );
  expect(f.requests).toHaveLength(1);
  expect(f.streams).toHaveLength(0);
});
test("compact terminal run dismissal survives review refresh and does not suppress a different run", async () => {
  const f = await compactRuntimeFixture();
  await f.launch();
  await waitFor(() => expect(f.streams).toHaveLength(1));
  await act(async () =>
    f.streams[0].onmessage({
      data: JSON.stringify({
        type: "status",
        run: { id: "run-1", status: "failed", error: "First failure" },
      }),
    }),
  );
  await screen.findByRole("alert");
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss agent run alert" }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  f.view.rerender(<AgentPanel {...f.props} reviewId="refreshed" />);
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
  expect(screen.getByRole("status").textContent).toContain("failed");
  fireEvent.click(screen.getByRole("button", { name: "×" }));
  expect(screen.queryByRole("alert")).toBeNull();
  await f.launch();
  await waitFor(() => expect(f.streams).toHaveLength(2));
  await act(async () =>
    f.streams[1].onmessage({
      data: JSON.stringify({
        type: "status",
        run: {
          id: "run-2",
          status: "needs-attention",
          error: "New permission denial",
        },
      }),
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "New permission denial",
  );
  expect(f.requests).toHaveLength(2);
});

test("compact active run survives A to B to A project navigation and stale A events cannot replace B", async () => {
  const f = await compactRuntimeFixture();
  await f.launch();
  await waitFor(() => expect(f.streams).toHaveLength(1));
  await act(async () =>
    f.streams[0].onmessage({
      data: JSON.stringify({ type: "output", text: "A output" }),
    }),
  );
  f.view.rerender(
    <AgentPanel
      {...f.props}
      repositoryId="project-b"
      reviewId="review-b"
      comments={[]}
    />,
  );
  await act(async () => {
    f.streams[0].onmessage({
      data: JSON.stringify({
        type: "status",
        run: { id: "run-1", status: "failed", error: "Stale A event" },
      }),
    });
    f.streams[0].onmessage({
      data: JSON.stringify({ type: "output", text: "Stale A output" }),
    });
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Fix with Agent" }).textContent,
  ).not.toContain("Running");
  expect(
    f.streams.filter(
      (stream) =>
        stream.url.includes("project-b") && stream.url.includes("run-1"),
    ),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
  expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
  expect(screen.queryByLabelText("Agent output")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "×" }));
  f.view.rerender(<AgentPanel {...f.props} reviewId="refreshed-a" />);
  await waitFor(() => expect(f.streams).toHaveLength(2));
  expect(f.streams[1].url).toContain("/repositories/repo/agents/run-1/events");
  await act(async () =>
    f.streams[1].onmessage({
      data: JSON.stringify({ type: "output", text: "Replayed A output" }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
  expect(screen.getByLabelText("Agent output").textContent).toBe(
    "Replayed A output",
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
  await waitFor(() =>
    expect(f.stops).toEqual(["/api/repositories/repo/agents/run-1/stop"]),
  );
  expect(f.requests).toHaveLength(1);
});

for (const returnBeforeResponse of [false, true]) {
  test(`compact delayed authorized run retains A Stop after navigation, returnBeforeResponse=${returnBeforeResponse}`, async () => {
    const f = await compactRuntimeFixture(false, true);
    await f.launch();
    expect(f.streams).toHaveLength(0);
    f.view.rerender(
      <AgentPanel
        {...f.props}
        repositoryId="project-b"
        reviewId="review-b"
        comments={[]}
      />,
    );
    if (returnBeforeResponse)
      f.view.rerender(<AgentPanel {...f.props} reviewId="returned-a" />);
    await act(async () => f.releaseLaunch());
    if (!returnBeforeResponse) {
      expect(
        screen.getByRole("button", { name: "Fix with Agent" }).textContent,
      ).not.toContain("Running");
      expect(f.streams).toHaveLength(0);
      f.view.rerender(<AgentPanel {...f.props} reviewId="returned-a" />);
    }
    await waitFor(() => expect(f.streams).toHaveLength(1));
    expect(f.streams[0].url).toContain(
      "/repositories/repo/agents/run-1/events",
    );
    fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    await waitFor(() =>
      expect(f.stops).toEqual(["/api/repositories/repo/agents/run-1/stop"]),
    );
    expect(f.requests).toHaveLength(1);
  });
}

test("an active project's Stop survives more than sixteen other project results", async () => {
  const f = await compactRuntimeFixture();
  await f.launch();
  await waitFor(() => expect(f.streams).toHaveLength(1));
  for (let index = 1; index <= 16; index++) {
    f.view.rerender(
      <AgentPanel
        {...f.props}
        repositoryId={`other-${index}`}
        reviewId={`review-${index}`}
      />,
    );
    await f.launch();
    await waitFor(() => expect(f.streams).toHaveLength(index + 1));
    await act(async () =>
      f.streams[index].onmessage({
        data: JSON.stringify({
          type: "status",
          run: { id: `run-${index + 1}`, status: "completed", error: null },
        }),
      }),
    );
  }
  f.view.rerender(<AgentPanel {...f.props} reviewId="returned-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
  expect(screen.getByRole("button", { name: "Stop agent" })).toBeTruthy();
});
