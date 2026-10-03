import { afterEach, expect, test } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../apps/server/src/app.js";
import { parseCLI } from "../apps/server/src/cli.js";
import { execFileSync } from "node:child_process";

const fixtures: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "review-directory-test-"));
  fixtures.push(path);
  return realpath(path);
}
const localHeaders = {
  host: "localhost:7373",
  origin: "http://localhost:7373",
};
async function setup(options: Record<string, unknown> = {}) {
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: await fixture(),
    ...options,
  });
  apps.push(app);
  const session = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: localHeaders,
    payload: { token: "fixture" },
  });
  const headers = {
    ...localHeaders,
    cookie: `review_session=${session.cookies[0]!.value}`,
  };
  const rootsResponse = await app.inject({
    url: "/api/directory-roots",
    headers,
  });
  return {
    app,
    headers,
    rootsResponse,
    roots: rootsResponse.json().roots as {
      id: string;
      path: string;
      label: string;
    }[],
    list: (rootId: string, path = "", cursor?: string) =>
      app.inject({
        url:
          "/api/directory-listing?" +
          new URLSearchParams({ rootId, path, ...(cursor ? { cursor } : {}) }),
        headers,
      }),
  };
}
test("directory browser lists only visible real directories and does not register them", async () => {
  const root = await fixture();
  for (const name of [
    "first",
    "second",
    ".git",
    ".private",
    "node_modules",
    "$RECYCLE.BIN",
  ])
    await mkdir(join(root, name));
  await writeFile(join(root, "secret.txt"), "not directory data");
  const { app, headers, rootsResponse, roots, list } = await setup({
    browseRoots: [root],
  });
  expect(rootsResponse.statusCode).toBe(200);
  expect(rootsResponse.headers["cache-control"]).toBe("no-store");
  expect(roots).toHaveLength(1);
  expect(roots[0]).toMatchObject({ path: root });
  const response = await list(roots[0]!.id);
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toMatchObject({
    path: root,
    relativePath: "",
    entries: [
      { name: "first", relativePath: "first" },
      { name: "second", relativePath: "second" },
    ],
    nextCursor: null,
  });
  expect(response.body).not.toMatch(
    /secret|not directory data|\.git|\.private|node_modules|RECYCLE/,
  );
  expect(
    (await app.inject({ url: "/api/repositories", headers })).json()
      .repositories,
  ).toEqual([]);
});
test("directory endpoints retain authentication, Host, Origin and same-origin restrictions", async () => {
  const root = await fixture();
  const { app, headers, roots } = await setup({ browseRoots: [root] });
  for (const url of [
    "/api/directory-roots",
    `/api/directory-listing?rootId=${roots?.[0]?.id ?? "missing"}`,
  ]) {
    expect((await app.inject({ url, headers: localHeaders })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          url,
          headers: { ...headers, host: "foreign.test:7373" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url,
          headers: { ...headers, origin: "http://foreign.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url,
          headers: { ...headers, "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
  }
});
test("rejects traversal, absolute paths, hidden paths, unknown roots, symlinks and files", async () => {
  const root = await fixture(),
    outside = await fixture();
  await mkdir(join(root, "inside"));
  await mkdir(join(root, ".hidden"));
  await mkdir(join(outside, "sensitive"));
  await writeFile(join(root, "file.txt"), "private");
  await symlink(outside, join(root, "outside-link"), "dir");
  await symlink(join(root, "inside"), join(root, "inside-link"), "dir");
  const { roots, list, app, headers } = await setup({ browseRoots: [root] });
  expect(roots).toHaveLength(1);
  const id = roots[0]!.id;
  for (const path of [
    "..",
    "../outside",
    root,
    "inside/../../outside",
    "inside\\..",
    "a//b",
    ".hidden",
    "inside/.",
    "outside-link",
    "inside-link",
    "file.txt",
    "\u0000",
    "a\nb",
  ])
    expect((await list(id, path)).statusCode, path).toBeGreaterThanOrEqual(400);
  expect((await list("not-configured", "")).statusCode).toBe(404);
  expect((await list(id)).json().entries).toEqual([
    { name: "inside", relativePath: "inside" },
  ]);
  expect((await list(id, "inside")).json()).toMatchObject({
    path: join(root, "inside"),
    relativePath: "inside",
    entries: [],
  });
  expect(
    (
      await app.inject({
        url: `/api/directory-listing?rootId=${id}&rootId=${id}`,
        headers,
      })
    ).statusCode,
  ).toBe(400);
});
test("changed root identity or a retargeted configured symlink fails closed", async () => {
  const parent = await fixture(),
    root = join(parent, "root"),
    other = join(parent, "other"),
    alias = join(parent, "alias");
  await mkdir(root);
  await mkdir(other);
  await symlink(root, alias, "dir");
  const { roots, list } = await setup({ browseRoots: [root, alias] });
  expect(roots).toHaveLength(1);
  await rename(root, join(parent, "old-root"));
  await mkdir(root);
  await mkdir(join(root, "replacement"));
  const changed = await list(roots[0]!.id);
  expect(changed.statusCode).toBe(403);
  expect(changed.json().error).toMatch(/changed|restart/i);
  const second = await setup({ browseRoots: [alias] });
  await rm(alias);
  await symlink(other, alias, "dir");
  expect((await second.list(second.roots[0]!.id)).statusCode).toBe(403);
});
test("omits review state and rejects unreadable directories without leaking child names", async () => {
  const root = await fixture(),
    privateState = join(root, "review-state"),
    denied = join(root, "denied");
  await mkdir(privateState);
  await mkdir(denied);
  await mkdir(join(denied, "private-child"));
  await chmod(denied, 0);
  try {
    const { roots, list } = await setup({
      browseRoots: [root],
      dataDir: privateState,
    });
    expect(roots).toHaveLength(1);
    expect((await list(roots[0]!.id)).json().entries).toEqual([]);
    expect((await list(roots[0]!.id, "review-state")).statusCode).toBe(403);
    const response = await list(roots[0]!.id, "denied");
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("private-child");
    expect(response.json().error).toMatch(/permission|read/i);
  } finally {
    await chmod(denied, 0o700);
  }
});
test("uses bounded pages with explicit limit feedback, and validates cursors", async () => {
  const root = await fixture();
  await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      mkdir(join(root, `folder-${String(index).padStart(3, "0")}`)),
    ),
  );
  const { roots, list } = await setup({ browseRoots: [root] });
  expect(roots).toHaveLength(1);
  const first = await list(roots[0]!.id),
    page = first.json();
  expect(page.entries).toHaveLength(100);
  expect(page.nextCursor).toBe("100");
  const next = (await list(roots[0]!.id, "", page.nextCursor)).json();
  expect(next.entries).toHaveLength(20);
  expect(next.nextCursor).toBeNull();
  expect(
    new Set([...page.entries, ...next.entries].map((entry) => entry.name)).size,
  ).toBe(120);
  for (const cursor of ["-1", "01", "1.5", "50000", "NaN"])
    expect((await list(roots[0]!.id, "", cursor)).statusCode).toBe(400);
  await Promise.all(
    Array.from({ length: 2001 }, (_, index) =>
      writeFile(join(root, `file-${index}`), ""),
    ),
  );
  const limited = (await list(roots[0]!.id)).json();
  expect(limited.truncated).toBe(true);
  expect(limited.message).toMatch(/limit|many/i);
  expect(limited.entries.length).toBeLessThanOrEqual(100);
});
test("native default allows siblings, while containers default only to the launched repository", async () => {
  const parent = await fixture(),
    repo = join(parent, "repo"),
    sibling = join(parent, "sibling");
  execFileSync("git", ["init", "--initial-branch=main", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await mkdir(sibling);
  const native = await setup({ repositoryPath: repo });
  expect(native.roots).toHaveLength(1);
  expect(native.roots[0]!.path).toBe(parent);
  expect(
    (await native.list(native.roots[0]!.id))
      .json()
      .entries.map((entry: { name: string }) => entry.name),
  ).toContain("sibling");
  const container = await setup({ repositoryPath: repo, container: true });
  expect(container.roots.map((root) => root.path)).toEqual([repo]);
  expect((await container.list(container.roots[0]!.id)).json().entries).toEqual(
    [],
  );
  const unconfigured = await setup({ container: true });
  expect(unconfigured.roots).toEqual([]);
  expect(unconfigured.rootsResponse.json().message).toMatch(/--browse-root/);
  const extra = await setup({
    repositoryPath: repo,
    container: true,
    browseRoots: [sibling],
  });
  expect(extra.roots.map((root) => root.path)).toEqual([repo, sibling]);
  const mounted = await setup({
    repositoryPath: repo,
    container: true,
    browseRoots: [repo],
  });
  expect(mounted.roots.map((root) => root.path)).toEqual([repo]);
});
test("directory CLI roots are explicit, repeatable and cannot be combined with export", () => {
  expect(
    parseCLI(["repo", "--browse-root", "first", "--browse-root", "second"])
      .browseRoots,
  ).toEqual([resolve("first"), resolve("second")]);
  expect(parseCLI(["repo"]).browseRoots).toEqual([]);
  expect(parseCLI(["repo", "--container"]).browseRoots).toEqual([]);
  for (const args of [
    ["repo", "--browse-root"],
    ["repo", "--browse-root", "--container"],
    ["repo", "--export-comments", "out.json", "--browse-root", "first"],
  ])
    expect(() => parseCLI(args)).toThrow();
});

test("implicit native browsing never exposes the shared temporary parent", async () => {
  const root = await fixture();
  execFileSync("git", ["init", "--initial-branch=main", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const { roots } = await setup({ repositoryPath: root });
  expect(roots.map((entry) => entry.path)).toEqual([root]);
});

test("nested ancestor symlinks and lookalike sibling prefixes cannot escape the configured root", async () => {
  const parent = await fixture(),
    root = join(parent, "project"),
    outside = join(parent, "project-private");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(outside, "nested"));
  await symlink(outside, join(root, "alias"), "dir");
  const { roots, list } = await setup({ browseRoots: [root] });
  for (const path of ["alias/nested", "../project-private/nested"])
    expect((await list(roots[0]!.id, path)).statusCode).toBeGreaterThanOrEqual(
      400,
    );
});

test("missing folders and malformed listing queries return useful errors without cached data", async () => {
  const root = await fixture();
  const { roots, list, app, headers } = await setup({ browseRoots: [root] });
  const missing = await list(roots[0]!.id, "removed");
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error).toMatch(/no longer available/);
  expect(missing.headers["cache-control"]).toBe("no-store");
  for (const query of [
    "",
    `rootId=${roots[0]!.id}&path=x&path=y`,
    `rootId=${roots[0]!.id}&cursor=0&cursor=100`,
    `rootId=${roots[0]!.id}&unexpected=value`,
  ]) {
    const response = await app.inject({
      url: `/api/directory-listing?${query}`,
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  const unauthenticated = await app.inject({
    url: "/api/directory-roots",
    headers: localHeaders,
  });
  expect(unauthenticated.headers["cache-control"]).toBe("no-store");
});
