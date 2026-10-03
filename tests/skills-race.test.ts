import { test, expect, vi, afterEach } from "vitest";
const race = vi.hoisted(() => ({
  path: "",
  action: undefined as undefined | (() => Promise<void>),
  flags: [] as number[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const run = async (path: unknown) => {
    if (String(path) === race.path && race.action) {
      const action = race.action;
      race.action = undefined;
      await action();
    }
  };
  return {
    ...fs,
    lstat: async (path: any, ...args: any[]) => {
      const stat = await (fs.lstat as any)(path, ...args);
      await run(path);
      return stat;
    },
    open: async (path: any, flags: any, ...args: any[]) => {
      race.flags.push(flags);
      const handle = await (fs.open as any)(path, flags, ...args);
      const stat = handle.stat.bind(handle);
      handle.stat = async (...args: any[]) => {
        const result = await stat(...args);
        await run(path);
        return result;
      };
      return handle;
    },
  };
});
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants } from "node:fs";
import { SkillCatalog } from "../packages/agents/src/skills.js";
const dirs: string[] = [];
afterEach(async () => {
  race.action = undefined;
  race.flags = [];
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "skill-race-")));
  dirs.push(dir);
  const root = join(dir, "skills");
  await mkdir(join(root, "exact"), { recursive: true });
  const path = join(root, "exact", "SKILL.md");
  await writeFile(path, "original");
  race.path = path;
  return { dir, root, path };
}
test("catalog skips skill replaced with external symlink between stat and read", async () => {
  const f = await setup();
  const outside = join(f.dir, "outside");
  await writeFile(outside, "external secret");
  race.action = async () => {
    await rm(f.path);
    await symlink(outside, f.path);
  };
  expect(await new SkillCatalog([f.root]).metadata()).toEqual([]);
});
test("catalog bounds bytes when a skill grows after descriptor stat", async () => {
  const f = await setup();
  race.action = async () => {
    await writeFile(f.path, "X".repeat(300 * 1024));
  };
  expect(await new SkillCatalog([f.root]).metadata()).toEqual([]);
});
test("catalog file descriptors are no-follow and nonblocking before type validation", async () => {
  const f = await setup();
  expect(await new SkillCatalog([f.root]).metadata()).toHaveLength(1);
  expect(race.flags.length).toBeGreaterThan(0);
  expect(
    race.flags.every(
      (f) =>
        (f & constants.O_NOFOLLOW) !== 0 && (f & constants.O_NONBLOCK) !== 0,
    ),
  ).toBe(true);
});
