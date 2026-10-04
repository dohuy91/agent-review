import {
  canonicalMkdtemp as mkdtemp,
  invalidUtf8FilenameUnsupported,
} from "./filesystem-fixtures.js";
import { afterEach, expect, test } from "vitest";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppOptions } from "../apps/server/src/app.js";
import type {
  ReviewMode,
  ReviewObservation,
} from "../packages/shared/src/index.js";
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(options: Partial<AppOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "review-actions-"));
  roots.push(root);
  const state = await mkdtemp(join(tmpdir(), "review-actions-state-"));
  roots.push(state);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    }).replace(/\n$/, "");
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const original = Array.from({ length: 24 }, (_, i) => `line ${i + 1}\n`).join(
    "",
  );
  await writeFile(join(root, "a.txt"), original);
  await writeFile(join(root, "b.txt"), "base b\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: state,
    repositoryPath: root,
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
  const auth = {
    ...headers,
    cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
  };
  const id = (
    await app.inject({ url: "/api/repositories", headers: auth })
  ).json().selectedRepositoryId;
  const url = `/api/repositories/${id}`;
  const get = (suffix: string) =>
    app.inject({ url: url + suffix, headers: auth });
  const post = async (suffix: string, payload: unknown) => {
    const result = await app.inject({
      method: "POST",
      url: url + suffix,
      headers: auth,
      payload: payload as object,
    });
    return result;
  };
  const review = async (mode: ReviewMode = "working") => {
    const r = await get(`/review?base=HEAD&mode=${mode}`);
    expect(r.statusCode).toBe(200);
    return r.json<ReviewObservation>();
  };
  return { root, git, app, auth, id, url, get, post, review, original };
}

