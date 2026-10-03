import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryBrowser } from "../apps/server/src/directory-browser.js";

// Map only synthetic configured mount paths to disposable directory metadata;
// never inspect or enumerate real system folders or a user's directories.
const mount = vi.hoisted(() => ({ source: "" }));
vi.mock("node:fs/promises", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const isSynthetic = (path: unknown) =>
    typeof path === "string" &&
    /^(\/usr(?:\/src(?:\/fixture-repo)?)?|\/var(?:\/www(?:\/fixture-repo)?)?|\/etc(?:\/fixture-repo)?|\/proc(?:\/fixture-repo)?|\/sys|\/dev)$/.test(
      path,
    );
  return {
    ...fs,
    realpath: async (path: Parameters<typeof fs.realpath>[0]) =>
      isSynthetic(path) ? String(path) : fs.realpath(path),
    lstat: async (path: Parameters<typeof fs.lstat>[0]) =>
      fs.lstat(isSynthetic(path) ? mount.source : path),
    access: async (path: Parameters<typeof fs.access>[0], mode?: number) =>
      fs.access(isSynthetic(path) ? mount.source : path, mode),
  };
});
afterEach(async () => {
  if (mount.source) await rm(mount.source, { recursive: true, force: true });
  mount.source = "";
});
async function fixture() {
  mount.source = await mkdtemp(join(tmpdir(), "directory-policy-"));
}
test("explicit project mounts below usr and var remain browseable without exposing their system parent", async () => {
  await fixture();
  for (const repositoryPath of [
    "/usr/src/fixture-repo",
    "/var/www/fixture-repo",
  ]) {
    const browser = await DirectoryBrowser.create({
      container: true,
      repositoryPath,
    });
    expect((await browser.listRoots()).roots.map((root) => root.path)).toEqual([
      repositoryPath,
    ]);
  }
  const explicit = await DirectoryBrowser.create({
    container: true,
    browseRoots: ["/usr/src/fixture-repo"],
  });
  expect((await explicit.listRoots()).roots.map((root) => root.path)).toEqual([
    "/usr/src/fixture-repo",
  ]);
});
test("system roots and sensitive virtual/configuration trees are not browse locations", async () => {
  await fixture();
  for (const root of [
    "/usr",
    "/var",
    "/etc",
    "/etc/fixture-repo",
    "/proc",
    "/proc/fixture-repo",
    "/sys",
    "/dev",
  ])
    await expect(
      DirectoryBrowser.create({ browseRoots: [root] }),
    ).rejects.toThrow(/system folders/);
});
