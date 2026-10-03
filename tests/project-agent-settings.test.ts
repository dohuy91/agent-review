import { afterEach, expect, test } from "vitest";
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
import { execFileSync } from "node:child_process";
import { ReviewStore } from "../packages/review/src/store.js";
import { registerRepository } from "../apps/server/src/registry.js";
const dirs: string[] = [],
  stores: ReviewStore[] = [];
afterEach(async () => {
  stores.splice(0).forEach((s) => s.close());
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "project-agents-")));
  dirs.push(dir);
  const root = join(dir, "repo");
  await mkdir(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  await writeFile(join(root, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const repository = await registerRepository(root),
    store = new ReviewStore(join(dir, "state"));
  stores.push(store);
  await mkdir(join(root, "src"));
  const mod: any =
    await import("../packages/review/src/project-settings.js").catch(
      () => ({}),
    );
  return { dir, root, repository, store, mod, git };
}
test("project agent settings default to the registered worktree and persist exact selection", async () => {
  const f = await fixture();
  expect(typeof f.mod.getProjectAgentSettings).toBe("function");
  expect(f.mod.getProjectAgentSettings(f.store, f.repository)).toMatchObject({
    revision: 0,
    settings: { startingFolder: f.root, adapter: "codex", skill: null },
  });
  const settings = {
    startingFolder: join(f.root, "src"),
    adapter: "claude",
    skill: { locator: "exact", digest: "a".repeat(64) },
  };
  const saved = f.mod.putProjectAgentSettings(
    f.store,
    f.repository,
    settings,
    0,
  );
  expect(saved).toMatchObject({ revision: 1, settings });
  const second = new ReviewStore(join(f.dir, "state"));
  stores.push(second);
  expect(f.mod.getProjectAgentSettings(second, f.repository)).toEqual(saved);
  expect(() =>
    f.mod.putProjectAgentSettings(
      f.store,
      f.repository,
      { ...settings, adapter: "codex" },
      0,
    ),
  ).toThrow(/changed/i);
});
test("starting folder rejects outside paths, symlinks, files and nested Git identities", async () => {
  const f = await fixture();
  expect(typeof f.mod.validateStartingFolder).toBe("function");
  await mkdir(join(f.dir, "outside"));
  await symlink(join(f.root, "src"), join(f.root, "alias"));
  await expect(
    f.mod.validateStartingFolder(f.repository, join(f.root, "src")),
  ).resolves.toBe(join(f.root, "src"));
  for (const path of [
    join(f.dir, "outside"),
    join(f.root, "alias"),
    join(f.root, "a.txt"),
    `${f.root}/src/..`,
  ])
    await expect(
      f.mod.validateStartingFolder(f.repository, path),
    ).rejects.toThrow();
  const nested = join(f.root, "nested");
  await mkdir(nested);
  execFileSync("git", ["-C", nested, "init", "-q"]);
  await expect(
    f.mod.validateStartingFolder(f.repository, nested),
  ).rejects.toThrow(/worktree|folder/i);
});
test("project discovery stays at the selected folder and labels exact project and allowed global skills", async () => {
  const f = await fixture();
  const mod: any = await import("../packages/agents/src/skills.js");
  expect(typeof mod.projectSkillCatalog).toBe("function");
  for (const [path, text] of [
    [
      join(f.root, "src", ".agents", "skills", "fix", "SKILL.md"),
      "---\nname: Review fixes\ndescription: Apply findings\n---\nFix",
    ],
    [join(f.dir, "global", "debug", "SKILL.md"), "# Debug"],
    [join(f.root, ".agents", "skills", "not-selected", "SKILL.md"), "No"],
  ]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
  await symlink(
    join(f.dir, "global"),
    join(f.root, "src", ".agents", "skills", "escape"),
  );
  const catalog = mod.projectSkillCatalog(join(f.root, "src"), [
    join(f.dir, "global"),
  ]);
  const skills = await catalog.metadata();
  expect(skills).toHaveLength(2);
  expect(skills.find((s: any) => s.source === "project")).toMatchObject({
    name: "Review fixes",
    description: "Apply findings",
    sourceRoot: join(f.root, "src", ".agents", "skills"),
  });
  expect(skills.find((s: any) => s.source === "global")).toMatchObject({
    name: "debug",
    sourceRoot: join(f.dir, "global"),
  });
  const skill = skills[0];
  await expect(catalog.resolve(skill)).resolves.toBeTypeOf("string");
  await writeFile(skill.locator, "changed");
  await expect(catalog.resolve(skill)).rejects.toThrow(/changed/i);
});
test("folder execution stamp changes when a chosen directory is replaced and rejects escaped roots", async () => {
  const f = await fixture();
  const mod: any = await import("../packages/agents/src/target.js");
  expect(typeof mod.startingFolderStamp).toBe("function");
  const cwd = join(f.root, "src"),
    before = await mod.startingFolderStamp(f.repository, cwd);
  await rm(cwd, { recursive: true });
  await mkdir(cwd);
  expect(await mod.startingFolderStamp(f.repository, cwd)).not.toBe(before);
  await rm(cwd, { recursive: true });
  await symlink(join(f.dir, "state"), cwd);
  await expect(mod.startingFolderStamp(f.repository, cwd)).rejects.toThrow();
});
