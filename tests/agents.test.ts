import { test, expect, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createApp } from "../apps/server/src/app.js";
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
async function fixture(
  writes = true,
  script = "process.stdin.on('data',()=>{});process.stdout.write('FIXTURE_LOG');setInterval(()=>{},1000)",
  mode = "full",
) {
  const dir = await mkdtemp(join(tmpdir(), "agent-boundary-"));
  roots.push(dir);
  const root = join(dir, "repo"),
    skills = join(dir, "skills"),
    dataDir = join(dir, "data");
  await mkdir(root);
  await mkdir(join(skills, "exact"), { recursive: true });
  await writeFile(
    join(skills, "exact", "SKILL.md"),
    "# Exact skill\nFix only selected findings.",
  );
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  await writeFile(join(root, "a.txt"), "original\nstable1\nstable2\nstable3\n");
  git("add", ".");
  git("commit", "-qm", "base");
  await writeFile(join(root, "a.txt"), "changed\nstable1\nstable2\nstable3\n");
  const invocations: {
    command: string;
    args: string[];
    options: any;
    prompt: string;
  }[] = [];
  const processFactory = (command: string, args: string[], options: any) => {
    const invocation = { command, args, options, prompt: "" };
    invocations.push(invocation);
    const child = spawn(process.execPath, ["-e", script], options);
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = ((p: any) => {
      invocation.prompt = String(p);
      return end(p);
    }) as any;
    return child;
  };
  const launch = async () => {
    const app = await createApp({
      port: 7373,
      token: "test",
      repositoryPath: root,
      dataDir,
      skillRoots: [skills],
      enableWrites: writes,
      processFactory,
    });
    apps.push(app);
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { host: "localhost:7373", origin: "http://localhost:7373" },
      payload: { token: "test" },
    });
    const headers = {
      host: "localhost:7373",
      origin: "http://localhost:7373",
      cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
    };
    const id = (await app.inject({ url: "/api/repositories", headers })).json()
      .selectedRepositoryId;
    const call = (method: any, url: string, payload?: any) =>
      app.inject({
        method,
        url: url.startsWith("/api/") ? url : `/api/repositories/${id}/${url}`,
        headers,
        payload,
      });
    return { app, call, id };
  };
  let base = "HEAD";
  if (mode === "staged") git("add", ".");
  if (mode === "branch") {
    git("add", ".");
    git("commit", "-qm", "branch finding");
    base = "HEAD~1";
  }
  const a = await launch();
  const review = (
    await a.call("GET", `review?base=${base}&mode=${mode}`)
  ).json();
  const skill = (await a.call("GET", "/api/skills")).json().skills?.[0];
  if (skill)
    await a.call("PUT", "profiles", {
      reviewId: review.id,
      scope: "worktree",
      profile: { locator: skill.locator, digest: skill.digest },
    });
  const comment = (
    await a.call("POST", "comments", {
      reviewId: review.id,
      path: "a.txt",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "Fix fixture",
      severity: "warning",
    })
  ).json();
  const exported = (await a.call("GET", `export?reviewId=${review.id}`)).json();
  const payload = {
    adapter: "codex",
    reviewId: review.id,
    commentIds: [comment.id],
    expected: { target: exported.target, profile: exported.profile },
  };
  return {
    ...a,
    root,
    skills,
    dataDir,
    git,
    launch,
    review,
    skill,
    comment,
    payload,
    invocations,
  };
}
test("skill catalog and exact stdin execution, fixed command, owned stop and metadata-only restart", async () => {
  const f = await fixture();
  expect(f.skill?.digest).toMatch(/^[a-f0-9]{64}$/);
  const res = await f.call("POST", "agents", f.payload);
  expect(res.statusCode).toBe(201);
  const run = res.json();
  expect(f.invocations).toHaveLength(1);
  const p = f.invocations[0];
  expect(p.command).toBe("codex");
  expect(p.options.shell).toBe(false);
  expect(p.options.cwd).toBe(f.payload.expected.target.worktreeRoot);
  expect(p.args).toContain("--ephemeral");
  expect(p.args.join(" ")).not.toMatch(/bypass|approve-for-me|full-auto/);
  expect(p.prompt).toContain(f.skill.locator);
  expect(p.prompt).toContain(f.payload.expected.target.head);
  expect(p.prompt).toContain("Fix fixture");
  expect((await f.call("POST", `agents/${run.id}/stop`)).json().status).toBe(
    "stopped",
  );
  await f.app.close();
  const a = await f.launch();
  expect((await a.call("GET", "agents/history")).json().runs[0].status).toBe(
    "stopped",
  );
  await a.app.close();
  const db = await readFile(join(f.dataDir, "review.sqlite"));
  expect(db.includes(Buffer.from("FIXTURE_LOG"))).toBe(false);
  expect(db.includes(Buffer.from("Fix only selected findings"))).toBe(false);
});
for (const mutation of [
  "head",
  "branch",
  "index",
  "worktree",
  "profile",
  "skill",
  "detached",
] as const)
  test(`stale ${mutation} rejects before process creation`, async () => {
    const f = await fixture();
    if (mutation === "head") {
      f.git("add", ".");
      f.git("commit", "-qm", "changed");
    }
    if (mutation === "branch") f.git("checkout", "-qb", "other");
    if (mutation === "index") f.git("add", ".");
    if (mutation === "worktree")
      await writeFile(join(f.root, "a.txt"), "different\n");
    if (mutation === "profile")
      await f.call("PUT", "profiles", {
        reviewId: f.review.id,
        scope: "worktree",
        profile: null,
      });
    if (mutation === "skill")
      await writeFile(join(f.skills, "exact", "SKILL.md"), "Changed skill");
    if (mutation === "detached") f.git("checkout", "--detach", "-q");
    expect((await f.call("POST", "agents", f.payload)).statusCode).toBe(409);
    expect(f.invocations).toHaveLength(0);
  });
