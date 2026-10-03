import { afterEach, expect, test } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { registerRepository } from "../apps/server/src/registry.js";
import { installSecurity } from "../apps/server/src/security.js";
import { installReviewRoutes } from "../apps/server/src/routes/reviews.js";
import { installPushRoutes } from "../apps/server/src/routes/push.js";
import { RepositoryQueue } from "../packages/git/src/mutations.js";
import type { PushPreview, PushTransport } from "../packages/git/src/push.js";
const roots: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(
  options: {
    enableWrites?: boolean;
    now?: () => number;
    transport?: (base: PushTransport) => PushTransport;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "review-owned-push-"));
  const remote = await mkdtemp(join(tmpdir(), "review-owned-push-remote-"));
  roots.push(root, remote);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "diff.autoRefreshIndex=false",
        "-C",
        root,
        ...args,
      ],
      { encoding: "utf8" },
    ).replace(/\n$/, "");
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(join(root, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const branch = git("symbolic-ref", "HEAD"),
    base = git("rev-parse", "HEAD");
  execFileSync("git", [
    "clone",
    "--bare",
    "--no-hardlinks",
    "--quiet",
    root,
    remote,
  ]);
  await writeFile(join(root, "a.txt"), "ahead\n");
  git("commit", "-qam", "selected outgoing");
  git("remote", "add", "origin", "https://fetch.example.test/project.git");
  git(
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://user:secret@push.example.test/project.git?token=hidden",
  );
  const calls: { args: string[]; options: object }[] = [];
  const recipient =
    "https://user:secret@push.example.test/project.git?token=hidden";
  const local: PushTransport = async (command, args, runOptions) => {
    calls.push({ args: [...args], options: runOptions });
    const copied = [...args];
    const at = copied.indexOf(recipient);
    if (at < 0)
      throw new Error("Only the owned fixture recipient may be substituted");
    copied[at] = remote;
    copied.splice(copied.indexOf("-C"), 0, "-c", "protocol.file.allow=always");
    return new Promise((resolve) =>
      execFile(
        command,
        copied,
        { ...runOptions, encoding: "buffer" },
        (error, stdout) =>
          resolve({
            code: error ? Number((error as { code?: number }).code ?? 1) : 0,
            stdout: stdout as Buffer,
          }),
      ),
    );
  };
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  apps.push(app);
  await app.register(cookie);
  installSecurity(app, 7373, "push-fixture");
  const repo = await registerRepository(root);
  const repositories = new Map([[repo.id, repo]]);
  const access = installReviewRoutes(app, repositories);
  const queue = new RepositoryQueue();
  installPushRoutes(app, repositories, access, {
    queue,
    enableWrites: options.enableWrites ?? true,
    pushTransport: options.transport?.(local) ?? local,
    now: options.now,
  });
  app.setErrorHandler((_e, _r, reply) =>
    reply.code(500).send({ error: "Request failed" }),
  );
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
  const session = await app.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "push-fixture" },
  });
  const auth = {
    ...headers,
    cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
  };
  const url = `/api/repositories/${repo.id}`;
  const post = (suffix: string, payload: object) =>
    app.inject({ method: "POST", url: url + suffix, headers: auth, payload });
  const review = async (target?: string, comparisonBase = "HEAD") => {
    const response = await app.inject({
      url:
        url +
        `/review?base=${encodeURIComponent(comparisonBase)}&mode=branch${target ? "&target=" + encodeURIComponent(target) : ""}`,
      headers: auth,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const preview = async (extra: object = {}) =>
    post("/push-preview", {
      reviewId: (await review()).id,
      localRef: branch,
      remote: "origin",
      destinationRef: branch,
      inspectRemote: true,
      ...extra,
    });
  const remoteGit = (...args: string[]) =>
    execFileSync("git", ["--git-dir", remote, ...args], {
      encoding: "utf8",
    }).replace(/\n$/, "");
  return {
    root,
    remote,
    repo,
    git,
    remoteGit,
    app,
    auth,
    url,
    post,
    review,
    preview,
    branch,
    base,
    calls,
    recipient,
    access,
    queue,
  };
}

test("explicit preview inspects actual push recipient and returns exact refs, OIDs, and bounded outgoing metadata", async () => {
  const f = await fixture();
  expect(f.calls).toHaveLength(0);
  const response = await f.preview();
  expect(response.statusCode, response.body).toBe(200);
  const p = response.json<PushPreview>();
  expect(p).toMatchObject({
    repositoryId: f.repo.id,
    localRef: f.branch,
    sourceOid: f.git("rev-parse", "HEAD"),
    remote: "origin",
    recipient: {
      url: "https://push.example.test/project.git",
      transport: "https",
    },
    destinationRef: f.branch,
    destinationOid: f.base,
    newBranch: false,
    upToDate: false,
    outgoing: { total: 1, truncated: false },
  });
  expect(p.outgoing.commits[0]).toMatchObject({ subject: "selected outgoing" });
  expect(response.body).not.toMatch(/secret|hidden|user:|fetch.example/);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.args).toContain("ls-remote");
});
test("confirmed plan pushes one exact non-force branch without touching local index, source, upstream, or other refs", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "unstaged\n");
  const index = await readFile(join(f.root, ".git/index"));
  const p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  const r = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({
    ok: true,
    outcome: "pushed",
    sourceOid: f.git("rev-parse", "HEAD"),
  });
  expect(f.remoteGit("rev-parse", f.branch)).toBe(f.git("rev-parse", "HEAD"));
  expect(await readFile(join(f.root, ".git/index"))).toEqual(index);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("unstaged\n");
  const push = f.calls.find((c) => c.args.includes("push"))!;
  expect(push.args.at(-1)).toBe(`${f.git("rev-parse", "HEAD")}:${f.branch}`);
  expect(push.args).toEqual(
    expect.arrayContaining([
      "--no-force",
      "--no-mirror",
      "--no-all",
      "--no-tags",
      "--no-follow-tags",
      "--recurse-submodules=no",
      "--no-signed",
      "--no-set-upstream",
    ]),
  );
  expect(
    push.args.some(
      (a) =>
        a === "--force" ||
        a.startsWith("--force-with-lease") ||
        a.startsWith("+"),
    ),
  ).toBe(false);
  expect(() => f.git("config", "--get-regexp", "^branch\\.")).toThrow();
});
test("inspection is explicit, confirmation is explicit, and a consumed plan cannot run again", async () => {
  const f = await fixture();
  const review = await f.review();
  expect(
    (
      await f.post("/push-preview", {
        reviewId: review.id,
        localRef: f.branch,
        remote: "origin",
        destinationRef: f.branch,
      })
    ).statusCode,
  ).toBe(400);
  expect(f.calls).toHaveLength(0);
  const p = await f.preview();
  expect(p.statusCode).toBe(200);
  expect(
    (await f.post("/push", { previewId: p.json().previewId })).statusCode,
  ).toBe(400);
  expect(
    (await f.post("/push", { previewId: p.json().previewId, confirmed: true }))
      .statusCode,
  ).toBe(200);
  const count = f.calls.length;
  expect(
    (await f.post("/push", { previewId: p.json().previewId, confirmed: true }))
      .statusCode,
  ).toBe(409);
  expect(f.calls).toHaveLength(count);
});
for (const change of [
  "source",
  "index",
  "branch",
  "config",
  "tracking",
] as const)
  test(`push plan refuses stale ${change} without transmission`, async () => {
    const f = await fixture();
    const p = await f.preview();
    expect(p.statusCode).toBe(200);
    const count = f.calls.length;
    if (change === "source")
      await writeFile(join(f.root, "a.txt"), "after preview\n");
    if (change === "index")
      f.git("update-index", "--assume-unchanged", "a.txt");
    if (change === "branch")
      f.git("commit", "--allow-empty", "-qm", "new local head");
    if (change === "config") f.git("config", "user.name", "Changed");
    if (change === "tracking")
      f.git("update-ref", "refs/remotes/origin/other", f.base);
    const response = await f.post("/push", {
      previewId: p.json().previewId,
      confirmed: true,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(f.calls).toHaveLength(count);
    expect(f.remoteGit("rev-parse", f.branch)).toBe(f.base);
  });
test("expired plans and moved remote tips are refused without push", async () => {
  let time = Date.now();
  const f = await fixture({ now: () => time });
  let p = await f.preview();
  expect(p.statusCode).toBe(200);
  time += 5 * 60 * 1000 + 1;
  let result = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode).toBe(409);
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(0);
  p = await f.preview();
  expect(p.statusCode).toBe(200);
  f.remoteGit("update-ref", "-d", f.branch, f.base);
  result = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode).toBe(409);
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(0);
});
test("an explicitly selected other local branch is previewed and pushed without switching the worktree", async () => {
  const f = await fixture();
  f.git("branch", "selected-other", f.base);
  const localRef = "refs/heads/selected-other";
  const review = await f.review(localRef);
  const r = await f.post("/push-preview", {
    reviewId: review.id,
    localRef,
    remote: "origin",
    destinationRef: "refs/heads/reviewed-other",
    inspectRemote: true,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({
    localRef,
    sourceOid: f.base,
    worktree: { branch: f.branch, head: f.git("rev-parse", "HEAD") },
    destinationOid: null,
    newBranch: true,
  });
  expect(
    (await f.post("/push", { previewId: r.json().previewId, confirmed: true }))
      .statusCode,
  ).toBe(200);
  expect(f.remoteGit("rev-parse", "refs/heads/reviewed-other")).toBe(f.base);
  expect(f.git("symbolic-ref", "HEAD")).toBe(f.branch);
});
test("unsafe push configuration and double-applying recipient rewrites are rejected before network", async () => {
  const f = await fixture();
  const cases = [
    ["remote.origin.mirror", "true"],
    ["remote.origin.push", "+refs/heads/*:refs/heads/*"],
    ["remote.origin.receivepack", "custom"],
    ["remote.origin.vcs", "custom"],
    ["core.alternateRefsCommand", "false"],
    ["push.pushOption", "custom"],
  ];
  for (const [key, value] of cases) {
    f.git("config", key!, value!);
    const r = await f.preview();
    expect(r.statusCode, r.body).toBe(400);
    expect(f.calls).toHaveLength(0);
    f.git("config", "--unset-all", key!);
  }
  f.git("config", "url.https://elsewhere.test/.insteadOf", f.recipient);
  f.git(
    "config",
    "url.https://third.test/.insteadOf",
    "https://elsewhere.test/",
  );
  expect((await f.preview()).statusCode).toBe(400);
  expect(f.calls).toHaveLength(0);
  f.git("config", "--unset-all", "url.https://elsewhere.test/.insteadOf");
  f.git("config", "--unset-all", "url.https://third.test/.insteadOf");
  f.git(
    "config",
    "--add",
    "remote.origin.pushurl",
    "https://second.test/project.git",
  );
  expect((await f.preview()).statusCode).toBe(400);
  expect(f.calls).toHaveLength(0);
});
test("comparison plans bind the reviewed tracking ref to the configured source before any inspection", async () => {
  const f = await fixture();
  f.git(
    "remote",
    "add",
    "upstream",
    "https://upstream.example.test/project.git",
  );
  const comparisonRef = "refs/remotes/origin/main";
  f.git(
    "config",
    "remote.origin.fetch",
    `+refs/heads/release:${comparisonRef}`,
  );
  f.git("update-ref", comparisonRef, f.base);
  f.remoteGit("update-ref", "refs/heads/release", f.base);
  const review = await f.review(undefined, comparisonRef);
  const request = {
    reviewId: review.id,
    localRef: f.branch,
    remote: "origin",
    destinationRef: "refs/heads/release",
    comparisonRef,
    inspectRemote: true,
  };
  const p = await f.post("/push-preview", request);
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json().comparisonRef).toBe(comparisonRef);
  expect(f.calls).toHaveLength(1);
  for (const changed of [
    { destinationRef: "refs/heads/main" },
    { remote: "upstream" },
    { comparisonRef: "refs/remotes/origin/other" },
  ]) {
    const response = await f.post("/push-preview", { ...request, ...changed });
    expect(response.statusCode, response.body).toBe(409);
    expect(f.calls).toHaveLength(1);
  }
  f.git("config", "remote.origin.fetch", `+refs/heads/main:${comparisonRef}`);
  const result = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode, result.body).toBe(409);
  expect(f.calls).toHaveLength(1);
  expect(f.remoteGit("rev-parse", "refs/heads/release")).toBe(f.base);
});

