import { afterEach, expect, test, vi } from "vitest";
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
import { execFileSync, spawn } from "node:child_process";
import Fastify from "fastify";
import { ReviewStore } from "../packages/review/src/store.js";
import { registerRepository } from "../apps/server/src/registry.js";
import { installReviewRoutes } from "../apps/server/src/routes/reviews.js";
import { installCommentRoutes } from "../apps/server/src/routes/comments.js";
import { SkillCatalog } from "../packages/agents/src/skills.js";
import { installAgentRoutes } from "../apps/server/src/routes/agents.js";
const dirs: string[] = [],
  apps: any[] = [],
  stores: ReviewStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((a) => a.close()));
  stores.splice(0).forEach((s) => s.close());
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "project-agent-http-")),
  );
  dirs.push(dir);
  const root = join(dir, "repo"),
    cwd = join(root, "src");
  await mkdir(cwd, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  await writeFile(join(root, "a.txt"), "base\nstable\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "other");
  const skillPath = join(cwd, ".agents", "skills", "fix", "SKILL.md");
  await mkdir(join(skillPath, ".."), { recursive: true });
  await writeFile(skillPath, "Fix selected findings");
  await writeFile(join(root, "a.txt"), "changed\nstable\n");
  const repository = await registerRepository(root),
    repositories = new Map([[repository.id, repository]]),
    store = new ReviewStore(join(dir, "state"));
  stores.push(store);
  const app = Fastify();
  apps.push(app);
  const access = installReviewRoutes(app, repositories);
  installCommentRoutes(app, repositories, access, store);
  const invocations: any[] = [];
  installAgentRoutes(app, repositories, access, store, {
    skillRoots: [],
    enableWrites: true,
    processFactory: (command, args, options) => {
      invocations.push({ command, args, options });
      return spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'turn.completed'})))",
        ],
        options,
      );
    },
  });
  const mod: any =
    await import("../apps/server/src/routes/project-settings.js").catch(
      () => ({}),
    );
  expect(typeof mod.installProjectSettingsRoutes).toBe("function");
  mod.installProjectSettingsRoutes(app, repositories, access, store, {
    skillRoots: [],
  });
  const call = (method: any, url: string, payload?: any) =>
    app.inject({
      method,
      url: `/api/repositories/${repository.id}/${url}`,
      payload,
    });
  const review = (await call("GET", "review?base=HEAD&mode=full")).json();
  const comment = (
    await call("POST", "comments", {
      reviewId: review.id,
      path: "a.txt",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "Fix",
      severity: "warning",
    })
  ).json();
  const skills = (
    await call(
      "GET",
      `skills?reviewId=${review.id}&startingFolder=${encodeURIComponent(cwd)}`,
    )
  ).json().skills;
  const settings = {
    startingFolder: cwd,
    adapter: "codex",
    skill: { locator: skills[0].locator, digest: skills[0].digest },
  };
  return {
    dir,
    root,
    cwd,
    skillPath,
    git,
    app,
    call,
    repository,
    review,
    comment,
    settings,
    invocations,
    access,
  };
}
test("scoped settings HTTP persistence uses exact revision and rejects folder and skill escapes", async () => {
  const f = await fixture();
  expect(
    (await f.call("GET", "project-settings")).json().settings.startingFolder,
  ).toBe(f.root);
  const save = () =>
    f.call("PUT", "project-settings", {
      reviewId: f.review.id,
      expectedRevision: 0,
      settings: f.settings,
    });
  expect((await save()).statusCode).toBe(200);
  expect((await save()).statusCode).toBe(409);
  await mkdir(join(f.dir, "outside"));
  await symlink(f.cwd, join(f.root, "alias"));
  const fresh = (await f.call("GET", "review?base=HEAD&mode=full")).json();
  for (const startingFolder of [join(f.dir, "outside"), join(f.root, "alias")])
    expect(
      (
        await f.call("PUT", "project-settings", {
          reviewId: fresh.id,
          expectedRevision: 1,
          settings: { ...f.settings, startingFolder },
        })
      ).statusCode,
    ).toBe(409);
  expect(
    (
      await f.call("PUT", "project-settings", {
        reviewId: fresh.id,
        expectedRevision: 1,
        settings: {
          ...f.settings,
          skill: { ...f.settings.skill, digest: "a".repeat(64) },
        },
      })
    ).statusCode,
  ).toBe(409);
  const folders = (
    await f.call(
      "GET",
      `agent-folders?reviewId=${fresh.id}&path=${encodeURIComponent(f.root)}`,
    )
  ).json();
  expect(folders.folders.map((d: any) => d.name)).toEqual(["src"]);
  expect(folders.parent).toBeNull();
});
test("explicit project context executes in the confirmed folder with exact skill while preserving reviewed target", async () => {
  const f = await fixture();
  await f.call("PUT", "project-settings", {
    reviewId: f.review.id,
    expectedRevision: 0,
    settings: f.settings,
  });
  const contextResponse = await f.call(
    "GET",
    `agent-context?reviewId=${f.review.id}`,
  );
  expect(contextResponse.statusCode, contextResponse.body).toBe(200);
  const context = contextResponse.json();
  expect(context.execution).toMatchObject({
    startingFolder: f.cwd,
    settingsRevision: 1,
    adapter: "codex",
    skill: f.settings.skill,
  });
  expect(context.target.worktreeRoot).toBe(f.root);
  const response = await f.call("POST", "agents", {
    adapter: "codex",
    reviewId: f.review.id,
    commentIds: [f.comment.id],
    expected: {
      target: context.target,
      profile: context.profile,
      execution: context.execution,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  expect(f.invocations[0].options.cwd).toBe(f.cwd);
  expect(f.invocations[0].args).toContain(f.cwd);
  expect(response.json().execution).toEqual(context.execution);
});
for (const mutation of ["settings", "skill", "folder", "adapter"]) {
  test(`changed ${mutation} invalidates exact project execution before process creation`, async () => {
    const f = await fixture();
    await f.call("PUT", "project-settings", {
      reviewId: f.review.id,
      expectedRevision: 0,
      settings: f.settings,
    });
    const context = (
      await f.call("GET", `agent-context?reviewId=${f.review.id}`)
    ).json();
    if (mutation === "settings")
      await f.call("PUT", "project-settings", {
        reviewId: f.review.id,
        expectedRevision: 1,
        settings: { ...f.settings, adapter: "claude" },
      });
    if (mutation === "skill") await writeFile(f.skillPath, "Changed");
    if (mutation === "folder") {
      await rm(f.cwd, { recursive: true });
      await symlink(join(f.dir, "state"), f.cwd);
    }
    const response = await f.call("POST", "agents", {
      adapter: mutation === "adapter" ? "claude" : "codex",
      reviewId: f.review.id,
      commentIds: [f.comment.id],
      expected: {
        target: context.target,
        profile: context.profile,
        execution: context.execution,
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(f.invocations).toHaveLength(0);
  });
}

for (const mutation of ["branch", "content"] as const) {
  test(`final project skill resolution ${mutation} race rejects execution before process creation`, async () => {
    const f = await fixture();
    await f.call("PUT", "project-settings", {
      reviewId: f.review.id,
      expectedRevision: 0,
      settings: f.settings,
    });
    const context = (
      await f.call("GET", `agent-context?reviewId=${f.review.id}`)
    ).json();
    const originalValidation = f.access.validateExecution.bind(f.access);
    let checks = 0,
      resolutions = 0,
      mutated = false;
    f.access.validateExecution = async (...args) => {
      await originalValidation(...args);
      checks++;
    };
    const originalResolve = SkillCatalog.prototype.resolve;
    vi.spyOn(SkillCatalog.prototype, "resolve").mockImplementation(
      async function (this: SkillCatalog, profile) {
        const text = await originalResolve.call(this, profile);
        // Three validation passes plus the launch read make this the final selection resolution.
        // It was after the third whole-worktree check in the unsafe ordering.
        if (++resolutions === 16 && !mutated) {
          mutated = true;
          if (mutation === "branch") f.git("switch", "-q", "other");
          else
            await writeFile(
              join(f.root, "a.txt"),
              "changed after final workspace validation\nstable\n",
            );
        }
        return text;
      },
    );
    const response = await f.call("POST", "agents", {
      adapter: "codex",
      reviewId: f.review.id,
      commentIds: [f.comment.id],
      expected: {
        target: context.target,
        profile: context.profile,
        execution: context.execution,
      },
    });
    expect(mutated).toBe(true);
    expect(
      response.statusCode,
      `checks=${checks}, resolutions=${resolutions}, response=${response.body}`,
    ).toBe(409);
    expect(f.invocations).toHaveLength(0);
  });
}