test("unknown duplicate resolved outdated comments and HTTP process injection reject", async () => {
  const f = await fixture();
  for (const ids of [["unknown"], [f.comment.id, f.comment.id]])
    expect(
      (await f.call("POST", "agents", { ...f.payload, commentIds: ids }))
        .statusCode,
    ).toBe(400);
  expect(
    (await f.call("POST", "agents", { ...f.payload, processFactory: "evil" }))
      .statusCode,
  ).toBe(400);
  await f.call("PATCH", `comments/${f.comment.id}`, { status: "resolved" });
  expect((await f.call("POST", "agents", f.payload)).statusCode).toBe(409);
  await f.call("PATCH", `comments/${f.comment.id}`, { status: "open" });
  await writeFile(join(f.root, "a.txt"), "unrelated\n");
  const review = (await f.call("GET", "review?base=HEAD&mode=full")).json();
  const e = (await f.call("GET", `export?reviewId=${review.id}`)).json();
  expect(
    (
      await f.call("POST", "agents", {
        ...f.payload,
        reviewId: review.id,
        expected: { target: e.target, profile: e.profile },
      })
    ).statusCode,
  ).toBe(409);
  expect(f.invocations).toHaveLength(0);
});
test("symlink escapes are omitted; readonly capability blocks writes", async () => {
  const f = await fixture(false);
  await symlink(f.root, join(f.skills, "escape"));
  expect((await f.call("GET", "/api/skills")).json().skills).toHaveLength(1);
  expect((await f.call("POST", "agents", f.payload)).statusCode).toBe(403);
  expect(f.invocations).toHaveLength(0);
});

for (const [event, status] of [
  ["turn.failed", "failed"],
  ["none", "failed"],
  ["turn.completed", "completed"],
])
  test(`JSON ${event} with zero exit is ${status}`, async () => {
    const f = await fixture(
      true,
      `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'${event}'}));});`,
    );
    const run = (await f.call("POST", "agents", f.payload)).json();
    await new Promise((r) => setTimeout(r, 150));
    expect(
      (await f.call("GET", "agents/history"))
        .json()
        .runs.find((r: any) => r.id === run.id).status,
    ).toBe(status);
  });