test("comparison plans refuse missing, symbolic, excluded and ambiguous tracking mappings offline", async () => {
  const f = await fixture();
  const comparisonRef = "refs/remotes/origin/main";
  f.git("update-ref", comparisonRef, f.base);
  const review = await f.review(undefined, comparisonRef);
  const request = {
    reviewId: review.id,
    localRef: f.branch,
    remote: "origin",
    destinationRef: "refs/heads/main",
    comparisonRef,
    inspectRemote: true,
  };
  const configurations = [
    ["+refs/heads/release:refs/remotes/origin/release"],
    ["+refs/heads/*:refs/remotes/origin/*", "^refs/heads/main"],
    [
      "+refs/heads/main:refs/remotes/origin/main",
      "+refs/heads/release:refs/remotes/origin/main",
    ],
    ["+refs/tags/*:refs/remotes/origin/*"],
  ];
  for (const specs of configurations) {
    f.git("config", "--unset-all", "remote.origin.fetch");
    for (const spec of specs)
      f.git("config", "--add", "remote.origin.fetch", spec);
    const result = await f.post("/push-preview", request);
    expect(result.statusCode, result.body).toBe(409);
    expect(f.calls).toHaveLength(0);
  }
  f.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  f.git("symbolic-ref", comparisonRef, f.branch);
  expect((await f.post("/push-preview", request)).statusCode).toBe(409);
  expect(f.calls).toHaveLength(0);
});

