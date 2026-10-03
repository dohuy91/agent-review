import { afterEach, expect, test, vi } from "vitest";
const race = vi.hoisted(() => ({
  path: "",
  action: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (path: any, options: any) => {
      const stat = await fs.lstat(path, options);
      if (path === race.path && options?.bigint && race.action) {
        const action = race.action;
        race.action = undefined;
        await action();
      }
      return stat;
    },
  };
});
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { registerRepository } from "../apps/server/src/registry.js";
import { startingFolderStamp } from "../packages/agents/src/target.js";
const dirs: string[] = [];
afterEach(async () => {
  race.action = undefined;
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
test("folder replaced after identity stat is rejected rather than stamped with old directory identity", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "starting-folder-race-")),
  );
  dirs.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  await writeFile(join(root, "a.txt"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const cwd = join(root, "src");
  await mkdir(cwd);
  const repo = await registerRepository(root);
  race.path = cwd;
  race.action = async () => {
    await rm(cwd, { recursive: true });
    await mkdir(cwd);
  };
  await expect(startingFolderStamp(repo, cwd)).rejects.toThrow(/changed/i);
});

test("synchronous final folder identity check matches the confirmed stamp and rejects replaced canonical or symlinked directories", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "starting-folder-final-")),
  );
  dirs.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  await writeFile(join(root, "a.txt"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const cwd = join(root, "src");
  await mkdir(cwd);
  const repo = await registerRepository(root);
  const mod: any = await import("../packages/agents/src/target.js");
  expect(typeof mod.startingFolderStampSync).toBe("function");
  const stamp = await startingFolderStamp(repo, cwd);
  expect(mod.startingFolderStampSync(repo, cwd)).toBe(stamp);
  await rm(cwd, { recursive: true });
  await mkdir(cwd);
  expect(mod.startingFolderStampSync(repo, cwd)).not.toBe(stamp);
  await rm(cwd, { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(root, cwd);
  expect(() => mod.startingFolderStampSync(repo, cwd)).toThrow(
    /folder|changed/i,
  );
});