test("output flood terminates owned child and persists generic failure only", async () => {
  const f = await fixture(
    true,
    "process.stdin.resume();process.stdout.write('Z'.repeat(2*1024*1024));setInterval(()=>{},1000)",
  );
  const run = (await f.call("POST", "agents", f.payload)).json();
  await new Promise((r) => setTimeout(r, 150));
  expect((await f.call("GET", "agents/history")).json().runs[0].error).toBe(
    "Output limit exceeded",
  );
  await f.app.close();
  expect(
    (await readFile(join(f.dataDir, "review.sqlite"))).includes(
      Buffer.from("ZZZZZZ"),
    ),
  ).toBe(false);
});
test("CLI capability defaults and repeatable skills roots", async () => {
  const { parseCLI } = await import("../apps/server/src/cli.js");
  expect(parseCLI(["repo"]).enableWrites).toBe(true);
  expect(parseCLI(["repo", "--container"]).enableWrites).toBe(false);
  expect(
    parseCLI(["repo", "--container", "--enable-writes"]).enableWrites,
  ).toBe(true);
  expect(
    parseCLI(["repo", "--skills-dir", "one", "--skills-dir", "two"]).skillRoots,
  ).toHaveLength(4);
});

test("Git configuration changes with unchanged HEAD reject before process", async () => {
  const f = await fixture();
  f.git("config", "core.filemode", "false");
  expect((await f.call("POST", "agents", f.payload)).statusCode).toBe(409);
  expect(f.invocations).toHaveLength(0);
});

for (const mode of ["branch", "staged"])
  test(`${mode} off-comparison worktree mutation rejects process`, async () => {
    const f = await fixture(true, undefined, mode);
    await writeFile(join(f.root, "a.txt"), "off comparison edit\n");
    expect((await f.call("POST", "agents", f.payload)).statusCode).toBe(409);
    expect(f.invocations).toHaveLength(0);
  });

test("unsafe unrelated tracked parent disables agent execution while branch blob review remains available", async () => {
  const f = await fixture(true, undefined, "branch");
  await mkdir(join(f.root, "nested"));
  await writeFile(join(f.root, "nested", "file.txt"), "tracked");
  f.git("add", ".");
  f.git("commit", "-qm", "tracked parent");
  const outside = join(f.dataDir, "external");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "file.txt"), "external one");
  await rm(join(f.root, "nested"), { recursive: true });
  await symlink(outside, join(f.root, "nested"));
  const response = await f.call("GET", "review?base=HEAD~2&mode=branch");
  expect(response.statusCode).toBe(200);
  const review = response.json();
  const exported = (await f.call("GET", `export?reviewId=${review.id}`)).json();
  expect(
    (await f.call("GET", `diff?reviewId=${review.id}&path=a.txt`)).statusCode,
  ).toBe(200);
  for (const text of ["external one", "external two"]) {
    await writeFile(join(outside, "file.txt"), text);
    expect(
      (
        await f.call("POST", "agents", {
          ...f.payload,
          reviewId: review.id,
          expected: { target: exported.target, profile: exported.profile },
        })
      ).statusCode,
    ).toBe(409);
  }
  expect(f.invocations).toHaveLength(0);
});
test("native and container skill defaults are explicit, with CLI directories additive", async () => {
  const { parseCLI } = await import("../apps/server/src/cli.js");
  const { homedir } = await import("node:os");
  const native = [
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".agents", "skills"),
  ];
  expect(parseCLI(["repo"]).skillRoots).toEqual(native);
  expect(parseCLI(["repo", "--skills-dir", "extra"]).skillRoots).toEqual([
    ...native,
    join(process.cwd(), "extra"),
  ]);
  expect(parseCLI(["repo", "--container"]).skillRoots).toEqual([]);
  expect(parseCLI(["repo", "--container"]).container).toBe(true);
  expect(parseCLI(["repo"]).container).toBe(false);
});
test("explicit empty AppOptions override and container omitted roots both stay empty", async () => {
  for (const options of [{ skillRoots: [] }, { container: true }]) {
    const dataDir = await mkdtemp(join(tmpdir(), "empty-skills-"));
    roots.push(dataDir);
    const app = await createApp({
      port: 7373,
      token: "fixture",
      dataDir,
      ...options,
    });
    apps.push(app);
    const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers,
      payload: { token: "fixture" },
    });
    const cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
    expect(
      (
        await app.inject({
          url: "/api/skills",
          headers: { ...headers, cookie },
        })
      ).json(),
    ).toEqual({ skills: [] });
  }
});