test("URL-scoped redirect overrides are refused before Push inspection and false aliases remain supported", async () => {
  const f = await fixture();
  const key = "http.https://push.example.test/.followRedirects";
  for (const value of ["true", "initial", "unknown", ""]) {
    f.git("config", key, value);
    const result = await f.preview();
    expect(result.statusCode, result.body).toBe(400);
    expect(result.json().error).toMatch(/redirect/i);
    expect(result.body).not.toMatch(/secret|hidden|user:/);
    expect(f.calls).toHaveLength(0);
  }
  for (const value of ["false", "no", "off", "0", "FALSE"]) {
    f.git("config", key, value);
    const result = await f.preview();
    expect(result.statusCode, result.body).toBe(200);
  }
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(0);
});

test("adding a URL-scoped redirect override invalidates confirmation before another remote inspection", async () => {
  const f = await fixture();
  const p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  f.git("config", "http.https://push.example.test/.followRedirects", "true");
  const result = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode, result.body).toBe(400);
  expect(f.calls).toHaveLength(1);
});
test("read-only, authentication, and strict payload gates prevent hidden network actions", async () => {
  const f = await fixture({ enableWrites: false });
  expect((await f.preview()).statusCode).toBe(403);
  expect(
    (await f.post("/push", { previewId: "x", confirmed: true })).statusCode,
  ).toBe(403);
  expect(f.calls).toHaveLength(0);
  const r = await f.app.inject({
    method: "POST",
    url: f.url + "/push-preview",
    headers: { host: "localhost:7373", origin: "http://localhost:7373" },
    payload: {},
  });
  expect(r.statusCode).toBe(401);
  const g = await fixture();
  expect(
    (
      await g.preview({
        url: "https://other.test",
        refspec: "+refs/heads/*:refs/heads/*",
        env: {},
      })
    ).statusCode,
  ).toBe(400);
  expect(g.calls).toHaveLength(0);
});
function divergentRemote(f: Awaited<ReturnType<typeof fixture>>) {
  const oid = f.remoteGit(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit-tree",
    f.remoteGit("rev-parse", `${f.base}^{tree}`),
    "-p",
    f.base,
    "-m",
    "remote diverged",
  );
  f.remoteGit("update-ref", f.branch, oid);
  return oid;
}
test("preview refuses unknown remote history and known non-fast-forward history without silently fetching", async () => {
  const f = await fixture();
  divergentRemote(f);
  let r = await f.preview();
  expect(r.statusCode, r.body).toBe(400);
  expect(r.json().error).toMatch(/fetch/i);
  expect(
    f.calls.map((c) =>
      c.args.find((a) => a === "ls-remote" || a === "push" || a === "fetch"),
    ),
  ).toEqual(["ls-remote"]);
  f.git(
    "fetch",
    "--quiet",
    f.remote,
    `${f.branch}:refs/remotes/owned-fixture/diverged`,
  );
  r = await f.preview();
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json().error).toMatch(/Force-push is disabled/);
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(0);
});
test("a non-fast-forward race is rejected authoritatively with no force fallback or plan retry", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({
    transport: (base) => async (command, args, options) => {
      if (args.includes("push")) divergentRemote(f);
      return base(command, args, options);
    },
  });
  const p = await f.preview();
  expect(p.statusCode).toBe(200);
  const result = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode, result.body).toBe(409);
  expect(result.json().outcome).toBe("rejected");
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
  const count = f.calls.length;
  expect(
    (await f.post("/push", { previewId: p.json().previewId, confirmed: true }))
      .statusCode,
  ).toBe(409);
  expect(f.calls).toHaveLength(count);
  expect(f.remoteGit("rev-parse", f.branch)).not.toBe(
    f.git("rev-parse", "HEAD"),
  );
});
test("authentication errors and output floods cannot expose helper output or produce a push plan", async () => {
  for (const fault of ["auth", "flood"]) {
    const f = await fixture({
      transport: () => async () => ({
        code: fault === "auth" ? 128 : 0,
        stdout:
          fault === "auth"
            ? Buffer.from(
                "secret credential https://user:password@example.test",
              )
            : Buffer.alloc(1024 * 1024 + 1, 120),
      }),
    });
    const r = await f.preview();
    expect(r.statusCode, r.body).toBe(502);
    expect(r.body).not.toMatch(/secret|password|credential https/);
    expect(r.json().outcome).toBe("not-pushed");
    expect(r.json().previewId).toBeUndefined();
  }
});
test("loss of acknowledgment after transmission is uncertain and consumes the plan without retry", async () => {
  const f = await fixture({
    transport: (base) => async (command, args, options) => {
      const result = await base(command, args, options);
      if (args.includes("push"))
        throw new Error("secret helper output after remote accepted");
      return result;
    },
  });
  const p = await f.preview();
  expect(p.statusCode).toBe(200);
  const r = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(r.statusCode, r.body).toBe(502);
  expect(r.json().outcome).toBe("uncertain");
  expect(r.body).not.toContain("secret");
  expect(f.remoteGit("rev-parse", f.branch)).toBe(f.git("rev-parse", "HEAD"));
  const count = f.calls.length;
  expect(
    (await f.post("/push", { previewId: p.json().previewId, confirmed: true }))
      .statusCode,
  ).toBe(409);
  expect(f.calls).toHaveLength(count);
});
test("outgoing metadata is bounded and new-branch semantics remain explicit", async () => {
  const f = await fixture();
  for (let i = 0; i < 52; i++)
    f.git("commit", "--allow-empty", "-qm", `commit ${i} ` + "x".repeat(400));
  const p = await f.preview({ destinationRef: "refs/heads/new-preview-only" });
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json()).toMatchObject({
    newBranch: true,
    destinationOid: null,
    outgoing: { total: 54, truncated: true },
  });
  expect(p.json().outgoing.commits).toHaveLength(50);
  expect(
    p
      .json()
      .outgoing.commits.every(
        (c: { subject: string }) => c.subject.length <= 300,
      ),
  ).toBe(true);
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(0);
});
test("follow-tags, signing, implicit-all, and upstream defaults cannot broaden the explicit push", async () => {
  const f = await fixture();
  f.git("tag", "-a", "only-local-tag", "-m", "tag");
  f.git("branch", "only-local-branch");
  f.git("config", "push.followTags", "true");
  f.git("config", "push.gpgSign", "true");
  f.git("config", "push.autoSetupRemote", "true");
  f.git("config", "push.default", "matching");
  const before = f.git("for-each-ref", "--format=%(refname) %(objectname)");
  const p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  const r = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(f.remoteGit("for-each-ref", "--format=%(refname)")).toBe(f.branch);
  expect(f.git("for-each-ref", "--format=%(refname) %(objectname)")).toBe(
    before,
  );
  expect(() => f.git("config", "--get-regexp", "^branch\\.")).toThrow();
  expect(f.git("config", "push.autoSetupRemote")).toBe("true");
});
test("already-up-to-date confirmation is honest and sends no additional push", async () => {
  const f = await fixture();
  let p = await f.preview();
  expect(
    (await f.post("/push", { previewId: p.json().previewId, confirmed: true }))
      .statusCode,
  ).toBe(200);
  p = await f.preview();
  expect(p.statusCode).toBe(200);
  expect(p.json()).toMatchObject({
    upToDate: true,
    outgoing: { total: 0, commits: [], truncated: false },
  });
  const r = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().outcome).toBe("up-to-date");
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
});
test("same-OID checkout changes and mismatched selected local refs are refused", async () => {
  const f = await fixture();
  f.git("branch", "same-oid");
  const r = await f.review();
  expect(
    (await f.preview({ reviewId: r.id, localRef: "refs/heads/same-oid" }))
      .statusCode,
  ).toBe(409);
  expect(f.calls).toHaveLength(0);
  const p = await f.preview();
  expect(p.statusCode).toBe(200);
  f.git("symbolic-ref", "HEAD", "refs/heads/same-oid");
  const count = f.calls.length;
  const response = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(f.calls).toHaveLength(count);
});
test("historical observations cannot authorize Push even at the same selected OID", async () => {
  const f = await fixture();
  const r = await f.review();
  const historical = await f.access.openHistorical(f.repo.id, {
    ...r,
    acceptedAt: new Date().toISOString(),
    fileCount: r.files.length,
    historicalContent: "git-objects-only",
  });
  expect(historical.head).toBe(r.head);
  const response = await f.post("/push-preview", {
    reviewId: historical.id,
    localRef: f.branch,
    remote: "origin",
    destinationRef: f.branch,
    inspectRemote: true,
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(f.calls).toHaveLength(0);
});
test("Push uses the supplied repository queue and concurrent confirmations cannot duplicate transmission", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const entered = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const owner = f.queue.run(f.repo.id, async () => {
    locked();
    await gate;
  });
  await entered;
  const preview = f.preview();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.calls).toHaveLength(0);
  release();
  await owner;
  const p = await preview;
  expect(p.statusCode).toBe(200);
  const results = await Promise.all(
    [1, 2].map(() =>
      f.post("/push", { previewId: p.json().previewId, confirmed: true }),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
});
test("manual Push never executes a configured pre-push hook", async () => {
  const { chmod, access } = await import("node:fs/promises");
  const f = await fixture();
  const marker = join(f.root, ".git/owned-prepush-marker");
  const hook = join(f.root, ".git/hooks/pre-push");
  await writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`);
  await chmod(hook, 0o755);
  const p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  const result = await f.post("/push", {
    previewId: p.json().previewId,
    confirmed: true,
  });
  expect(result.statusCode, result.body).toBe(200);
  await expect(access(marker)).rejects.toThrow();
});