test("literal wildcard/newline file stage and unstage preserve other paths and worktree bytes", async () => {
  const f = await fixture();
  const names = ["*.txt", "-odd\nname", "a.txt"];
  for (const name of names) await writeFile(join(f.root, name), "changed\n");
  let r = await f.review();
  let result = await f.post("/git", {
    reviewId: r.id,
    action: "stage",
    path: "*.txt",
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().changed).toBe(true);
  expect(f.git("diff", "--cached", "--name-only", "-z")).toBe("*.txt\0");
  r = await f.review();
  expect(
    (
      await f.post("/git", {
        reviewId: r.id,
        action: "stage",
        path: "-odd\nname",
      })
    ).statusCode,
  ).toBe(200);
  r = await f.review("staged");
  expect(
    (await f.post("/git", { reviewId: r.id, action: "unstage", path: "*.txt" }))
      .statusCode,
  ).toBe(200);
  expect(f.git("diff", "--cached", "--name-only", "-z")).toBe("-odd\nname\0");
  expect(await readFile(join(f.root, "*.txt"), "utf8")).toBe("changed\n");
});
test("one-hunk stage and unstage retain all other hunks and missing final newline", async () => {
  const f = await fixture();
  const next = f.original
    .replace("line 2\n", "changed 2\n")
    .replace("line 24\n", "changed 24");
  await writeFile(join(f.root, "a.txt"), next);
  let r = await f.review();
  expect(
    (
      await f.post("/git", {
        reviewId: r.id,
        action: "stage",
        path: "a.txt",
        hunkIndex: 1,
      })
    ).statusCode,
  ).toBe(200);
  expect(f.git("show", ":a.txt")).toBe(
    f.original.replace("line 24\n", "changed 24"),
  );
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe(next);
  r = await f.review();
  expect(
    (
      await f.post("/git", {
        reviewId: r.id,
        action: "stage",
        path: "a.txt",
        hunkIndex: 0,
      })
    ).statusCode,
  ).toBe(200);
  r = await f.review("staged");
  expect(
    (
      await f.post("/git", {
        reviewId: r.id,
        action: "unstage",
        path: "a.txt",
        hunkIndex: 0,
      })
    ).statusCode,
  ).toBe(200);
  expect(f.git("show", ":a.txt")).toBe(
    f.original.replace("line 24\n", "changed 24"),
  );
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe(next);
});
test("ambiguous hunk modes and binary hunks fail with actionable errors", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "change\n");
  let r = await f.review("full");
  const bad = await f.post("/git", {
    reviewId: r.id,
    action: "stage",
    path: "a.txt",
    hunkIndex: 0,
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/Working/i);
  await writeFile(join(f.root, "binary"), Buffer.from([0, 1, 2]));
  r = await f.review();
  expect(
    (
      await f.post("/git", {
        reviewId: r.id,
        action: "stage",
        path: "binary",
        hunkIndex: 0,
      })
    ).statusCode,
  ).toBe(400);
});
test("discard requires a current explicit preview and confirmation and restores index bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "staged\n");
  f.git("add", "a.txt");
  await writeFile(join(f.root, "a.txt"), "unsaved\n");
  let r = await f.review();
  let p = await f.post("/discard-preview", { reviewId: r.id, path: "a.txt" });
  expect(p.statusCode).toBe(200);
  expect(p.json()).toMatchObject({
    path: "a.txt",
    target: { repositoryId: f.id, head: f.git("rev-parse", "HEAD") },
  });
  expect(
    (await f.post("/discard", { previewId: p.json().previewId })).statusCode,
  ).toBe(400);
  await writeFile(join(f.root, "a.txt"), "newer\n");
  expect(
    (
      await f.post("/discard", {
        previewId: p.json().previewId,
        confirmed: true,
      })
    ).statusCode,
  ).toBe(409);
  r = await f.review();
  p = await f.post("/discard-preview", { reviewId: r.id, path: "a.txt" });
  expect(
    (
      await f.post("/discard", {
        previewId: p.json().previewId,
        confirmed: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("staged\n");
  expect(
    (
      await f.post("/discard", {
        previewId: p.json().previewId,
        confirmed: true,
      })
    ).statusCode,
  ).toBe(409);
});
test("deleted regular files can stage, unstage, and discard without losing bytes", async () => {
  const f = await fixture();
  await rm(join(f.root, "b.txt"));
  let r = await f.review();
  expect(
    (await f.post("/git", { reviewId: r.id, action: "stage", path: "b.txt" }))
      .statusCode,
  ).toBe(200);
  r = await f.review("staged");
  expect(
    (await f.post("/git", { reviewId: r.id, action: "unstage", path: "b.txt" }))
      .statusCode,
  ).toBe(200);
  r = await f.review();
  let p = await f.post("/discard-preview", { reviewId: r.id, path: "b.txt" });
  expect(
    (
      await f.post("/discard", {
        previewId: p.json().previewId,
        confirmed: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(await readFile(join(f.root, "b.txt"), "utf8")).toBe("base b\n");
});
test("added regular files can be discarded while symlink mutations are refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "new"), "new\n");
  let r = await f.review();
  const p = await f.post("/discard-preview", { reviewId: r.id, path: "new" });
  expect(
    (
      await f.post("/discard", {
        previewId: p.json().previewId,
        confirmed: true,
      })
    ).statusCode,
  ).toBe(200);
  await expect(access(join(f.root, "new"))).rejects.toThrow();
  await symlink("/etc/passwd", join(f.root, "link"));
  r = await f.review();
  expect(
    (await f.post("/git", { reviewId: r.id, action: "stage", path: "link" }))
      .statusCode,
  ).toBe(400);
  expect(
    (await f.post("/discard-preview", { reviewId: r.id, path: "link" }))
      .statusCode,
  ).toBe(400);
});
test("selected-index commit preserves unrelated index bytes and all unstaged bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "selected index\n");
  await writeFile(join(f.root, "b.txt"), "unrelated staged\n");
  f.git("add", ".");
  await writeFile(join(f.root, "a.txt"), "unstaged selected\n");
  await writeFile(join(f.root, "b.txt"), "unstaged other\n");
  const before = await readFile(join(f.root, ".git/index"));
  const head = f.git("rev-parse", "HEAD");
  const r = await f.review("staged");
  const result = await f.post("/commit", {
    reviewId: r.id,
    paths: ["a.txt"],
    message: "selected only",
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().commit).toMatch(/^[a-f0-9]{40,64}$/);
  expect(f.git("show", "HEAD:a.txt")).toBe("selected index");
  expect(f.git("show", "HEAD:b.txt")).toBe("base b");
  expect(f.git("rev-parse", "HEAD^")).toBe(head);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe(
    "unstaged selected\n",
  );
  expect(await readFile(join(f.root, "b.txt"), "utf8")).toBe(
    "unstaged other\n",
  );
});
test("local writes never execute configured filters, hooks, or signing", async () => {
  const f = await fixture();
  const marker = join(f.root, ".git/executed");
  await writeFile(join(f.root, ".gitattributes"), "*.txt filter=probe\n");
  f.git("config", "filter.probe.clean", `touch '${marker}'; cat`);
  f.git("config", "filter.probe.process", `touch '${marker}'; exit 1`);
  f.git("config", "filter.probe.required", "true");
  f.git("config", "commit.gpgsign", "true");
  f.git("config", "gpg.program", marker);
  await writeFile(
    join(f.root, ".git/hooks/pre-commit"),
    `#!/bin/sh\ntouch '${marker}'\n`,
  );
  await chmod(join(f.root, ".git/hooks/pre-commit"), 0o755);
  await writeFile(join(f.root, "a.txt"), "raw\n");
  let r = await f.review();
  const stage = await f.post("/git", {
    reviewId: r.id,
    action: "stage",
    path: "a.txt",
  });
  expect(stage.statusCode, stage.body).toBe(200);
  expect(f.git("show", ":a.txt")).toBe("raw");
  r = await f.review("staged");
  expect(
    (
      await f.post("/commit", {
        reviewId: r.id,
        paths: ["a.txt"],
        message: "safe",
      })
    ).statusCode,
  ).toBe(200);
  await expect(access(marker)).rejects.toThrow();
});
test("read-only capabilities reject every write path including fetch", async () => {
  const f = await fixture({ container: true });
  await writeFile(join(f.root, "a.txt"), "changed\n");
  const r = await f.review();
  const cap = await f.get("/capabilities");
  expect(cap.statusCode).toBe(200);
  expect(cap.json()).toMatchObject({
    writesEnabled: false,
    fetchEnabled: false,
  });
  for (const [path, body] of [
    ["/git", { reviewId: r.id, action: "stage", path: "a.txt" }],
    ["/discard-preview", { reviewId: r.id, path: "a.txt" }],
    ["/discard", { previewId: "x", confirmed: true }],
    ["/commit", { reviewId: r.id, paths: ["a.txt"], message: "no" }],
    ["/fetch", { remote: "origin", expectedHead: r.head }],
  ] as const)
    expect((await f.post(path, body)).statusCode).toBe(403);
});
test("stale index, changed HEAD, and historical review IDs cannot mutate", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "changed\n");
  let r = await f.review();
  f.git("add", "a.txt");
  expect(
    (await f.post("/git", { reviewId: r.id, action: "stage", path: "a.txt" }))
      .statusCode,
  ).toBe(409);
  r = await f.review("staged");
  f.git("commit", "-qm", "external");
  expect(
    (
      await f.post("/commit", {
        reviewId: r.id,
        paths: ["a.txt"],
        message: "no",
      })
    ).statusCode,
  ).toBe(409);
  const current = await f.review("branch");
  const historical = await f.get(`/history/${current.id}/review`);
  expect(historical.statusCode).toBe(200);
  expect(
    (
      await f.post("/git", {
        reviewId: historical.json().id,
        action: "stage",
        path: "a.txt",
      })
    ).statusCode,
  ).toBe(409);
});
test("index.lock excludes writes and is never removed when owned by another process", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "changed\n");
  const r = await f.review();
  await writeFile(join(f.root, ".git/index.lock"), "owned elsewhere");
  expect(
    (await f.post("/git", { reviewId: r.id, action: "stage", path: "a.txt" }))
      .statusCode,
  ).toBe(409);
  expect(await readFile(join(f.root, ".git/index.lock"), "utf8")).toBe(
    "owned elsewhere",
  );
});
test("commit rejects missing configured identity without changing HEAD or index", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "changed\n");
  f.git("add", ".");
  f.git("config", "user.name", "");
  f.git("config", "user.email", "");
  const r = await f.review("staged");
  const before = await readFile(join(f.root, ".git/index"));
  const result = await f.post("/commit", {
    reviewId: r.id,
    paths: ["a.txt"],
    message: "no",
  });
  expect(result.statusCode).toBe(400);
  expect(result.json().error).toMatch(/identity/i);
  expect(f.git("rev-parse", "HEAD")).toBe(r.head);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
});
test("strict HTTP schema rejects arbitrary commands, patches, URLs, and environments", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "change\n");
  const r = await f.review();
  expect(
    (
      await f.post("/git", {
        reviewId: r.id,
        action: "stage",
        path: "a.txt",
        patch: "evil",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.post("/fetch", {
        remote: "origin",
        expectedHead: r.head,
        url: "https://example.test",
        env: {},
      })
    ).statusCode,
  ).toBe(400);
});
test("offline remote metadata redacts credentials and classifies HTTPS/SSH without contacting helpers", async () => {
  const f = await fixture();
  f.git(
    "remote",
    "add",
    "https",
    "https://secret:password@example.test/repo.git?token=hidden#private",
  );
  f.git("remote", "add", "scp", "git@example.test:org/repo.git");
  f.git("remote", "add", "ssh", "ssh://git@example.test/org/repo.git");
  f.git("remote", "add", "unsafe", "ext::echo secret");
  const response = await f.get("/remotes");
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toMatch(/secret|password|hidden|private|ext::/);
  expect(response.json().remotes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "https",
        transport: "https",
        url: "https://example.test/repo.git",
      }),
      expect.objectContaining({
        name: "scp",
        transport: "ssh",
        url: "example.test:org/repo.git",
      }),
      expect.objectContaining({
        name: "ssh",
        transport: "ssh",
        url: "ssh://example.test/org/repo.git",
      }),
      expect.objectContaining({
        name: "unsafe",
        transport: "unsupported",
        fetchAvailable: false,
      }),
    ]),
  );
});
test("fetch uses only fixed argv with internal transport and rejects unsafe effective config before transport", async () => {
  const calls: { command: string; args: string[]; options: object }[] = [];
  const f = await fixture({
    fetchTransport: async (
      command: string,
      args: string[],
      options: object,
    ) => {
      calls.push({ command, args, options });
    },
  } as Partial<AppOptions>);
  f.git("remote", "add", "origin", "https://example.test/repo.git");
  let head = f.git("rev-parse", "HEAD");
  let result = await f.post("/fetch", {
    reviewId: (await f.review()).id,
    remote: "origin",
    expectedHead: head,
  });
  expect(result.statusCode).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.command).toBe("git");
  expect(calls[0]!.args).toEqual(
    expect.arrayContaining([
      "fetch",
      "--no-tags",
      "--no-prune",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--no-write-commit-graph",
      "--no-write-fetch-head",
      "--refmap=",
      "origin",
      "refs/heads/*:refs/remotes/origin/*",
    ]),
  );
  expect(calls[0]!.options).toMatchObject({
    shell: false,
    timeout: 60000,
    maxBuffer: 1048576,
  });
  for (const [key, value] of [
    ["remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
    ["remote.origin.uploadpack", "evil"],
    ["remote.origin.vcs", "evil"],
    ["url.ext::evil.insteadOf", "https://example.test/"],
    ["remotes.origin", "other"],
  ]) {
    f.git("config", key, value);
    result = await f.post("/fetch", {
      reviewId: (await f.review()).id,
      remote: "origin",
      expectedHead: head,
    });
    expect(result.statusCode).toBe(400);
    expect(calls).toHaveLength(1);
    f.git("config", "--unset-all", key);
    if (key === "remote.origin.fetch")
      f.git("config", key, "+refs/heads/*:refs/remotes/origin/*");
  }
  expect(
    (
      await f.post("/fetch", {
        reviewId: (await f.review()).id,
        remote: "origin",
        expectedHead: "0".repeat(40),
      })
    ).statusCode,
  ).toBe(409);
  expect(calls).toHaveLength(1);
});
test("fetch failures are bounded generic responses without helper output or credentials", async () => {
  const f = await fixture({
    fetchTransport: async () => {
      throw new Error(
        "https://token:password@example.test secret helper stderr",
      );
    },
  } as Partial<AppOptions>);
  f.git("remote", "add", "origin", "https://example.test/repo.git");
  const r = await f.post("/fetch", {
    reviewId: (await f.review()).id,
    remote: "origin",
    expectedHead: f.git("rev-parse", "HEAD"),
  });
  expect(r.statusCode).toBe(502);
  expect(r.body).not.toMatch(/password|token|secret|stderr/);
  expect(r.json().error).toMatch(/fetch/i);
});
test("historical Fetch at unchanged HEAD fails before any transport", async () => {
  const calls: unknown[] = [];
  const f = await fixture({
    fetchTransport: async () => {
      calls.push("called");
    },
  });
  f.git("remote", "add", "origin", "https://example.test/repo.git");
  const r = await f.review("branch");
  const historical = await f.get(`/history/${r.id}/review`);
  expect(historical.statusCode).toBe(200);
  expect(historical.json().head).toBe(r.head);
  const result = await f.post("/fetch", {
    reviewId: historical.json().id,
    remote: "origin",
    expectedHead: r.head,
  });
  expect(result.statusCode).toBe(409);
  expect(calls).toHaveLength(0);
});
test("serialized same-observation writes allow one mutation and require the other to refresh", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "new a\n");
  await writeFile(join(f.root, "b.txt"), "new b\n");
  const r = await f.review();
  const results = await Promise.all(
    ["a.txt", "b.txt"].map((path) =>
      f.post("/git", { reviewId: r.id, action: "stage", path }),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(f.git("diff", "--cached", "--name-only").split("\n")).toHaveLength(1);
});
test("whole-file stage of an already staged full-view change reports an honest no-op", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "changed\n");
  f.git("add", "a.txt");
  const r = await f.review("full");
  const before = await readFile(join(f.root, ".git/index"));
  const result = await f.post("/git", {
    reviewId: r.id,
    action: "stage",
    path: "a.txt",
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ changed: false });
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
});
test("hunks never rewrite invalid UTF-8 bytes and whole-file stage preserves them", async () => {
  const f = await fixture();
  const raw = Buffer.from([0xff, 0x61, 0x0a]);
  await writeFile(join(f.root, "a.txt"), raw);
  let r = await f.review();
  expect(
    (
      await f.post("/git", {
        reviewId: r.id,
        action: "stage",
        path: "a.txt",
        hunkIndex: 0,
      })
    ).statusCode,
  ).toBe(400);
  r = await f.review();
  expect(
    (await f.post("/git", { reviewId: r.id, action: "stage", path: "a.txt" }))
      .statusCode,
  ).toBe(200);
  expect(execFileSync("git", ["-C", f.root, "show", ":a.txt"])).toEqual(raw);
});
test("symbolic index and branch ref indirection fail closed and preserve their targets", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "change\n");
  f.git("add", "a.txt");
  let r = await f.review("staged");
  const branch = f.git("symbolic-ref", "HEAD");
  f.git("branch", "indirect");
  f.git("symbolic-ref", branch, "refs/heads/indirect");
  expect(
    (
      await f.post("/commit", {
        reviewId: r.id,
        paths: ["a.txt"],
        message: "no",
      })
    ).statusCode,
  ).toBe(409);
  f.git("symbolic-ref", "--delete", branch);
  f.git("update-ref", branch, r.head);
  r = await f.review("staged");
  const original = await readFile(join(f.root, ".git/index"));
  const target = join(f.root, ".git/index-target");
  await writeFile(target, original);
  await rm(join(f.root, ".git/index"));
  await symlink(target, join(f.root, ".git/index"));
  expect(
    (
      await f.post("/commit", {
        reviewId: r.id,
        paths: ["a.txt"],
        message: "no",
      })
    ).statusCode,
  ).toBe(409);
  expect(await readFile(target)).toEqual(original);
});
test("non-round-trippable Git filenames cannot collapse onto a displayed mutation path", async (context) => {
  const f = await fixture();
  const unsupported = await invalidUtf8FilenameUnsupported(f.root);
  if (unsupported) context.skip(unsupported);
  const invalid = Buffer.concat([
    Buffer.from(f.root + "/"),
    Buffer.from([0xff]),
    Buffer.from(".txt"),
  ]);
  await writeFile(invalid, "invalid path\n");
  await writeFile(join(f.root, "�.txt"), "displayed path\n");
  f.git("add", ".");
  await writeFile(join(f.root, "�.txt"), "changed\n");
  const r = await f.review();
  const before = await readFile(join(f.root, ".git/index"));
  const result = await f.post("/git", {
    reviewId: r.id,
    action: "stage",
    path: "�.txt",
  });
  expect(result.statusCode).toBe(400);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
});
for (const source of ["index", "HEAD"] as const) {
  test(`raw ${source} Git path bytes reject displayed-name mutation without physical invalid filenames`, async () => {
    const f = await fixture();
    await writeFile(join(f.root, "�.txt"), "displayed path\n");
    f.git("add", ".");
    const oid = f.git("rev-parse", "HEAD:a.txt");
    const rawName = Buffer.concat([Buffer.from([0xff]), Buffer.from(".txt")]);
    const indexRecord = Buffer.concat([
      Buffer.from(`100644 ${oid}\t`),
      rawName,
      Buffer.from([0]),
    ]);
    execFileSync("git", ["-C", f.root, "update-index", "-z", "--index-info"], {
      input: indexRecord,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (source === "HEAD") {
      const tree = f.git("write-tree");
      const parent = f.git("rev-parse", "HEAD");
      const commit = f.git(
        "commit-tree",
        tree,
        "-p",
        parent,
        "-m",
        "raw tree fixture",
      );
      f.git("update-ref", "HEAD", commit, parent);
      const removal = Buffer.concat([
        Buffer.from(`0 ${"0".repeat(oid.length)}\t`),
        rawName,
        Buffer.from([0]),
      ]);
      execFileSync(
        "git",
        ["-C", f.root, "update-index", "-z", "--index-info"],
        { input: removal, stdio: ["pipe", "pipe", "pipe"] },
      );
    }
    await writeFile(join(f.root, "�.txt"), "changed displayed path\n");
    const r = await f.review("full");
    const before = await readFile(join(f.root, ".git/index"));
    const result = await f.post("/git", {
      reviewId: r.id,
      action: "stage",
      path: "�.txt",
    });
    expect(result.statusCode, result.body).toBe(400);
    expect(result.json().error).toMatch(/Non-UTF-8|Ambiguous/);
    expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
    expect(await readFile(join(f.root, "�.txt"), "utf8")).toBe(
      "changed displayed path\n",
    );
  });
}
test("discard restores executable mode even when file bytes match the index", async () => {
  const f = await fixture();
  await chmod(join(f.root, "a.txt"), 0o755);
  const r = await f.review();
  const p = await f.post("/discard-preview", { reviewId: r.id, path: "a.txt" });
  expect(p.statusCode).toBe(200);
  const result = await f.post("/discard", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().changed).toBe(true);
  expect(f.git("diff", "--name-only")).toBe("");
});
test("hunk unstage preserves an independently staged executable mode change", async () => {
  const f = await fixture();
  await chmod(join(f.root, "a.txt"), 0o755);
  await writeFile(
    join(f.root, "a.txt"),
    f.original.replace("line 2", "changed 2"),
  );
  f.git("add", "a.txt");
  const r = await f.review("staged");
  const result = await f.post("/git", {
    reviewId: r.id,
    action: "unstage",
    path: "a.txt",
    hunkIndex: 0,
  });
  expect(result.statusCode).toBe(200);
  expect(f.git("ls-files", "--stage", "a.txt")).toMatch(/^100755 /);
  expect(f.git("show", ":a.txt") + "\n").toBe(f.original);
});
test("valid HTTPS-to-SSH rewrites keep sanitized effective metadata and fixed scope", async () => {
  const calls: unknown[] = [];
  const f = await fixture({
    fetchTransport: async () => {
      calls.push(true);
    },
  });
  f.git("remote", "add", "origin", "https://example.test/repo.git");
  f.git(
    "config",
    "url.ssh://git@other.test/.insteadOf",
    "https://example.test/",
  );
  const meta = await f.get("/remotes");
  expect(meta.json().remotes[0]).toMatchObject({
    transport: "ssh",
    url: "ssh://other.test/repo.git",
    fetchAvailable: true,
  });
  const r = await f.review();
  expect(
    (
      await f.post("/fetch", {
        reviewId: r.id,
        remote: "origin",
        expectedHead: r.head,
      })
    ).statusCode,
  ).toBe(200);
  expect(calls).toHaveLength(1);
});
test("native Fetch transport terminates its owned helper descendants on timeout and output overflow", async () => {
  const { nativeFetchTransport } =
    await import("../packages/git/src/remotes.js");
  const f = await fixture();
  for (const kind of ["timeout", "overflow"]) {
    const marker = join(f.root, kind);
    const code = `${kind === "overflow" ? 'process.stdout.write("x".repeat(8192));' : ""}setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"alive"),400)`;
    const args = [
      "-C",
      f.root,
      "-c",
      `alias.fixture=!node -e '${code}'`,
      "fixture",
    ];
    await expect(
      nativeFetchTransport("git", args, {
        shell: false,
        encoding: "buffer",
        timeout: kind === "timeout" ? 60 : 2000,
        maxBuffer: kind === "overflow" ? 128 : 8192,
      }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 450));
    await expect(access(marker)).rejects.toThrow();
  }
});
test("index flag-only changes after review also invalidate a commit", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "staged\n");
  f.git("add", "a.txt");
  const r = await f.review("staged");
  f.git("update-index", "--assume-unchanged", "b.txt");
  const before = await readFile(join(f.root, ".git/index"));
  const result = await f.post("/commit", {
    reviewId: r.id,
    paths: ["a.txt"],
    message: "stale flags",
  });
  expect(result.statusCode).toBe(409);
  expect(f.git("rev-parse", "HEAD")).toBe(r.head);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
});
test("raw index stamp refuses oversized and no-follow index files", async () => {
  const { readIndexBytes } = await import("../packages/git/src/git.js");
  const f = await fixture();
  const { open } = await import("node:fs/promises");
  const handle = await open(join(f.root, ".git/index"), "w");
  await handle.truncate(16 * 1024 * 1024 + 1);
  await handle.close();
  await expect(readIndexBytes(join(f.root, ".git"))).rejects.toThrow(/Unsafe/);
  await rm(join(f.root, ".git/index"));
  await symlink("/etc/passwd", join(f.root, ".git/index"));
  await expect(readIndexBytes(join(f.root, ".git"))).rejects.toThrow(/Unsafe/);
});

