import { test, expect } from "vitest";
import { parseCLI } from "../apps/server/src/cli.js";
test("export arguments and launch mode are explicit", () => {
  expect(parseCLI(["repo", "--export-comments", "out.json"]).exportPath).toBe(
    "out.json",
  );
  expect(parseCLI(["repo", "--mode", "staged"]).mode).toBe("staged");
  expect(() => parseCLI(["repo", "--export-comments"])).toThrow(
    "requires a value",
  );
  expect(() => parseCLI(["repo", "--mode", "invalid"])).toThrow("mode");
  expect(() =>
    parseCLI(["repo", "--export-comments", "out.json", "--base", "main"]),
  ).toThrow("launch");
});
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createApp } from "../apps/server/src/app.js";
test("separate CLI process exports durable old-side metadata and profile without listening, refuses overwrite", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cli-test-"));
  const root = join(parent, "repo");
  const state = join(parent, "state");
  try {
    execFileSync(process.execPath, ["scripts/create-demo.mjs", root]);
    const app = await createApp({
      port: 7373,
      token: "test",
      repositoryPath: root,
      dataDir: state,
      base: "demo-base",
    });
    try {
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
      const id = (
        await app.inject({ url: "/api/repositories", headers })
      ).json().selectedRepositoryId;
      const url = `/api/repositories/${id}`;
      const review = (
        await app.inject({
          url: `${url}/review?base=demo-base&mode=full`,
          headers,
        })
      ).json();
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/comments`,
            headers,
            payload: {
              reviewId: review.id,
              path: "deleted.txt",
              side: "old",
              startLine: 1,
              endLine: 2,
              body: "Migration note",
              severity: "warning",
            },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${url}/profiles`,
            headers,
            payload: {
              reviewId: review.id,
              scope: "worktree",
              profile: { locator: "skills/reviewer", digest: "a".repeat(64) },
            },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
    const output = join(parent, "export.json");
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["bin/review-app.mjs", ...args], {
        encoding: "utf8",
        env: { ...process.env, REVIEW_DATA_DIR: state },
        timeout: 15000,
      });
    const result = run([root, "--export-comments", output]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("token=");
    const text = await readFile(output, "utf8");
    const data = JSON.parse(text);
    expect(data.schemaVersion).toBe(1);
    expect(data.target).toMatchObject({
      base: execFileSync("git", ["-C", root, "rev-parse", "demo-base"], {
        encoding: "utf8",
      }).trim(),
      mode: "full",
    });
    expect(data.comments[0]).toMatchObject({
      side: "old",
      startLine: 1,
      endLine: 2,
      severity: "warning",
      status: "open",
      attachment: "current",
    });
    expect(data.comments[0].anchor.selected).toHaveLength(2);
    expect(data.profile).toMatchObject({ source: "worktree", revision: 1 });
    expect(text).not.toContain("Legacy workflow");
    expect(text).not.toContain("oldContent");
    expect(run([root, "--export-comments", output]).status).toBe(1);
    expect(await readFile(output, "utf8")).toBe(text);
    expect(
      run([root, "--export-comments", join(parent, "absent", "out.json")])
        .status,
    ).toBe(1);
    expect(
      run([
        join(parent, "missing"),
        "--export-comments",
        join(parent, "missing.json"),
      ]).status,
    ).toBe(1);
    const demoAgain = spawnSync(
      process.execPath,
      ["scripts/create-demo.mjs", root],
      { encoding: "utf8" },
    );
    expect(demoAgain.status).toBe(1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);