test("adapter metadata identifies unknown local CLI provider without probing fixtures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-provider-"));
  roots.push(dir);
  const app = await createApp({
    port: 7373,
    token: "test",
    dataDir: dir,
    agentAvailability: async () => ({
      id: "codex",
      available: true,
      version: "fixture-only",
      error: null,
    }),
  });
  apps.push(app);
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
  const session = await app.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "test" },
  });
  const cookie = session.headers["set-cookie"]!.toString().split(";")[0];
  const result = (
    await app.inject({ url: "/api/agents", headers: { ...headers, cookie } })
  ).json();
  expect(result.agents[0].provider).toEqual({
    identity: null,
    label: "Provider identity unknown; uses local Codex CLI settings",
  });
});

test("Claude stdin manual permissions report permission denials as needs-attention", async () => {
  const f = await fixture(
    true,
    `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'permission_denied'}));console.log(JSON.stringify({type:'result',subtype:'success',permission_denials:[{tool_name:'Edit'}]}));})`,
  );
  const response = await f.call("POST", "agents", {
    ...f.payload,
    adapter: "claude",
  });
  expect(response.statusCode).toBe(201);
  const invocation = f.invocations[0]!;
  expect(invocation.command).toBe("claude");
  expect(invocation.args).toEqual([
    "-p",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--permission-mode",
    "manual",
    "--permission-prompts",
    "none",
  ]);
  expect(invocation.prompt).toContain("Fix fixture");
  await new Promise((r) => setTimeout(r, 100));
  expect((await f.call("GET", "agents/history")).json().runs[0].status).toBe(
    "needs-attention",
  );
});
test("OpenCode uses bounded argv JSON prompt and verified fixed flags", async () => {
  const f = await fixture(
    true,
    `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'step_finish',part:{reason:'stop'}})))`,
  );
  const response = await f.call("POST", "agents", {
    ...f.payload,
    adapter: "opencode",
  });
  expect(response.statusCode).toBe(201);
  const p = f.invocations[0]!;
  expect(p.command).toBe("opencode");
  expect(p.args.slice(0, 6)).toEqual([
    "run",
    "--format",
    "json",
    "--dir",
    f.payload.expected.target.worktreeRoot,
    "--",
  ]);
  expect(JSON.parse(p.args[6]!).comments[0].body).toBe("Fix fixture");
  expect(p.prompt).not.toContain("Fix fixture");
  await new Promise((r) => setTimeout(r, 100));
  expect((await f.call("GET", "agents/history")).json().runs[0].status).toBe(
    "completed",
  );
});
test("history persists accepted review metadata without source or prompt", async () => {
  const f = await fixture();
  const response = await f.call("GET", "history");
  expect(response.statusCode).toBe(200);
  const h = response.json();
  expect(h.reviews[0].head).toBe(f.review.head);
  expect(h.reviews[0].files).toBeUndefined();
  expect(h.runs).toEqual([]);
});
test("Git proven rename shares immutable origin and attached path across comments export and Send", async () => {
  const f = await fixture();
  f.git("add", ".");
  f.git("mv", "a.txt", "renamed.txt");
  const review = (await f.call("GET", "review?base=HEAD&mode=full")).json();
  const notes = (await f.call("GET", `comments?reviewId=${review.id}`)).json()
    .comments;
  expect(notes[0].attachment).toBe("current");
  expect(notes[0].path).toBe("a.txt");
  expect(notes[0].attachedPath).toBe("renamed.txt");
  const exported = (await f.call("GET", `export?reviewId=${review.id}`)).json();
  expect(exported.comments[0]).toEqual(notes[0]);
  const response = await f.call("POST", "agents", {
    ...f.payload,
    reviewId: review.id,
    expected: { target: exported.target, profile: exported.profile },
  });
  expect(response.statusCode).toBe(201);
  expect(JSON.parse(f.invocations[0]!.prompt).comments[0].path).toBe(
    "renamed.txt",
  );
  await f.call("POST", `agents/${response.json().id}/stop`);
});
for (const adapter of ["claude", "opencode"])
  test(`${adapter} unchanged-HEAD workspace change rejects without process`, async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.txt"), "late changed\n");
    const response = await f.call("POST", "agents", { ...f.payload, adapter });
    expect(response.statusCode).toBe(409);
    expect(f.invocations).toHaveLength(0);
  });