test("controlled local fixture fetch changes only remote-tracking refs and skips hooks and FETCH_HEAD", async () => {
  const donor = await mkdtemp(join(tmpdir(), "review-fetch-donor-"));
  roots.push(donor);
  const { nativeFetchTransport } =
    await import("../packages/git/src/remotes.js");
  const f = await fixture({
    fetchTransport: async (command, args, options) => {
      const fixed = [...args];
      fixed.splice(fixed.indexOf("-C"), 0, "-c", "protocol.file.allow=always");
      fixed[fixed.lastIndexOf("origin")] = donor;
      await nativeFetchTransport(command, fixed, options);
    },
  });
  f.git("commit", "--allow-empty", "-qm", "remote ahead");
  const remoteHead = f.git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", "--quiet", f.root, donor]);
  f.git("reset", "--hard", "-q", "HEAD~1");
  await writeFile(join(f.root, "a.txt"), "staged\n");
  f.git("add", "a.txt");
  await writeFile(join(f.root, "a.txt"), "unstaged\n");
  f.git("remote", "add", "origin", "https://example.test/fixture.git");
  const marker = join(f.root, ".git/fetch-hook");
  await writeFile(
    join(f.root, ".git/hooks/reference-transaction"),
    `#!/bin/sh\ntouch '${marker}'\n`,
  );
  await chmod(join(f.root, ".git/hooks/reference-transaction"), 0o755);
  const before = await readFile(join(f.root, ".git/index"));
  const r = await f.review();
  const result = await f.post("/fetch", {
    reviewId: r.id,
    remote: "origin",
    expectedHead: r.head,
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(
    f.git(
      "rev-parse",
      `refs/remotes/origin/${f.git("branch", "--show-current")}`,
    ),
  ).toBe(remoteHead);
  expect(f.git("rev-parse", "HEAD")).toBe(r.head);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("unstaged\n");
  await expect(access(marker)).rejects.toThrow();
  await expect(access(join(f.root, ".git/FETCH_HEAD"))).rejects.toThrow();
});
test("offline review never refreshes raw index stat-cache bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "new"), f.original);
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `100644,${f.git("rev-parse", "HEAD:a.txt")},new`,
  );
  const before = await readFile(join(f.root, ".git/index"));
  await f.review();
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
});
test("discard with a missing parent is an actionable safe refusal", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "nested"));
  await writeFile(join(f.root, "nested/file"), "base\n");
  f.git("add", ".");
  f.git("commit", "-qm", "nested");
  await rm(join(f.root, "nested"), { recursive: true });
  const r = await f.review();
  const p = await f.post("/discard-preview", {
    reviewId: r.id,
    path: "nested/file",
  });
  expect(p.statusCode).toBe(200);
  const result = await f.post("/discard", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode).toBe(400);
  expect(result.json().error).toMatch(/parent|directory/i);
  await expect(access(join(f.root, "nested"))).rejects.toThrow();
});
test("oversized whole-file stage fails with actionable guidance and unchanged index", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "large"), "x".repeat(600 * 1024));
  const r = await f.review();
  const before = await readFile(join(f.root, ".git/index"));
  const result = await f.post("/git", {
    reviewId: r.id,
    path: "large",
    action: "stage",
  });
  expect(result.statusCode).toBe(400);
  expect(result.json().error).toMatch(/size|large|limit/i);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
});
test("invalid HEAD path bytes and duplicate display names fail closed even after index removal", async (context) => {
  const f = await fixture();
  const unsupported = await invalidUtf8FilenameUnsupported(f.root);
  if (unsupported) context.skip(unsupported);
  const invalid = Buffer.concat([
    Buffer.from(f.root + "/"),
    Buffer.from([0xff]),
    Buffer.from(".txt"),
  ]);
  await writeFile(invalid, "invalid\n");
  await writeFile(join(f.root, "�.txt"), "valid\n");
  f.git("add", ".");
  f.git("commit", "-qm", "paths");
  await rm(invalid);
  f.git("add", "-A");
  await writeFile(join(f.root, "�.txt"), "modified\n");
  const r = await f.review("full");
  const before = await readFile(join(f.root, ".git/index"));
  const result = await f.post("/git", {
    reviewId: r.id,
    action: "stage",
    path: "�.txt",
  });
  expect(result.statusCode).toBe(400);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
});
test("selected commit holds the real index lock and never rolls back an externally moved branch", async () => {
  const { commitSelected } = await import("../packages/git/src/commit.js");
  const { registerRepository } = await import("../apps/server/src/registry.js");
  const { getReview } = await import("../packages/git/src/review.js");
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "selected\n");
  f.git("add", "a.txt");
  const repo = await registerRepository(f.root);
  const review = await getReview(repo, "HEAD", "staged");
  const before = await readFile(join(f.root, ".git/index"));
  const tree = f.git("rev-parse", "HEAD^{tree}");
  const other = f.git(
    "commit-tree",
    tree,
    "-p",
    review.head,
    "-m",
    "external writer",
  );
  let validations = 0;
  await expect(
    commitSelected(repo, review, ["a.txt"], "mine", async () => {
      validations++;
      await access(join(f.root, ".git/index.lock"));
      if (validations === 1) {
        expect(() =>
          execFileSync("git", ["-C", f.root, "add", "b.txt"], {
            stdio: "pipe",
          }),
        ).toThrow();
      }
      if (validations === 2)
        f.git("update-ref", review.branch!, other, review.head);
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(f.git("rev-parse", "HEAD")).toBe(other);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
  await expect(access(join(f.root, ".git/index.lock"))).rejects.toThrow();
});
test("discard never broadens existing file read permissions", async () => {
  const f = await fixture();
  await chmod(join(f.root, "a.txt"), 0o600);
  await writeFile(join(f.root, "a.txt"), "private edit\n");
  const r = await f.review();
  const p = await f.post("/discard-preview", { reviewId: r.id, path: "a.txt" });
  const result = await f.post("/discard", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode).toBe(200);
  const { stat } = await import("node:fs/promises");
  expect((await stat(join(f.root, "a.txt"))).mode & 0o077).toBe(0);
});

// Review regressions are confined to this test's disposable worktree/state directories.
for (const destination of [
  "branch-log",
  "head-log",
  "shared-log",
  "objects",
  "object-child",
] as const) {
  test(`metadata guard refuses ${destination} aliases before local writes`, async () => {
    const { rename, link, readdir } = await import("node:fs/promises");
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "review-owned-metadata-"));
    roots.push(outside);
    await writeFile(join(f.root, "a.txt"), "new selected content\n");
    if (destination.endsWith("log")) f.git("add", "a.txt");
    const branch = f.git("symbolic-ref", "HEAD");
    const target = join(outside, "target");
    if (destination.endsWith("log")) {
      await writeFile(target, "owned sentinel\n");
      const log =
        destination === "head-log"
          ? join(f.root, ".git/logs/HEAD")
          : join(f.root, ".git/logs", branch);
      await rm(log);
      if (destination === "shared-log") await link(target, log);
      else await symlink(target, log);
    } else {
      let location = join(f.root, ".git/objects");
      if (destination === "object-child")
        location = join(location, f.git("hash-object", "a.txt").slice(0, 2));
      try {
        await rename(location, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(target);
      }
      await symlink(target, location);
    }
    const beforeIndex = await readFile(join(f.root, ".git/index"));
    const beforeHead = f.git("rev-parse", "HEAD");
    const beforeRefs = f.git(
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    );
    const beforeOutside = destination.endsWith("log")
      ? await readFile(target)
      : JSON.stringify((await readdir(target)).sort());
    const r = await f.review(
      destination.endsWith("log") ? "staged" : "working",
    );
    const result = destination.endsWith("log")
      ? await f.post("/commit", {
          reviewId: r.id,
          paths: ["a.txt"],
          message: "blocked metadata",
        })
      : await f.post("/git", {
          reviewId: r.id,
          action: "stage",
          path: "a.txt",
        });
    expect(result.statusCode, result.body).toBe(400);
    expect(f.git("rev-parse", "HEAD")).toBe(beforeHead);
    expect(f.git("for-each-ref", "--format=%(refname) %(objectname)")).toBe(
      beforeRefs,
    );
    expect(await readFile(join(f.root, ".git/index"))).toEqual(beforeIndex);
    expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe(
      "new selected content\n",
    );
    expect(
      destination.endsWith("log")
        ? await readFile(target)
        : JSON.stringify((await readdir(target)).sort()),
    ).toEqual(beforeOutside);
  });
}
for (const destination of [
  "refs/remotes/origin",
  "logs/refs/remotes/origin",
  "objects/pack",
] as const) {
  test(`Fetch refuses redirected ${destination} before calling transport`, async () => {
    let calls = 0;
    const f = await fixture({
      fetchTransport: async () => {
        calls++;
      },
    });
    f.git("remote", "add", "origin", "https://example.test/fixture.git");
    const { dirname } = await import("node:path");
    const outside = await mkdtemp(
      join(tmpdir(), "review-owned-fetch-metadata-"),
    );
    roots.push(outside);
    await writeFile(join(outside, "sentinel"), "unchanged\n");
    const location = join(f.root, ".git", destination);
    await mkdir(dirname(location), { recursive: true });
    await rm(location, { recursive: true, force: true });
    await symlink(
      destination === "refs/remotes/origin"
        ? join(f.root, ".git/refs/heads")
        : outside,
      location,
    );
    const head = f.git("rev-parse", "HEAD"),
      refs = f.git("for-each-ref", "--format=%(refname) %(objectname)"),
      index = await readFile(join(f.root, ".git/index")),
      source = await readFile(join(f.root, "a.txt"));
    const r = await f.review();
    const meta = await f.get("/remotes");
    expect(meta.json().remotes[0].fetchAvailable).toBe(false);
    const result = await f.post("/fetch", {
      reviewId: r.id,
      remote: "origin",
      expectedHead: r.head,
    });
    expect(result.statusCode, result.body).toBe(400);
    expect(calls).toBe(0);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(f.git("for-each-ref", "--format=%(refname) %(objectname)")).toBe(
      refs,
    );
    expect(await readFile(join(f.root, ".git/index"))).toEqual(index);
    expect(await readFile(join(f.root, "a.txt"))).toEqual(source);
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe(
      "unchanged\n",
    );
  });
}
test("Fetch refuses alternateRefsCommand while leaving authentication configuration supported", async () => {
  let calls = 0;
  const f = await fixture({
    fetchTransport: async () => {
      calls++;
    },
  });
  f.git("remote", "add", "origin", "https://example.test/fixture.git");
  const alternate = await mkdtemp(join(tmpdir(), "review-owned-alternate-"));
  roots.push(alternate);
  await mkdir(join(alternate, "objects"));
  await writeFile(
    join(f.root, ".git/objects/info/alternates"),
    join(alternate, "objects") + "\n",
  );
  f.git("config", "core.alternateRefsCommand", "false");
  f.git("config", "credential.helper", "existing-helper");
  f.git("config", "core.sshCommand", "ssh");
  let r = await f.review();
  let result = await f.post("/fetch", {
    reviewId: r.id,
    remote: "origin",
    expectedHead: r.head,
  });
  expect(result.statusCode).toBe(400);
  expect(calls).toBe(0);
  expect((await f.get("/remotes")).json().remotes[0].fetchAvailable).toBe(
    false,
  );
  f.git("config", "--unset", "core.alternateRefsCommand");
  r = await f.review();
  result = await f.post("/fetch", {
    reviewId: r.id,
    remote: "origin",
    expectedHead: r.head,
  });
  expect(result.statusCode).toBe(200);
  expect(calls).toBe(1);
});
test("empty intent-to-add becomes a real staged addition and intent-only commit is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "empty"), "");
  f.git("add", "-N", "empty");
  let r = await f.review();
  const before = await readFile(join(f.root, ".git/index"));
  let result = await f.post("/commit", {
    reviewId: r.id,
    paths: ["empty"],
    message: "intent is not staged",
  });
  expect(result.statusCode, result.body).toBe(400);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
  r = await f.review();
  result = await f.post("/git", {
    reviewId: r.id,
    action: "stage",
    path: "empty",
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().changed).toBe(true);
  expect(f.git("diff", "--cached", "--name-only")).toBe("empty");
  expect(f.git("status", "--short")).toBe("A  empty");
});