test("Git rename changed and duplicate hash contexts stay outdated across export and Send", async () => {
  const f = await fixture();
  f.git("add", ".");
  f.git("mv", "a.txt", "renamed.txt");
  await writeFile(
    join(f.root, "renamed.txt"),
    "different\nstable1\nstable2\nstable3\n",
  );
  let review = (await f.call("GET", "review?base=HEAD&mode=full")).json();
  let notes = (await f.call("GET", `comments?reviewId=${review.id}`)).json()
    .comments;
  expect(notes[0].attachment).toBe("outdated");
  await writeFile(
    join(f.root, "renamed.txt"),
    "changed\nstable1\nstable2\nstable3\nchanged\nstable1\nstable2\nstable3\n",
  );
  review = (await f.call("GET", "review?base=HEAD&mode=full")).json();
  notes = (await f.call("GET", `comments?reviewId=${review.id}`)).json()
    .comments;
  expect(notes[0].attachment).toBe("outdated");
  expect(notes[0].attachedPath).toBe(null);
  const exported = (await f.call("GET", `export?reviewId=${review.id}`)).json();
  expect(exported.comments[0]).toEqual(notes[0]);
  expect(
    (
      await f.call("POST", "agents", {
        ...f.payload,
        reviewId: review.id,
        expected: { target: exported.target, profile: exported.profile },
      })
    ).statusCode,
  ).toBe(409);
  expect(f.invocations).toHaveLength(0);
});
for (const adapter of ["claude", "opencode"])
  test(`${adapter} final JSON without newline completes truthfully`, async () => {
    const event =
      adapter === "claude"
        ? {
            type: "result",
            subtype: "success",
            is_error: false,
            permission_denials: [],
          }
        : { type: "step_finish", part: { reason: "stop" } };
    const f = await fixture(
      true,
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(event))}))`,
    );
    const response = await f.call("POST", "agents", { ...f.payload, adapter });
    expect(response.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    expect((await f.call("GET", "agents/history")).json().runs[0].status).toBe(
      "completed",
    );
  });
test("historic branch comparison reopens pinned Git endpoints after HEAD advances and rejects execution and writes", async () => {
  const f = await fixture(true, undefined, "branch");
  const originalHead = f.review.head;
  await writeFile(join(f.root, "a.txt"), "later\nstable1\nstable2\nstable3\n");
  f.git("add", ".");
  f.git("commit", "-qm", "later");
  const response = await f.call("GET", `history/${f.review.id}/review`);
  expect(response.statusCode).toBe(200);
  const old = response.json();
  expect(old.historical).toBe(true);
  expect(old.head).toBe(originalHead);
  const diff = (
    await f.call("GET", `diff?reviewId=${old.id}&path=a.txt`)
  ).json();
  expect(diff.newContent).toBe("changed\nstable1\nstable2\nstable3\n");
  const exported = (await f.call("GET", `export?reviewId=${old.id}`)).json();
  const start = await f.call("POST", "agents", {
    ...f.payload,
    reviewId: old.id,
    expected: { target: exported.target, profile: exported.profile },
  });
  expect(start.statusCode).toBe(409);
  expect(f.invocations).toHaveLength(0);
  expect(
    (
      await f.call("POST", "comments", {
        reviewId: old.id,
        path: "a.txt",
        side: "new",
        startLine: 1,
        endLine: 1,
        body: "no historic writes",
        severity: "info",
      })
    ).statusCode,
  ).toBe(403);
  const mutationStatuses = [
    (
      await f.call("PUT", "reviewed", {
        reviewId: old.id,
        path: "a.txt",
        reviewed: true,
      })
    ).statusCode,
    (
      await f.call("PUT", "profiles", {
        reviewId: old.id,
        scope: "worktree",
        profile: null,
      })
    ).statusCode,
    (
      await f.call("PATCH", `comments/${f.comment.id}?reviewId=${old.id}`, {
        body: "historic edit",
      })
    ).statusCode,
    (await f.call("DELETE", `comments/${f.comment.id}?reviewId=${old.id}`))
      .statusCode,
  ];
  expect(mutationStatuses).toEqual([403, 403, 403, 403]);
  expect(
    (await f.call("GET", `comments?reviewId=${old.id}`)).json().comments[0]
      .body,
  ).toBe("Fix fixture");
  expect(
    (
      await f.call("PATCH", `comments/${f.comment.id}`, {
        body: "current lifecycle",
      })
    ).statusCode,
  ).toBe(200);
  expect((await f.call("GET", "history/unknown/review")).statusCode).toBe(404);
});
